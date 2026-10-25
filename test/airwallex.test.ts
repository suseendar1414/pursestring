import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AirwallexAdapter } from "../src/adapters/airwallex.js";
import type { CardReference } from "../src/types.js";
import { intent, setup } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init: RequestInit };

/** Answers like the Airwallex demo API: login, create, details, update. */
function stubFetch(calls: Call[]) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    let body: unknown = {};
    if (path.endsWith("/authentication/login")) {
      body = { token: "tok_1", expires_at: new Date(Date.now() + 30 * 60_000).toISOString() };
    } else if (path.endsWith("/issuing/cards/create")) {
      body = { card_id: "card_1", card_status: "ACTIVE", created_at: "2026-10-20T00:00:00Z" };
    } else if (path.endsWith("/details")) {
      body = { card_number: "4111111111114242", cvv: "123", expiry_month: 1, expiry_year: 2030, name_on_card: "PurseString" };
    } else if (path.endsWith("/update")) {
      body = { card_id: "card_1", card_status: "CLOSED" };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const adapter = () => new AirwallexAdapter({ clientId: "cid", apiKey: "key", cardholderId: "ch_1" });

test("airwallex logs in, then issues a single-use card on the demo API capped per transaction in the intent's currency", async () => {
  const calls: Call[] = [];
  stubFetch(calls);
  const card = await adapter().issueCard({
    intent_id: "int_1",
    amount: 12.4,
    currency: "EUR",
    vendor_domain: "pdfocr.io",
    single_use: true,
    memo: "pdfocr.io for task #102",
  });

  assert.equal(calls[0].url, "https://api-demo.airwallex.com/api/v1/authentication/login");
  const loginHeaders = calls[0].init.headers as Record<string, string>;
  assert.equal(loginHeaders["x-client-id"], "cid");
  assert.equal(loginHeaders["x-api-key"], "key");

  assert.equal(calls[1].url, "https://api-demo.airwallex.com/api/v1/issuing/cards/create");
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, "Bearer tok_1");
  const body = JSON.parse(String(calls[1].init.body));
  assert.equal(body.request_id, "int_1");
  assert.equal(body.cardholder_id, "ch_1");
  assert.equal(body.form_factor, "VIRTUAL");
  assert.deepEqual(body.authorization_controls, {
    allowed_transaction_count: "SINGLE",
    transaction_limits: { currency: "EUR", limits: [{ amount: 12.4, interval: "PER_TRANSACTION" }] },
  });

  assert.equal(calls[2].url, "https://api-demo.airwallex.com/api/v1/issuing/cards/card_1/details");
  assert.equal(card.adapter, "airwallex");
  assert.equal(card.token, "card_1");
  assert.equal(card.last_four, "4242");
  assert.equal(card.exp_month, "01");
  assert.equal(card.exp_year, "2030");
  assert.equal(card.currency, "EUR");
  assert.equal(card.spend_limit, 12.4);
});

test("airwallex issues a recurring card as multi-use with a monthly cap, and reuses the login token", async () => {
  const calls: Call[] = [];
  stubFetch(calls);
  const a = adapter();
  const req = { intent_id: "int_2", amount: 30, currency: "USD", vendor_domain: "openai.com", single_use: false, memo: "sub" };
  await a.issueCard(req);
  await a.issueCard({ ...req, intent_id: "int_3" });
  const body = JSON.parse(String(calls[1].init.body));
  assert.equal(body.authorization_controls.allowed_transaction_count, "MULTIPLE");
  assert.equal(body.authorization_controls.transaction_limits.limits[0].interval, "MONTHLY");
  assert.equal(calls.filter((c) => c.url.endsWith("/authentication/login")).length, 1);
});

test("airwallex production uses api.airwallex.com and closes a card by setting card_status CLOSED", async () => {
  const calls: Call[] = [];
  stubFetch(calls);
  const ref: CardReference = {
    adapter: "airwallex",
    token: "card_1",
    last_four: "4242",
    issued_at: "",
    spend_limit: 13,
    currency: "USD",
    single_use: true,
  };
  await new AirwallexAdapter({ clientId: "cid", apiKey: "key", cardholderId: "ch_1", environment: "production" }).closeCard(ref);
  assert.equal(calls[1].url, "https://api.airwallex.com/api/v1/issuing/cards/card_1/update");
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { card_status: "CLOSED" });
});

test("routing to airwallex without credentials is a clear error", async () => {
  const { gov } = setup({ vendors: { allowlist: ["pdfocr.io"] }, routes: [{ rail: "airwallex" }] });
  const { record } = await gov.submitIntent(intent());
  await assert.rejects(gov.requestCard(record.intent_id), /AIRWALLEX_CLIENT_ID/);
});
