import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rails } from "../src/adapters/index.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { parsePolicy, type Config } from "../src/config.js";
import { Governance } from "../src/governance.js";
import type { Notifier } from "../src/notify.js";
import { Store } from "../src/store.js";
import type { IntentRecord, PurchaseIntent } from "../src/types.js";

export const POLICY = {
  vendors: { allowlist: ["pdfocr.io", "*.openai.com"], blocklist: ["*.casino"] },
};

export function intent(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  return {
    agent_id: "invoice-bot",
    task_id: "102",
    task_goal: "Parse invoice PDF for task #102",
    vendor_domain: "pdfocr.io",
    amount: 15,
    currency: "USD",
    is_recurring: false,
    alternatives_attempted: ["PyPDF2 (failed OCR)"],
    reasoning: [],
    ...overrides,
  };
}

export function setup(policy: unknown = POLICY) {
  const dir = mkdtempSync(join(tmpdir(), "pursestring-test-"));
  const config: Config = { policy: parsePolicy(policy), policyPath: null, homeDir: dir, env: {} };
  const store = new Store(dir);
  const pinged: IntentRecord[] = [];
  const notifier: Notifier = { approvalRequested: async (r) => void pinged.push(r) };
  const adapter = new MockAdapter();
  let issued = 0;
  const countingAdapter = {
    name: adapter.name,
    kind: adapter.kind,
    closeCard: adapter.closeCard.bind(adapter),
    issueCard: async (req: Parameters<MockAdapter["issueCard"]>[0]) => {
      issued++;
      return adapter.issueCard(req);
    },
    getCard: adapter.getCard.bind(adapter),
  };
  const gov = new Governance(config, store, new Rails(config, { mock: countingAdapter }), notifier);
  return { gov, store, pinged, dir, adapter, issuedCount: () => issued };
}
