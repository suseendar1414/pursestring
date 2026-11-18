import assert from "node:assert/strict";
import { test } from "node:test";
import { GovernanceError } from "../src/governance.js";
import { intent, POLICY, setup } from "./helpers.js";

const LOOPY = { ...POLICY, hard_limits: { per_agent_daily_budget: 10_000 }, kill_switch: { loop_detection: { max_similar: 3 } } };

test("repeated near-identical purchases under new task IDs halt the agent", async () => {
  const { gov, store } = setup(LOOPY);
  const a = await gov.submitIntent(intent({ task_id: "1", amount: 15 }));
  const b = await gov.submitIntent(intent({ task_id: "2", amount: 16.5 })); // within 10%
  assert.equal(a.record.status, "approved");
  assert.equal(b.record.status, "approved");

  const c = await gov.submitIntent(intent({ task_id: "3", amount: 15.2 }));
  assert.equal(c.record.status, "denied");
  assert.equal(c.record.evaluation.rules[0].rule, "kill_switch.loop_detection");
  assert.match(c.record.evaluation.summary, /loop detected: 3 near-identical purchases \(pdfocr\.io/);

  // Already-approved intents can't be spent once the agent is halted.
  await assert.rejects(gov.requestCard(a.record.intent_id), (e: GovernanceError) => e.code === "halted");
  // Anything new is denied, even an unrelated purchase.
  const d = await gov.submitIntent(intent({ task_id: "4", vendor_domain: "api.openai.com", amount: 5 }));
  assert.equal(d.record.status, "denied");
  assert.equal(d.record.evaluation.rules[0].rule, "kill_switch");
  // Other agents keep working.
  const other = await gov.submitIntent(intent({ agent_id: "other-bot", task_id: "9" }));
  assert.equal(other.record.status, "approved");

  const halts = gov.activeHalts();
  assert.equal(halts.length, 1);
  assert.equal(halts[0].agent_id, "invoice-bot");
  assert.deepEqual(halts[0].intent_ids, [a.record.intent_id, b.record.intent_id, c.record.intent_id]);
  assert.ok(store.readAudit(50).some((e) => e.event === "kill_switch_tripped" && e.by === "policy:loop_detection"));
  assert.equal(store.verifyAudit().ok, true);
});

test("retries, different vendors and different amounts are not a loop", async () => {
  const { gov } = setup(LOOPY);
  for (let i = 0; i < 5; i++) {
    const r = await gov.submitIntent(intent({ task_id: "same" })); // same key: deduplicated, not new
    assert.equal(r.record.status, "approved");
  }
  await gov.submitIntent(intent({ task_id: "x1", amount: 15 }));
  await gov.submitIntent(intent({ task_id: "x2", amount: 17 })); // 2.00 apart is over 10% of 17.00
  const r = await gov.submitIntent(intent({ task_id: "x3", vendor_domain: "api.openai.com", amount: 15 }));
  assert.equal(r.record.status, "approved");
  assert.equal(gov.activeHalts().length, 0);
});

test("loop detection can be turned off", async () => {
  const { gov } = setup({ ...LOOPY, kill_switch: { loop_detection: { enabled: false, max_similar: 2 } } });
  for (let i = 0; i < 4; i++) assert.equal((await gov.submitIntent(intent({ task_id: `t${i}` }))).record.status, "approved");
});

test("a resumed agent isn't tripped again by the loop it was resumed from", async () => {
  const { gov } = setup(LOOPY);
  for (const t of ["1", "2", "3"]) await gov.submitIntent(intent({ task_id: t }));
  assert.equal(gov.activeHalts().length, 1);
  gov.resume({ agent_id: "invoice-bot", by: "maya", via: "http" });
  assert.equal(gov.activeHalts().length, 0);
  const next = await gov.submitIntent(intent({ task_id: "4" }));
  assert.equal(next.record.status, "approved");
});

test("the global kill switch stops every agent, declines card charges and keeps the first halt", async () => {
  const { gov } = setup();
  const { record } = await gov.submitIntent(intent());
  const { card } = await gov.requestCard(record.intent_id);

  const h = await gov.halt({ reason: "incident 42", by: "maya", via: "cli" });
  assert.equal(h.scope, "all");
  const again = await gov.halt({ reason: "second", by: "sam", via: "cli" });
  assert.equal(again.reason, "incident 42");

  const auth = gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO" });
  assert.equal(auth.approved, false);
  assert.equal(auth.code, "halted");
  await assert.rejects(gov.requestCard(record.intent_id), (e: GovernanceError) => e.code === "halted");
  const other = await gov.submitIntent(intent({ agent_id: "other-bot" }));
  assert.equal(other.record.status, "denied");

  // Lifting one agent's halt doesn't lift the global one.
  assert.throws(() => gov.resume({ agent_id: "other-bot", by: "maya", via: "cli" }), (e: GovernanceError) => e.code === "not_halted");
  gov.resume({ by: "maya", via: "cli" });
  assert.equal(gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO" }).approved, true);
});

test("with approval codes on, a terminal resume needs the code sent to Slack", async () => {
  const { gov } = setup(POLICY, { slackWebhookUrl: "https://hooks.slack.test/x" });
  const sent: (string | undefined)[] = [];
  gov.notifier.killSwitchTripped = async (_h, extras) => void sent.push(extras?.code);
  await gov.halt({ agent_id: "invoice-bot", reason: "suspicious", by: "maya", via: "http" });
  const code = sent[0]!;
  assert.match(code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  assert.equal(JSON.stringify(gov.activeHalts()).includes("salt"), false, "the code hash is never shown");

  assert.throws(() => gov.resume({ agent_id: "invoice-bot", by: "agent", via: "cli" }), (e: GovernanceError) => e.code === "code_required");
  assert.throws(
    () => gov.resume({ agent_id: "invoice-bot", by: "agent", via: "cli", code: "AAAAA-AAAAA" }),
    (e: GovernanceError) => e.code === "bad_code",
  );
  assert.equal(gov.activeHalts().length, 1);
  gov.resume({ agent_id: "invoice-bot", by: "maya", via: "cli", code });
  assert.equal(gov.activeHalts().length, 0);
});
