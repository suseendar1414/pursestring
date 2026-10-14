import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePolicy } from "../src/config.js";
import { GovernanceError } from "../src/governance.js";
import { routeRail, vendorLabel } from "../src/policy.js";
import { intent, setup } from "./helpers.js";

const ROUTES = {
  vendors: { allowlist: ["pdfocr.io"] },
  routes: [
    { rail: "ach", min_amount: 1000 },
    { rail: "amex", vendors: ["*.salesforce.com"] },
    { rail: "highnote", recurring: true },
  ],
  hard_limits: { max_amount: 50000 },
};

test("routes pick the rail by amount, vendor and recurrence; first match wins", () => {
  const p = parsePolicy(ROUTES);
  assert.equal(routeRail(p, intent({ amount: 15 })).rail, "mock");
  assert.equal(routeRail(p, intent({ amount: 2500 })).rail, "ach");
  assert.equal(routeRail(p, intent({ amount: 2500, vendor_domain: "login.salesforce.com" })).rail, "ach");
  assert.equal(routeRail(p, intent({ amount: 40, vendor_domain: "salesforce.com" })).rail, "amex");
  assert.equal(routeRail(p, intent({ is_recurring: true })).rail, "highnote");
});

test("the chosen rail is recorded on the intent", async () => {
  const { gov } = setup(ROUTES);
  const { record } = await gov.submitIntent(intent({ amount: 2500 }));
  assert.equal(record.rail, "ach");
});

test("a bank-transfer route never yields a card", async () => {
  const { gov } = setup(ROUTES);
  const { record } = await gov.submitIntent(intent({ amount: 2500 }));
  gov.decide(record.intent_id, true, "cfo");
  await assert.rejects(gov.requestCard(record.intent_id), (e: GovernanceError) => e.code === "bank_transfer_rail");
});

test("a planned card rail fails safely with a pointer to its issue", async () => {
  const { gov } = setup(ROUTES);
  const { record } = await gov.submitIntent(intent({ is_recurring: true }));
  gov.decide(record.intent_id, true, "alice");
  await assert.rejects(
    gov.requestCard(record.intent_id),
    (e: GovernanceError) => e.code === "adapter_error" && /highnote rail .* isn't implemented yet/.test(e.message),
  );
  assert.equal(gov.store.get(record.intent_id)?.status, "approved", "intent goes back to approved, no card recorded");
});

test("routing to lithic without a key is a clear error", async () => {
  const { gov } = setup({ vendors: { allowlist: ["pdfocr.io"] }, routes: [{ rail: "lithic" }] });
  const { record } = await gov.submitIntent(intent());
  await assert.rejects(gov.requestCard(record.intent_id), /LITHIC_API_KEY/);
});

test("vendor label for merchant matching", () => {
  assert.equal(vendorLabel("https://www.pdfocr.io/buy"), "pdfocr");
  assert.equal(vendorLabel("shop.example.co.uk"), "example");
  assert.equal(vendorLabel("api.open-ai.com"), "openai");
});
