import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PayPalMcpUpstream } from "../src/paypal-mcp.js";
import { createMcpServer } from "../src/server.js";
import { setup } from "./helpers.js";

/** Stands in for PayPal's MCP server (@paypal/mcp): same tool names and argument shapes. */
function fakePayPal() {
  const refunds: Record<string, unknown>[] = [];
  const server = new McpServer({ name: "paypal", version: "0" });
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
      refunds.push(args);
      // Like @paypal/mcp: API failures come back as ordinary content, not as an MCP error.
      if (args.capture_id === "BAD") {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, status: 422, code: "PAYPAL_API_HTTP_ERROR" }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ id: `REF${refunds.length}`, status: "COMPLETED" }) }] };
    },
  );
  server.registerTool(
    "list_transactions",
    { description: "List transactions.", inputSchema: { transaction_status: z.string().optional() } },
    async () => ({ content: [{ type: "text", text: JSON.stringify({ transactions: [] }) }] }),
  );
  server.registerTool(
    "cancel_subscription",
    { description: "Cancel a subscription.", inputSchema: { subscription_id: z.string() } },
    async () => ({ content: [{ type: "text", text: "cancelled" }] }),
  );
  return { server, refunds };
}

async function connect(policy: Record<string, unknown> = {}) {
  const { server: paypal, refunds } = fakePayPal();
  const tokens = ["tok1"];
  const upstream = await new PayPalMcpUpstream(
    (token) => {
      assert.equal(token, tokens[0], "PayPal's server gets the current OAuth token");
      const [a, b] = InMemoryTransport.createLinkedPair();
      void paypal.connect(a);
      return b;
    },
    async () => tokens[0],
  ).start();

  const { gov } = setup({ vendors: { allowlist: ["pdfocr.io"] }, hard_limits: { per_agent_daily_budget: 40 }, ...policy });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(gov, upstream).connect(a);
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const texts = (r.content as { text: string }[]).map((c) => c.text);
    const parse = (t: string) => {
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    };
    return { isError: Boolean(r.isError), first: parse(texts[0]), last: parse(texts[texts.length - 1]) };
  };
  return { gov, client, call, refunds };
}

const refund = (value: string, extra: Record<string, unknown> = {}) => ({
  capture_id: "CAP1",
  amount: { currency_code: "USD", value },
  agent_id: "support-bot",
  reason: "Customer was double-charged for order 991",
  ...extra,
});

test("PayPal's tools are listed next to PurseString's, and governed ones ask for agent_id and reason", async () => {
  const { client } = await connect();
  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name);
  for (const n of ["create_refund", "list_transactions", "cancel_subscription", "submit_purchase_intent"]) assert.ok(names.includes(n), n);
  const props = (n: string) => Object.keys((tools.find((t) => t.name === n)!.inputSchema.properties ?? {}) as object);
  assert.ok(props("create_refund").includes("agent_id") && props("create_refund").includes("capture_id"));
  assert.ok(!props("list_transactions").includes("agent_id"), "read-only tools pass through unchanged");
});

test("read-only PayPal tools pass straight through", async () => {
  const { call } = await connect();
  const r = await call("list_transactions", {});
  assert.deepEqual(r.first, { transactions: [] });
});

test("a small refund runs once; repeating it returns PayPal's first answer without refunding again", async () => {
  const { call, refunds } = await connect();
  const first = await call("create_refund", refund("10.00"));
  assert.equal(first.isError, false);
  assert.deepEqual(first.first, { id: "REF1", status: "COMPLETED" });
  assert.equal(refunds.length, 1);
  assert.deepEqual(refunds[0], { capture_id: "CAP1", amount: { currency_code: "USD", value: "10.00" } }, "PayPal never sees PurseString's fields");

  const again = await call("create_refund", refund("10.00"));
  assert.deepEqual(again.first, { id: "REF1", status: "COMPLETED" });
  assert.equal(again.last.pursestring.replayed, true);
  assert.equal(refunds.length, 1, "no second refund");
});

test("a large refund waits for a human, then runs when the agent repeats the call", async () => {
  const { gov, call, refunds } = await connect();
  const paused = await call("create_refund", refund("80.00"));
  assert.equal(paused.isError, true);
  assert.equal(paused.first.error, "pending_approval");
  const id = paused.first.intent_id as string;
  assert.match(id, /^int_/);
  assert.equal(refunds.length, 0);

  gov.decide(id, true, "alice");
  const ran = await call("create_refund", refund("80.00", { intent_id: id }));
  assert.equal(ran.isError, false);
  assert.equal(refunds.length, 1);
  assert.equal(ran.last.pursestring.approved_by, "alice");
});

test("an approval can't be reused for different arguments", async () => {
  const { gov, call, refunds } = await connect();
  const paused = await call("create_refund", refund("80.00"));
  gov.decide(paused.first.intent_id, true, "alice");
  const swapped = await call("create_refund", refund("400.00", { intent_id: paused.first.intent_id }));
  assert.equal(swapped.first.error, "args_mismatch");
  assert.equal(refunds.length, 0);
});

test("refunds over the cap are refused, and full refunds of unknown size need a human", async () => {
  const { call, refunds } = await connect();
  const big = await call("create_refund", refund("900.00"));
  assert.equal(big.first.error, "denied");
  const full = await call("create_refund", { capture_id: "CAP2", agent_id: "support-bot", reason: "Order never shipped" });
  assert.equal(full.first.error, "pending_approval");
  assert.equal(refunds.length, 0);
});

test("refunds count toward the agent's daily budget", async () => {
  const { call, refunds } = await connect();
  await call("create_refund", refund("20.00", { capture_id: "CAP1" }));
  await call("create_refund", refund("20.00", { capture_id: "CAP2" }));
  const third = await call("create_refund", refund("20.00", { capture_id: "CAP3" }));
  assert.equal(third.first.error, "pending_approval");
  assert.equal(refunds.length, 2);
});

test("cancelling a subscription always needs a human, and deny-listed tools never run", async () => {
  const { call } = await connect();
  const cancel = await call("cancel_subscription", { subscription_id: "I-1", agent_id: "support-bot", reason: "Customer asked" });
  assert.equal(cancel.first.error, "pending_approval");

  const locked = await connect({ paypal_tools: { deny: ["create_refund"] } });
  const r = await locked.call("create_refund", refund("5.00"));
  assert.equal(r.first.error, "denied");
  assert.equal(locked.refunds.length, 0);
});

test("when PayPal refuses a refund nothing is recorded as spent and the approval stands", async () => {
  const { gov, call } = await connect();
  const r = await call("create_refund", refund("10.00", { capture_id: "BAD" }));
  assert.equal(r.isError, true);
  assert.equal(r.first.status, 422);
  assert.equal(gov.store.get(r.last.pursestring.intent_id)?.status, "approved");
});
