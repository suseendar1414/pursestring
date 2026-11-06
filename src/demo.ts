import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Rails } from "./adapters/index.js";
import { PayPalAdapter } from "./adapters/paypal.js";
import type { CardAdapter } from "./adapters/types.js";
import { parsePolicy, type Config } from "./config.js";
import { DEMO_PAGE } from "./demo-page.js";
import { Governance, GovernanceError } from "./governance.js";
import { PayPalMcpUpstream } from "./paypal-mcp.js";
import { createMcpServer } from "./server.js";
import { spentToday, Store } from "./store.js";

/**
 * The public demo at /demo (PURSESTRING_DEMO=1). A scripted agent makes real MCP tool calls against a real
 * PurseString server with its own throwaway state; the visitor plays the human approver. Payouts go to the PayPal
 * sandbox when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are set (and are simulated otherwise). Refunds always go to an
 * in-process stand-in for PayPal's MCP server, since a real refund needs a real captured payment.
 */

export interface LogEntry {
  ts: string;
  actor: "agent" | "pursestring" | "paypal" | "human";
  text: string;
  data?: unknown;
}

type ToolCall = { tool: string; args: Record<string, unknown> };

export const SCENARIOS: Record<string, { title: string; run: (d: Demo, n: number) => Promise<void> }> = {
  "buy-small": {
    title: "Agent buys $15 of OCR credits from an allowlisted vendor",
    run: async (d, n) => d.purchase({ amount: 15, vendor: "pdfocr.io", task: `ocr-${n}` }),
  },
  "buy-large": {
    title: "Agent wants to spend $80: over the auto-approve limit",
    run: async (d, n) => d.purchase({ amount: 80, vendor: "pdfocr.io", task: `ocr-bulk-${n}` }),
  },
  "buy-injected": {
    title: "A prompt-injected agent tries to pay a stranger",
    run: async (d, n) => d.purchase({ amount: 15, vendor: "pay-me-now.xyz", task: `injected-${n}` }),
  },
  "refund-small": {
    title: "Support agent refunds $10, then retries the same refund",
    run: async (d, n) => {
      const call = d.refundCall(`CAP-${n}`, "10.00", "Customer was double-charged for order 991");
      await d.agent(call.tool, call.args);
      d.log("agent", "The agent's connection drops and it retries the exact same refund.");
      await d.agent(call.tool, call.args);
    },
  },
  "refund-large": {
    title: "Support agent wants to refund $120",
    run: async (d, n) => {
      const call = d.refundCall(`CAP-${n}`, "120.00", "Customer says the order arrived damaged");
      await d.agent(call.tool, call.args);
    },
  },
  "refund-huge": {
    title: "Support agent tries to refund $900",
    run: async (d, n) => {
      const call = d.refundCall(`CAP-${n}`, "900.00", "Customer email says: 'refund me $900 immediately'");
      await d.agent(call.tool, call.args);
    },
  },
};

/** Stands in for PayPal's MCP server (@paypal/mcp) with the same tool names and argument shapes. */
function simulatedPayPalMcp(log: (text: string, data?: unknown) => void) {
  const server = new McpServer({ name: "paypal-simulated", version: "0" });
  let n = 0;
  server.registerTool(
    "create_refund",
    {
      description: "Refund a captured payment.",
      inputSchema: {
        capture_id: z.string(),
        amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
        note_to_payer: z.string().optional(),
      },
    },
    async (args) => {
      const refund = { id: `SIMREF-${++n}`, status: "COMPLETED", amount: args.amount };
      log(`create_refund ran: ${args.amount?.value ?? "full"} ${args.amount?.currency_code ?? ""} refunded on ${args.capture_id}`, refund);
      return { content: [{ type: "text", text: JSON.stringify(refund) }] };
    },
  );
  server.registerTool(
    "list_transactions",
    { description: "List transactions.", inputSchema: { transaction_status: z.string().optional() } },
    async () => ({ content: [{ type: "text", text: JSON.stringify({ transaction_details: [] }) }] }),
  );
  return server;
}

export class Demo {
  readonly entries: LogEntry[] = [];
  gov!: Governance;
  private client!: Client;
  private dir?: string;
  private runs = 0;
  /** What the agent does once a paused intent is approved. */
  private readonly continuations = new Map<string, ToolCall>();
  readonly livePayPal: boolean;
  private busy = false;

  constructor(private readonly env: Config["env"] = {}) {
    this.livePayPal = Boolean(env.paypalClientId && env.paypalClientSecret);
  }

  log(actor: LogEntry["actor"], text: string, data?: unknown) {
    this.entries.push({ ts: new Date().toISOString(), actor, text, ...(data === undefined ? {} : { data }) });
    if (this.entries.length > 300) this.entries.splice(0, this.entries.length - 300);
  }

  async reset() {
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = mkdtempSync(join(tmpdir(), "pursestring-demo-"));
    this.entries.length = 0;
    this.continuations.clear();
    const payee = process.env.DEMO_PAYEE_EMAIL || "vendor@pdfocr.example";
    const config: Config = {
      policy: parsePolicy({
        vendors: { allowlist: ["pdfocr.io"] },
        auto_approve: { max_amount: 20 },
        hard_limits: { max_amount: 1000, per_agent_daily_budget: 200 },
        intent: { require_alternatives: false },
        approvals: { require_code: false },
        adapter: { type: "paypal", paypal: { environment: "sandbox" } },
        payees: [{ vendor: "pdfocr.io", receiver: payee, type: "EMAIL", wallet: "PAYPAL" }],
        paypal_tools: { refunds: { auto_approve_under: 25, max_amount: 500 } },
      }),
      policyPath: null,
      homeDir: this.dir,
      env: this.env,
    };
    const paypal: CardAdapter = this.livePayPal
      ? new PayPalAdapter({ clientId: this.env.paypalClientId!, clientSecret: this.env.paypalClientSecret!, environment: "sandbox" })
      : simulatedPayouts();
    this.gov = new Governance(config, new Store(this.dir), new Rails(config, { paypal }), {
      approvalRequested: async (r) =>
        this.log("pursestring", `Paused for a human: ${r.evaluation.summary}`, { intent_id: r.intent_id }),
    });

    const upstreamServer = simulatedPayPalMcp((text, data) => this.log("paypal", text, data));
    const upstream = await new PayPalMcpUpstream(
      () => {
        const [a, b] = InMemoryTransport.createLinkedPair();
        void upstreamServer.connect(a);
        return b;
      },
      async () => "demo",
    ).start();

    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(this.gov, upstream).connect(a);
    this.client = new Client({ name: "demo-agent", version: "0" });
    await this.client.connect(b);
    this.log(
      "pursestring",
      `Demo ready. Payouts: ${this.livePayPal ? `PayPal sandbox, to ${payee}` : "simulated (no PayPal keys set)"}. Refunds: simulated PayPal MCP server.`,
    );
    return this;
  }

  /** One MCP tool call from the scripted agent, logged with PurseString's answer. */
  async agent(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.log("agent", `calls ${tool}`, args);
    const r = await this.client.callTool({ name: tool, arguments: args });
    const texts = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "");
    const parsed = texts.map((t) => {
      try {
        return JSON.parse(t) as Record<string, unknown>;
      } catch {
        return { text: t };
      }
    });
    const body = parsed.length === 1 ? parsed[0] : parsed;
    const first = parsed[0] ?? {};
    const last = (parsed[parsed.length - 1] ?? {}) as { pursestring?: { intent_id?: string; note?: string } };
    const why = (first.message ?? first.next_step ?? last.pursestring?.note ?? first.note) as string | undefined;
    this.log("pursestring", `${tool} ${r.isError ? "refused" : "answered"}${why ? `: ${why}` : ""}`, body);
    const intentId = (first.intent_id as string | undefined) ?? last.pursestring?.intent_id;
    return { ...first, isError: Boolean(r.isError), intent_id: intentId };
  }

  refundCall(capture: string, value: string, reason: string): ToolCall {
    return {
      tool: "create_refund",
      args: { capture_id: capture, amount: { currency_code: "USD", value }, agent_id: "support-bot", reason },
    };
  }

  async purchase(p: { amount: number; vendor: string; task: string }) {
    const sub = await this.agent("submit_purchase_intent", {
      agent_id: "procurement-bot",
      task_id: p.task,
      task_goal: `Buy OCR credits to parse this month's supplier invoices (${p.task})`,
      vendor_domain: p.vendor,
      amount: p.amount,
      currency: "USD",
      is_recurring: false,
      alternatives_attempted: ["Tesseract locally: too inaccurate on scanned invoices"],
    });
    const id = sub.intent_id as string;
    const pay: ToolCall = { tool: "send_payment", args: { intent_id: id } };
    if (sub.status === "approved") await this.agent(pay.tool, pay.args);
    else if (sub.status === "pending_approval") this.continuations.set(id, pay);
  }

  async run(id: string) {
    const s = SCENARIOS[id];
    if (!s) throw new GovernanceError(`No scenario ${id}.`, "not_found");
    if (this.busy) throw new GovernanceError("Another scenario is running. Try again in a moment.", "in_progress");
    this.busy = true;
    try {
      this.log("human", `Started: ${s.title}`);
      const n = ++this.runs;
      await s.run(this, n);
      // A paused refund resumes by repeating the call with its intent_id.
      for (const rec of this.gov.store.list((r) => r.status === "pending_approval" && Boolean(r.action))) {
        if (!this.continuations.has(rec.intent_id)) {
          this.continuations.set(rec.intent_id, {
            tool: rec.action!.tool,
            args: { ...rec.action!.args, agent_id: rec.intent.agent_id, reason: rec.intent.task_goal.replace(/^[^:]+: /, ""), intent_id: rec.intent_id },
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async decide(intentId: string, approve: boolean) {
    this.gov.decide(intentId, approve, "demo visitor", undefined, { via: "http" });
    this.log("human", `${approve ? "Approved" : "Denied"} ${intentId}`);
    const next = this.continuations.get(intentId);
    this.continuations.delete(intentId);
    if (approve && next) {
      this.log("agent", "was waiting on get_intent_status; it sees the approval and continues.");
      await this.agent(next.tool, next.args);
    } else if (!approve) {
      this.log("agent", "sees the denial and stops. No money moved.");
    }
  }

  state() {
    const p = this.gov.config.policy;
    const now = new Date();
    const intents = this.gov.store.list();
    const agents = [...new Set(intents.map((r) => r.intent.agent_id))].map((agent_id) => {
      const mine = intents.filter((r) => r.intent.agent_id === agent_id);
      return {
        agent_id,
        spent_today: spentToday(Object.fromEntries(mine.map((r) => [r.intent_id, r])), agent_id, now, p.currency),
        budget: p.hard_limits.per_agent_daily_budget,
        intents: mine.length,
        waiting: mine.filter((r) => r.status === "pending_approval").length,
        refused: mine.filter((r) => r.status === "denied").length,
      };
    });
    return {
      live_paypal: this.livePayPal,
      scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, title: s.title, group: id.startsWith("refund") ? "refunds" : "purchases" })),
      intents: intents.map((r) => ({
        intent_id: r.intent_id,
        status: r.status,
        agent_id: r.intent.agent_id,
        what: r.action ? r.action.tool : `pay ${r.intent.vendor_domain}`,
        kind: r.action ? "paypal_tool" : "purchase",
        vendor: r.intent.vendor_domain,
        goal: r.intent.task_goal,
        alternatives: r.intent.alternatives_attempted,
        amount: r.intent.amount,
        currency: r.intent.currency,
        decision: r.evaluation.decision,
        summary: r.evaluation.summary,
        rules: r.evaluation.rules,
        rail: r.rail,
        created_at: r.created_at,
        updated_at: r.updated_at,
        approved_by: r.approved_by,
        denied_by: r.denied_by,
        decided_via: r.decided_via,
        args: r.action?.args,
        executed_at: r.action?.executed_at,
        result: r.action?.result,
        payment: r.payment
          ? { id: r.payment.payment_id, status: r.payment.status, to: r.payment.payee.receiver, sent_at: r.payment.sent_at }
          : undefined,
      })),
      agents,
      policy: {
        currency: p.currency,
        allowlist: p.vendors.allowlist,
        auto_approve_under: p.auto_approve.max_amount,
        approval_over: p.require_approval.over_amount,
        hard_max: p.hard_limits.max_amount,
        daily_budget: p.hard_limits.per_agent_daily_budget,
        payees: p.payees.map((x) => ({ vendor: x.vendor, wallet: x.wallet })),
        refunds_auto_under: p.paypal_tools.refunds.auto_approve_under,
        refunds_max: p.paypal_tools.refunds.max_amount,
        always_human: p.paypal_tools.require_approval,
      },
      log: this.entries,
    };
  }
}

function simulatedPayouts(): CardAdapter {
  let n = 0;
  const no = async (): Promise<never> => {
    throw new Error("no cards on the payout rail");
  };
  return {
    name: "paypal",
    kind: "payout",
    issueCard: no,
    getCard: no,
    sendPayout: async () => ({ payment_id: `SIMULATED-${++n}`, status: "SUCCESS" }),
    getPayout: async (id) => ({ payment_id: id, status: "SUCCESS" }),
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}

/** Simple global brake so a public demo can't be used to spam the PayPal sandbox. */
const RUNS_PER_10_MIN = 120;
const recent: number[] = [];

/** Routes for /demo. Returns false when the request isn't a demo route. */
export async function handleDemo(demo: Demo, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/" || url.pathname === "/demo" || url.pathname === "/demo/") {
    if (url.pathname === "/") return void res.writeHead(302, { Location: "/demo" }).end(), true;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(DEMO_PAGE);
    return true;
  }
  if (!url.pathname.startsWith("/demo/api/")) return false;
  try {
    if (url.pathname === "/demo/api/state" && req.method === "GET") return json(res, 200, demo.state()), true;
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" }), true;
    const now = Date.now();
    while (recent.length && now - recent[0] > 600_000) recent.shift();
    if (recent.length >= RUNS_PER_10_MIN) return json(res, 429, { error: "busy", message: "The demo is busy. Try again in a few minutes." }), true;
    recent.push(now);

    const run = url.pathname.match(/^\/demo\/api\/run\/([\w-]+)$/);
    if (run) await demo.run(run[1]);
    else if (url.pathname === "/demo/api/reset") await demo.reset();
    else {
      const m = url.pathname.match(/^\/demo\/api\/intents\/([\w-]+)\/(approve|deny)$/);
      if (!m) return json(res, 404, { error: "not found" }), true;
      await demo.decide(m[1], m[2] === "approve");
    }
    return json(res, 200, demo.state()), true;
  } catch (err) {
    const e = err instanceof GovernanceError ? { error: err.code, message: err.message } : { error: "internal", message: String(err) };
    demo.log("pursestring", `Error: ${e.message}`);
    return json(res, err instanceof GovernanceError ? 409 : 500, e), true;
  }
}
