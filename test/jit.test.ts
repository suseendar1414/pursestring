import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { GovernanceError } from "../src/governance.js";
import { startHttp } from "../src/http.js";
import { signStandardWebhook, verifyStandardWebhook } from "../src/webhooks.js";
import { intent, POLICY, setup } from "./helpers.js";

async function issued(policy: Record<string, unknown> = POLICY, overrides = {}) {
  const ctx = setup(policy);
  const { record } = await ctx.gov.submitIntent(intent(overrides));
  if (record.status === "pending_approval") ctx.gov.decide(record.intent_id, true, "alice");
  const { card } = await ctx.gov.requestCard(record.intent_id);
  return { ...ctx, record, card };
}

test("approves a charge that matches the intent, then refuses a second use", async () => {
  const { gov, card } = await issued();
  const first = gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO*INVOICE" });
  assert.equal(first.code, "approved");
  const second = gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO*INVOICE" });
  assert.equal(second.code, "already_used");
});

test("declines over the approved amount, honouring the tolerance", async () => {
  const strict = await issued();
  assert.equal(strict.gov.authorize({ card_token: strict.card.token, amount: 15.5, merchant: "x" }).code, "over_amount");
  const lenient = await issued({ ...POLICY, jit: { tolerance_percent: 5 } });
  assert.equal(lenient.gov.authorize({ card_token: lenient.card.token, amount: 15.5, merchant: "x" }).code, "approved");
});

test("declines unknown cards and, when required, the wrong merchant", async () => {
  const { gov, card } = await issued({ ...POLICY, jit: { require_merchant_match: true } });
  assert.equal(gov.authorize({ card_token: "nope", amount: 1, merchant: "x" }).code, "unknown_card");
  assert.equal(gov.authorize({ card_token: card.token, amount: 15, merchant: "SKETCHY SHOP LLC" }).code, "merchant_mismatch");
  assert.equal(gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO SAN FRANCISCO" }).code, "approved");
});

test("recurring cards are capped per month, not per charge", async () => {
  const { gov, card } = await issued(POLICY, { is_recurring: true, amount: 15 });
  assert.equal(card.single_use, false);
  assert.equal(card.expires_at, undefined, "subscriptions don't expire after minutes");
  assert.equal(gov.authorize({ card_token: card.token, amount: 10, merchant: "pdfocr" }).code, "approved");
  assert.equal(gov.authorize({ card_token: card.token, amount: 5, merchant: "pdfocr" }).code, "approved");
  assert.equal(gov.authorize({ card_token: card.token, amount: 1, merchant: "pdfocr" }).code, "over_amount");
});

test("single-use cards expire after the TTL: declined, not replayed, and closed at the rail", async () => {
  const { gov, card, record, adapter } = await issued({ ...POLICY, cards: { ttl_minutes: 0.001 } });
  assert.ok(card.expires_at);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(gov.authorize({ card_token: card.token, amount: 15, merchant: "pdfocr" }).code, "card_expired");
  await assert.rejects(gov.requestCard(record.intent_id), (e: GovernanceError) => e.code === "card_expired");
  assert.equal(await gov.sweepExpiredCards(), 1);
  assert.ok(adapter.closed.has(card.token));
  assert.equal(await gov.sweepExpiredCards(), 0, "sweeping is idempotent");
});

test("decisions are fast enough for a real-time authorization budget", async () => {
  const { gov, card } = await issued();
  for (let i = 0; i < 50; i++) await gov.submitIntent(intent({ task_id: `bulk-${i}`, vendor_domain: "other.dev" }));
  const d = gov.authorize({ card_token: card.token, amount: 15, merchant: "pdfocr" });
  assert.ok(d.latency_ms < 200, `took ${d.latency_ms} ms`);
});

test("standard webhook signatures verify, and tampering or stale timestamps fail", () => {
  const secret = "whsec_" + Buffer.from("test-secret-key-32-bytes-long!!!").toString("base64");
  const body = '{"token":"t"}';
  const now = 1_800_000_000;
  const sig = signStandardWebhook(secret, "msg_1", now, body);
  const h = { "webhook-id": "msg_1", "webhook-timestamp": String(now), "webhook-signature": `v1,bogus ${sig}` };
  assert.ok(verifyStandardWebhook(secret, h, body, 300, now));
  assert.ok(!verifyStandardWebhook(secret, h, body + " ", 300, now));
  assert.ok(!verifyStandardWebhook(secret, h, body, 300, now + 3600));
  assert.ok(!verifyStandardWebhook(secret, { ...h, "webhook-signature": undefined }, body, 300, now));
});

test("Lithic ASA endpoint answers with the request token and an ASA result", async () => {
  const secret = "whsec_" + Buffer.from("another-test-secret-for-lithic!!").toString("base64");
  const { gov, card } = await issued();
  gov.config.env.lithicWebhookSecret = secret;
  const server = startHttp(gov, 0, "127.0.0.1", { quiet: true });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const call = async (payload: unknown, signed = true) => {
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signed) Object.assign(headers, { "webhook-id": "m1", "webhook-timestamp": String(ts), "webhook-signature": signStandardWebhook(secret, "m1", ts, body) });
    const res = await fetch(`http://127.0.0.1:${port}/jit/lithic`, { method: "POST", headers, body });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  try {
    const asa = { token: "asa_1", card_token: card.token, amount: 1500, merchant: { descriptor: "PDFOCR.IO", mcc: "5734" } };
    assert.equal((await call(asa, false)).status, 401);
    assert.deepEqual((await call(asa)).json, { token: "asa_1", result: "APPROVED" });
    assert.deepEqual((await call({ ...asa, token: "asa_2" })).json, { token: "asa_2", result: "VELOCITY_EXCEEDED" });
    const other = await call({ token: "asa_3", card: { token: "unknown" }, amount: 100, merchant: { descriptor: "X" } });
    assert.equal(other.json.result, "CARD_PAUSED");
  } finally {
    server.close();
  }
});
