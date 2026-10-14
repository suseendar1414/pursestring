import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GovernanceError } from "../src/governance.js";
import { intent, setup } from "./helpers.js";

test("double-charge loop: retries return the same intent and the same card", async () => {
  const { gov, issuedCount } = setup();
  const first = await gov.submitIntent(intent());
  assert.equal(first.record.status, "approved");
  const card1 = await gov.requestCard(first.record.intent_id);
  assert.equal(card1.replayed, false);

  // Checkout hung; the agent starts over with the same intent.
  const again = await gov.submitIntent(intent({ task_goal: "Parse invoice PDF for task #102, retrying" }));
  assert.equal(again.deduplicated, true);
  assert.equal(again.record.intent_id, first.record.intent_id);
  const card2 = await gov.requestCard(again.record.intent_id);
  assert.equal(card2.replayed, true);
  assert.equal(card2.card.pan, card1.card.pan);
  assert.equal(card2.card.cvv, card1.card.cvv);
  assert.equal(issuedCount(), 1);
});

test("recurring spend pauses, pings, and only issues after a human approves", async () => {
  const { gov, pinged } = setup();
  const { record } = await gov.submitIntent(intent({ is_recurring: true }));
  assert.equal(record.status, "pending_approval");
  assert.equal(pinged.length, 1);
  await assert.rejects(gov.requestCard(record.intent_id), (e: GovernanceError) => e.code === "pending_approval");

  // A duplicate submit while pending must not ping Slack again.
  await gov.submitIntent(intent({ is_recurring: true }));
  assert.equal(pinged.length, 1);

  gov.decide(record.intent_id, true, "alice");
  const { card } = await gov.requestCard(record.intent_id);
  assert.equal(card.single_use, false, "approved recurring spend gets a merchant-locked card");
});

test("denied intents never get a card", async () => {
  const { gov } = setup();
  const { record } = await gov.submitIntent(intent({ amount: 60 }));
  gov.decide(record.intent_id, false, "bob", "use the free tier");
  await assert.rejects(gov.requestCard(record.intent_id), (e: GovernanceError) => e.code === "denied");
  const blocked = await gov.submitIntent(intent({ vendor_domain: "slots.casino", amount: 5 }));
  assert.equal(blocked.record.status, "denied");
});

test("get_intent_status waits for a human decision", async () => {
  const { gov } = setup();
  const { record } = await gov.submitIntent(intent({ vendor_domain: "new-vendor.dev" }));
  setTimeout(() => gov.decide(record.intent_id, true, "carol"), 300);
  const t0 = Date.now();
  const rec = await gov.getStatus(record.intent_id, 5);
  assert.equal(rec.status, "approved");
  assert.ok(Date.now() - t0 < 4000);
});

test("auto-approvals are re-checked against the daily budget at issue time", async () => {
  const { gov } = setup({ vendors: { allowlist: ["pdfocr.io"] }, hard_limits: { per_agent_daily_budget: 25 } });
  const a = await gov.submitIntent(intent({ task_id: "1" }));
  const b = await gov.submitIntent(intent({ task_id: "2" }));
  assert.equal(b.record.status, "approved");
  await gov.requestCard(a.record.intent_id);
  await assert.rejects(gov.requestCard(b.record.intent_id), (e: GovernanceError) => e.code === "pending_approval");
});

test("decision log records the reasoning tree and never the card number", async () => {
  const { gov, store } = setup();
  const { record } = await gov.submitIntent(intent({ reasoning: ["PyPDF2 returned empty text", "pdfocr.io has pay-per-file"] }));
  const { card } = await gov.requestCard(record.intent_id);
  await gov.requestCard(record.intent_id);
  const log = readFileSync(store.auditPath, "utf8");
  const events = log.trim().split("\n").map((l) => JSON.parse(l).event);
  assert.deepEqual(events, ["intent_submitted", "card_issued", "card_replayed"]);
  assert.ok(log.includes("PyPDF2 returned empty text"));
  assert.ok(!log.includes(card.pan));
  assert.ok(!readFileSync(store.statePath, "utf8").includes(card.pan));
});
