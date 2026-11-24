import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Rails } from "../src/adapters/index.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { parsePolicy, policyHash, type Config } from "../src/config.js";
import { Governance, GovernanceError } from "../src/governance.js";
import { WebhookNotifier } from "../src/notify.js";
import { Store } from "../src/store.js";
import type { IntentRecord } from "../src/types.js";
import { encodeB64Json, USDC } from "../src/x402.js";
import { intent, POLICY, setup } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A second PurseString process over the same state directory, running `policy`: what you get when someone edits
 * policies.yaml and restarts the server between the decision and the payment.
 */
function restartWith(dir: string, policy: unknown, env: Config["env"] = {}) {
  const config: Config = { policy: parsePolicy(policy), policyPath: null, homeDir: dir, env };
  const pinged: IntentRecord[] = [];
  const gov = new Governance(config, new Store(dir), new Rails(config, { mock: new MockAdapter() }), {
    approvalRequested: async (r) => {
      pinged.push(r);
    },
  });
  return { gov, pinged };
}

const stale = (e: GovernanceError) => e.code === "stale_evidence";

test("the policy hash ignores key order but changes with any rule", () => {
  const a = policyHash(parsePolicy({ vendors: { allowlist: ["pdfocr.io"], blocklist: ["*.casino"] } }));
  const b = policyHash(parsePolicy({ vendors: { blocklist: ["*.casino"], allowlist: ["pdfocr.io"] } }));
  const c = policyHash(parsePolicy({ vendors: { allowlist: ["pdfocr.io"], blocklist: ["*.casino"] }, hard_limits: { max_amount: 999 } }));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("every audit entry and every intent carries the policy hash, and the chain still verifies", async () => {
  const { gov, store } = setup();
  const { record } = await gov.submitIntent(intent());
  gov.checkCompliance(intent({ amount: 20 }));
  await gov.requestCard(record.intent_id);
  const entries = store.readAudit();
  assert.ok(entries.length >= 3);
  for (const e of entries) assert.equal(e.policy_hash, gov.policyHash, `${e.event} is stamped`);
  assert.equal(store.verifyAudit().ok, true);

  const ev = store.get(record.intent_id)!.evidence!;
  assert.equal(ev.policy_hash, gov.policyHash);
  assert.equal(ev.vendor, "pdfocr.io");
  assert.equal(ev.rail, "mock");
  assert.ok(!Number.isNaN(Date.parse(ev.observed_at)));
  const submitted = entries.find((e) => e.event === "intent_submitted") as { evidence: { policy_hash: string } };
  assert.equal(submitted.evidence.policy_hash, gov.policyHash);
  const issued = entries.find((e) => e.event === "card_issued") as { recheck: { outcome: string } };
  assert.equal(issued.recheck.outcome, "unchanged");
});

test("a human approval made under the old policy is refused if the new policy denies the vendor", async () => {
  const { gov, dir, issuedCount } = setup();
  const { record } = await gov.submitIntent(intent({ amount: 80 })); // over the approval threshold
  assert.equal(record.status, "pending_approval");
  gov.decide(record.intent_id, true, "maya", undefined, { via: "http" });

  const later = restartWith(dir, { vendors: { allowlist: ["*.openai.com"], blocklist: ["pdfocr.io"] } });
  await assert.rejects(later.gov.requestCard(record.intent_id), stale);
  assert.equal(issuedCount(), 0);

  const rec = later.gov.store.get(record.intent_id)!;
  assert.equal(rec.status, "denied", "the denial is saved, not rolled back with the throw");
  assert.equal(rec.denied_by, "policy:execution_recheck");
  assert.equal(rec.recheck?.outcome, "rejected");
  assert.equal(rec.recheck?.policy_hash, later.gov.policyHash);

  const entry = later.gov.store.readAudit().find((e) => e.event === "execution_recheck_failed")!;
  assert.equal(entry.policy_hash, later.gov.policyHash);
  assert.equal(entry.decided_under_policy_hash, gov.policyHash);
  assert.notEqual(entry.policy_hash, entry.decided_under_policy_hash);
  const approved = later.gov.store.readAudit().find((e) => e.event === "human_approved")!;
  assert.equal(approved.decided_under_policy_hash, gov.policyHash);
  assert.equal(later.gov.store.verifyAudit().ok, true);

  // A retry doesn't get another chance: the intent stays denied.
  await assert.rejects(later.gov.requestCard(record.intent_id), (e: GovernanceError) => e.code === "denied");
});

test("a policy change that still allows the purchase goes ahead and is logged as re-evaluated", async () => {
  const { gov, dir } = setup();
  const { record } = await gov.submitIntent(intent());
  const later = restartWith(dir, { ...POLICY, hard_limits: { per_agent_daily_budget: 500 } });
  const out = await later.gov.requestCard(record.intent_id);
  assert.equal(out.replayed, false);
  assert.equal(out.record.recheck?.outcome, "re_evaluated");
  const issued = later.gov.store.readAudit().find((e) => e.event === "card_issued") as { policy_hash: string; recheck: { outcome: string } };
  assert.equal(issued.recheck.outcome, "re_evaluated");
  assert.equal(issued.policy_hash, later.gov.policyHash);
});

test("a policy that now routes the vendor to another rail refuses the old approval", async () => {
  const { gov, dir } = setup();
  const { record } = await gov.submitIntent(intent());
  const later = restartWith(dir, { ...POLICY, routes: [{ rail: "paypal", vendors: ["pdfocr.io"] }] });
  await assert.rejects(later.gov.requestCard(record.intent_id), (e: GovernanceError) => stale(e) && /'paypal' rail/.test(e.message));
});

type Call = { url: string; method: string; body: string };
function stubStripe(calls: Call[]) {
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
    return new Response(JSON.stringify({ id: "tr_1", reversed: false }), { status: 200 });
  }) as typeof fetch;
}

const STRIPE = (account: string | null) => ({
  vendors: { allowlist: ["pdfocr.io"] },
  routes: [{ rail: "stripe_connect", vendors: ["pdfocr.io"] }],
  payees: account ? [{ vendor: "pdfocr.io", stripe_account: account }] : [],
});
const STRIPE_ENV = { stripeSecretKey: "sk_test_x" };

test("a payee swapped in policies.yaml after approval is never paid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pursestring-recheck-"));
  const calls: Call[] = [];
  stubStripe(calls);
  const before = restartWith(dir, STRIPE("acct_pdf"), STRIPE_ENV);
  const { record } = await before.gov.submitIntent(intent({ amount: 80 }));
  assert.equal(record.evidence?.payee?.destination, "acct_pdf");
  assert.equal(record.evidence?.payee?.source, "policies.yaml#payees");
  assert.equal(before.pinged.length, 1);
  before.gov.decide(record.intent_id, true, "maya", undefined, { via: "http" });

  const after = restartWith(dir, STRIPE("acct_evil"), STRIPE_ENV);
  await assert.rejects(
    after.gov.sendPayment(record.intent_id),
    (e: GovernanceError) => stale(e) && /approved acct_pdf/.test(e.message) && /acct_evil/.test(e.message),
  );
  assert.equal(calls.length, 0, "no transfer was sent");
  assert.equal(after.gov.store.get(record.intent_id)!.status, "denied");
  const entry = after.gov.store.readAudit().find((e) => e.event === "execution_recheck_failed")!;
  assert.equal(entry.approved_payee, "acct_pdf");

  // The original payee pays as approved.
  const ok = await before.gov.submitIntent(intent({ task_id: "103" }));
  const paid = await before.gov.sendPayment(ok.record.intent_id);
  assert.equal(paid.payment.paid_to, "acct_pdf");
  const sent = before.gov.store.readAudit().find((e) => e.event === "payment_sent")!;
  assert.equal(sent.payee_source, "policies.yaml#payees");
  assert.equal((sent.recheck as { outcome: string }).outcome, "unchanged");
});

test("a payee removed after approval is refused, and one added after approval is recorded as such", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pursestring-recheck-"));
  const calls: Call[] = [];
  stubStripe(calls);
  const withPayee = restartWith(dir, STRIPE("acct_pdf"), STRIPE_ENV);
  const removed = await withPayee.gov.submitIntent(intent());
  await assert.rejects(restartWith(dir, STRIPE(null), STRIPE_ENV).gov.sendPayment(removed.record.intent_id), stale);

  // Submitted before any payee was on file; a human adds it, and the payment goes to what they added.
  const none = restartWith(dir, STRIPE(null), STRIPE_ENV);
  const early = await none.gov.submitIntent(intent({ task_id: "104" }));
  assert.equal(early.record.evidence?.payee, undefined);
  await assert.rejects(none.gov.sendPayment(early.record.intent_id), (e: GovernanceError) => e.code === "no_payee");
  const paid = await withPayee.gov.sendPayment(early.record.intent_id);
  assert.equal(paid.payment.paid_to, "acct_pdf");
  assert.equal(paid.record.evidence?.payee?.destination, "acct_pdf");
  assert.ok(paid.record.evidence?.payee_added_after_decision);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("the approval message shows the payee the human is approving", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pursestring-recheck-"));
  const { gov, pinged } = restartWith(dir, STRIPE("acct_pdf"), STRIPE_ENV);
  await gov.submitIntent(intent({ amount: 80 }));
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    bodies.push(String(init.body));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  await new WebhookNotifier({ ...gov.config, env: { discordWebhookUrl: "https://discord.example/hook" } }).approvalRequested(pinged[0]);
  assert.match(bodies[0], /Pays to:\*\* acct_pdf \(payee on file in policies\.yaml\)/);
});

test("legacy intents with no evidence are checked against today's policy", async () => {
  const { gov, dir, store } = setup();
  const { record } = await gov.submitIntent(intent());
  store.transact((intents) => {
    delete intents[record.intent_id].evidence;
  });
  const later = restartWith(dir, { vendors: { allowlist: [], blocklist: ["pdfocr.io"] } });
  await assert.rejects(later.gov.requestCard(record.intent_id), stale);

  const fine = await gov.submitIntent(intent({ task_id: "105" }));
  store.transact((intents) => {
    delete intents[fine.record.intent_id].evidence;
  });
  const out = await gov.requestCard(fine.record.intent_id);
  assert.equal(out.record.recheck?.outcome, "no_evidence");
});

// x402: a signed authorization that is re-sent on retry must still go to the pinned address.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const X402 = (pin?: string) => ({
  vendors: { allowlist: ["api.weather.example"] },
  x402: { enabled: true, ...(pin ? { pay_to: [{ vendor: "api.weather.example", address: pin }] } : {}) },
});

test("a re-sent x402 authorization is refused once its payTo is no longer pinned", async () => {
  let paidRequests = 0;
  let refuse = true;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const pay = new Headers(init.headers).get("payment-signature");
    const accept = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: USDC[84532].address,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    };
    if (!pay) {
      const doc = { x402Version: 2, error: "payment required", resource: { url: String(url) }, accepts: [accept] };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodeB64Json(doc) } });
    }
    paidRequests++;
    if (refuse) {
      refuse = false;
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-RESPONSE": encodeB64Json({ success: false, errorReason: "insufficient_funds", transaction: "", network: accept.network }) },
      });
    }
    return new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": encodeB64Json({ success: true, transaction: "0xabc", network: accept.network }) } });
  }) as typeof fetch;

  const { gov, dir } = setup(X402(PAY_TO), { x402PrivateKey: KEY });
  const call = { agent_id: "research-bot", task_id: "t1", task_goal: "Get the hourly forecast for the trip report", url: "https://api.weather.example/f", alternatives_attempted: ["none free"] };
  await assert.rejects(gov.x402Fetch(call), (e: GovernanceError) => e.code === "payment_refused");
  const rec = gov.store.list((r) => Boolean(r.x402))[0];
  assert.equal(rec.evidence?.x402?.pay_to, PAY_TO);
  assert.equal(rec.evidence?.x402?.source, "https://api.weather.example/f");

  const later = restartWith(dir, X402("0x1111111111111111111111111111111111111111"), { x402PrivateKey: KEY });
  await assert.rejects(later.gov.x402Fetch({ ...call, intent_id: rec.intent_id }), (e: GovernanceError) => stale(e) && /pinned/.test(e.message));
  assert.equal(paidRequests, 1, "the authorization was not sent again");
});
