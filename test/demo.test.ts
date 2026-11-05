import assert from "node:assert/strict";
import { test } from "node:test";
import { Demo } from "../src/demo.js";

const byStatus = (d: Demo) => d.state().intents.map((i) => `${i.what}:${i.status}`);

test("the demo agent's small purchase is paid and the injected one can't reach a stranger", async () => {
  const d = await new Demo().reset();
  await d.run("buy-small");
  assert.deepEqual(byStatus(d), ["pay pdfocr.io:paid"]);
  await d.run("buy-injected");
  const injected = d.state().intents[1];
  assert.equal(injected.status, "pending_approval");
  await d.decide(injected.intent_id, true);
  assert.equal(d.state().intents[1].status, "approved", "approved, but there's no payee on file, so nothing is paid");
  assert.match(d.entries.map((e) => e.text).join("\n"), /No payee on file for pay-me-now\.xyz/);
});

test("the demo pauses a large refund, runs it once on approval and refuses a huge one", async () => {
  const d = await new Demo().reset();
  await d.run("refund-small");
  assert.deepEqual(byStatus(d), ["create_refund:executed"]);
  assert.equal(d.entries.filter((e) => e.actor === "paypal").length, 1, "the retried refund never reaches PayPal");
  await d.run("refund-large");
  const id = d.state().intents[1].intent_id;
  await d.decide(id, true);
  await d.run("refund-huge");
  assert.deepEqual(byStatus(d), ["create_refund:executed", "create_refund:executed", "create_refund:denied"]);
  await d.reset();
  assert.equal(d.state().intents.length, 0);
});
