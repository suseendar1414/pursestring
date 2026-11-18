import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GovernanceError } from "../src/governance.js";
import { atomicToCents, encodeB64Json, parseChallenge, USDC, X402Wallet } from "../src/x402.js";
import { intent, setup } from "./helpers.js";

/** A well-known test key (Hardhat/Anvil account #1). Never holds real funds. */
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const SEPOLIA_USDC = USDC[84532].address;
const URL_ = "https://api.weather.example/forecast";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface Server {
  /** Payment headers received, decoded. */
  payments: Record<string, any>[];
  /** Raw payment header values received. */
  raw: string[];
  requests: number;
  /** Make the next paid request fail like a facilitator refusing it. */
  refuseNext?: boolean;
  amount: string;
}

/** A tiny x402 resource server: 402 with requirements until it sees a payment header, then 200 + settlement. */
function x402Server(opts: { version?: 1 | 2; amount?: string; network?: string; payTo?: string } = {}): Server {
  const version = opts.version ?? 2;
  const srv: Server = { payments: [], raw: [], requests: 0, amount: opts.amount ?? "10000" };
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    srv.requests++;
    const h = new Headers(init.headers);
    const pay = h.get(version === 1 ? "x-payment" : "payment-signature");
    const accept = {
      scheme: "exact",
      network: opts.network ?? (version === 1 ? "base-sepolia" : "eip155:84532"),
      ...(version === 1 ? { maxAmountRequired: srv.amount, resource: String(url) } : { amount: srv.amount }),
      asset: SEPOLIA_USDC,
      payTo: opts.payTo ?? PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    };
    if (!pay) {
      const doc = { x402Version: version, error: "payment required", resource: { url: String(url) }, accepts: [accept] };
      return version === 1
        ? new Response(JSON.stringify(doc), { status: 402, headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodeB64Json(doc) } });
    }
    srv.raw.push(pay);
    srv.payments.push(JSON.parse(Buffer.from(pay, "base64").toString("utf8")));
    if (srv.refuseNext) {
      srv.refuseNext = false;
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-RESPONSE": encodeB64Json({ success: false, errorReason: "insufficient_funds", transaction: "", network: accept.network }) },
      });
    }
    const settle = encodeB64Json({ success: true, transaction: "0xabc123", network: accept.network, payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
    return new Response(JSON.stringify({ forecast: "sunny" }), {
      status: 200,
      headers: { "content-type": "application/json", [version === 1 ? "X-PAYMENT-RESPONSE" : "PAYMENT-RESPONSE"]: settle },
    });
  }) as typeof fetch;
  return srv;
}

const POLICY = {
  vendors: { allowlist: ["api.weather.example"] },
  x402: { enabled: true },
};

function x402Setup(policy: unknown = POLICY) {
  return setup(policy, { x402PrivateKey: KEY });
}

const call = (overrides: Record<string, unknown> = {}) => ({
  agent_id: "research-bot",
  task_id: "t1",
  task_goal: "Get the weather forecast for the trip report",
  url: URL_,
  alternatives_attempted: ["free NOAA feed had no hourly data"],
  ...overrides,
});

test("the wallet's EIP-3009 signature verifies with an independent EIP-712 implementation", async () => {
  const w = new X402Wallet(KEY);
  assert.equal(w.address, privateKeyToAccount(KEY).address);
  const challenge = parseChallenge(
    new Headers({ "PAYMENT-REQUIRED": encodeB64Json({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:84532", amount: "10000", asset: SEPOLIA_USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }] }) }),
    "",
  )!;
  const { signature, authorization: a } = w.authorize(challenge.accepts[0], new Date());
  const ok = await verifyTypedData({
    address: w.address as `0x${string}`,
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: SEPOLIA_USDC },
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from: a.from as `0x${string}`, to: a.to as `0x${string}`, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as `0x${string}` },
    signature: signature as `0x${string}`,
  });
  assert.equal(ok, true);
  assert.equal(a.to, PAY_TO);
  assert.equal(a.value, "10000");
});

test("sub-cent prices are budgeted as a full cent; whole cents stay exact", () => {
  assert.equal(atomicToCents("1000"), 1); // $0.001
  assert.equal(atomicToCents("10000"), 1); // $0.01
  assert.equal(atomicToCents("10001"), 2);
  assert.equal(atomicToCents("1500000"), 150); // $1.50
});

test("an auto-approved x402 call pays once and a repeat returns the stored response", async () => {
  const srv = x402Server();
  const { gov, store } = x402Setup();
  const out = await gov.x402Fetch(call());
  assert.equal(out.paid, true);
  assert.equal(out.response?.status, 200);
  assert.match(out.response!.body, /sunny/);
  assert.equal(out.transaction, "0xabc123");
  assert.equal(out.record?.rail, "x402");
  assert.equal(out.record?.intent.amount, 0.01);
  assert.equal(out.record?.payment?.paid_to, PAY_TO);

  const p = srv.payments[0];
  assert.equal(p.x402Version, 2);
  assert.equal(p.accepted.payTo, PAY_TO);
  assert.equal(p.payload.authorization.value, "10000");
  assert.equal(p.payload.authorization.from, privateKeyToAccount(KEY).address);
  assert.ok(Number(p.payload.authorization.validBefore) - Date.now() / 1000 <= 61);

  const again = await gov.x402Fetch(call());
  assert.equal(again.replayed, true);
  assert.match(again.response!.body, /sunny/);
  assert.equal(srv.payments.length, 1, "no second payment");
  const again2 = await gov.x402Fetch(call({ intent_id: out.record!.intent_id }));
  assert.equal(again2.replayed, true);
  assert.equal(srv.payments.length, 1);
  assert.ok(store.readAudit(50).some((e) => e.event === "payment_sent" && e.adapter === "x402" && e.amount_atomic === "10000"));
});

test("x402 v1 servers get an X-PAYMENT header", async () => {
  const srv = x402Server({ version: 1 });
  const { gov } = x402Setup();
  const out = await gov.x402Fetch(call());
  assert.equal(out.paid, true);
  assert.equal(srv.payments[0].x402Version, 1);
  assert.equal(srv.payments[0].network, "base-sepolia");
  assert.equal(out.record?.x402?.network, "eip155:84532");
});

test("a free resource comes straight back with no intent", async () => {
  globalThis.fetch = (async () => new Response("hello", { status: 200 })) as typeof fetch;
  const { gov } = x402Setup();
  const out = await gov.x402Fetch(call());
  assert.equal(out.paid, false);
  assert.equal(out.record, undefined);
  assert.equal(out.response?.body, "hello");
});

test("a price over the approval threshold waits for a human, then pays exactly what was approved", async () => {
  const srv = x402Server({ amount: "80000000" }); // $80
  const { gov } = x402Setup();
  const first = await gov.x402Fetch(call());
  assert.equal(first.paid, false);
  assert.equal(first.record?.status, "pending_approval");
  assert.equal(srv.payments.length, 0);

  gov.decide(first.record!.intent_id, true, "maya", undefined, { via: "http" });
  srv.amount = "90000000"; // the server raised the price after approval
  await assert.rejects(gov.x402Fetch(call({ intent_id: first.record!.intent_id })), (e: GovernanceError) => e.code === "price_changed");
  assert.equal(srv.payments.length, 0);

  srv.amount = "80000000";
  const paid = await gov.x402Fetch(call({ intent_id: first.record!.intent_id }));
  assert.equal(paid.paid, true);
  assert.equal(srv.payments.length, 1);
});

test("a refused payment is retried with the very same authorization, so it can't settle twice", async () => {
  const srv = x402Server();
  srv.refuseNext = true;
  const { gov } = x402Setup();
  await assert.rejects(gov.x402Fetch(call()), (e: GovernanceError) => e.code === "payment_refused" && /insufficient_funds/.test(e.message));
  const rec = gov.store.list((r) => Boolean(r.x402))[0];
  assert.equal(rec.status, "approved");
  const out = await gov.x402Fetch(call({ intent_id: rec.intent_id }));
  assert.equal(out.paid, true);
  assert.equal(srv.raw.length, 2);
  assert.equal(srv.raw[0], srv.raw[1], "same signed payload both times");
});

test("x402 refuses unknown networks, non-USDC assets, unpinned payees, non-https and a halted agent", async () => {
  x402Server({ network: "eip155:8453" });
  const { gov } = x402Setup();
  await assert.rejects(gov.x402Fetch(call()), (e: GovernanceError) => e.code === "x402_unsupported" && /x402\.networks/.test(e.message));

  x402Server({ payTo: "0x1111111111111111111111111111111111111111" });
  const pinned = x402Setup({ ...POLICY, x402: { enabled: true, pay_to: [{ vendor: "api.weather.example", address: PAY_TO }] } });
  await assert.rejects(pinned.gov.x402Fetch(call()), (e: GovernanceError) => e.code === "x402_unsupported" && /pinned/.test(e.message));

  await assert.rejects(gov.x402Fetch(call({ url: "http://api.weather.example/x" })), (e: GovernanceError) => e.code === "bad_url");

  const srv = x402Server();
  await gov.halt({ agent_id: "research-bot", reason: "test", by: "maya", via: "http" });
  const out = await gov.x402Fetch(call({ task_id: "t9" }));
  assert.equal(out.paid, false);
  assert.equal(out.record?.status, "denied");
  assert.equal(srv.payments.length, 0);
});

test("x402 payments count toward the daily budget and other rails refuse x402 intents", async () => {
  x402Server({ amount: "15000000" }); // $15
  const { gov } = x402Setup({ ...POLICY, hard_limits: { per_agent_daily_budget: 20 } });
  const a = await gov.x402Fetch(call({ task_id: "a" }));
  assert.equal(a.paid, true);
  await assert.rejects(gov.requestCard(a.record!.intent_id), (e: GovernanceError) => e.code === "x402_rail");
  const b = await gov.x402Fetch(call({ task_id: "b" }));
  assert.equal(b.paid, false);
  assert.equal(b.record?.status, "pending_approval");
  const card = await gov.submitIntent(intent({ agent_id: "research-bot", vendor_domain: "api.weather.example", amount: 10, task_id: "c" }));
  assert.equal(card.record.status, "pending_approval", "the $15 x402 payment used the budget");
});

test("x402 is off unless enabled", async () => {
  const { gov } = setup({ vendors: { allowlist: [] } }, { x402PrivateKey: KEY });
  await assert.rejects(gov.x402Fetch(call()), (e: GovernanceError) => e.code === "x402_disabled");
});
