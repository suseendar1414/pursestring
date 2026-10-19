import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { startHttp } from "../src/http.js";
import { allowedRedirect, revokeAllOAuth } from "../src/oauth.js";
import { setup } from "./helpers.js";

const PUBLIC = "https://pursestring.example.com";
const ADMIN = "admin-secret-for-tests";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

let base = "";
let server: ReturnType<typeof startHttp>;
let homeDir = "";
const savedAdmin = process.env.PURSESTRING_ADMIN_TOKEN;

before(async () => {
  process.env.PURSESTRING_ADMIN_TOKEN = ADMIN;
  const { gov } = setup();
  homeDir = gov.config.homeDir;
  server = startHttp(gov, 0, "127.0.0.1", { quiet: true, publicUrl: PUBLIC });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  if (savedAdmin === undefined) delete process.env.PURSESTRING_ADMIN_TOKEN;
  else process.env.PURSESTRING_ADMIN_TOKEN = savedAdmin;
});

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
  redirect: "manual" as const,
});

async function register(extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT <script>", redirect_uris: [REDIRECT], ...extra }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, string> };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function authorize(client_id: string, challenge: string, password = ADMIN) {
  return fetch(
    `${base}/oauth/authorize`,
    form({
      client_id,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${PUBLIC}/mcp`,
      decision: "allow",
      password,
    }),
  );
}

async function signIn(clientId: string) {
  const { verifier, challenge } = pkce();
  const res = await authorize(clientId, challenge);
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const tok = await fetch(
    `${base}/oauth/token`,
    form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }),
  );
  return (await tok.json()) as Record<string, string>;
}

const mcp = (token?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }),
  });

test("/mcp asks unauthenticated clients to sign in, and publishes the metadata they need", async () => {
  const res = await mcp();
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate")!, /resource_metadata="https:\/\/pursestring\.example\.com\/\.well-known\/oauth-protected-resource"/);

  const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
  assert.deepEqual(prm.authorization_servers, [PUBLIC]);
  assert.equal(prm.resource, `${PUBLIC}/mcp`);

  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.equal(as.token_endpoint, `${PUBLIC}/oauth/token`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("full sign-in: register, consent with the admin token, PKCE exchange, then /mcp works", async () => {
  const { status, json: client } = await register();
  assert.equal(status, 201);

  const page = await fetch(
    `${base}/oauth/authorize?` +
      new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge: "x", code_challenge_method: "S256" }),
  );
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes("ChatGPT &lt;script&gt;"), "client name is escaped");
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const tokens = await signIn(client.client_id);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal((await mcp(tokens.access_token)).status, 200);
  assert.equal((await mcp("not-a-token")).status, 401);
});

test("a wrong admin token gets no code, and the redirect carries state and iss", async () => {
  const { json: client } = await register();
  const { challenge } = pkce();
  const wrong = await authorize(client.client_id, challenge, "nope");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("location"), null);

  const ok = await authorize(client.client_id, challenge);
  assert.equal(ok.status, 302);
  const back = new URL(ok.headers.get("location")!);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), "xyz");
  assert.equal(back.searchParams.get("iss"), PUBLIC);
});

test("codes are single use and need the matching PKCE verifier", async () => {
  const { json: client } = await register();
  const { verifier, challenge } = pkce();
  const code = new URL((await authorize(client.client_id, challenge)).headers.get("location")!).searchParams.get("code")!;
  const exchange = (v: string) =>
    fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, code_verifier: v, redirect_uri: REDIRECT, client_id: client.client_id }));

  const bad = await exchange("wrong-verifier");
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as Record<string, string>).error, "invalid_grant");
  // The failed attempt burned the code, so even the right verifier is refused now.
  assert.equal((await exchange(verifier)).status, 400);
});

test("refresh tokens rotate: the old one stops working", async () => {
  const { json: client } = await register();
  const first = await signIn(client.client_id);
  const refresh = (t: string) => fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: t, client_id: client.client_id }));

  const second = await refresh(first.refresh_token);
  assert.equal(second.status, 200);
  const next = (await second.json()) as Record<string, string>;
  assert.equal((await mcp(next.access_token)).status, 200);
  assert.equal((await refresh(first.refresh_token)).status, 400);
});

test("confidential clients must present their secret", async () => {
  const { json: client } = await register({ token_endpoint_auth_method: "client_secret_post" });
  assert.ok(client.client_secret);
  const { verifier, challenge } = pkce();
  const code = new URL((await authorize(client.client_id, challenge)).headers.get("location")!).searchParams.get("code")!;
  const noSecret = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: client.client_id }));
  assert.equal(noSecret.status, 401);
});

test("only https or loopback redirect URIs can be registered", async () => {
  assert.equal((await register({ redirect_uris: ["http://evil.example/cb"] })).status, 400);
  assert.equal((await register({ redirect_uris: ["javascript:alert(1)"] })).status, 400);
  assert.ok(allowedRedirect("http://127.0.0.1:3000/cb"));
  assert.ok(!allowedRedirect("https://x.example/cb#frag"));
});

test("oauth revoke signs out a running server's clients", async () => {
  const { json: client } = await register();
  const tokens = await signIn(client.client_id);
  assert.equal((await mcp(tokens.access_token)).status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(revokeAllOAuth(homeDir) >= 1);
  assert.equal((await mcp(tokens.access_token)).status, 401);
});

test("locks the consent page after repeated wrong admin tokens", async () => {
  const { json: client } = await register();
  const { challenge } = pkce();
  for (let i = 0; i < 5; i++) await authorize(client.client_id, challenge, `wrong-${i}`);
  const locked = await authorize(client.client_id, challenge);
  assert.equal(locked.status, 401);
  assert.match(await locked.text(), /Too many wrong tries/);
});

test("refuses to start OAuth without an admin token or with a plain-http public address", () => {
  const { gov } = setup();
  delete process.env.PURSESTRING_ADMIN_TOKEN;
  assert.throws(() => startHttp(gov, 0, "127.0.0.1", { quiet: true, publicUrl: PUBLIC }), /PURSESTRING_ADMIN_TOKEN/);
  process.env.PURSESTRING_ADMIN_TOKEN = ADMIN;
  assert.throws(() => startHttp(gov, 0, "127.0.0.1", { quiet: true, publicUrl: "http://example.com" }), /https/);
});
