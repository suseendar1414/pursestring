import type { Policy } from "./config.js";
import type { Decision, PolicyEvaluation, PurchaseIntent, RuleResult } from "./types.js";

/** Lowercase a vendor string and strip scheme, credentials, port, path and a leading "www.". */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  d = d.split(/[/?#]/)[0];
  d = d.replace(/^.*@/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return d.replace(/^www\./, "");
}

/** "example.com" matches only itself; "*.example.com" matches example.com and any subdomain. */
export function domainMatches(domain: string, pattern: string): boolean {
  const d = normalizeDomain(domain);
  const p = pattern.trim().toLowerCase();
  if (p.startsWith("*.")) {
    const base = normalizeDomain(p.slice(2));
    return d === base || d.endsWith("." + base);
  }
  return d === normalizeDomain(p);
}

export function isAllowlisted(policy: Policy, domain: string): boolean {
  return policy.vendors.allowlist.some((p) => domainMatches(domain, p));
}

export function isBlocklisted(policy: Policy, domain: string): boolean {
  return policy.vendors.blocklist.some((p) => domainMatches(domain, p));
}

const fmt = (n: number, c: string) => `${n.toFixed(2)} ${c}`;

/**
 * Evaluate an intent against the policy. Pure: everything it needs is passed in,
 * so the same call powers the dry-run tool and the real submission.
 */
export function evaluate(
  policy: Policy,
  intent: PurchaseIntent,
  ctx: { spentTodayByAgent: number },
): PolicyEvaluation {
  const rules: RuleResult[] = [];
  const add = (rule: string, passed: boolean, effect: Decision, detail: string) =>
    rules.push({ rule, passed, effect, detail });
  const cur = policy.currency;
  const amt = intent.amount;
  const allowlisted = isAllowlisted(policy, intent.vendor_domain);

  // Hard refusals: no human can approve these.
  add(
    "hard_limits.max_amount",
    amt <= policy.hard_limits.max_amount,
    "deny",
    `${fmt(amt, cur)} vs hard cap ${fmt(policy.hard_limits.max_amount, cur)}`,
  );
  add(
    "vendors.blocklist",
    !isBlocklisted(policy, intent.vendor_domain),
    "deny",
    `${normalizeDomain(intent.vendor_domain)} ${isBlocklisted(policy, intent.vendor_domain) ? "is" : "is not"} blocklisted`,
  );
  add(
    "currency",
    intent.currency.toUpperCase() === cur.toUpperCase(),
    "deny",
    `intent currency ${intent.currency.toUpperCase()}, policy currency ${cur}`,
  );

  // Intent quality: the agent must say why, and what it tried first.
  add(
    "intent.task_goal",
    intent.task_goal.trim().length >= policy.intent.min_goal_length,
    "require_approval",
    `goal is ${intent.task_goal.trim().length} chars, minimum ${policy.intent.min_goal_length}`,
  );
  if (policy.intent.require_alternatives) {
    add(
      "intent.alternatives_attempted",
      intent.alternatives_attempted.length > 0,
      "require_approval",
      intent.alternatives_attempted.length > 0
        ? `tried: ${intent.alternatives_attempted.join("; ")}`
        : "no alternatives listed before paying",
    );
  }

  // Reversibility: things a human must see.
  if (policy.require_approval.recurring) {
    add(
      "require_approval.recurring",
      !intent.is_recurring,
      "require_approval",
      intent.is_recurring ? "recurring charge: will renew until cancelled" : "one-time charge",
    );
  }
  add(
    "require_approval.over_amount",
    amt <= policy.require_approval.over_amount,
    "require_approval",
    `${fmt(amt, cur)} vs approval threshold ${fmt(policy.require_approval.over_amount, cur)}`,
  );
  if (policy.require_approval.non_allowlisted_vendor) {
    add(
      "vendors.allowlist",
      allowlisted,
      "require_approval",
      `${normalizeDomain(intent.vendor_domain)} ${allowlisted ? "is" : "is not"} on the allowlist`,
    );
  }
  const projected = ctx.spentTodayByAgent + amt;
  add(
    "hard_limits.per_agent_daily_budget",
    projected <= policy.hard_limits.per_agent_daily_budget,
    "require_approval",
    `${intent.agent_id} has ${fmt(ctx.spentTodayByAgent, cur)} issued today; this makes ${fmt(projected, cur)} of ${fmt(policy.hard_limits.per_agent_daily_budget, cur)}`,
  );

  // Auto-approve envelope: everything else must be small, one-off and known.
  const aa = policy.auto_approve;
  const autoOk =
    amt < aa.max_amount &&
    (aa.allow_recurring || !intent.is_recurring) &&
    (!aa.require_allowlisted_vendor || allowlisted);
  add(
    "auto_approve",
    autoOk,
    "require_approval",
    autoOk
      ? `under ${fmt(aa.max_amount, cur)}, ${intent.is_recurring ? "recurring allowed" : "one-time"}, vendor ok`
      : `auto-approve needs amount under ${fmt(aa.max_amount, cur)}` +
          (aa.allow_recurring ? "" : ", one-time charge") +
          (aa.require_allowlisted_vendor ? ", allowlisted vendor" : ""),
  );

  const failed = rules.filter((r) => !r.passed);
  const decision: Decision = failed.some((r) => r.effect === "deny")
    ? "deny"
    : failed.length > 0
      ? "require_approval"
      : "auto_approve";

  const summary =
    decision === "auto_approve"
      ? "All rules passed; safe to auto-approve."
      : `${decision === "deny" ? "Denied" : "Needs human approval"}: ` +
        failed
          .filter((r) => decision !== "deny" || r.effect === "deny")
          .map((r) => `${r.rule} (${r.detail})`)
          .join("; ");

  return { decision, rules, summary };
}
