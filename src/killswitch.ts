import type { ApprovalChannel, ApprovalCodeHash } from "./approvals.js";
import type { Policy } from "./config.js";
import { toMinor } from "./money.js";
import { normalizeDomain } from "./policy.js";
import type { IntentRecord, PurchaseIntent } from "./types.js";

/** Who halted spending and why. Kept after a resume, with resumed_at set, as history. */
export interface HaltRecord {
  /** "all" stops every agent; "agent" stops one. */
  scope: "all" | "agent";
  agent_id?: string;
  reason: string;
  /** Who pulled it: a person's name, or "policy:loop_detection". */
  by: string;
  via: ApprovalChannel | "loop_detector";
  tripped_at: string;
  /** For a loop-detection halt: the intents that looked like a loop. */
  intent_ids?: string[];
  /** Hash of the one-time code sent to Slack or Discord; a terminal resume needs it when codes are required. */
  resume_code?: ApprovalCodeHash;
  resume_code_attempts?: number;
  resumed_at?: string;
  resumed_by?: string;
  resumed_via?: ApprovalChannel;
}

export type Halts = Record<string, HaltRecord>;

/** "*" is the global switch; "agent:<id>" is one agent's. */
export const haltKey = (agentId?: string) => (agentId ? `agent:${agentId.trim()}` : "*");

/** The halt that stops this agent right now, if any. The global switch wins over the agent's own. */
export function activeHalt(halts: Halts, agentId: string): HaltRecord | undefined {
  const all = halts["*"];
  if (all && !all.resumed_at) return all;
  const own = halts[haltKey(agentId)];
  return own && !own.resumed_at ? own : undefined;
}

/** Whether two intents look like the same purchase made again: same agent and vendor, amount within tolerance. */
function similar(policy: Policy, a: PurchaseIntent, b: PurchaseIntent): boolean {
  if (a.agent_id.trim() !== b.agent_id.trim()) return false;
  if (normalizeDomain(a.vendor_domain) !== normalizeDomain(b.vendor_domain)) return false;
  if (a.currency.toUpperCase() !== b.currency.toUpperCase()) return false;
  // Whole minor units and basis points, so "within 10%" is exact: 15.00 vs 16.50 is in, 16.51 is out.
  const x = toMinor(a.amount, a.currency);
  const y = toMinor(b.amount, b.currency);
  const bp = Math.round(policy.kill_switch.loop_detection.amount_tolerance_percent * 100);
  return Math.abs(x - y) * 10_000 <= Math.max(x, y) * bp;
}

/**
 * Earlier intents in the loop-detection window that look like this one. Each one has its own idempotency key, so
 * these are new purchases, not retries: an agent re-buying the same thing under fresh task IDs. Intents from before
 * the agent was last resumed don't count, so a resume isn't tripped again by the loop it was resumed from.
 */
export function similarRecent(
  policy: Policy,
  intents: Record<string, IntentRecord>,
  halts: Halts,
  intent: PurchaseIntent,
  now: Date,
): IntentRecord[] {
  const ld = policy.kill_switch.loop_detection;
  let since = now.getTime() - ld.window_minutes * 60_000;
  for (const key of ["*", haltKey(intent.agent_id)]) {
    const resumed = halts[key]?.resumed_at;
    if (resumed) since = Math.max(since, new Date(resumed).getTime());
  }
  return Object.values(intents)
    .filter((r) => !r.action && new Date(r.created_at).getTime() >= since && similar(policy, r.intent, intent))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
