import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Rails } from "../src/adapters/index.js";
import { PayPalAdapter } from "../src/adapters/paypal.js";
import type { CardAdapter, PayoutRequest } from "../src/adapters/types.js";
import { parsePolicy, type Config } from "../src/config.js";
import { Governance, GovernanceError } from "../src/governance.js";
import { Store } from "../src/store.js";
import { intent } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init: RequestInit };

/** Answers like the PayPal sandbox: token, create payout, get payout. */
function stubFetch(calls: Call[]) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    let body: unknown = {};
    if (path === "/v1/oauth2/token") body = { access_token: "A21_tok", expires_in: 32400 };
    else if (path === "/v1/payments/payouts" && init.method === "POST") {
      body = { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } };
    } else if (path === "/v1/payments/payouts/BATCH1") {
      body = { batch_header: { payout_batch_id: "BATCH1", batch_status: "SUCCESS" }, items: [{ transaction_status: "SUCCESS" }] };
    }
    return new Response(JSON.stringify(body), { status: init.method === "POST" && path.endsWith("payouts") ? 201 : 200 });
  }) as typeof fetch;
}

test("paypal logs in with client credentials and sends one idempotent payout to the payee on the sandbox", async () => {
  const calls: Call[] = [];
  stubFetch(calls);
  const pp = new PayPalAdapter({ clientId: "cid", clientSecret: "sec" });
  const out = await pp.sendPayout({
    intent_id: "int_1",
    amount: 15,
    currency: "usd",
    payee: { receiver: "billing@pdfocr.io", type: "EMAIL", wallet: "PAYPAL" },
    note: "OCR credits",
  });
  assert.deepEqual(out, { payment_id: "BATCH1", status: "PENDING" });

  assert.equal(calls[0].url, "https://api-m.sandbox.paypal.com/v1/oauth2/token");
  const auth = (calls[0].init.headers as Record<string, string>).Authorization;
  assert.equal(auth, `Basic ${Buffer.from("cid:sec").toString("base64")}`);
  assert.equal(calls[0].init.body, "grant_type=client_credentials");

  assert.equal(calls[1].url, "https://api-m.sandbox.paypal.com/v1/payments/payouts");
  const headers = calls[1].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer A21_tok");
  assert.equal(headers["PayPal-Request-Id"], "int_1");
  const body = JSON.parse(String(calls[1].init.body));
  assert.equal(body.sender_batch_header.sender_batch_id, "int_1");
  assert.deepEqual(body.items[0], {
    recipient_type: "EMAIL",
    recipient_wallet: "PAYPAL",
    receiver: "billing@pdfocr.io",
    amount: { value: "15.00", currency: "USD" },
    note: "OCR credits",
    sender_item_id: "int_1",
  });

  assert.deepEqual(await pp.getPayout("BATCH1"), { payment_id: "BATCH1", status: "SUCCESS" });
  assert.equal(calls.filter((c) => c.url.endsWith("/oauth2/token")).length, 1, "token is reused");
});

test("paypal sends zero-decimal currencies without cents and production uses the live host", async () => {
  const calls: Call[] = [];
  stubFetch(calls);
  const pp = new PayPalAdapter({ clientId: "cid", clientSecret: "sec", environment: "production" });
  await pp.sendPayout({
    intent_id: "int_2",
    amount: 1500,
    currency: "JPY",
    payee: { receiver: "+15551234567", type: "PHONE", wallet: "VENMO" },
    note: "x",
  });
  assert.equal(calls[1].url, "https://api-m.paypal.com/v1/payments/payouts");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)).items[0].amount, { value: "1500", currency: "JPY" });
});

const PAYPAL_POLICY = {
  vendors: { allowlist: ["pdfocr.io", "*.openai.com"] },
  adapter: { type: "paypal" },
  payees: [{ vendor: "pdfocr.io", receiver: "billing@pdfocr.io" }],
  hard_limits: { per_agent_daily_budget: 20 },
};

/** Governance on the paypal rail with an in-memory payout adapter. */
function setupPayPal(policy: unknown = PAYPAL_POLICY, opts: { fail?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pursestring-paypal-"));
  const config: Config = { policy: parsePolicy(policy), policyPath: null, homeDir: dir, env: {} };
  const store = new Store(dir);
  const sent: PayoutRequest[] = [];
  const paypal: CardAdapter = {
    name: "paypal",
    kind: "payout",
    issueCard: async () => assert.fail("no cards on paypal"),
    getCard: async () => assert.fail("no cards on paypal"),
    sendPayout: async (req) => {
      if (opts.fail) throw new Error("PayPal POST /v1/payments/payouts failed: 422 INSUFFICIENT_FUNDS");
      sent.push(req);
      return { payment_id: `BATCH_${sent.length}`, status: "PENDING" };
    },
    getPayout: async (id) => ({ payment_id: id, status: "SUCCESS" }),
  };
  const gov = new Governance(config, store, new Rails(config, { paypal }), { approvalRequested: async () => {} });
  return { gov, store, sent };
}

test("an approved intent is paid once, to the payee on file, and a retry never pays twice", async () => {
  const { gov, sent } = setupPayPal();
  const { record } = await gov.submitIntent(intent());
  assert.equal(record.status, "approved");
  assert.equal(record.rail, "paypal");

  const first = await gov.sendPayment(record.intent_id);
  assert.equal(first.replayed, false);
  assert.equal(first.record.status, "paid");
  assert.equal(first.payment.payee.receiver, "billing@pdfocr.io");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].intent_id, record.intent_id);
  assert.equal(sent[0].amount, 15);

  const again = await gov.sendPayment(record.intent_id);
  assert.equal(again.replayed, true);
  assert.equal(again.payment.payment_id, "BATCH_1");
  assert.equal(again.payment.status, "SUCCESS", "replay refreshes the status from PayPal");
  assert.equal(sent.length, 1, "no second payout");
});

test("payouts count toward the agent's daily budget", async () => {
  const { gov } = setupPayPal();
  const { record } = await gov.submitIntent(intent({ amount: 15, task_id: "1" }));
  await gov.sendPayment(record.intent_id);
  const next = await gov.submitIntent(intent({ amount: 15, task_id: "2" }));
  assert.equal(next.record.status, "pending_approval");
});

test("a vendor with no payee on file can't be paid by payout", async () => {
  const { gov, sent } = setupPayPal();
  const { record } = await gov.submitIntent(intent({ vendor_domain: "api.openai.com" }));
  await assert.rejects(gov.sendPayment(record.intent_id), (e: GovernanceError) => e.code === "no_payee");
  assert.equal(gov.store.get(record.intent_id)?.status, "approved");
  assert.equal(sent.length, 0);
});

test("the paypal rail refuses cards, recurring spend and unapproved intents", async () => {
  const { gov, sent } = setupPayPal({ ...PAYPAL_POLICY, auto_approve: { allow_recurring: true }, require_approval: { recurring: false } });
  const { record } = await gov.submitIntent(intent());
  await assert.rejects(gov.requestCard(record.intent_id), (e: GovernanceError) => e.code === "payout_rail");

  const rec = await gov.submitIntent(intent({ is_recurring: true, task_id: "sub" }));
  await assert.rejects(gov.sendPayment(rec.record.intent_id), (e: GovernanceError) => e.code === "recurring_not_supported");

  const big = await gov.submitIntent(intent({ amount: 80, task_id: "big" }));
  assert.equal(big.record.status, "pending_approval");
  await assert.rejects(gov.sendPayment(big.record.intent_id), (e: GovernanceError) => e.code === "pending_approval");
  assert.equal(sent.length, 0);
});

test("a PayPal error leaves the intent approved so it can be retried", async () => {
  const { gov } = setupPayPal(PAYPAL_POLICY, { fail: true });
  const { record } = await gov.submitIntent(intent());
  await assert.rejects(gov.sendPayment(record.intent_id), (e: GovernanceError) => e.code === "adapter_error" && /422/.test(e.message));
  assert.equal(gov.store.get(record.intent_id)?.status, "approved");
});

test("card rails point the agent at request_ephemeral_card", async () => {
  const { gov } = setupPayPal({ ...PAYPAL_POLICY, adapter: { type: "mock" } });
  const { record } = await gov.submitIntent(intent());
  await assert.rejects(gov.sendPayment(record.intent_id), (e: GovernanceError) => e.code === "not_payout_rail");
});
