import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Rails } from "../src/adapters/index.js";
import { AirwallexAdapter } from "../src/adapters/airwallex.js";
import { AIRWALLEX_API_VERSION } from "../src/adapters/airwallex-client.js";
import { AirwallexPayoutsAdapter } from "../src/adapters/airwallex-payouts.js";
import { parsePolicy, type Config } from "../src/config.js";
import { Governance } from "../src/governance.js";
import { Store } from "../src/store.js";
import type { CardReference } from "../src/types.js";
import { intent, setup } from "./helpers.js";

/**
 * Every simulated Airwallex answer below is a response example from Airwallex's OpenAPI spec, copied verbatim into
 * fixtures/airwallex-openapi-examples.json. The only edits are made here, on a copy, and are called out where made:
 * a future expires_at (the example's is in 2021) and our own IDs where a test needs them to line up.
 */
const EX = JSON.parse(readFileSync(new URL("./fixtures/airwallex-openapi-examples.json", import.meta.url), "utf8"));
const copy = <T>(v: T): T => structuredClone(v);

/** Fields the spec marks required on IssuingNewCardRequest ("Create a Card"). */
const CARD_CREATE_REQUIRED = ["authorization_controls", "cardholder_id", "created_by", "form_factor", "is_personalized", "program", "request_id"];
/** Fields the spec marks required on "Create a Transfer". */
const TRANSFER_CREATE_REQUIRED = ["reason", "reference", "request_id", "transfer_currency"];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown; query: URLSearchParams };
type Reply = { status?: number; body: unknown };
type Route = (c: Call) => Reply | undefined;

const login = (): Reply => ({ status: 201, body: { ...EX.login_201, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() } });

/** Answers each request with the first route that matches, recording every call. Unmatched requests are a test failure. */
function stubFetch(routes: Route[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      url: u.origin + u.pathname,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      query: u.searchParams,
    };
    calls.push(call);
    const path = u.pathname;
    const reply =
      path === "/api/v1/authentication/login" ? login() : routes.map((r) => r(call)).find((r) => r !== undefined);
    if (!reply) throw new Error(`unexpected ${call.method} ${path}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

const on =
  (method: string, path: string | RegExp, reply: Reply | ((c: Call) => Reply)): Route =>
  (c) => {
    const p = new URL(c.url).pathname;
    if (c.method !== method || (typeof path === "string" ? p !== path : !path.test(p))) return undefined;
    return typeof reply === "function" ? reply(c) : reply;
  };

const CARD_ID = EX.card_create_202.card_id as string;
const cardRoutes = (): Route[] => [
  on("POST", "/api/v1/issuing/cards/create", { status: 202, body: EX.card_create_202 }),
  on("GET", `/api/v1/issuing/cards/${CARD_ID}/details`, { body: EX.card_details_200 }),
];

const cards = (extra: Partial<ConstructorParameters<typeof AirwallexAdapter>[0]> = {}) =>
  new AirwallexAdapter({ clientId: "cid", apiKey: "key", cardholderId: "ch_1", pollIntervalMs: 1, activationWaitMs: 500, ...extra });

const cardReq = {
  intent_id: "int_0123456789abcdef0123",
  amount: 12.4,
  currency: "eur",
  vendor_domain: "pdfocr.io",
  single_use: true,
  memo: "pursestring int_0123456789abcdef0123 invoice-bot/102 pdfocr.io",
};

test("airwallex card: logs in like the SDK, then sends the AgentOS virtual-card body with every spec-required field", async () => {
  const calls = stubFetch(cardRoutes());
  const card = await cards({ createdBy: "Jane Founder" }).issueCard(cardReq);

  const [loginCall, create, details] = calls;
  assert.equal(loginCall.url, "https://api-demo.airwallex.com/api/v1/authentication/login");
  assert.equal(loginCall.method, "POST");
  assert.equal(loginCall.headers["x-client-id"], "cid");
  assert.equal(loginCall.headers["x-api-key"], "key");
  assert.equal(loginCall.body, undefined, "login takes headers only");

  assert.equal(create.url, "https://api-demo.airwallex.com/api/v1/issuing/cards/create");
  assert.equal(create.headers.Authorization, `Bearer ${EX.login_201.token}`);
  assert.equal(create.headers["x-api-version"], AIRWALLEX_API_VERSION);
  assert.deepEqual(create.body, {
    request_id: "int_0123456789abcdef0123",
    cardholder_id: "ch_1",
    created_by: "Jane Founder",
    form_factor: "VIRTUAL",
    is_personalized: false,
    program: { purpose: "COMMERCIAL" },
    nick_name: "pursestring int_0123456789abcdef0123 invoice-bot/1",
    metadata: { intent_id: "int_0123456789abcdef0123", vendor_domain: "pdfocr.io" },
    authorization_controls: {
      allowed_transaction_count: "SINGLE",
      transaction_limits: { currency: "EUR", limits: [{ amount: 12.4, interval: "PER_TRANSACTION" }] },
    },
  });
  for (const f of CARD_CREATE_REQUIRED) assert.ok(f in (create.body as object), `missing required ${f}`);

  assert.equal(details.url, `https://api-demo.airwallex.com/api/v1/issuing/cards/${CARD_ID}/details`);
  assert.equal(details.method, "GET");
  assert.equal(card.token, CARD_ID);
  assert.equal(card.pan, "4111111111111111");
  assert.equal(card.last_four, "1111");
  assert.equal(card.cvv, "123");
  assert.equal(card.exp_month, "01");
  assert.equal(card.exp_year, "2022");
  assert.equal(card.currency, "EUR");
  assert.equal(card.spend_limit, 12.4);
  assert.equal(card.issued_at, EX.card_create_202.created_at);
});

test("airwallex card: a recurring spend gets a MULTIPLE-use card with a MONTHLY cap, and one login serves both cards", async () => {
  const calls = stubFetch(cardRoutes());
  const a = cards();
  await a.issueCard({ ...cardReq, single_use: false, amount: 30, currency: "USD" });
  await a.issueCard({ ...cardReq, intent_id: "int_2", single_use: false, amount: 30, currency: "USD" });
  const body = calls.find((c) => c.url.endsWith("/cards/create"))!.body as any;
  assert.equal(body.created_by, "PurseString", "default created_by");
  assert.deepEqual(body.authorization_controls, {
    allowed_transaction_count: "MULTIPLE",
    transaction_limits: { currency: "USD", limits: [{ amount: 30, interval: "MONTHLY" }] },
  });
  assert.equal(calls.filter((c) => c.url.endsWith("/authentication/login")).length, 1);
});

test("airwallex card: a PENDING card is polled until ACTIVE before the details call (details only work for active cards)", async () => {
  let gets = 0;
  const calls = stubFetch([
    on("POST", "/api/v1/issuing/cards/create", { status: 202, body: { ...copy(EX.card_create_202), card_status: "PENDING" } }),
    on("GET", `/api/v1/issuing/cards/${CARD_ID}`, () => ({
      body: { ...copy(EX.card_get_200), card_id: CARD_ID, card_status: ++gets < 2 ? "PENDING" : "ACTIVE" },
    })),
    on("GET", `/api/v1/issuing/cards/${CARD_ID}/details`, { body: EX.card_details_200 }),
  ]);
  const card = await cards().issueCard(cardReq);
  assert.equal(card.pan, "4111111111111111");
  assert.equal(gets, 2);
  assert.ok(calls.at(-1)!.url.endsWith("/details"));
});

test("airwallex card: a card that ends up FAILED is an error, not a half-issued card", async () => {
  stubFetch([on("POST", "/api/v1/issuing/cards/create", { status: 202, body: { ...copy(EX.card_create_202), card_status: "FAILED" } })]);
  await assert.rejects(cards().issueCard(cardReq), /FAILED, not ACTIVE/);
});

test("airwallex card: a refused replay of the same request_id finds the card by its exact nickname instead of failing", async () => {
  const nick = cardReq.memo.slice(0, 50);
  const listItem = { ...copy(EX.card_list_200.items[0]), card_id: CARD_ID, nick_name: nick };
  const calls = stubFetch([
    on("POST", "/api/v1/issuing/cards/create", { status: 400, body: { code: "bad_request", message: "request_id already used" } }),
    on("GET", "/api/v1/issuing/cards", { body: { has_more: false, items: [listItem] } }),
    on("GET", `/api/v1/issuing/cards/${CARD_ID}/details`, { body: EX.card_details_200 }),
  ]);
  const card = await cards().issueCard(cardReq);
  assert.equal(card.token, CARD_ID);
  const list = calls.find((c) => c.method === "GET" && c.url.endsWith("/api/v1/issuing/cards"))!;
  assert.equal(list.query.get("nick_name"), nick);
  assert.equal(list.query.get("cardholder_id"), "ch_1");
});

test("airwallex card: a real validation error still surfaces when no card exists for the intent", async () => {
  stubFetch([
    on("POST", "/api/v1/issuing/cards/create", { status: 400, body: { code: "field_required", message: "created_by is required" } }),
    on("GET", "/api/v1/issuing/cards", { body: { has_more: false, items: [] } }),
  ]);
  await assert.rejects(cards().issueCard(cardReq), /400 field_required: created_by is required/);
});

test("airwallex: an early 401 logs in again once and retries", async () => {
  let creates = 0;
  const calls = stubFetch([
    on("POST", "/api/v1/issuing/cards/create", () =>
      ++creates === 1 ? { status: 401, body: { code: "credentials_expired", message: "expired" } } : { status: 202, body: EX.card_create_202 },
    ),
    on("GET", `/api/v1/issuing/cards/${CARD_ID}/details`, { body: EX.card_details_200 }),
  ]);
  await cards().issueCard(cardReq);
  assert.equal(calls.filter((c) => c.url.endsWith("/authentication/login")).length, 2);
  assert.equal(creates, 2);
});

test("airwallex card: production uses api.airwallex.com, x-login-as picks the account, and close sets card_status CLOSED", async () => {
  const calls = stubFetch([on("POST", `/api/v1/issuing/cards/${CARD_ID}/update`, { body: EX.card_update_200 })]);
  const ref: CardReference = { adapter: "airwallex", token: CARD_ID, last_four: "1111", issued_at: "", spend_limit: 13, currency: "USD", single_use: true };
  await cards({ environment: "production", loginAs: "acct_abc" }).closeCard(ref);
  assert.equal(calls[0].url, "https://api.airwallex.com/api/v1/authentication/login");
  assert.equal(calls[0].headers["x-login-as"], "acct_abc");
  assert.equal(calls[1].url, `https://api.airwallex.com/api/v1/issuing/cards/${CARD_ID}/update`);
  assert.deepEqual(calls[1].body, { card_status: "CLOSED" });
});

test("airwallex: sandbox refuses a production base_url, so a live key can't be used without environment: production", () => {
  assert.throws(() => cards({ baseUrl: "https://api.airwallex.com" }), /environment: production/);
  assert.doesNotThrow(() => cards({ baseUrl: "https://api.sandbox.airwallex.com" }));
  assert.doesNotThrow(() => cards({ baseUrl: "https://api.airwallex.com", environment: "production" }));
});

test("routing to airwallex without credentials is a clear error", async () => {
  const { gov } = setup({ vendors: { allowlist: ["pdfocr.io"] }, routes: [{ rail: "airwallex" }] });
  const { record } = await gov.submitIntent(intent());
  await assert.rejects(gov.requestCard(record.intent_id), /AIRWALLEX_CLIENT_ID/);
});

// ---- Payouts ----

const BEN_ID = EX.beneficiary_get_200.id as string; // a SWIFT beneficiary receiving AUD
const TRANSFER_ID = EX.transfer_create_201.id as string;
const payouts = (extra: Partial<ConstructorParameters<typeof AirwallexPayoutsAdapter>[0]> = {}) =>
  new AirwallexPayoutsAdapter({ clientId: "cid", apiKey: "key", ...extra });
const payReq = {
  intent_id: "int_0123456789abcdef0123",
  amount: 1250.5,
  currency: "aud",
  payee: { airwallex_beneficiary: BEN_ID },
  note: "Parse invoice PDF for task #102 (PurseString int_0123456789abcdef0123, invoice-bot/102)",
};
const payoutRoutes = (): Route[] => [
  on("GET", `/api/v1/beneficiaries/${BEN_ID}`, { body: EX.beneficiary_get_200 }),
  on("POST", "/api/v1/transfers/create", { status: 201, body: EX.transfer_create_201 }),
  on("GET", `/api/v1/transfers/${TRANSFER_ID}`, { body: EX.transfer_get_200 }),
];

test("airwallex payouts: checks the beneficiary, then sends the developer-MCP create_transfer body with a decimal-string amount", async () => {
  const calls = stubFetch(payoutRoutes());
  const out = await payouts().sendPayout(payReq);
  assert.deepEqual(out, { payment_id: TRANSFER_ID, status: "PROCESSING" });

  const ben = calls[1];
  assert.equal(ben.url, `https://api-demo.airwallex.com/api/v1/beneficiaries/${BEN_ID}`);
  const create = calls[2];
  assert.equal(create.url, "https://api-demo.airwallex.com/api/v1/transfers/create");
  assert.equal(create.method, "POST");
  assert.equal(create.headers["x-api-version"], AIRWALLEX_API_VERSION);
  assert.deepEqual(create.body, {
    request_id: "int_0123456789abcdef0123",
    beneficiary_id: BEN_ID,
    transfer_currency: "AUD",
    transfer_amount: "1250.50",
    source_currency: "AUD",
    transfer_method: "SWIFT",
    fee_paid_by: "PAYER",
    reason: "professional_business_services",
    reference: "PS0123456789abcdef",
    remarks: payReq.note,
    metadata: { pursestring_intent_id: "int_0123456789abcdef0123" },
  });
  for (const f of TRANSFER_CREATE_REQUIRED) assert.ok(f in (create.body as object), `missing required ${f}`);
  assert.equal(((create.body as any).reference as string).length, 18);

  assert.deepEqual(await payouts().getPayout(TRANSFER_ID), { payment_id: TRANSFER_ID, status: "PROCESSING" });
});

test("airwallex payouts: amounts are exact decimal strings for zero- and three-decimal currencies", async () => {
  const mk = (cur: string): Route => on("GET", `/api/v1/beneficiaries/${BEN_ID}`, () => {
    const b = copy(EX.beneficiary_get_200);
    b.beneficiary.bank_details.account_currency = cur;
    return { body: b };
  });
  for (const [cur, amount, expected] of [["JPY", 1500, "1500"], ["KWD", 1.234, "1.234"], ["USD", 0.1 + 0.2, "0.30"]] as const) {
    const calls = stubFetch([mk(cur), on("POST", "/api/v1/transfers/create", { status: 201, body: EX.transfer_create_201 })]);
    await payouts().sendPayout({ ...payReq, currency: cur, amount });
    assert.equal((calls.find((c) => c.method === "POST" && c.url.endsWith("/create"))!.body as any).transfer_amount, expected);
  }
});

test("airwallex payouts: a currency the beneficiary doesn't receive fails before any transfer is created", async () => {
  const calls = stubFetch(payoutRoutes());
  await assert.rejects(payouts().sendPayout({ ...payReq, currency: "USD" }), /receives AUD, but this payment is in USD/);
  assert.equal(calls.filter((c) => c.url.endsWith("/transfers/create")).length, 0);
});

test("airwallex payouts: a configured transfer method must be one the beneficiary was saved with", async () => {
  const calls = stubFetch(payoutRoutes());
  await assert.rejects(payouts({ transferMethod: "LOCAL" }).sendPayout(payReq), /saved for SWIFT, not LOCAL/);
  assert.equal(calls.filter((c) => c.url.endsWith("/transfers/create")).length, 0);
  stubFetch(payoutRoutes());
  await assert.doesNotReject(payouts({ transferMethod: "SWIFT" }).sendPayout(payReq));
});

test("airwallex payouts: a retry after a crash gets request_id_duplicate and returns the transfer named in its details", async () => {
  const dup = copy(EX.transfer_create_400_examples.request_id_duplicate);
  const existing = { ...copy(EX.transfer_get_200), id: dup.details.id, request_id: payReq.intent_id, status: "SENT" };
  const calls = stubFetch([
    on("GET", `/api/v1/beneficiaries/${BEN_ID}`, { body: EX.beneficiary_get_200 }),
    on("POST", "/api/v1/transfers/create", { status: 400, body: dup }),
    on("GET", `/api/v1/transfers/${dup.details.id}`, { body: existing }),
  ]);
  assert.deepEqual(await payouts().sendPayout(payReq), { payment_id: dup.details.id, status: "SENT" });
  assert.equal(calls.filter((c) => c.url.endsWith("/transfers/create")).length, 1, "never a second create");
});

test("airwallex payouts: without a transfer id in the error it looks the transfer up by request_id", async () => {
  const listed = { ...copy(EX.transfer_list_200.items[0]), request_id: payReq.intent_id };
  const calls = stubFetch([
    on("GET", `/api/v1/beneficiaries/${BEN_ID}`, { body: EX.beneficiary_get_200 }),
    on("POST", "/api/v1/transfers/create", { status: 409, body: { code: "request_pending", message: "pending" } }),
    on("GET", "/api/v1/transfers", { body: { ...copy(EX.transfer_list_200), items: [listed] } }),
  ]);
  const out = await payouts().sendPayout(payReq);
  assert.equal(out.payment_id, listed.id);
  const list = calls.find((c) => c.method === "GET" && c.url.endsWith("/api/v1/transfers"))!;
  assert.equal(list.query.get("request_id"), payReq.intent_id);
  assert.equal(list.query.get("page"), "0");
});

test("airwallex payouts: other errors surface Airwallex's code and message", async () => {
  stubFetch([
    on("GET", `/api/v1/beneficiaries/${BEN_ID}`, { body: EX.beneficiary_get_200 }),
    on("POST", "/api/v1/transfers/create", { status: 400, body: EX.transfer_create_400_examples.validation_failed }),
  ]);
  await assert.rejects(payouts().sendPayout(payReq), /400 validation_failed/);
});

test("airwallex payouts through governance: pays only the beneficiary on file, once, and refuses bad beneficiary IDs in policy", async () => {
  assert.throws(() => parsePolicy({ payees: [{ vendor: "x.io", airwallex_beneficiary: "bob" }] }), /UUID/);
  const dir = mkdtempSync(join(tmpdir(), "pursestring-airwallex-"));
  const policy = parsePolicy({
    currency: "AUD",
    vendors: { allowlist: ["pdfocr.io"] },
    routes: [{ rail: "airwallex_payouts" }],
    payees: [
      { vendor: "pdfocr.io", receiver: "billing@pdfocr.io" },
      { vendor: "pdfocr.io", airwallex_beneficiary: BEN_ID },
    ],
  });
  const config: Config = { policy, policyPath: null, homeDir: dir, env: { airwallexClientId: "cid", airwallexApiKey: "key" } };
  const gov = new Governance(config, new Store(dir), new Rails(config), { approvalRequested: async () => {} });
  const calls = stubFetch(payoutRoutes());

  const { record } = await gov.submitIntent(intent({ currency: "AUD", amount: 15 }));
  assert.equal(record.rail, "airwallex_payouts");
  const paid = await gov.sendPayment(record.intent_id);
  assert.equal(paid.payment.adapter, "airwallex_payouts");
  assert.equal(paid.payment.paid_to, BEN_ID);
  assert.equal(paid.payment.payment_id, TRANSFER_ID);
  const create = calls.find((c) => c.url.endsWith("/transfers/create"))!;
  assert.equal((create.body as any).request_id, record.intent_id);
  assert.equal((create.body as any).transfer_amount, "15.00");

  const again = await gov.sendPayment(record.intent_id);
  assert.equal(again.replayed, true);
  assert.equal(calls.filter((c) => c.url.endsWith("/transfers/create")).length, 1, "no second transfer");
});

test("routing to airwallex_payouts needs only the client ID and API key", async () => {
  const { gov } = setup({ vendors: { allowlist: ["pdfocr.io"] }, routes: [{ rail: "airwallex_payouts" }], payees: [{ vendor: "pdfocr.io", airwallex_beneficiary: BEN_ID }] });
  const { record } = await gov.submitIntent(intent());
  await assert.rejects(gov.sendPayment(record.intent_id), /AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY are not both set/);
});
