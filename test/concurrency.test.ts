import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { startHttp } from "../src/http.js";
import { spentToday } from "../src/store.js";
import { signStandardWebhook } from "../src/webhooks.js";
import { intent, POLICY, setup } from "./helpers.js";

const run = promisify(execFile);

// ---- Racing spends -----------------------------------------------------------------------------------------------

test("parallel card requests can't overspend the daily budget between the check and the card", async () => {
  const { gov, store } = setup({ ...POLICY, hard_limits: { per_agent_daily_budget: 40 } });
  const ids = [];
  for (const task of ["a", "b", "c", "d"]) ids.push((await gov.submitIntent(intent({ task_id: task }))).record.intent_id);
  const results = await Promise.allSettled(ids.map((id) => gov.requestCard(id)));
  const issued = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(issued, 2, "two 15.00 cards fit in 40.00; a third would not");
  const spent = store.transact((intents, now) => spentToday(intents, "invoice-bot", now));
  assert.ok(spent <= 40, `spent ${spent}`);
});

test("parallel requests for the same card issue it once", async () => {
  const { gov, issuedCount } = setup();
  const { record } = await gov.submitIntent(intent());
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => gov.requestCard(record.intent_id)));
  assert.equal(issuedCount(), 1);
  const errors = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code);
  assert.ok(errors.every((c) => c === "in_progress"), `unexpected errors: ${errors}`);
});

test("separate processes racing on one state file: one intent per key, and the budget holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pursestring-race-"));
  const worker = join(import.meta.dirname, "fixtures", "submit-worker.ts");
  const spawn = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", worker, dir, ...args], { cwd: join(import.meta.dirname, "..") }).then((r) => JSON.parse(r.stdout));

  const same = await Promise.all([1, 2, 3, 4].map(() => spawn("same-task")));
  assert.equal(new Set(same.map((r) => r.intent_id)).size, 1, "identical intents from four processes are one intent");
  assert.equal(same.filter((r) => r.card === "issued").length, 1, "and get one card");

  const items = await Promise.all(["1", "2", "3", "4"].map((li) => spawn("items", li)));
  assert.equal(new Set(items.map((r) => r.intent_id)).size, 4, "different line items are different purchases");
  // 15.00 is already on a card from the first round, so of 40.00 only room for one more 15.00 card is left.
  assert.equal(items.filter((r) => r.card === "issued").length, 1, JSON.stringify(items));
});

// ---- Webhooks: duplicates and out of order -----------------------------------------------------------------------

async function lithicServer() {
  const asaSecret = "whsec_" + Buffer.from("asa-secret-for-race-tests-32by!!").toString("base64");
  const eventsSecret = Buffer.from("events-secret").toString("base64");
  const ctx = setup({ ...POLICY, hard_limits: { per_agent_daily_budget: 1000 } }, { lithicWebhookSecret: asaSecret, lithicEventsSecret: eventsSecret });
  const { record } = await ctx.gov.submitIntent(intent());
  const { card } = await ctx.gov.requestCard(record.intent_id);
  const server = startHttp(ctx.gov, 0, "127.0.0.1", { quiet: true });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  let n = 0;
  /** Deliver a signed webhook. Pass `id` to redeliver the same message, as Lithic does on retry. */
  const post = async (path: string, secret: string, payload: unknown, id = `msg_${++n}`) => {
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signStandardWebhook(secret, id, ts, body) },
      body,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const asa = (token: string, amount = 1500) =>
    post("/jit/lithic", asaSecret, { token, card_token: card.token, amount, merchant: { descriptor: "PDFOCR.IO" } });
  const tx = (token: string, events: unknown[], id?: string) =>
    post("/webhooks/lithic", eventsSecret, { event_type: "card_transaction.updated", payload: { token, card_token: card.token, currency: "USD", events } }, id);
  const spent = () => ctx.store.transact((intents, now) => spentToday(intents, "invoice-bot", now));
  const hold = () => ctx.store.get(record.intent_id)!.authorizations!.find((a) => a.approved && !a.superseded_at)!;
  return { ...ctx, card, record, server, asa, tx, post, spent, hold, eventsSecret };
}

const AUTH = { token: "e1", type: "AUTHORIZATION", amount: 1500, result: "APPROVED" };
const CLEAR = { token: "e2", type: "CLEARING", amount: 1200, result: "APPROVED" };
const EXPIRY = { token: "e3", type: "AUTHORIZATION_EXPIRY", result: "APPROVED" };

test("webhooks: the same delivery five times at once is applied once", async () => {
  const w = await lithicServer();
  try {
    await w.asa("tx_1");
    const deliveries = await Promise.all([1, 2, 3, 4, 5].map(() => w.tx("tx_1", [AUTH, CLEAR], "msg_same")));
    assert.ok(deliveries.every((d) => d.status === 200));
    const outcomes = deliveries.map((d) => d.body.settlements[0].outcome).sort();
    assert.deepEqual(outcomes, ["captured", "duplicate", "duplicate", "duplicate", "duplicate"]);
    assert.equal(w.hold().captured, 12);
    assert.equal(w.hold().event_ids!.length, 1);
  } finally {
    w.server.close();
  }
});

test("webhooks: a newer update arriving before an older one ends in the same place", async () => {
  const w = await lithicServer();
  try {
    await w.asa("tx_1");
    await w.tx("tx_1", [AUTH, CLEAR, EXPIRY]); // the later update, delivered first
    assert.equal(w.spent(), 12);
    const older = await w.tx("tx_1", [AUTH, CLEAR]);
    assert.equal(older.body.settlements[0].outcome, "duplicate");
    assert.equal(w.spent(), 12);
    assert.equal(w.hold().captured, 12);
  } finally {
    w.server.close();
  }
});

test("webhooks: events listed out of order inside one update give the same totals", async () => {
  const w = await lithicServer();
  try {
    await w.asa("tx_1");
    await w.tx("tx_1", [EXPIRY, CLEAR, AUTH]);
    assert.equal(w.hold().captured, 12);
    assert.equal(w.spent(), 12, "the expiry released the hold, the clearing still counts what was taken");
  } finally {
    w.server.close();
  }
});

test("webhooks: a capture that arrives before the authorization is recorded changes nothing, and applies on redelivery", async () => {
  const w = await lithicServer();
  try {
    const early = await w.tx("tx_1", [AUTH, CLEAR], "msg_early");
    assert.equal(early.status, 200);
    assert.equal(early.body.settlements[0].outcome, "unmatched");
    assert.equal(w.spent(), 15, "the card's limit stays reserved");
    await w.asa("tx_1");
    const retry = await w.tx("tx_1", [AUTH, CLEAR], "msg_early");
    assert.equal(retry.body.settlements[0].outcome, "captured");
    assert.equal(w.hold().captured, 12);
  } finally {
    w.server.close();
  }
});

test("webhooks: an ASA retry for the same transaction doesn't use up the single-use card", async () => {
  const w = await lithicServer();
  try {
    const all = await Promise.all([w.asa("tx_1"), w.asa("tx_1"), w.asa("tx_1")]);
    assert.ok(all.every((r) => r.body.result === "APPROVED"), JSON.stringify(all.map((r) => r.body)));
    assert.equal((await w.asa("tx_2")).body.result, "VELOCITY_EXCEEDED", "a different transaction is a second charge");
    assert.equal(w.store.get(w.record.intent_id)!.authorizations!.filter((a) => a.approved && !a.superseded_at).length, 1);
  } finally {
    w.server.close();
  }
});

test("webhooks: the same refund delivered at once is credited once", async () => {
  const w = await lithicServer();
  try {
    await w.asa("tx_1");
    await w.tx("tx_1", [AUTH, { ...CLEAR, amount: 1500 }]);
    const refund = { token: "rf_1", type: "RETURN", amount: -500, result: "APPROVED" };
    const deliveries = await Promise.all([1, 2, 3].map((i) => w.tx("tx_1", [refund], `msg_rf_${i}`)));
    const outcomes = deliveries.map((d) => d.body.refunds[0].outcome).sort();
    assert.deepEqual(outcomes, ["credited", "duplicate", "duplicate"]);
    assert.equal(w.store.get(w.record.intent_id)!.refunded_total, 5);
  } finally {
    w.server.close();
  }
});

test("webhooks: a replayed or tampered delivery is refused", async () => {
  const w = await lithicServer();
  try {
    await w.asa("tx_1");
    const body = JSON.stringify({ payload: { token: "tx_1", card_token: w.card.token, currency: "USD", events: [AUTH, CLEAR] } });
    const old = Math.floor(Date.now() / 1000) - 3600;
    const stale = await fetch(`http://127.0.0.1:${(w.server.address() as AddressInfo).port}/webhooks/lithic`, {
      method: "POST",
      headers: { "webhook-id": "m", "webhook-timestamp": String(old), "webhook-signature": signStandardWebhook(w.eventsSecret, "m", old, body) },
      body,
    });
    assert.equal(stale.status, 401, "an hour-old signature is outside the tolerance");
    const now = Math.floor(Date.now() / 1000);
    const tampered = await fetch(`http://127.0.0.1:${(w.server.address() as AddressInfo).port}/webhooks/lithic`, {
      method: "POST",
      headers: { "webhook-id": "m", "webhook-timestamp": String(now), "webhook-signature": signStandardWebhook(w.eventsSecret, "m", now, body) },
      body: body.replace("1200", "1"),
    });
    assert.equal(tampered.status, 401);
    assert.equal(w.hold().captured ?? 0, 0);
  } finally {
    w.server.close();
  }
});
