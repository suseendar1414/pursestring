// Run by concurrency.test.ts in its own process: submits one intent against a shared state directory and prints the
// result, so several processes race on the same state.json and lock the way a server and the CLI would.
import { Rails } from "../../src/adapters/index.js";
import { parsePolicy, type Config } from "../../src/config.js";
import { Governance } from "../../src/governance.js";
import { Store } from "../../src/store.js";

const [dir, taskId, lineItem] = process.argv.slice(2);
const config: Config = {
  policy: parsePolicy({ vendors: { allowlist: ["pdfocr.io"] }, hard_limits: { per_agent_daily_budget: 40 } }),
  policyPath: null,
  homeDir: dir,
  env: {},
};
const gov = new Governance(config, new Store(dir), new Rails(config), { approvalRequested: async () => {} });
const { record, deduplicated } = await gov.submitIntent({
  agent_id: "invoice-bot",
  task_id: taskId,
  ...(lineItem ? { line_item_id: lineItem } : {}),
  task_goal: "Parse invoice PDF for a race test",
  vendor_domain: "pdfocr.io",
  amount: 15,
  currency: "USD",
  is_recurring: false,
  alternatives_attempted: ["PyPDF2 (failed OCR)"],
  reasoning: [],
});
let card = "none";
try {
  card = (await gov.requestCard(record.intent_id)).replayed ? "replayed" : "issued";
} catch (err) {
  card = (err as { code?: string }).code ?? "error";
}
console.log(JSON.stringify({ intent_id: record.intent_id, deduplicated, card }));
