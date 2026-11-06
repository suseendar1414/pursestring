import type { Policy } from "./config.js";
import { formatMinor, toMinor } from "./money.js";
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

/** Minor units -> "49.99 USD". */
const fmt = (minor: number, c: string) => `${formatMinor(minor, c)} ${c}`;

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
  // Every comparison below is between whole minor units of the policy currency (cents for USD), so it is exact.
  const m = (major: number) => toMinor(major, cur);
  const amt = m(intent.amount);
  const spent = m(ctx.spentTodayByAgent);
  const hardMax = m(policy.hard_limits.max_amount);
  const approvalOver = m(policy.require_approval.over_amount);
  const budget = m(policy.hard_limits.per_agent_daily_budget);
  const autoMax = m(policy.auto_approve.max_amount);
  const allowlisted = isAllowlisted(policy, intent.vendor_domain);

  // Hard refusals: no human can approve these.
  add(
    "hard_limits.max_amount",
    amt <= hardMax,
    "deny",
    `${fmt(amt, cur)} vs hard cap ${fmt(hardMax, cur)}`,
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
    amt <= approvalOver,
    "require_approval",
    `${fmt(amt, cur)} vs approval threshold ${fmt(approvalOver, cur)}`,
  );
  if (policy.require_approval.non_allowlisted_vendor) {
    add(
      "vendors.allowlist",
      allowlisted,
      "require_approval",
      `${normalizeDomain(intent.vendor_domain)} ${allowlisted ? "is" : "is not"} on the allowlist`,
    );
  }
  const projected = spent + amt;
  add(
    "hard_limits.per_agent_daily_budget",
    projected <= budget,
    "require_approval",
    `${intent.agent_id} has ${fmt(spent, cur)} issued today; this makes ${fmt(projected, cur)} of ${fmt(budget, cur)}`,
  );

  // Auto-approve envelope: everything else must be small, one-off and known.
  const aa = policy.auto_approve;
  const autoOk =
    amt < autoMax &&
    (aa.allow_recurring || !intent.is_recurring) &&
    (!aa.require_allowlisted_vendor || allowlisted);
  add(
    "auto_approve",
    autoOk,
    "require_approval",
    autoOk
      ? `under ${fmt(autoMax, cur)}, ${intent.is_recurring ? "recurring allowed" : "one-time"}, vendor ok`
      : `auto-approve needs amount under ${fmt(autoMax, cur)}` +
          (aa.allow_recurring ? "" : ", one-time charge") +
          (aa.require_allowlisted_vendor ? ", allowlisted vendor" : ""),
  );

  return decide(rules);
}

function decide(rules: RuleResult[]): PolicyEvaluation {
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

/** PayPal MCP tools whose effect has an amount PurseString can read and budget. */
const AMOUNT_TOOLS = new Set(["create_refund"]);

/** Whether PurseString must rule on this PayPal tool before it runs. Everything else passes straight through. */
export function isGovernedTool(policy: Policy, tool: string): boolean {
  const t = policy.paypal_tools;
  return AMOUNT_TOOLS.has(tool) || t.require_approval.includes(tool) || t.deny.includes(tool);
}

/** The money a PayPal tool call moves, when its arguments say. A full refund has no amount until PayPal looks it up. */
export function toolCallAmount(args: Record<string, unknown>): { amount: number | null; currency: string | null } {
  const a = args.amount as { value?: unknown; currency_code?: unknown } | undefined;
  const value = a && typeof a === "object" ? Number(a.value) : NaN;
  return {
    amount: Number.isFinite(value) && value >= 0 ? value : null,
    currency: a && typeof a.currency_code === "string" ? a.currency_code.toUpperCase() : null,
  };
}

/** Rule on a call to one of PayPal's own MCP tools (refunds, dispute acceptance, cancellations). */
export function evaluateToolCall(
  policy: Policy,
  tool: string,
  args: Record<string, unknown>,
  ctx: { agentId: string; spentTodayByAgent: number },
): PolicyEvaluation {
  const t = policy.paypal_tools;
  const cur = policy.currency;
  const rules: RuleResult[] = [];
  const add = (rule: string, passed: boolean, effect: Decision, detail: string) => rules.push({ rule, passed, effect, detail });

  add("paypal_tools.deny", !t.deny.includes(tool), "deny", `${tool} ${t.deny.includes(tool) ? "is" : "is not"} on the deny list`);
  if (t.require_approval.includes(tool)) {
    add("paypal_tools.require_approval", false, "require_approval", `${tool} always needs a human`);
  }
  if (AMOUNT_TOOLS.has(tool)) {
    const { amount: major, currency } = toolCallAmount(args);
    if (major === null) {
      add("paypal_tools.refunds.amount", false, "require_approval", "no amount given, so PayPal refunds the full capture");
    } else {
      if (currency) add("currency", currency === cur.toUpperCase(), "deny", `refund currency ${currency}, policy currency ${cur}`);
      const m = (n: number) => toMinor(n, cur);
      const amount = m(major);
      const spent = m(ctx.spentTodayByAgent);
      const budget = m(policy.hard_limits.per_agent_daily_budget);
      add(
        "paypal_tools.refunds.max_amount",
        amount <= m(t.refunds.max_amount),
        "deny",
        `${fmt(amount, cur)} vs refund cap ${fmt(m(t.refunds.max_amount), cur)}`,
      );
      add(
        "paypal_tools.refunds.auto_approve_under",
        amount < m(t.refunds.auto_approve_under),
        "require_approval",
        `${fmt(amount, cur)} vs auto-approve limit ${fmt(m(t.refunds.auto_approve_under), cur)}`,
      );
      const projected = spent + amount;
      add(
        "hard_limits.per_agent_daily_budget",
        projected <= budget,
        "require_approval",
        `${ctx.agentId} has ${fmt(spent, cur)} out today; this makes ${fmt(projected, cur)} of ${fmt(budget, cur)}`,
      );
    }
  }
  return decide(rules);
}

/** Choose the rail for a purchase: the first matching route in policies.yaml, else adapter.type. */
export function routeRail(policy: Policy, intent: PurchaseIntent): { rail: string; route: number | null } {
  const m = (n: number) => toMinor(n, policy.currency);
  const amt = m(intent.amount);
  const i = policy.routes.findIndex(
    (r) =>
      (r.min_amount === undefined || amt >= m(r.min_amount)) &&
      (r.max_amount === undefined || amt < m(r.max_amount)) &&
      (r.recurring === undefined || r.recurring === intent.is_recurring) &&
      (r.vendors === undefined || r.vendors.some((p) => domainMatches(intent.vendor_domain, p))),
  );
  return i === -1 ? { rail: policy.adapter.type, route: null } : { rail: policy.routes[i].rail, route: i };
}

/** "https://www.pdfocr.io" -> "pdfocr": the part of a domain a card statement descriptor usually contains. */
export function vendorLabel(domain: string): string {
  const parts = normalizeDomain(domain).split(".");
  let i = parts.length - 2;
  // pdfocr.co.uk, shop.com.au: skip the second-level public suffix.
  if (i > 0 && ["co", "com", "org", "net", "gov", "ac", "edu"].includes(parts[i])) i--;
  return (parts[Math.max(i, 0)] ?? "").replace(/[^a-z0-9]/g, "");
}
