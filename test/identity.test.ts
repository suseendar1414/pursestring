import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parsePolicy } from "../src/config.js";
import { startHttp } from "../src/http.js";
import { AgentKeys } from "../src/identity.js";
import { createMcpServer } from "../src/server.js";
import { intent, POLICY, setup } from "./helpers.js";

const SUPPORT_KEY = "ps_agent_support_0123456789";
const INVOICE_KEY = "ps_agent_invoice_9876543210";
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

function keyedPolicy(extra: Record<string, unknown> = {}) {
  return {
    ...POLICY,
    agents: {
      keys: [
        { agent_id: "support-bot", key_sha256: hex(SUPPORT_KEY) },
        { agent_id: "invoice-bot", key_sha256: hex(INVOICE_KEY) },
      ],
      ...extra,
    },
  };
}

type Call = (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; data: Record<string, any> }>;

function caller(client: Client): Call {
  return async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: JSON.parse((r.content as { text: string }[])[0].text) };
  };
}

/** One in-process MCP connection on a shared governance, as the stdio server builds it. */
async function connect(gov: ReturnType<typeof setup>["gov"], agent_id?: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(gov, undefined, { agent_id }).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return caller(client);
}

const auditEvents = (dir: string) =>
  readFileSync(join(dir, "decisions.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { event: string; [k: string]: unknown });

test("no keys configured: agent_id is taken as given, as before", async () => {
  const { gov } = setup();
  const call = await connect(gov);
  const sub = await call("submit_purchase_intent", intent({ agent_id: "anyone" }));
  assert.equal(sub.isError, false);
  assert.equal(sub.data.status, "approved");
});

test("policy: key_sha256 or key_env, exactly one, and unique agent ids", () => {
  assert.throws(() => parsePolicy({ agents: { keys: [{ agent_id: "a" }] } }), /exactly one of key_sha256 or key_env/);
  assert.throws(() => parsePolicy({ agents: { keys: [{ agent_id: "a", key_sha256: "abc" }] } }), /64 hex/);
  assert.throws(
    () => parsePolicy({ agents: { keys: [{ agent_id: "a", key_env: "A" }, { agent_id: "a", key_env: "B" }] } }),
    /listed once/,
  );
  const p = parsePolicy(keyedPolicy());
  assert.equal(new AgentKeys(p).required, true, "require_key defaults to on once keys are listed");
  assert.equal(new AgentKeys(parsePolicy(keyedPolicy({ require_key: false }))).required, false);
});

test("key_env: the key comes from the environment, and an unset variable still reserves the id", () => {
  const p = parsePolicy({ agents: { keys: [{ agent_id: "ops-bot", key_env: "OPS_KEY" }, { agent_id: "x-bot", key_env: "X_KEY" }] } });
  const keys = new AgentKeys(p, { OPS_KEY: "secret-ops" });
  assert.equal(keys.resolve("secret-ops"), "ops-bot");
  assert.equal(keys.resolve("wrong"), undefined);
  assert.equal(keys.resolve(""), undefined);
  assert.deepEqual(keys.missing, ["x-bot"]);
  assert.equal(keys.isKeyed("x-bot"), true);
});

test("a verified agent spends under its own id and can't claim another", async () => {
  const { gov, dir } = setup(keyedPolicy());
  const call = await connect(gov, "support-bot");
  const ok = await call("submit_purchase_intent", intent({ agent_id: "support-bot" }));
  assert.equal(ok.data.status, "approved");
  assert.equal(gov.store.get(ok.data.intent_id)!.intent.agent_id, "support-bot");

  const spoof = await call("submit_purchase_intent", intent({ agent_id: "invoice-bot", task_id: "103" }));
  assert.equal(spoof.isError, true);
  assert.equal(spoof.data.error, "agent_identity_mismatch");
  assert.match(spoof.data.message, /verified as agent "support-bot"/);
  assert.equal(gov.store.list(() => true).length, 1, "the spoofed intent was never created");

  const dry = await call("check_policy_compliance", intent({ agent_id: "invoice-bot" }));
  assert.equal(dry.data.error, "agent_identity_mismatch", "a dry run can't read another agent's budget either");

  const refused = auditEvents(dir).filter((e) => e.event === "agent_identity_refused");
  assert.equal(refused.length, 2);
  assert.equal(refused[0].claimed_agent, "invoice-bot");
  assert.equal(refused[0].verified_agent, "support-bot");
});

test("a verified agent can't get a card for, pay, or read another agent's intent", async () => {
  const { gov } = setup(keyedPolicy());
  const invoice = await connect(gov, "invoice-bot");
  const support = await connect(gov, "support-bot");
  const sub = await invoice("submit_purchase_intent", intent({ agent_id: "invoice-bot" }));
  assert.equal(sub.data.status, "approved");

  for (const tool of ["request_ephemeral_card", "send_payment", "get_intent_status"]) {
    const r = await support(tool, { intent_id: sub.data.intent_id });
    assert.equal(r.isError, true, tool);
    assert.equal(r.data.error, "agent_identity_mismatch", tool);
    assert.doesNotMatch(r.data.message, /invoice-bot/, "the owner's id isn't revealed");
  }
  assert.equal(gov.store.get(sub.data.intent_id)!.status, "approved", "no card was issued");

  const card = await invoice("request_ephemeral_card", { intent_id: sub.data.intent_id });
  assert.equal(card.isError, false);
});

test("require_key on (the default with keys): an unkeyed caller is refused", async () => {
  const { gov } = setup(keyedPolicy());
  const anon = await connect(gov);
  const r = await anon("submit_purchase_intent", intent({ agent_id: "new-bot" }));
  assert.equal(r.data.error, "agent_key_required");
  assert.match(r.data.message, /PURSESTRING_AGENT_KEY/);
});

test("require_key: false lets unkeyed agents run, but not as a keyed id or on a keyed agent's intents", async () => {
  const { gov } = setup(keyedPolicy({ require_key: false }));
  const anon = await connect(gov);
  const free = await anon("submit_purchase_intent", intent({ agent_id: "new-bot" }));
  assert.equal(free.data.status, "approved");
  assert.equal((await anon("request_ephemeral_card", { intent_id: free.data.intent_id })).isError, false);

  const borrow = await anon("submit_purchase_intent", intent({ agent_id: " support-bot ", task_id: "104" }));
  assert.equal(borrow.data.error, "agent_key_required");

  const support = await connect(gov, "support-bot");
  const theirs = await support("submit_purchase_intent", intent({ agent_id: "support-bot", task_id: "105" }));
  const grab = await anon("request_ephemeral_card", { intent_id: theirs.data.intent_id });
  assert.equal(grab.data.error, "agent_key_required");
});

test("the kill switch and daily budget follow the verified id", async () => {
  const { gov } = setup({ ...keyedPolicy(), hard_limits: { per_agent_daily_budget: 20 } });
  const support = await connect(gov, "support-bot");
  const invoice = await connect(gov, "invoice-bot");

  await gov.halt({ agent_id: "support-bot", reason: "test", by: "t", via: "cli" });
  const halted = await support("submit_purchase_intent", intent({ agent_id: "support-bot" }));
  assert.equal(halted.data.status, "denied");
  // Halted support-bot can't dodge the halt by calling itself invoice-bot.
  const dodge = await support("submit_purchase_intent", intent({ agent_id: "invoice-bot" }));
  assert.equal(dodge.data.error, "agent_identity_mismatch");

  const first = await invoice("submit_purchase_intent", intent({ agent_id: "invoice-bot", amount: 15 }));
  assert.equal(first.data.status, "approved");
  await invoice("request_ephemeral_card", { intent_id: first.data.intent_id });
  const second = await invoice("submit_purchase_intent", intent({ agent_id: "invoice-bot", task_id: "106", amount: 15 }));
  assert.equal(second.data.status, "pending_approval", "15 + 15 is over invoice-bot's 20 budget");
});

test("HTTP /mcp: the agent key header or bearer names the agent; a wrong key is 401", async () => {
  const { gov } = setup(keyedPolicy());
  const server = startHttp(gov, 0, "127.0.0.1", { quiet: true });
  await new Promise((r) => server.once("listening", r));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const http = async (headers: Record<string, string>) => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    return caller(client);
  };
  try {
    const viaHeader = await http({ "X-PurseString-Agent-Key": SUPPORT_KEY });
    const ok = await viaHeader("submit_purchase_intent", intent({ agent_id: "support-bot" }));
    assert.equal(ok.data.status, "approved");
    const spoof = await viaHeader("submit_purchase_intent", intent({ agent_id: "invoice-bot" }));
    assert.equal(spoof.data.error, "agent_identity_mismatch");

    const viaBearer = await http({ Authorization: `Bearer ${INVOICE_KEY}` });
    assert.equal((await viaBearer("submit_purchase_intent", intent({ agent_id: "invoice-bot" }))).data.status, "approved");

    const anon = await http({});
    assert.equal((await anon("submit_purchase_intent", intent({ agent_id: "invoice-bot" }))).data.error, "agent_key_required");

    const bad = await fetch(url, {
      method: "POST",
      headers: { "X-PurseString-Agent-Key": "not-a-key", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(bad.status, 401);
  } finally {
    server.close();
  }
});

test("HTTP /mcp with PURSESTRING_TOKEN: an agent key also signs in, an unknown bearer doesn't", async () => {
  const saved = process.env.PURSESTRING_TOKEN;
  process.env.PURSESTRING_TOKEN = "shared-mcp-token";
  const { gov } = setup(keyedPolicy({ require_key: false }));
  const server = startHttp(gov, 0, "127.0.0.1", { quiet: true });
  try {
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const post = (auth: string) =>
      fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    assert.notEqual((await post(SUPPORT_KEY)).status, 401);
    assert.notEqual((await post("shared-mcp-token")).status, 401);
    assert.equal((await post("guess")).status, 401);
  } finally {
    server.close();
    if (saved === undefined) delete process.env.PURSESTRING_TOKEN;
    else process.env.PURSESTRING_TOKEN = saved;
  }
});
