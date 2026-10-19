import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PrivacyAdapter } from "../src/adapters/privacy.js";
import { intent, setup } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(calls: { url: string; init: RequestInit }[]) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const card = {
      token: "card_1",
      last_four: "4242",
      pan: "4111111111114242",
      cvv: "123",
      exp_month: "01",
      exp_year: "2030",
      spend_limit: 1300,
      type: "SINGLE_USE",
      created: "2026-10-19T00:00:00Z",
    };
    return new Response(JSON.stringify(card), { status: 200 });
  }) as typeof fetch;
}

test("privacy issues a single-use card on api.privacy.com, capped at the amount rounded up to whole dollars", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  stubFetch(calls);
  const card = await new PrivacyAdapter("key_123").issueCard({
    intent_id: "int_1",
    amount: 12.4,
    currency: "USD",
    vendor_domain: "pdfocr.io",
    single_use: true,
    memo: "pdfocr.io for task #102",
  });
  assert.equal(calls[0].url, "https://api.privacy.com/v1/cards");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "key_123");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    type: "SINGLE_USE",
    spend_limit: 1300,
    spend_limit_duration: "TRANSACTION",
    memo: "pdfocr.io for task #102",
  });
  assert.equal(card.adapter, "privacy");
  assert.equal(card.last_four, "4242");
});

test("privacy closes a card with PATCH state CLOSED", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  stubFetch(calls);
  await new PrivacyAdapter("key_123").closeCard({
    adapter: "privacy",
    token: "card_1",
    last_four: "4242",
    issued_at: "",
    spend_limit: 13,
    currency: "USD",
    single_use: true,
  });
  assert.equal(calls[0].url, "https://api.privacy.com/v1/cards/card_1");
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { state: "CLOSED" });
});

test("routing to privacy without a key is a clear error", async () => {
  const { gov } = setup({ vendors: { allowlist: ["pdfocr.io"] }, routes: [{ rail: "privacy" }] });
  const { record } = await gov.submitIntent(intent());
  await assert.rejects(gov.requestCard(record.intent_id), /PRIVACY_API_KEY/);
});
