import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Governance, GovernanceError } from "./governance.js";
import { createMcpServer, VERSION } from "./server.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
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
 * Set PURSESTRING_TOKEN to require a bearer token on /mcp, and PURSESTRING_ADMIN_TOKEN for the approval API.
 */
export function startHttp(gov: Governance, port: number, host: string) {
  const mcpToken = process.env.PURSESTRING_TOKEN;
  const adminToken = process.env.PURSESTRING_ADMIN_TOKEN;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") return send(res, 200, { ok: true, version: VERSION, rail: gov.adapter.name });

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
    console.error(`[pursestring] HTTP MCP server on http://${host}:${port}/mcp (rail: ${gov.adapter.name})`);
    if (!mcpToken) console.error("[pursestring] warning: PURSESTRING_TOKEN is not set, /mcp is unauthenticated. Keep it on a private network.");
  });
  return server;
}
