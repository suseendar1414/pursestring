import assert from "node:assert/strict";
import { test } from "node:test";
import { cardCostMinor } from "../src/holds.js";
import { idempotencyKey, spentToday } from "../src/store.js";
import type { IntentRecord } from "../src/types.js";
import { intent, POLICY, setup } from "./helpers.js";

async function issued(overrides = {}, policy: Record<string, unknown> = POLICY) {
  const ctx = setup(policy);
  const { record } = await ctx.gov.submitIntent(intent(overrides));
  if (record.status === "pending_approval") ctx.gov.decide(record.intent_id, true, "alice");
  const { card } = await ctx.gov.requestCard(record.intent_id);
  const spent = () => ctx.store.transact((intents, now) => spentToday(intents, "invoice-bot", now));
  const auths = () => ctx.store.get(record.intent_id)!.authorizations ?? [];
  /** Move time forward for one stored record by rewriting its timestamps into the past. */
  const edit = (fn: (r: IntentRecord) => void) => ctx.store.transact((intents) => fn(intents[record.intent_id]));
  return { ...ctx, record, card, spent, auths, edit };
}

const past = () => new Date(Date.now() - 60_000).toISOString();

// ---- Split captures ----------------------------------------------------------------------------------------------

test("split capture: the uncaptured part of a hold stays held until the merchant captures it", async () => {
  const { gov, card, spent } = await issued();
  gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
  const first = gov.recordSettlement({ event_id: "c1", kind: "capture", transaction_id: "tx_1", amount: 9, source: "lithic" });
  assert.equal(first.captured, 9);
  assert.equal(first.still_held, 6, "the second shipment can still capture 6.00");
  assert.match(first.message, /stays held until/);
  assert.equal(spent(), 15, "the leftover keeps counting against today's budget");

  const second = gov.recordSettlement({ event_id: "c2", kind: "capture", transaction_id: "tx_1", amount: 6, source: "lithic" });
  assert.equal(second.captured, 15);
  assert.equal(second.still_held, 0);
  assert.equal(spent(), 15);
});

test("split capture: on a recurring card the leftover keeps its room under the monthly cap", async () => {
  const { gov, card } = await issued({ is_recurring: true, amount: 15 });
  const charge = (amount: number, tx: string) => gov.authorize({ card_token: card.token, amount, merchant: "pdfocr", transaction_id: tx }).code;
  assert.equal(charge(15, "tx_1"), "approved");
  gov.recordSettlement({ event_id: "c1", kind: "capture", transaction_id: "tx_1", amount: 9, source: "lithic" });
  assert.equal(charge(6, "tx_2"), "over_amount", "6.00 is still held for tx_1's second shipment");
});

test("split capture: a release, a final capture, or the hold window ending frees the leftover", async () => {
  {
    const { gov, card, spent } = await issued();
    gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
    gov.recordSettlement({ event_id: "c1", kind: "capture", transaction_id: "tx_1", amount: 9, source: "lithic" });
    const r = gov.recordSettlement({ event_id: "x1", kind: "release", transaction_id: "tx_1", type: "AUTHORIZATION_EXPIRY", source: "lithic" });
    assert.equal(r.still_held, 0);
    assert.equal(spent(), 9);
  }
  {
    const { gov, card, spent } = await issued();
    gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
    gov.recordSettlement({ event_id: "c1", kind: "capture", transaction_id: "tx_1", amount: 5, source: "http" });
    gov.recordSettlement({ event_id: "c2", kind: "capture", transaction_id: "tx_1", amount: 4, final: true, source: "http" });
    assert.equal(spent(), 9, "a capture marked final closes the hold");
  }
  {
    const { gov, card, spent, edit } = await issued();
    gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
    gov.recordSettlement({ event_id: "c1", kind: "capture", transaction_id: "tx_1", amount: 9, source: "lithic" });
    assert.equal(spent(), 15);
    edit((r) => (r.authorizations![0].leftover_until = past()));
    assert.equal(spent(), 9, "after jit.partial_capture_hold_days the leftover stops counting");
  }
});

test("split capture: partial_capture_hold_days: 0 keeps the old rule, a capture ends the hold", async () => {
  const { gov, card, spent } = await issued({}, { ...POLICY, jit: { partial_capture_hold_days: 0 } });
  gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
  const r = gov.recordSettlement({ event_id: "c1", kind: "capture", transaction_id: "tx_1", amount: 9, source: "lithic" });
  assert.equal(r.still_held, 0);
  assert.equal(spent(), 9);
});

test("split capture: holds settled before this change keep their old meaning", async () => {
  const { gov, card, spent, edit } = await issued();
  gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
  // What an older state.json holds: settled_at, no leftover_until, no hold_closed_at.
  edit((r) => Object.assign(r.authorizations![0], { captured: 9, settled_at: past(), hold_status: "captured" }));
  assert.equal(spent(), 9);
});

// ---- Expired, unused cards ---------------------------------------------------------------------------------------

test("an unused single-use card gives its budget back once it expires", async () => {
  const { spent, edit, record, store } = await issued();
  assert.equal(store.get(record.intent_id)!.card!.jit_gated, true, "every mock charge passes authorize");
  assert.equal(spent(), 15, "reserved while the card can still be charged");
  edit((r) => (r.card!.expires_at = past()));
  assert.equal(spent(), 0, "expired with no approved charge: nothing was spent");
});

test("a closed card with a released hold costs nothing; one with an open hold still counts", async () => {
  {
    const { gov, card, spent, edit } = await issued();
    gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
    gov.recordSettlement({ event_id: "r1", kind: "release", transaction_id: "tx_1", source: "lithic" });
    edit((r) => (r.card!.closed_at = past()));
    assert.equal(spent(), 0);
  }
  {
    const { gov, card, spent, edit } = await issued();
    gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
    edit((r) => (r.card!.closed_at = past()));
    assert.equal(spent(), 15, "the merchant can still capture an approved hold after the card closes");
  }
});

test("the freed budget can be spent again the same day", async () => {
  const policy = { ...POLICY, hard_limits: { per_agent_daily_budget: 20 } };
  const { gov, edit } = await issued({}, policy);
  const blocked = await gov.submitIntent(intent({ task_id: "103" }));
  assert.notEqual(blocked.record.status, "approved", "15 + 15 is over the 20.00 budget");
  edit((r) => (r.card!.expires_at = past()));
  const next = await gov.submitIntent(intent({ task_id: "104" }));
  assert.equal(next.record.status, "approved");
});

test("cards on rails without a real-time check keep their limit after expiry: a charge may have gone unseen", () => {
  const rec = {
    card: { adapter: "privacy", token: "c", last_four: "1", issued_at: past(), spend_limit: 15, currency: "USD", single_use: true, expires_at: past() },
    authorizations: [],
  } as unknown as IntentRecord;
  assert.equal(cardCostMinor(rec), 1500);
  rec.card!.jit_gated = true;
  assert.equal(cardCostMinor(rec), 0);
});

test("Lithic cards are JIT-gated only when the ASA secret is set and jit is on", async () => {
  const ctx = setup();
  const g = ctx.gov as unknown as { jitGated(name: string): boolean; config: { env: Record<string, string> } };
  assert.equal(g.jitGated("lithic"), false);
  g.config.env.lithicWebhookSecret = "whsec_x";
  assert.equal(g.jitGated("lithic"), true);
  assert.equal(g.jitGated("privacy"), false);
  assert.equal(g.jitGated("airwallex"), false);
});

// ---- Line items in the idempotency key ---------------------------------------------------------------------------

test("line items: the same task can buy the same thing twice, and a retry of one line item is still deduplicated", async () => {
  const { gov } = setup();
  const a = await gov.submitIntent(intent({ line_item_id: "seat-1" }));
  const b = await gov.submitIntent(intent({ line_item_id: "seat-2" }));
  assert.equal(b.deduplicated, false);
  assert.notEqual(a.record.intent_id, b.record.intent_id);
  const retry = await gov.submitIntent(intent({ line_item_id: " seat-2 " }));
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.record.intent_id, b.record.intent_id);
});

test("line items: intents without one keep the exact key they had before", () => {
  // SHA-256 of "invoice-bot␟102␟pdfocr.io␟15.00", the key every existing state.json already holds.
  assert.equal(idempotencyKey(intent()), "fba9d925bc6211510ae1ce84b6be58cd668af58a320332ed88cb3f34fd011323");
  assert.equal(idempotencyKey({ ...intent(), line_item_id: undefined }), idempotencyKey(intent()));
  assert.notEqual(idempotencyKey(intent()), idempotencyKey(intent({ line_item_id: "seat-1" })));
  // The separator keeps a line item from colliding with a longer task ID.
  assert.notEqual(
    idempotencyKey(intent({ task_id: "102", line_item_id: "a" })),
    idempotencyKey(intent({ task_id: "102\u001fline:a" })),
  );
});

test("line items: loop detection still counts them, so fresh line items can't hide a loop", async () => {
  const { gov } = setup({ ...POLICY, hard_limits: { per_agent_daily_budget: 10_000 }, kill_switch: { loop_detection: { max_similar: 3 } } });
  const outcomes = [];
  for (const li of ["1", "2", "3"]) outcomes.push((await gov.submitIntent(intent({ line_item_id: li }))).record.status);
  assert.deepEqual(outcomes, ["approved", "approved", "denied"]);
});

// ---- Re-authorization of the same transaction --------------------------------------------------------------------

test("re-auth: the same transaction authorized again replaces its hold instead of counting twice on the monthly cap", async () => {
  const { gov, card, auths } = await issued({ is_recurring: true, amount: 15 });
  const charge = (amount: number, tx: string) => gov.authorize({ card_token: card.token, amount, merchant: "pdfocr", transaction_id: tx }).code;
  assert.equal(charge(15, "tx_1"), "approved");
  assert.equal(charge(15, "tx_1"), "approved", "same transaction: the old hold is replaced, not added to");
  assert.equal(charge(1, "tx_2"), "over_amount", "the month still has exactly one 15.00 hold");
  const live = auths().filter((a) => a.approved && !a.superseded_at);
  assert.equal(live.length, 1);
  assert.equal(live[0].reauthorization, true);
  // Later events for the transaction land on the live hold.
  const r = gov.recordSettlement({ event_id: "c1", kind: "capture", transaction_id: "tx_1", amount: 15, final: true, source: "lithic" });
  assert.equal(r.captured, 15);
  assert.equal(live[0].transaction_id, "tx_1");
  assert.equal(auths().filter((a) => a.captured).length, 1);
});

test("re-auth: a single-use card accepts a retry of the same transaction but not a new one", async () => {
  const { gov, card, spent } = await issued();
  const charge = (amount: number, tx: string) => gov.authorize({ card_token: card.token, amount, merchant: "PDFOCR.IO", transaction_id: tx }).code;
  assert.equal(charge(15, "tx_1"), "approved");
  assert.equal(charge(14, "tx_1"), "approved", "the issuer re-asking about tx_1 isn't a second charge");
  assert.equal(charge(15, "tx_2"), "already_used");
  assert.equal(charge(16, "tx_1"), "over_amount", "a re-auth is held to the same limit");
  gov.recordSettlement({ event_id: "c1", kind: "capture", transaction_id: "tx_1", amount: 14, final: true, source: "lithic" });
  assert.equal(spent(), 14);
});

test("re-auth: once a capture has landed, another authorization on the transaction counts on its own", async () => {
  const { gov, card } = await issued({ is_recurring: true, amount: 15 });
  const charge = (amount: number, tx: string) => gov.authorize({ card_token: card.token, amount, merchant: "pdfocr", transaction_id: tx }).code;
  assert.equal(charge(10, "tx_1"), "approved");
  gov.recordSettlement({ event_id: "c1", kind: "capture", transaction_id: "tx_1", amount: 10, final: true, source: "lithic" });
  assert.equal(charge(10, "tx_1"), "over_amount", "10 captured + 10 new is over the 15.00 month");
});

test("re-auth: a declined re-auth leaves the original hold in place", async () => {
  const { gov, card, spent, auths } = await issued();
  gov.authorize({ card_token: card.token, amount: 15, merchant: "PDFOCR.IO", transaction_id: "tx_1" });
  assert.equal(gov.authorize({ card_token: card.token, amount: 20, merchant: "PDFOCR.IO", transaction_id: "tx_1" }).code, "over_amount");
  assert.equal(auths().filter((a) => a.approved && !a.superseded_at).length, 1);
  assert.equal(spent(), 15);
});
