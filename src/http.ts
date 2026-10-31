import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifySlackSignature } from "./approvals.js";
import { Governance, GovernanceError, type AuthorizationCode } from "./governance.js";
import { OAuthServer } from "./oauth.js";
import { verifyStandardWebhook } from "./webhooks.js";
import { createMcpServer, VERSION } from "./server.js";

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readRaw(req);
  return raw ? JSON.parse(raw) : undefined;
}

/** Map our decision codes onto Lithic's ASA result values. Anything but APPROVED declines. */
const LITHIC_RESULT: Record<AuthorizationCode, string> = {
  approved: "APPROVED",
  over_amount: "INSUFFICIENT_FUNDS",
  already_used: "VELOCITY_EXCEEDED",
  merchant_mismatch: "UNAUTHORIZED_MERCHANT",
  card_expired: "CARD_PAUSED",
  intent_not_active: "CARD_PAUSED",
  unknown_card: "CARD_PAUSED",
};

interface LithicAsaRequest {
  token?: string;
  card_token?: string;
  card?: { token?: string };
  amount?: number;
  merchant_amount?: number;
  merchant?: { descriptor?: string; mcc?: string; acceptor_id?: string };
}

/** The parts of a Lithic transaction event we read. Lithic amounts are in cents; return amounts may be negative. */
interface LithicTransaction {
  token?: string;
  card_token?: string;
  currency?: string;
  merchant_currency?: string;
  merchant?: { descriptor?: string };
  events?: { token?: string; type?: string; amount?: number; result?: string }[];
}

/** Lithic event types that mean money came back to the card. Settled returns only: a credit authorization can still fall through. */
const LITHIC_REFUND_EVENTS = new Set(["RETURN"]);

/** Pull refund events out of a Lithic webhook, whatever the envelope (payload, data, or the transaction itself). */
export function lithicRefunds(body: Record<string, unknown>) {
  const tx = (body.payload ?? body.data ?? body) as LithicTransaction;
  return (tx.events ?? [])
    .filter((e) => e.type && LITHIC_REFUND_EVENTS.has(e.type) && (e.result ?? "APPROVED") === "APPROVED" && e.token && e.amount)
    .map((e) => ({
      refund_id: e.token!,
      amount: Math.abs(e.amount!) / 100,
      currency: tx.currency ?? tx.merchant_currency,
      card_token: tx.card_token,
      merchant: tx.merchant?.descriptor,
      source: "lithic",
    }));
}

interface SlackActionPayload {
  type?: string;
  user?: { id?: string; username?: string; name?: string };
  actions?: { action_id?: string; value?: string }[];
  response_url?: string;
}

/** Tell Slack what happened, replacing the buttons on success. Failures only cost the message update. */
function slackRespond(responseUrl: string | undefined, body: Record<string, unknown>) {
  if (!responseUrl?.startsWith("https://hooks.slack.com/")) return;
  void fetch(responseUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(
    (err) => console.error(`[pursestring] Slack response failed: ${err}`),
  );
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function bearerOf(req: IncomingMessage): string {
  return (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

function bearerOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;
  const got = Buffer.from(bearerOf(req));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Streamable HTTP mode, for Docker and remote agents.
 *   POST /mcp                          MCP endpoint (stateless)
 *   GET  /healthz                      liveness
 *   GET  /intents?status=pending_approval   list intents          (admin token)
 *   POST /intents/:id/approve|deny     human decision             (admin token)
 *   POST /jit/lithic                   Lithic Auth Stream Access   (LITHIC_WEBHOOK_SECRET signature)
 *   POST /webhooks/lithic              Lithic events: merchant refunds (LITHIC_EVENTS_SECRET signature)
 *   POST /refunds                      record a refund by hand or from another rail (admin token)
 *   POST /slack/actions                Slack Approve/Deny buttons  (SLACK_SIGNING_SECRET signature)
 *   POST /jit/authorize                generic real-time authorization for other rails (admin token)
 *   /.well-known/*, /oauth/*           OAuth sign-in for remote MCP clients (when PURSESTRING_PUBLIC_URL is set)
 * Set PURSESTRING_TOKEN to require a bearer token on /mcp, and PURSESTRING_ADMIN_TOKEN for the approval API.
 * Set PURSESTRING_PUBLIC_URL (the public https address) to let OAuth clients such as ChatGPT sign in; /mcp then
 * always requires a token, either PURSESTRING_TOKEN or an OAuth access token.
 */
export function startHttp(
  gov: Governance,
  port: number,
  host: string,
  opts: { quiet?: boolean; publicUrl?: string } = {},
) {
  const mcpToken = process.env.PURSESTRING_TOKEN;
  const adminToken = process.env.PURSESTRING_ADMIN_TOKEN;
  const publicUrl = opts.publicUrl ?? process.env.PURSESTRING_PUBLIC_URL;
  let oauth: OAuthServer | undefined;
  if (publicUrl) {
    if (!/^https:\/\//.test(publicUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(publicUrl)) {
      throw new Error("PURSESTRING_PUBLIC_URL must be an https address, for example https://pursestring.example.com");
    }
    if (!adminToken) throw new Error("OAuth sign-in needs PURSESTRING_ADMIN_TOKEN: it's the password on the consent page.");
    oauth = new OAuthServer(publicUrl, adminToken, gov.config.homeDir);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") return send(res, 200, { ok: true, version: VERSION, rail: gov.rails.default });

      if (oauth && (await oauth.handle(req, res, url))) return;

      if (url.pathname === "/mcp") {
        const authed = bearerOk(req, mcpToken) || (oauth?.verifyAccessToken(bearerOf(req)) ?? false);
        if ((mcpToken || oauth) && !authed) {
          res.writeHead(401, { "Content-Type": "application/json", ...(oauth ? { "WWW-Authenticate": oauth.challenge } : {}) });
          return void res.end(JSON.stringify({ error: "unauthorized" }));
        }
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed; stateless server accepts POST only" });
        const body = await readJson(req);
        const mcp = createMcpServer(gov);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (url.pathname === "/jit/lithic" && req.method === "POST") {
        if (!gov.config.policy.jit.enabled) return send(res, 404, { error: "jit disabled in policy" });
        const secret = gov.config.env.lithicWebhookSecret;
        if (!secret) return send(res, 503, { error: "set LITHIC_WEBHOOK_SECRET (your ASA HMAC key) to enable /jit/lithic" });
        const raw = await readRaw(req);
        if (!verifyStandardWebhook(secret, req.headers, raw)) return send(res, 401, { error: "bad signature" });
        const body = JSON.parse(raw) as LithicAsaRequest;
        const cents = body.amount ?? body.merchant_amount ?? 0;
        const decision = gov.authorize({
          card_token: body.card_token ?? body.card?.token ?? "",
          amount: cents / 100,
          merchant: body.merchant?.descriptor ?? "",
          merchant_id: body.merchant?.acceptor_id,
          mcc: body.merchant?.mcc,
        });
        return send(res, 200, { token: body.token, result: LITHIC_RESULT[decision.code] });
      }

      if (url.pathname === "/webhooks/lithic" && req.method === "POST") {
        const secret = gov.config.env.lithicEventsSecret;
        if (!secret) return send(res, 503, { error: "set LITHIC_EVENTS_SECRET (your Lithic event subscription secret) to enable /webhooks/lithic" });
        const raw = await readRaw(req);
        if (!verifyStandardWebhook(secret, req.headers, raw)) return send(res, 401, { error: "bad signature" });
        const refunds = lithicRefunds(JSON.parse(raw) as Record<string, unknown>);
        const results = [];
        for (const r of refunds) results.push(await gov.recordRefund(r));
        // Always 200 on a verified event: an unmatched refund is for a human, and a retry wouldn't change the answer.
        return send(res, 200, { received: true, refunds: results.map(({ outcome, intent_id, credited }) => ({ outcome, intent_id, credited })) });
      }

      if (url.pathname === "/refunds" && req.method === "POST") {
        if (!bearerOk(req, adminToken)) {
          return send(res, 401, { error: adminToken ? "unauthorized" : "set PURSESTRING_ADMIN_TOKEN to enable the refunds API" });
        }
        const body = ((await readJson(req)) ?? {}) as {
          refund_id?: string;
          amount?: number;
          currency?: string;
          intent_id?: string;
          card_token?: string;
          merchant?: string;
        };
        if (!body.refund_id || typeof body.amount !== "number" || (!body.intent_id && !body.card_token)) {
          return send(res, 400, { error: "refund_id, amount (major units) and intent_id or card_token are required" });
        }
        const result = await gov.recordRefund({
          refund_id: body.refund_id,
          amount: body.amount,
          currency: body.currency,
          intent_id: body.intent_id,
          card_token: body.card_token,
          merchant: body.merchant,
          source: "http",
        });
        return send(res, 200, result);
      }

      if (url.pathname === "/slack/actions" && req.method === "POST") {
        const secret = gov.config.env.slackSigningSecret;
        if (!secret) return send(res, 503, { error: "set SLACK_SIGNING_SECRET to enable Slack buttons" });
        const raw = await readRaw(req);
        if (!verifySlackSignature(secret, req.headers, raw)) return send(res, 401, { error: "bad signature" });
        const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}") as SlackActionPayload;
        const action = payload.actions?.[0];
        const approve = action?.action_id === "pursestring_approve";
        if (payload.type !== "block_actions" || !action?.value || (!approve && action.action_id !== "pursestring_deny")) {
          return void res.writeHead(200).end();
        }
        const userId = payload.user?.id ?? "unknown";
        const who = `slack:${payload.user?.username ?? payload.user?.name ?? userId} (${userId})`;
        const allowed = gov.config.policy.approvals.slack_approvers;
        res.writeHead(200).end();
        if (allowed.length && !allowed.includes(userId)) {
          gov.store.audit("slack_decision_refused", { intent_id: action.value, by: who, reason: "not in approvals.slack_approvers" });
          return slackRespond(payload.response_url, {
            response_type: "ephemeral",
            replace_original: false,
            text: "You're not on this server's list of Slack approvers (approvals.slack_approvers).",
          });
        }
        try {
          const rec = gov.decide(action.value, approve, who, undefined, { via: "slack" });
          slackRespond(payload.response_url, {
            replace_original: true,
            text: `${approve ? ":white_check_mark: Approved" : ":no_entry: Denied"} by <@${userId}>: ${rec.intent.amount.toFixed(2)} ${rec.intent.currency} at ${rec.intent.vendor_domain} (${rec.intent_id})`,
          });
        } catch (err) {
          slackRespond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: (err as Error).message });
        }
        return;
      }

      if (url.pathname === "/jit/authorize" && req.method === "POST") {
        if (!gov.config.policy.jit.enabled) return send(res, 404, { error: "jit disabled in policy" });
        if (!bearerOk(req, adminToken)) return send(res, 401, { error: "unauthorized" });
        const body = ((await readJson(req)) ?? {}) as {
          card_token?: string;
          amount?: number;
          merchant?: string;
          merchant_id?: string;
          mcc?: string;
        };
        if (!body.card_token || typeof body.amount !== "number") {
          return send(res, 400, { error: "card_token and amount (major units) are required" });
        }
        const decision = gov.authorize({
          card_token: body.card_token,
          amount: body.amount,
          merchant: body.merchant ?? "",
          merchant_id: body.merchant_id,
          mcc: body.mcc,
        });
        return send(res, 200, decision);
      }

      if (url.pathname.startsWith("/intents")) {
        if (!bearerOk(req, adminToken)) {
          return send(res, 401, { error: adminToken ? "unauthorized" : "set PURSESTRING_ADMIN_TOKEN to enable the approval API" });
        }
        const m = url.pathname.match(/^\/intents\/([\w-]+)\/(approve|deny)$/);
        if (m && req.method === "POST") {
          const body = ((await readJson(req)) ?? {}) as { by?: string; note?: string };
          const rec = gov.decide(m[1], m[2] === "approve", body.by ?? "http-admin", body.note, { via: "http" });
          return send(res, 200, { intent_id: rec.intent_id, status: rec.status });
        }
        if (url.pathname === "/intents" && req.method === "GET") {
          const status = url.searchParams.get("status");
          const rows = gov.store.list((r) => !status || r.status === status);
          return send(res, 200, rows.map(({ approval_code: _hash, ...r }) => r));
        }
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof GovernanceError) return send(res, err.code === "not_found" ? 404 : 409, { error: err.code, message: err.message });
      if (!res.headersSent) send(res, 500, { error: "internal", message: String(err) });
    }
  });

  server.listen(port, host, () => {
    if (opts.quiet) return;
    console.error(`[pursestring] HTTP MCP server on http://${host}:${port}/mcp (rail: ${gov.rails.default})`);
    if (oauth) console.error(`[pursestring] OAuth sign-in on: add ${oauth.resource} as a connector in ChatGPT or Claude`);
    else if (!mcpToken) console.error("[pursestring] warning: PURSESTRING_TOKEN is not set, /mcp is unauthenticated. Keep it on a private network.");
  });
  return server;
}
