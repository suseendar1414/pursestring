import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

/**
 * A small OAuth 2.1 authorization server for one owner, so remote MCP clients that only speak OAuth
 * (ChatGPT developer mode, claude.ai custom connectors) can connect without an open endpoint.
 *
 * It follows the MCP authorization spec: protected resource metadata (RFC 9728), authorization server
 * metadata (RFC 8414), dynamic client registration (RFC 7591), and the authorization code flow with PKCE (S256).
 * The consent page asks for PURSESTRING_ADMIN_TOKEN, so only the person running PurseString can connect a client.
 * Tokens are stored hashed in $PURSESTRING_HOME/oauth.json.
 */

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 50;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 10 * 60 * 1000;
export const SCOPE = "pursestring";

interface Client {
  client_id: string;
  client_secret_hash?: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
}

interface Token {
  client_id: string;
  expires_at: number;
}

interface OAuthState {
  clients: Record<string, Client>;
  access: Record<string, Token>;
  refresh: Record<string, Token>;
}

interface PendingCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const random = (bytes = 32) => randomBytes(bytes).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** https anywhere, or http only on loopback (for local MCP clients). */
export function allowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Form-encoded (the OAuth default) or JSON, flattened to strings. */
async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readRaw(req);
  if (!raw) return {};
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }).end(JSON.stringify(body));
}

const oauthError = (res: ServerResponse, status: number, error: string, description: string) =>
  json(res, status, { error, error_description: description });

/** Forget every OAuth client and token. Connected apps must sign in again. Returns how many apps were connected. */
export function revokeAllOAuth(homeDir: string): number {
  const path = join(homeDir, "oauth.json");
  if (!existsSync(path)) return 0;
  const n = Object.keys((JSON.parse(readFileSync(path, "utf8")) as OAuthState).clients).length;
  writeFileSync(path, JSON.stringify({ clients: {}, access: {}, refresh: {} }, null, 2), { mode: 0o600 });
  return n;
}

export class OAuthServer {
  readonly issuer: string;
  readonly resource: string;
  private readonly path: string;
  private state: OAuthState;
  private readonly codes = new Map<string, PendingCode>();
  private failures: number[] = [];
  private loadedMtime = 0;

  constructor(publicUrl: string, private readonly password: string, homeDir: string) {
    this.issuer = publicUrl.replace(/\/+$/, "");
    this.resource = `${this.issuer}/mcp`;
    this.path = join(homeDir, "oauth.json");
    this.state = { clients: {}, access: {}, refresh: {} };
    this.reload();
  }

  /** Pick up changes made outside this process, such as `pursestring oauth revoke`. */
  private reload() {
    if (!existsSync(this.path)) return;
    const mtime = statSync(this.path).mtimeMs;
    if (mtime === this.loadedMtime) return;
    this.state = JSON.parse(readFileSync(this.path, "utf8")) as OAuthState;
    this.loadedMtime = mtime;
  }

  /** The WWW-Authenticate value for a 401 on /mcp, pointing clients at the metadata. */
  get challenge(): string {
    return `Bearer resource_metadata="${this.issuer}/.well-known/oauth-protected-resource"`;
  }

  verifyAccessToken(token: string): boolean {
    this.reload();
    const t = this.state.access[sha256(token)];
    return !!t && t.expires_at > Date.now() / 1000 && !!this.state.clients[t.client_id];
  }

  /** Returns true if the request was an OAuth route and has been answered. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    this.reload();
    const p = url.pathname;
    if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") {
      json(res, 200, {
        resource: this.resource,
        authorization_servers: [this.issuer],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ["header"],
        resource_name: "PurseString",
      });
      return true;
    }
    if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration") {
      json(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/oauth/authorize`,
        token_endpoint: `${this.issuer}/oauth/token`,
        registration_endpoint: `${this.issuer}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        scopes_supported: [SCOPE],
      });
      return true;
    }
    if (p === "/oauth/register" && req.method === "POST") return this.register(req, res).then(() => true);
    if (p === "/oauth/authorize" && req.method === "GET") return this.authorizePage(res, url), true;
    if (p === "/oauth/authorize" && req.method === "POST") return this.authorizeSubmit(req, res).then(() => true);
    if (p === "/oauth/token" && req.method === "POST") return this.token(req, res).then(() => true);
    return false;
  }

  private save() {
    const now = Date.now() / 1000;
    for (const kind of ["access", "refresh"] as const) {
      for (const [k, t] of Object.entries(this.state[kind])) if (t.expires_at <= now) delete this.state[kind][k];
    }
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.loadedMtime = statSync(this.path).mtimeMs;
  }

  private async register(req: IncomingMessage, res: ServerResponse) {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readRaw(req)) as Record<string, unknown>;
      if (!body || typeof body !== "object") throw new Error("not an object");
    } catch {
      return oauthError(res, 400, "invalid_client_metadata", "Body must be JSON client metadata.");
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string" && allowedRedirect(u))) {
      return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be https URLs, or http on localhost.");
    }
    const method = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
      return oauthError(res, 400, "invalid_client_metadata", `Unsupported token_endpoint_auth_method ${method}.`);
    }
    const client: Client = {
      client_id: `ps_client_${random(12)}`,
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "An MCP client",
      redirect_uris: uris as string[],
      created_at: new Date().toISOString(),
    };
    const secret = method === "none" ? undefined : random();
    if (secret) client.client_secret_hash = sha256(secret);

    const ids = Object.keys(this.state.clients);
    if (ids.length >= MAX_CLIENTS) {
      const oldest = ids.sort((a, b) => this.state.clients[a].created_at.localeCompare(this.state.clients[b].created_at))[0];
      delete this.state.clients[oldest];
    }
    this.state.clients[client.client_id] = client;
    this.save();
    json(res, 201, {
      client_id: client.client_id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    });
  }

  /** Validates an authorization request. Errors before the redirect URI is trusted are shown, not redirected. */
  private check(params: URLSearchParams | Record<string, string>): { client: Client; p: Record<string, string> } | { error: string } {
    const p = params instanceof URLSearchParams ? Object.fromEntries(params) : params;
    const client = this.state.clients[p.client_id ?? ""];
    if (!client) return { error: "Unknown app. Remove the connector and add it again." };
    if (!client.redirect_uris.includes(p.redirect_uri ?? "")) return { error: "The app's redirect address doesn't match its registration." };
    if (p.response_type !== "code") return { error: "Only response_type=code is supported." };
    if (!p.code_challenge || p.code_challenge_method !== "S256") return { error: "PKCE with S256 is required." };
    if (p.resource && p.resource !== this.resource && p.resource !== this.issuer) return { error: `This server is ${this.resource}.` };
    return { client, p };
  }

  private page(res: ServerResponse, status: number, body: string) {
    res
      .writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
      })
      .end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PurseString</title><style>
body{font-family:system-ui,sans-serif;background:#f6f5f2;color:#1d1d1b;display:flex;justify-content:center;padding:48px 16px}
main{background:#fff;border:1px solid #e3e1db;border-radius:14px;max-width:420px;width:100%;padding:28px}
h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;color:#45443f}code{font-size:13px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cfccc4;border-radius:8px;font-size:15px;margin:6px 0 16px}
button{padding:10px 16px;border-radius:8px;border:0;font-size:15px;cursor:pointer;margin-right:8px}
.allow{background:#1d1d1b;color:#fff}.deny{background:#ecebe6;color:#1d1d1b}.err{color:#b42318}
</style></head><body><main>${body}</main></body></html>`);
  }

  private authorizePage(res: ServerResponse, url: URL, error?: string) {
    const checked = this.check(url.searchParams);
    if ("error" in checked) return this.page(res, 400, `<h1>Can't connect</h1><p class="err">${escapeHtml(checked.error)}</p>`);
    const { client, p } = checked;
    const hidden = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "resource", "scope"]
      .filter((k) => p[k] !== undefined)
      .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(p[k])}">`)
      .join("");
    this.page(
      res,
      error ? 401 : 200,
      `<h1>Connect ${escapeHtml(client.client_name)} to PurseString?</h1>
<p>It will be able to check policy, submit purchases and request cards, within your <code>policies.yaml</code>.
After approving, you'll be sent back to <code>${escapeHtml(new URL(p.redirect_uri).host)}</code>.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">${hidden}
<label for="pw">Your PurseString admin token</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<button class="allow" name="decision" value="allow">Allow</button><button class="deny" name="decision" value="deny" formnovalidate>Deny</button>
</form>`,
    );
  }

  private async authorizeSubmit(req: IncomingMessage, res: ServerResponse) {
    const body = await readForm(req);
    const checked = this.check(body);
    if ("error" in checked) return this.page(res, 400, `<h1>Can't connect</h1><p class="err">${escapeHtml(checked.error)}</p>`);
    const { client, p } = checked;
    const back = new URL(p.redirect_uri);
    if (p.state) back.searchParams.set("state", p.state);
    back.searchParams.set("iss", this.issuer);

    if (body.decision !== "allow") {
      back.searchParams.set("error", "access_denied");
      return void res.writeHead(302, { Location: back.toString() }).end();
    }
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < LOCKOUT_MS);
    const retryUrl = new URL(`${this.issuer}/oauth/authorize`);
    for (const [k, v] of Object.entries(p)) if (k !== "password" && k !== "decision") retryUrl.searchParams.set(k, v);
    if (this.failures.length >= MAX_FAILED_LOGINS) {
      return this.authorizePage(res, retryUrl, "Too many wrong tries. Wait 10 minutes and try again.");
    }
    if (!safeEqual(sha256(body.password ?? ""), sha256(this.password))) {
      this.failures.push(now);
      return this.authorizePage(res, retryUrl, "That admin token is wrong.");
    }

    const code = random();
    this.codes.set(sha256(code), { client_id: client.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, expires_at: now + CODE_TTL_MS });
    back.searchParams.set("code", code);
    res.writeHead(302, { Location: back.toString() }).end();
  }

  private clientFrom(req: IncomingMessage, body: Record<string, string>): Client | undefined {
    let id = body.client_id;
    let secret = body.client_secret;
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (basic) {
      const [u, s] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
      id = decodeURIComponent(u ?? "");
      secret = decodeURIComponent(s ?? "");
    }
    const client = this.state.clients[id ?? ""];
    if (!client) return undefined;
    if (client.client_secret_hash && !safeEqual(sha256(secret ?? ""), client.client_secret_hash)) return undefined;
    return client;
  }

  private issue(res: ServerResponse, client: Client) {
    const access = random();
    const refresh = random();
    const now = Math.floor(Date.now() / 1000);
    this.state.access[sha256(access)] = { client_id: client.client_id, expires_at: now + ACCESS_TTL_S };
    this.state.refresh[sha256(refresh)] = { client_id: client.client_id, expires_at: now + REFRESH_TTL_S };
    this.save();
    json(res, 200, { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE });
  }

  private async token(req: IncomingMessage, res: ServerResponse) {
    const body = await readForm(req);
    const client = this.clientFrom(req, body);
    if (!client) return oauthError(res, 401, "invalid_client", "Unknown client or wrong client secret.");

    if (body.grant_type === "authorization_code") {
      const key = sha256(body.code ?? "");
      const pending = this.codes.get(key);
      this.codes.delete(key); // single use, even when the exchange fails
      if (!pending || pending.expires_at < Date.now() || pending.client_id !== client.client_id) {
        return oauthError(res, 400, "invalid_grant", "The authorization code is invalid or expired.");
      }
      if (body.redirect_uri !== pending.redirect_uri) return oauthError(res, 400, "invalid_grant", "redirect_uri doesn't match.");
      const challenge = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
      if (!body.code_verifier || !safeEqual(challenge, pending.code_challenge)) {
        return oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
      }
      return this.issue(res, client);
    }

    if (body.grant_type === "refresh_token") {
      const key = sha256(body.refresh_token ?? "");
      const t = this.state.refresh[key];
      if (!t || t.client_id !== client.client_id || t.expires_at <= Date.now() / 1000) {
        return oauthError(res, 400, "invalid_grant", "The refresh token is invalid or expired.");
      }
      delete this.state.refresh[key]; // rotate
      return this.issue(res, client);
    }

    oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  }
}
