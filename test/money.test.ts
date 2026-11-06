import assert from "node:assert/strict";
import { test } from "node:test";
import { GovernanceError } from "../src/governance.js";
import { exponent, formatMajor, formatMinor, isWholeMinor, toMajor, toMinor } from "../src/money.js";
import { spentToday, idempotencyKey } from "../src/store.js";
import { intent, POLICY, setup } from "./helpers.js";

test("each currency uses its own minor unit", () => {
  assert.equal(exponent("USD"), 2);
  assert.equal(exponent("jpy"), 0);
  assert.equal(exponent("KWD"), 3);
  assert.equal(toMinor(49.99, "USD"), 4999);
  assert.equal(toMinor(1500, "JPY"), 1500);
  assert.equal(toMinor(1.234, "KWD"), 1234);
  assert.equal(toMajor(4999, "USD"), 49.99);
  assert.equal(formatMinor(4999, "USD"), "49.99");
  assert.equal(formatMinor(5, "USD"), "0.05");
  assert.equal(formatMinor(-5, "USD"), "-0.05");
  assert.equal(formatMinor(1500, "JPY"), "1500");
  assert.equal(formatMinor(1234, "KWD"), "1.234");
  assert.equal(formatMajor(0.1 + 0.2, "USD"), "0.30");
  assert.ok(isWholeMinor(15.5, "USD"));
  assert.ok(!isWholeMinor(15.001, "USD"));
  assert.ok(!isWholeMinor(1500.5, "JPY"));
  assert.ok(isWholeMinor(1.234, "KWD"));
});

test("a hundred 0.01 spends add up to exactly 1.00", () => {
  let floats = 0;
  let cents = 0;
  for (let i = 0; i < 100; i++) {
    floats += 0.01;
    cents += toMinor(0.01, "USD");
  }
  assert.notEqual(floats, 1, "plain floats drift");
  assert.equal(cents, 100);
});

test("0.10 then 0.20 fits a 0.30 daily budget exactly", async () => {
  const policy = { ...POLICY, hard_limits: { max_amount: 1000, per_agent_daily_budget: 0.3 } };
  const { gov, store } = setup(policy);
  const first = await gov.submitIntent(intent({ amount: 0.1, task_id: "a" }));
  await gov.requestCard(first.record.intent_id);
  // In floats 0.1 + 0.2 is 0.30000000000000004, which used to read as over a 0.30 budget.
  const second = await gov.submitIntent(intent({ amount: 0.2, task_id: "b" }));
  assert.equal(second.record.status, "approved", second.record.evaluation.summary);
  await gov.requestCard(second.record.intent_id);
  assert.equal(store.transact((i, now) => spentToday(i, "invoice-bot", now)), 0.3);
  const third = await gov.submitIntent(intent({ amount: 0.01, task_id: "c" }));
  assert.equal(third.record.status, "pending_approval", "one cent over the budget needs a human");
  assert.match(third.record.evaluation.summary, /this makes 0\.31 USD of 0\.30 USD/);
});

test("ten 0.10 charges on a recurring card fill a 1.00 monthly cap exactly", async () => {
  const { gov } = setup(POLICY);
  const { record } = await gov.submitIntent(intent({ amount: 1, is_recurring: true }));
  gov.decide(record.intent_id, true, "alice");
  const { card } = await gov.requestCard(record.intent_id);
  for (let i = 0; i < 10; i++) {
    assert.equal(gov.authorize({ card_token: card.token, amount: 0.1, merchant: "PDFOCR.IO" }).code, "approved", `charge ${i + 1}`);
  }
  const over = gov.authorize({ card_token: card.token, amount: 0.01, merchant: "PDFOCR.IO" });
  assert.equal(over.code, "over_amount");
  assert.match(over.reason, /take this month to 1\.01, over the approved 1\.00 USD/);
});

test("tolerance is exact: 15% on 1.00 allows 1.15 and not 1.16", async () => {
  const policy = { ...POLICY, jit: { tolerance_percent: 15 } };
  const ok = setup(policy);
  const a = await ok.gov.submitIntent(intent({ amount: 1 }));
  const ca = await ok.gov.requestCard(a.record.intent_id);
  // 1.00 * 1.15 is 1.1499999999999999 in floats.
  assert.equal(ok.gov.authorize({ card_token: ca.card.token, amount: 1.15, merchant: "PDFOCR.IO" }).code, "approved");
  const over = setup(policy);
  const b = await over.gov.submitIntent(intent({ amount: 1 }));
  const cb = await over.gov.requestCard(b.record.intent_id);
  assert.equal(over.gov.authorize({ card_token: cb.card.token, amount: 1.16, merchant: "PDFOCR.IO" }).code, "over_amount");
});

test("refunds of 0.10 and 0.20 fully refund a 0.30 charge", async () => {
  const { gov, store } = setup(POLICY);
  const { record } = await gov.submitIntent(intent({ amount: 0.3 }));
  const { card } = await gov.requestCard(record.intent_id);
  gov.authorize({ card_token: card.token, amount: 0.3, merchant: "PDFOCR.IO" });
  await gov.recordRefund({ refund_id: "r1", amount: 0.1, card_token: card.token, source: "lithic" });
  const r = await gov.recordRefund({ refund_id: "r2", amount: 0.2, card_token: card.token, source: "lithic" });
  assert.equal(r.outcome, "credited");
  assert.equal(r.refund_status, "refunded");
  assert.equal(r.refunded_total, 0.3);
  assert.equal(store.transact((i, now) => spentToday(i, "invoice-bot", now)), 0);
  const extra = await gov.recordRefund({ refund_id: "r3", amount: 0.01, card_token: card.token, source: "lithic" });
  assert.equal(extra.outcome, "over_original");
});

const JPY = {
  ...POLICY,
  currency: "JPY",
  auto_approve: { max_amount: 3000 },
  require_approval: { over_amount: 7500 },
  hard_limits: { max_amount: 150000, per_agent_daily_budget: 30000 },
};

test("JPY: whole yen work, fractions of a yen are refused, amounts print without decimals", async () => {
  const { gov } = setup(JPY);
  const { record } = await gov.submitIntent(intent({ amount: 1500, currency: "JPY" }));
  assert.equal(record.status, "approved");
  assert.ok(record.evaluation.rules.some((r) => r.detail === "1500 JPY vs hard cap 150000 JPY"));
  await assert.rejects(gov.submitIntent(intent({ amount: 1500.5, currency: "JPY", task_id: "x" })), (e: GovernanceError) => e.code === "bad_amount");
  assert.throws(() => gov.checkCompliance(intent({ amount: 0.5, currency: "JPY" })), (e: GovernanceError) => e.code === "bad_amount");
});

test("KWD: three decimals are kept, compared and printed exactly", async () => {
  const KWD = {
    ...POLICY,
    currency: "KWD",
    auto_approve: { max_amount: 5 },
    require_approval: { over_amount: 15 },
    hard_limits: { max_amount: 300, per_agent_daily_budget: 2.469 },
  };
  const { gov } = setup(KWD);
  const a = await gov.submitIntent(intent({ amount: 1.234, currency: "KWD", task_id: "a" }));
  assert.equal(a.record.status, "approved");
  await gov.requestCard(a.record.intent_id);
  const b = await gov.submitIntent(intent({ amount: 1.235, currency: "KWD", task_id: "b" }));
  assert.equal(b.record.status, "approved", "1.234 + 1.235 is exactly the 2.469 budget");
  await gov.requestCard(b.record.intent_id);
  const c = await gov.submitIntent(intent({ amount: 0.001, currency: "KWD", task_id: "c" }));
  assert.match(c.record.evaluation.summary, /this makes 2\.470 KWD of 2\.469 KWD/);
  await assert.rejects(gov.submitIntent(intent({ amount: 1.2345, currency: "KWD", task_id: "d" })), (e: GovernanceError) => e.code === "bad_amount");
});

test("idempotency keys tell apart amounts one minor unit apart, in any currency", () => {
  const k = (amount: number, currency: string) => idempotencyKey(intent({ amount, currency }));
  assert.notEqual(k(1.231, "KWD"), k(1.232, "KWD"));
  assert.equal(k(15, "USD"), idempotencyKey(intent({ amount: 15 })), "USD keys are unchanged");
});
