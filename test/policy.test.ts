import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePolicy } from "../src/config.js";
import { domainMatches, evaluate, normalizeDomain } from "../src/policy.js";
import { idempotencyKey } from "../src/store.js";
import { intent, POLICY } from "./helpers.js";

const policy = parsePolicy(POLICY);
const run = (o = {}, spent = 0) => evaluate(policy, intent(o), { spentTodayByAgent: spent });
const failed = (o = {}, spent = 0) => run(o, spent).rules.filter((r) => !r.passed).map((r) => r.rule);

test("small one-time allowlisted spend is auto-approved", () => {
  assert.equal(run().decision, "auto_approve");
});

test("recurring spend always needs a human, even at $15", () => {
  const e = run({ is_recurring: true });
  assert.equal(e.decision, "require_approval");
  assert.ok(failed({ is_recurring: true }).includes("require_approval.recurring"));
});

test("vendor outside the allowlist needs a human", () => {
  assert.equal(run({ vendor_domain: "randomocr.biz" }).decision, "require_approval");
});

test("$20 to $50 on an allowlisted vendor is outside the auto-approve envelope", () => {
  assert.equal(run({ amount: 20 }).decision, "require_approval");
  assert.deepEqual(failed({ amount: 35 }), ["auto_approve"]);
});

test("over the approval threshold needs a human", () => {
  assert.ok(failed({ amount: 75 }).includes("require_approval.over_amount"));
});

test("blocklisted vendor and hard cap are denied outright", () => {
  assert.equal(run({ vendor_domain: "lucky.casino", amount: 5 }).decision, "deny");
  assert.equal(run({ amount: 5000 }).decision, "deny");
  assert.equal(run({ currency: "EUR" }).decision, "deny");
});

test("missing alternatives or a vague goal routes to a human", () => {
  assert.ok(failed({ alternatives_attempted: [] }).includes("intent.alternatives_attempted"));
  assert.ok(failed({ task_goal: "buy it" }).includes("intent.task_goal"));
});

test("daily budget pushes further spend to a human", () => {
  assert.ok(failed({}, 190).includes("hard_limits.per_agent_daily_budget"));
});

test("domain normalization and wildcard matching", () => {
  assert.equal(normalizeDomain("https://www.PDFocr.io/checkout?x=1"), "pdfocr.io");
  assert.ok(domainMatches("api.openai.com", "*.openai.com"));
  assert.ok(domainMatches("openai.com", "*.openai.com"));
  assert.ok(!domainMatches("evilopenai.com", "*.openai.com"));
  assert.ok(!domainMatches("pdfocr.io.evil.com", "pdfocr.io"));
});

test("idempotency key is stable across formatting and distinct across fields", () => {
  const a = idempotencyKey(intent());
  assert.equal(a, idempotencyKey(intent({ vendor_domain: "https://www.pdfocr.io/", amount: 15.0 })));
  assert.notEqual(a, idempotencyKey(intent({ amount: 15.01 })));
  assert.notEqual(a, idempotencyKey(intent({ task_id: "103" })));
  assert.notEqual(
    idempotencyKey(intent({ agent_id: "a", task_id: "bc" })),
    idempotencyKey(intent({ agent_id: "ab", task_id: "c" })),
  );
});
