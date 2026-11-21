import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePolicy, type Config } from "../src/config.js";
import { Rails } from "../src/adapters/index.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { Governance } from "../src/governance.js";
import { Store } from "../src/store.js";
import { intent, POLICY, setup } from "./helpers.js";

const FAST = {
  ...POLICY,
  hard_limits: { per_agent_daily_budget: 10_000, velocity: { max_intents: 3, window_minutes: 10 } },
  kill_switch: { loop_detection: { enabled: false } },
};
const VENDORS = ["pdfocr.io", "api.openai.com", "example.org", "pdfocr.io"];

test("the intent past the limit is denied, across any vendors", async () => {
  const { gov } = setup(FAST);
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const r = await gov.submitIntent(intent({ task_id: `t${i}`, vendor_domain: VENDORS[i], amount: 1 + i }));
    statuses.push(r.record.status);
    assert.ok(r.record.evaluation.rules.some((x) => x.rule === "hard_limits.velocity" && x.passed));
  }
  // example.org isn't allowlisted, so it waits for a human, but it still counts.
  assert.deepEqual(statuses, ["approved", "approved", "pending_approval"]);

  const fourth = await gov.submitIntent(intent({ task_id: "t3", vendor_domain: "pdfocr.io", amount: 7 }));
  assert.equal(fourth.record.status, "denied");
  assert.equal(fourth.record.evaluation.rules[0].rule, "hard_limits.velocity");
  assert.match(fourth.record.evaluation.summary, /velocity limit: invoice-bot already submitted 3 spend intents in the last 10 minutes/);

  // Another agent has its own window.
  assert.equal((await gov.submitIntent(intent({ agent_id: "other-bot", task_id: "o1" }))).record.status, "approved");
  // A velocity denial is not a halt: nothing already approved is frozen.
  assert.equal(gov.activeHalts().length, 0);
});

test("retries of the same intent don't count", async () => {
  const { gov } = setup(FAST);
  for (let i = 0; i < 10; i++) {
    const r = await gov.submitIntent(intent({ task_id: "same" }));
    assert.equal(r.record.status, "approved");
  }
  assert.equal((await gov.submitIntent(intent({ task_id: "b", amount: 2 }))).record.status, "approved");
  assert.equal((await gov.submitIntent(intent({ task_id: "c", amount: 3 }))).record.status, "approved");
  assert.equal((await gov.submitIntent(intent({ task_id: "d", amount: 4 }))).record.status, "denied");
});

test("it's a rolling window: old intents age out, and refused ones don't hold the window shut", async () => {
  const { gov, store } = setup(FAST);
  const first = await gov.submitIntent(intent({ task_id: "1", amount: 1 }));
  await gov.submitIntent(intent({ task_id: "2", amount: 2 }));
  await gov.submitIntent(intent({ task_id: "3", amount: 3 }));
  for (const t of ["4", "5", "6"]) assert.equal((await gov.submitIntent(intent({ task_id: t, amount: 4 }))).record.status, "denied");

  // Move the first intent to just outside the window.
  store.transact((intents, now) => {
    intents[first.record.intent_id].created_at = new Date(now.getTime() - 10 * 60_000 - 1).toISOString();
  });
  assert.equal((await gov.submitIntent(intent({ task_id: "7", amount: 5 }))).record.status, "approved");
  assert.equal((await gov.submitIntent(intent({ task_id: "8", amount: 6 }))).record.status, "denied");
});

test("the count is read under the store lock, so two server processes share one limit", async () => {
  const { gov, dir } = setup(FAST);
  const config: Config = { policy: parsePolicy(FAST), policyPath: null, homeDir: dir, env: {} };
  const second = new Governance(config, new Store(dir), new Rails(config, { mock: new MockAdapter() }), {
    approvalRequested: async () => {},
  });
  const results = await Promise.all(
    [0, 1, 2, 3, 4, 5].map((i) => (i % 2 ? gov : second).submitIntent(intent({ task_id: `p${i}`, amount: 1 + i }))),
  );
  const approved = results.filter((r) => r.record.status === "approved").length;
  assert.equal(approved, 3);
  assert.equal(results.filter((r) => r.record.status === "denied").length, 3);
});

test("check_policy_compliance shows the limit without using it up", async () => {
  const { gov } = setup(FAST);
  for (const t of ["1", "2"]) await gov.submitIntent(intent({ task_id: t, amount: Number(t) }));
  for (let i = 0; i < 5; i++) {
    const dry = gov.checkCompliance(intent({ task_id: "3", amount: 3 }));
    assert.equal(dry.evaluation.decision, "auto_approve");
  }
  await gov.submitIntent(intent({ task_id: "3", amount: 3 }));
  const dry = gov.checkCompliance(intent({ task_id: "4", amount: 4 }));
  assert.equal(dry.evaluation.decision, "deny");
  assert.equal(dry.evaluation.rules[0].rule, "hard_limits.velocity");
});

test("the limit can be turned off, and defaults to 20 intents in 10 minutes", async () => {
  const { gov } = setup({ ...FAST, hard_limits: { per_agent_daily_budget: 10_000, velocity: { enabled: false, max_intents: 1 } } });
  for (let i = 0; i < 5; i++) assert.equal((await gov.submitIntent(intent({ task_id: `t${i}`, amount: 1 + i }))).record.status, "approved");
  assert.deepEqual(parsePolicy({}).hard_limits.velocity, { enabled: true, max_intents: 20, window_minutes: 10 });
});

test("loop detection still halts a loop that also hits the velocity limit", async () => {
  const { gov } = setup({ ...FAST, kill_switch: { loop_detection: { max_similar: 4 } } });
  for (const t of ["1", "2", "3"]) await gov.submitIntent(intent({ task_id: t }));
  const r = await gov.submitIntent(intent({ task_id: "4" }));
  assert.equal(r.record.status, "denied");
  assert.equal(r.record.evaluation.rules[0].rule, "kill_switch.loop_detection");
  assert.ok(r.record.evaluation.rules.some((x) => x.rule === "hard_limits.velocity" && !x.passed));
  assert.equal(gov.activeHalts().length, 1);
});
