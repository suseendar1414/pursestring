import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { intent, setup } from "./helpers.js";

async function connect() {
  const { gov } = setup();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(gov).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: JSON.parse((r.content as { text: string }[])[0].text) };
  };
  return { client, call };
}

test("exposes the governance tools", async () => {
  const { client } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["check_policy_compliance", "get_intent_status", "request_ephemeral_card", "submit_purchase_intent"]);
});

test("agent flow over MCP: check, submit, card, retry", async () => {
  const { call } = await connect();
  const check = await call("check_policy_compliance", intent());
  assert.equal(check.data.decision, "auto_approve");

  const sub = await call("submit_purchase_intent", intent());
  assert.equal(sub.data.status, "approved");

  const card = await call("request_ephemeral_card", { intent_id: sub.data.intent_id });
  assert.equal(card.isError, false);
  assert.match(card.data.card.number, /^4000/);

  const retry = await call("request_ephemeral_card", { intent_id: sub.data.intent_id });
  assert.equal(retry.data.replayed, true);
  assert.equal(retry.data.card.number, card.data.card.number);
});

test("pending intents return a tool error that tells the agent to wait", async () => {
  const { call } = await connect();
  const sub = await call("submit_purchase_intent", intent({ is_recurring: true }));
  assert.equal(sub.data.status, "pending_approval");
  const card = await call("request_ephemeral_card", { intent_id: sub.data.intent_id });
  assert.equal(card.isError, true);
  assert.equal(card.data.error, "pending_approval");
});
