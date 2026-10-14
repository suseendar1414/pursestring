import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Governance, GovernanceError, type AuthorizationCode } from "./governance.js";
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
  merchant?: { descriptor?: string; mcc?: string };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function bearerOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
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
 *   POST /jit/authorize                generic real-time authorization for other rails (admin token)
 * Set PURSESTRING_TOKEN to require a bearer token on /mcp, and PURSESTRING_ADMIN_TOKEN for the approval API.
 */
export function startHttp(gov: Governance, port: number, host: string, opts: { quiet?: boolean } = {}) {
  const mcpToken = process.env.PURSESTRING_TOKEN;
  const adminToken = process.env.PURSESTRING_ADMIN_TOKEN;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") return send(res, 200, { ok: true, version: VERSION, rail: gov.rails.default });

      if (url.pathname === "/mcp") {
        if (mcpToken && !bearerOk(req, mcpToken)) return send(res, 401, { error: "unauthorized" });
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
          mcc: body.merchant?.mcc,
        });
        return send(res, 200, { token: body.token, result: LITHIC_RESULT[decision.code] });
      }

      if (url.pathname === "/jit/authorize" && req.method === "POST") {
        if (!gov.config.policy.jit.enabled) return send(res, 404, { error: "jit disabled in policy" });
        if (!bearerOk(req, adminToken)) return send(res, 401, { error: "unauthorized" });
        const body = ((await readJson(req)) ?? {}) as { card_token?: string; amount?: number; merchant?: string; mcc?: string };
        if (!body.card_token || typeof body.amount !== "number") {
          return send(res, 400, { error: "card_token and amount (major units) are required" });
        }
        return send(res, 200, gov.authorize({ card_token: body.card_token, amount: body.amount, merchant: body.merchant ?? "", mcc: body.mcc }));
      }

      if (url.pathname.startsWith("/intents")) {
        if (!bearerOk(req, adminToken)) {
          return send(res, 401, { error: adminToken ? "unauthorized" : "set PURSESTRING_ADMIN_TOKEN to enable the approval API" });
        }
        const m = url.pathname.match(/^\/intents\/([\w-]+)\/(approve|deny)$/);
        if (m && req.method === "POST") {
          const body = ((await readJson(req)) ?? {}) as { by?: string; note?: string };
          const rec = gov.decide(m[1], m[2] === "approve", body.by ?? "http-admin", body.note);
          return send(res, 200, { intent_id: rec.intent_id, status: rec.status });
        }
        if (url.pathname === "/intents" && req.method === "GET") {
          const status = url.searchParams.get("status");
          return send(res, 200, gov.store.list((r) => !status || r.status === status));
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
    if (!mcpToken) console.error("[pursestring] warning: PURSESTRING_TOKEN is not set, /mcp is unauthenticated. Keep it on a private network.");
  });
  return server;
}
