import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Rails } from "../src/adapters/index.js";
import { ModernTreasuryAdapter } from "../src/adapters/modern-treasury.js";
import { RazorpayXAdapter } from "../src/adapters/razorpayx.js";
import { StripeConnectAdapter } from "../src/adapters/stripe-connect.js";
import { parsePolicy, type Config } from "../src/config.js";
import { Governance, GovernanceError } from "../src/governance.js";
import { Store } from "../src/store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intent } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init: RequestInit };

/** Records each request and answers with `answer(path, method)`. */
function stubFetch(calls: Call[], answer: (path: string, method: string) => unknown, status = 200) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer(new URL(url).pathname, init.method ?? "GET")), { status });
  }) as typeof fetch;
}

const headers = (c: Call) => c.init.headers as Record<string, string>;

test("stripe_connect sends one idempotent transfer in integer minor units to the connected account", async () => {
  const calls: Call[] = [];
  stubFetch(calls, (path) => (path === "/v1/transfers/tr_1" ? { id: "tr_1", reversed: true } : { id: "tr_1", reversed: false }));
  const stripe = new StripeConnectAdapter({ secretKey: "sk_test_abc" });
  const out = await stripe.sendPayout({
    intent_id: "int_1",
    amount: 49.99,
    currency: "usd",
    payee: { stripe_account: "acct_123" },
    note: "OCR credits",
  });
  assert.deepEqual(out, { payment_id: "tr_1", status: "transferred" });
  assert.equal(calls[0].url, "https://api.stripe.com/v1/transfers");
  assert.equal(headers(calls[0]).Authorization, "Bearer sk_test_abc");
  assert.equal(headers(calls[0])["Idempotency-Key"], "int_1");
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("amount"), "4999");
  assert.equal(form.get("currency"), "usd");
  assert.equal(form.get("destination"), "acct_123");
  assert.equal(form.get("metadata[pursestring_intent_id]"), "int_1");
  assert.deepEqual(await stripe.getPayout("tr_1"), { payment_id: "tr_1", status: "reversed" });
});

test("stripe_connect sends JPY as whole yen and ISK with Stripe's two decimals", async () => {
  const calls: Call[] = [];
  stubFetch(calls, () => ({ id: "tr_2" }));
  const stripe = new StripeConnectAdapter({ secretKey: "sk_test_abc" });
  await stripe.sendPayout({ intent_id: "a", amount: 1500, currency: "JPY", payee: { stripe_account: "acct_1" }, note: "" });
  await stripe.sendPayout({ intent_id: "b", amount: 1500, currency: "ISK", payee: { stripe_account: "acct_1" }, note: "" });
  assert.equal(new URLSearchParams(String(calls[0].init.body)).get("amount"), "1500");
  assert.equal(new URLSearchParams(String(calls[1].init.body)).get("amount"), "150000");
});

test("sandbox mode refuses live Stripe and RazorpayX keys", () => {
  assert.throws(() => new StripeConnectAdapter({ secretKey: "sk_live_abc" }), /test-mode/);
  assert.doesNotThrow(() => new StripeConnectAdapter({ secretKey: "sk_live_abc", environment: "production" }));
  assert.throws(() => new RazorpayXAdapter({ keyId: "rzp_live_x", keySecret: "s", accountNumber: "1" }), /test-mode/);
});

test("razorpayx sends one idempotent INR payout in paise to the fund account", async () => {
  const calls: Call[] = [];
  stubFetch(calls, (path) => (path === "/v1/payouts/pout_1" ? { id: "pout_1", status: "processed" } : { id: "pout_1", status: "processing" }));
  const rx = new RazorpayXAdapter({ keyId: "rzp_test_k", keySecret: "sec", accountNumber: "7878780080316316" });
  const out = await rx.sendPayout({
    intent_id: "int_9",
    amount: 1250.5,
    currency: "INR",
    payee: { razorpayx_fund_account: "fa_00000000000001" },
    note: "GST filing (PurseString int_9, bot/7)",
  });
  assert.deepEqual(out, { payment_id: "pout_1", status: "processing" });
  assert.equal(calls[0].url, "https://api.razorpay.com/v1/payouts");
  assert.equal(headers(calls[0]).Authorization, `Basic ${Buffer.from("rzp_test_k:sec").toString("base64")}`);
  assert.equal(headers(calls[0])["X-Payout-Idempotency"], "int_9");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.amount, 125050);
  assert.equal(body.currency, "INR");
  assert.equal(body.fund_account_id, "fa_00000000000001");
  assert.equal(body.account_number, "7878780080316316");
  assert.equal(body.mode, "IMPS");
  assert.equal(body.queue_if_low_balance, false);
  assert.equal(body.reference_id, "int_9");
  assert.match(body.narration, /^[A-Za-z0-9 ]{1,30}$/);
  assert.deepEqual(await rx.getPayout("pout_1"), { payment_id: "pout_1", status: "processed" });

  await assert.rejects(
    rx.sendPayout({ intent_id: "x", amount: 5, currency: "USD", payee: { razorpayx_fund_account: "fa_1" }, note: "" }),
    /INR only/,
  );
});

test("modern_treasury creates one idempotent ACH credit payment order in cents", async () => {
  const calls: Call[] = [];
  stubFetch(calls, (path) =>
    path === "/api/payment_orders/po_1" ? { id: "po_1", status: "completed" } : { id: "po_1", status: "approved" },
  );
  const mt = new ModernTreasuryAdapter({ organizationId: "org", apiKey: "key", originatingAccountId: "ia_1" });
  const out = await mt.sendPayout({
    intent_id: "int_5",
    amount: 120,
    currency: "USD",
    payee: { modern_treasury_account: "ea_1" },
    note: "Invoice 33",
  });
  assert.deepEqual(out, { payment_id: "po_1", status: "approved" });
  assert.equal(calls[0].url, "https://app.moderntreasury.com/api/payment_orders");
  assert.equal(headers(calls[0]).Authorization, `Basic ${Buffer.from("org:key").toString("base64")}`);
  assert.equal(headers(calls[0])["Idempotency-Key"], "int_5");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    type: "ach",
    direction: "credit",
    amount: 12000,
    currency: "USD",
    originating_account_id: "ia_1",
    receiving_account_id: "ea_1",
    description: "Invoice 33",
    metadata: { pursestring_intent_id: "int_5" },
  });
  assert.deepEqual(await mt.getPayout("po_1"), { payment_id: "po_1", status: "completed" });
});

test("a rail error surfaces the provider's status and message", async () => {
  stubFetch([], () => ({ error: { description: "Insufficient balance" } }), 400);
  const rx = new RazorpayXAdapter({ keyId: "rzp_test_k", keySecret: "s", accountNumber: "1" });
  await assert.rejects(
    rx.sendPayout({ intent_id: "x", amount: 5, currency: "INR", payee: { razorpayx_fund_account: "fa_1" }, note: "" }),
    /RazorpayX POST \/v1\/payouts failed: 400 .*Insufficient balance/,
  );
});

test("payee entries need at least one destination and well-formed IDs", () => {
  assert.throws(() => parsePolicy({ payees: [{ vendor: "x.io" }] }), /at least one of/);
  assert.throws(() => parsePolicy({ payees: [{ vendor: "x.io", stripe_account: "bob" }] }), /acct_/);
  assert.throws(() => parsePolicy({ payees: [{ vendor: "x.io", razorpayx_fund_account: "bob" }] }), /fa_/);
  assert.doesNotThrow(() => parsePolicy({ payees: [{ vendor: "x.io", modern_treasury_account: "ea_1" }] }));
});

test("each payout rail pays the payee field it owns, through governance, once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pursestring-rails-"));
  const policy = parsePolicy({
    vendors: { allowlist: ["pdfocr.io", "tax.in", "acme.com"] },
    routes: [
      { rail: "stripe_connect", vendors: ["pdfocr.io"] },
      { rail: "modern_treasury", vendors: ["acme.com"] },
    ],
    payees: [
      // A PayPal-only entry first: the Stripe rail must skip it and use the entry that has a stripe_account.
      { vendor: "pdfocr.io", receiver: "billing@pdfocr.io" },
      { vendor: "pdfocr.io", stripe_account: "acct_pdf" },
      { vendor: "acme.com", receiver: "ap@acme.com" },
    ],
  });
  const config: Config = {
    policy,
    policyPath: null,
    homeDir: dir,
    env: { stripeSecretKey: "sk_test_x", modernTreasuryOrgId: "o", modernTreasuryApiKey: "k", modernTreasuryOriginatingAccountId: "ia" },
  };
  const gov = new Governance(config, new Store(dir), new Rails(config), { approvalRequested: async () => {} });
  const calls: Call[] = [];
  stubFetch(calls, () => ({ id: "tr_9", reversed: false }));

  const { record } = await gov.submitIntent(intent());
  assert.equal(record.rail, "stripe_connect");
  const paid = await gov.sendPayment(record.intent_id);
  assert.equal(paid.payment.paid_to, "acct_pdf");
  assert.equal(paid.payment.adapter, "stripe_connect");
  assert.equal(new URLSearchParams(String(calls[0].init.body)).get("destination"), "acct_pdf");
  const again = await gov.sendPayment(record.intent_id);
  assert.equal(again.replayed, true);
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1, "no second transfer");

  // acme.com only has a PayPal receiver, so the Modern Treasury rail has nowhere to send money.
  const mt = await gov.submitIntent(intent({ vendor_domain: "acme.com", task_id: "mt" }));
  assert.equal(mt.record.rail, "modern_treasury");
  await assert.rejects(gov.sendPayment(mt.record.intent_id), (e: GovernanceError) => e.code === "no_payee" && /modern_treasury_account/.test(e.message));
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1);
});
