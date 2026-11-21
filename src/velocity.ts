import type { Policy } from "./config.js";
import type { RuleResult } from "./types.js";
import type { IntentRecord } from "./types.js";

export const VELOCITY_RULE = "hard_limits.velocity";

/** Whether this intent was itself turned away by the velocity limit. Those don't count, so the window can drain. */
function deniedByVelocity(r: IntentRecord): boolean {
  return r.evaluation.rules.some((x) => x.rule === VELOCITY_RULE && !x.passed);
}

/**
 * The agent's intents that count against its velocity limit right now: every new intent it submitted inside the
 * rolling window, whatever the vendor, rail, amount or outcome, except ones the limit itself refused. A retry with
 * the same idempotency key returns the original record instead of making a new one, so it never shows up here.
 */
export function recentIntents(policy: Policy, intents: Record<string, IntentRecord>, agentId: string, now: Date): IntentRecord[] {
  const v = policy.hard_limits.velocity;
  const since = now.getTime() - v.window_minutes * 60_000;
  const agent = agentId.trim();
  return Object.values(intents).filter(
    (r) => r.intent.agent_id.trim() === agent && new Date(r.created_at).getTime() > since && !deniedByVelocity(r),
  );
}

/** The velocity rule for a new intent from this agent, or undefined when the limit is off. Run it inside the store lock. */
export function velocityRule(policy: Policy, intents: Record<string, IntentRecord>, agentId: string, now: Date): RuleResult | undefined {
  const v = policy.hard_limits.velocity;
  if (!v.enabled) return undefined;
  const used = recentIntents(policy, intents, agentId, now).length;
  const passed = used < v.max_intents;
  return {
    rule: VELOCITY_RULE,
    passed,
    effect: "deny",
    detail: passed
      ? `${used + 1} of ${v.max_intents} intents allowed in ${v.window_minutes} minutes`
      : `velocity limit: ${agentId.trim()} already submitted ${used} spend intents in the last ${v.window_minutes} ` +
        `minutes (limit ${v.max_intents}, any vendor). Wait for older ones to age out, or ask a human to raise ` +
        `hard_limits.velocity.max_intents.`,
  };
}
