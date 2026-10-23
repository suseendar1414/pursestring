import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  hashApprovalCode,
  newApprovalCode,
  normalizeApprovalCode,
  signSlackRequest,
  verifyApprovalCode,
  verifySlackSignature,
} from "../src/approvals.js";
import { GovernanceError } from "../src/governance.js";
import { startHttp } from "../src/http.js";
import { intent, POLICY, setup } from "./helpers.js";

const SLACK = { slackWebhookUrl: "https://hooks.slack.com/services/T/B/X" };

async function pending(env = SLACK, policy: unknown = POLICY) {
  const ctx = setup(policy, env);
  const { record } = await ctx.gov.submitIntent(intent({ is_recurring: true }));
  assert.equal(record.status, "pending_approval");
  return { ...ctx, id: record.intent_id, code: ctx.codes[0] };
}

test("approval codes: random, readable, and tolerant of how people type them", () => {
  const code = newApprovalCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.notEqual(newApprovalCode(), code);
  const stored = hashApprovalCode("AB0C1-DEF23");
  assert.ok(verifyApprovalCode("abOcl def23", stored));
  assert.ok(!verifyApprovalCode("AB0C1-DEF24", stored));
  assert.equal(normalizeApprovalCode(" ab-oi "), "AB01");
});

test("with Slack set up, the terminal can't approve without the code only Slack received", async () => {
  const { gov, id, code } = await pending();
  assert.ok(gov.requireCode);
  assert.ok(code, "the notifier gets the code");
  assert.throws(() => gov.decide(id, true, "agent"), (e: GovernanceError) => e.code === "code_required");
  assert.throws(() => gov.decide(id, true, "agent", undefined, { via: "cli", code: "00000-00000" }), (e: GovernanceError) => e.code === "bad_code");
  assert.equal(gov.store.get(id)?.status, "pending_approval");

  const rec = gov.decide(id, true, "alice", undefined, { via: "cli", code: code!.toLowerCase() });
  assert.equal(rec.status, "approved");
  assert.equal(rec.decided_via, "cli");
  assert.equal(rec.approval_code, undefined, "the code is single use");
});

test("five wrong codes deny the intent", async () => {
  const { gov, id } = await pending();
  for (let i = 1; i <= 4; i++) {
    assert.throws(() => gov.decide(id, true, "agent", undefined, { via: "cli", code: `0000${i}-00000` }), /tries left/);
  }
  assert.throws(() => gov.decide(id, true, "agent", undefined, { via: "cli", code: "00005-00000" }), (e: GovernanceError) => e.code === "denied");
  const rec = gov.store.get(id)!;
  assert.equal(rec.status, "denied");
  assert.equal(rec.denied_by, "policy:approval_code_attempts");
});

test("denying needs no code, and the HTTP admin API (its own token) needs none either", async () => {
  const a = await pending();
  assert.equal(a.gov.decide(a.id, false, "agent").status, "denied");
  const b = await pending();
  assert.equal(b.gov.decide(b.id, true, "alice", undefined, { via: "http" }).status, "approved");
});

test("the code never reaches the agent, the state file or the log in plain text", async () => {
  const { gov, store, id, code } = await pending();
  const status = await gov.getStatus(id);
  assert.ok(!JSON.stringify(status).includes(code!));
  assert.ok(!readFileSync(store.statePath, "utf8").includes(code!));
  gov.decide(id, true, "alice", undefined, { via: "cli", code });
  const log = readFileSync(store.auditPath, "utf8");
  assert.ok(!log.includes(code!));
  const approved = log.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.event === "human_approved");
  assert.equal(approved.via, "cli");
});

test("codes are off without Slack or Discord, and can be forced either way in policy", async () => {
  const off = await pending({} as typeof SLACK);
  assert.equal(off.code, undefined);
  assert.equal(off.gov.decide(off.id, true, "alice").status, "approved");

  const forcedOff = await pending(SLACK, { ...POLICY, approvals: { require_code: false } });
  assert.equal(forcedOff.code, undefined);

  // Forced on with nowhere to send the code: the terminal can't approve, the HTTP API still can.
  const forcedOn = await pending({} as typeof SLACK, { ...POLICY, approvals: { require_code: true } });
  assert.throws(() => forcedOn.gov.decide(forcedOn.id, true, "agent", undefined, { via: "cli", code: "x" }), /HTTP approval API/);
});

test("Slack signatures: only Slack's signing secret makes a valid request", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const body = "payload=%7B%7D";
  const now = 1_700_000_000;
  const headers = { "x-slack-request-timestamp": String(now), "x-slack-signature": signSlackRequest(secret, now, body) };
  assert.ok(verifySlackSignature(secret, headers, body, 300, now));
  assert.ok(!verifySlackSignature("wrong-secret", headers, body, 300, now));
  assert.ok(!verifySlackSignature(secret, headers, body + "x", 300, now));
  assert.ok(!verifySlackSignature(secret, headers, body, 300, now + 301), "old requests can't be replayed");
});

test("Slack buttons approve over a signed request and record who clicked", async () => {
  const secret = "slack-signing-secret-for-tests";
  const ctx = await pending({ ...SLACK, slackSigningSecret: secret } as typeof SLACK, {
    ...POLICY,
    approvals: { slack_approvers: ["U_ALICE"] },
  });
  const server = startHttp(ctx.gov, 0, "127.0.0.1", { quiet: true });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const click = async (user: string, actionId: string, signed = true) => {
    const payload = {
      type: "block_actions",
      user: { id: user, username: user.toLowerCase() },
      actions: [{ action_id: actionId, value: ctx.id }],
      response_url: "https://example.com/not-slack",
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const ts = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (signed) Object.assign(headers, { "x-slack-request-timestamp": String(ts), "x-slack-signature": signSlackRequest(secret, ts, body) });
    return (await fetch(`http://127.0.0.1:${port}/slack/actions`, { method: "POST", headers, body })).status;
  };
  try {
    assert.equal(await click("U_ALICE", "pursestring_approve", false), 401);
    assert.equal(await click("U_MALLORY", "pursestring_approve"), 200);
    assert.equal(ctx.gov.store.get(ctx.id)?.status, "pending_approval", "only listed Slack users can approve");
    assert.equal(await click("U_ALICE", "pursestring_approve"), 200);
    const rec = ctx.gov.store.get(ctx.id)!;
    assert.equal(rec.status, "approved");
    assert.equal(rec.decided_via, "slack");
    assert.equal(rec.approved_by, "slack:u_alice (U_ALICE)");
  } finally {
    server.close();
  }
});
