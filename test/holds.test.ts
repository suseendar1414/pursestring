import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { GovernanceError } from "../src/governance.js";
import { lithicSettlements, startHttp } from "../src/http.js";
import { spentToday } from "../src/store.js";
import { signStandardWebhook } from "../src/webhooks.js";
import { intent, POLICY, setup } from "./helpers.js";

async function issued(overrides = {}, policy: Record<string, unknown> = POLICY, env = {}) {
  const ctx = setup(policy, env);
  const { record } = await ctx.gov.submitIntent(intent(overrides));
  if (record.status === "pending_approval") ctx.gov.decide(record.intent_id, true, "alice");
  const { card } = await ctx.gov.requestCard(record.intent_id);
  const spent = () => ctx.store.transact((intents, now) => spentToday(intents, "invoice-bot", now));
  const hold = (i = 0) => ctx.store.get(record.intent_id)!.authorizations!.filter((a) => a.approved)[i];
  return { ...ctx, record, card, spent, hold };
}

test("a single-use card can be authorized again after its first hold is reversed", async () => {
  const { gov, card, hold } = await issued();
  assert.equal(gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" }).code, "approved");
  assert.equal(gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_2" }).code, "already_used");

  const r = gov.recordSettlement({ event_id: "ev_rev", kind: "release", transaction_id: "tx_1", source: "lithic" });
  assert.equal(r.outcome, "released");
  assert.equal(r.hold_status, "released");
  assert.equal(r.still_held, 0);
  assert.equal(hold(0).hold_status, "released");

  assert.equal(gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_3" }).code, "approved");
  assert.equal(
    gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_4" }).code,
    "already_used",
    "the new hold uses the card up again",
  );
});

test("a partly reversed hold still uses up a single-use card", async () => {
  const { gov, card } = await issued();
  gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
  const r = gov.recordSettlement({ event_id: "ev_part", kind: "release", transaction_id: "tx_1", amount: 5, source: "lithic" });
  assert.equal(r.still_held, 10);
  assert.equal(gov.authorize({ card_token: card.token, amount: 5, merchant: "PDFOCR.IO", transaction_id: "tx_2" }).code, "already_used");
});

test("a capture smaller than the hold counts only what was captured", async () => {
  const { gov, card, spent } = await issued();
  gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
  assert.equal(spent(), 15, "the card's limit is reserved until the charge settles");
  const r = gov.recordSettlement({ event_id: "ev_clr", kind: "capture", transaction_id: "tx_1", amount: 9.5, source: "lithic" });
  assert.equal(r.outcome, "captured");
  assert.equal(r.hold_status, "captured");
  assert.equal(r.captured, 9.5);
  assert.equal(r.still_held, 0, "capture ends the hold");
  assert.equal(spent(), 9.5);
  assert.equal(gov.authorize({ card_token: card.token, amount: 5, merchant: "PDFOCR.IO", transaction_id: "tx_2" }).code, "already_used");
});

test("refunds are measured against what was captured, not the hold", async () => {
  const { gov, card, spent } = await issued();
  gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
  gov.recordSettlement({ event_id: "ev_clr", kind: "capture", transaction_id: "tx_1", amount: 10, source: "lithic" });
  const over = await gov.recordRefund({ refund_id: "rf_1", amount: 12, card_token: card.token, source: "lithic" });
  assert.equal(over.outcome, "over_original");
  const ok = await gov.recordRefund({ refund_id: "rf_2", amount: 10, card_token: card.token, source: "lithic" });
  assert.equal(ok.refund_status, "refunded");
  assert.equal(spent(), 0);
});

test("a released hold on a single-use card keeps the limit reserved: it can still be charged", async () => {
  const { gov, card, spent } = await issued();
  gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
  gov.recordSettlement({ event_id: "ev_rev", kind: "release", transaction_id: "tx_1", source: "lithic" });
  assert.equal(spent(), 15);
});

test("on a recurring card a released hold gives its room back under the monthly cap", async () => {
  const { gov, card } = await issued({ is_recurring: true, amount: 15 });
  const charge = (amount: number, tx: string) => gov.authorize({ card_token: card.token, amount, merchant: "pdfocr", transaction_id: tx }).code;
  assert.equal(charge(15, "tx_1"), "approved");
  assert.equal(charge(15, "tx_2"), "over_amount");
  gov.recordSettlement({ event_id: "ev_exp", kind: "release", transaction_id: "tx_1", type: "AUTHORIZATION_EXPIRY", source: "lithic" });
  assert.equal(charge(15, "tx_3"), "approved");
});

test("on a recurring card a smaller capture frees the rest of the month's cap", async () => {
  const { gov, card } = await issued({ is_recurring: true, amount: 15 });
  const charge = (amount: number, tx: string) => gov.authorize({ card_token: card.token, amount, merchant: "pdfocr", transaction_id: tx }).code;
  assert.equal(charge(15, "tx_1"), "approved");
  gov.recordSettlement({ event_id: "ev_clr", kind: "capture", transaction_id: "tx_1", amount: 12, source: "lithic" });
  assert.equal(charge(3, "tx_2"), "approved");
  assert.equal(charge(1, "tx_3"), "over_amount");
});

test("the same event twice is applied once, and unknown holds change nothing", async () => {
  const { gov, card, hold } = await issued({ is_recurring: true, amount: 15 });
  gov.authorize({ card_token: card.token, amount: 15, merchant: "pdfocr", transaction_id: "tx_1" });
  gov.recordSettlement({ event_id: "ev_1", kind: "capture", transaction_id: "tx_1", amount: 6, source: "lithic" });
  const again = gov.recordSettlement({ event_id: "ev_1", kind: "capture", transaction_id: "tx_1", amount: 6, source: "lithic" });
  assert.equal(again.outcome, "duplicate");
  assert.equal(hold().captured, 6);
  const stray = gov.recordSettlement({ event_id: "ev_2", kind: "capture", transaction_id: "tx_nope", amount: 6, source: "lithic" });
  assert.equal(stray.outcome, "unmatched");
  const events = gov.store.readAudit().map((e) => e.event);
  assert.ok(events.includes("hold_captured"));
  assert.ok(events.includes("settlement_duplicate"));
  assert.ok(events.includes("settlement_unmatched"));
});

test("without a transaction ID, an event finds the hold by card only when there's exactly one open", async () => {
  const { gov, card, spent } = await issued();
  gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO" });
  const r = gov.recordSettlement({ event_id: "ev_1", kind: "capture", card_token: card.token, amount: 14, source: "http" });
  assert.equal(r.outcome, "captured");
  assert.equal(spent(), 14);

  const sub = await issued({ is_recurring: true, amount: 15, task_id: "sub" });
  sub.gov.authorize({ card_token: sub.card.token, amount: 5, merchant: "pdfocr" });
  sub.gov.authorize({ card_token: sub.card.token, amount: 5, merchant: "pdfocr" });
  const ambiguous = sub.gov.recordSettlement({ event_id: "ev_2", kind: "release", card_token: sub.card.token, source: "http" });
  assert.equal(ambiguous.outcome, "unmatched", "two open holds: refuse to guess");
});

test("bad settlement input is refused", async () => {
  const { gov } = await issued();
  const code = (fn: () => unknown) => assert.throws(fn, (e: GovernanceError) => e.code === "bad_settlement");
  code(() => gov.recordSettlement({ event_id: "", kind: "capture", transaction_id: "t", amount: 1, source: "http" }));
  code(() => gov.recordSettlement({ event_id: "e", kind: "capture", transaction_id: "t", source: "http" }));
  code(() => gov.recordSettlement({ event_id: "e", kind: "release", transaction_id: "t", amount: -1, source: "http" }));
});

test("Lithic transaction events map to captures and releases", () => {
  const got = lithicSettlements({
    payload: {
      token: "tx_1",
      card_token: "card_1",
      currency: "USD",
      events: [
        { token: "e1", type: "AUTHORIZATION", amount: 1500, result: "APPROVED" },
        { token: "e2", type: "AUTHORIZATION_REVERSAL", amount: -500, result: "APPROVED" },
        { token: "e3", type: "CLEARING", amount: 900, result: "APPROVED" },
        { token: "e4", type: "AUTHORIZATION_EXPIRY", amount: 0 },
        { token: "e5", type: "CLEARING", amount: 100, result: "DECLINED" },
        { token: "e6", type: "RETURN", amount: -300, result: "APPROVED" },
      ],
    },
  });
  assert.deepEqual(
    got.map(({ event_id, kind, amount, transaction_id }) => ({ event_id, kind, amount, transaction_id })),
    [
      { event_id: "e2", kind: "release", amount: 5, transaction_id: "tx_1" },
      { event_id: "e3", kind: "capture", amount: 9, transaction_id: "tx_1" },
      { event_id: "e4", kind: "release", amount: undefined, transaction_id: "tx_1" },
    ],
  );
});

test("Lithic end to end: ASA approves, a reversal frees the card, a re-auth clears for less", async () => {
  const asaSecret = "whsec_" + Buffer.from("asa-secret-for-holds-test-32by!!").toString("base64");
  const eventsSecret = Buffer.from("events-secret").toString("base64");
  const { gov, card, spent } = await issued({}, POLICY, { lithicWebhookSecret: asaSecret, lithicEventsSecret: eventsSecret });
  const server = startHttp(gov, 0, "127.0.0.1", { quiet: true });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  let n = 0;
  const post = async (path: string, secret: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const id = `msg_${++n}`;
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signStandardWebhook(secret, id, ts, body) },
      body,
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const asa = (token: string) => post("/jit/lithic", asaSecret, { token, card_token: card.token, amount: 1500, merchant: { descriptor: "PDFOCR.IO" } });
  const tx = (token: string, events: unknown[]) =>
    post("/webhooks/lithic", eventsSecret, { event_type: "card_transaction.updated", payload: { token, card_token: card.token, currency: "USD", events } });
  try {
    assert.equal((await asa("tx_1")).result, "APPROVED");
    assert.equal((await asa("tx_2")).result, "VELOCITY_EXCEEDED");
    const rev = await tx("tx_1", [
      { token: "e1", type: "AUTHORIZATION", amount: 1500, result: "APPROVED" },
      { token: "e2", type: "AUTHORIZATION_REVERSAL", amount: -1500, result: "APPROVED" },
    ]);
    assert.deepEqual(rev.settlements, [{ outcome: "released", intent_id: gov.store.list()[0].intent_id, hold_status: "released" }]);
    assert.equal((await asa("tx_3")).result, "APPROVED");
    await tx("tx_3", [
      { token: "e3", type: "AUTHORIZATION", amount: 1500, result: "APPROVED" },
      { token: "e4", type: "CLEARING", amount: 1200, result: "APPROVED" },
    ]);
    assert.equal(spent(), 12);
    // Lithic re-sends the whole event list on every update: nothing is applied twice.
    const replay = await tx("tx_3", [
      { token: "e3", type: "AUTHORIZATION", amount: 1500, result: "APPROVED" },
      { token: "e4", type: "CLEARING", amount: 1200, result: "APPROVED" },
    ]);
    assert.equal((replay.settlements as { outcome: string }[])[0].outcome, "duplicate");
    assert.equal(spent(), 12);
  } finally {
    server.close();
  }
});
