import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const RAILS = ["mock", "lithic", "privacy", "airwallex", "highnote", "marqeta", "amex", "network_token", "ach"] as const;
const RailName = z.enum(RAILS);
export type RailName = z.infer<typeof RailName>;

const RouteSchema = z.object({
  rail: RailName,
  /** Matches when amount >= min_amount. */
  min_amount: z.number().nonnegative().optional(),
  /** Matches when amount < max_amount. */
  max_amount: z.number().positive().optional(),
  recurring: z.boolean().optional(),
  /** Vendor patterns, same syntax as the allowlist. */
  vendors: z.array(z.string()).optional(),
});
export type Route = z.infer<typeof RouteSchema>;

const PolicySchema = z.object({
  version: z.literal(1).default(1),
  currency: z.string().length(3).default("USD"),
  vendors: z
    .object({
      /** Domains the agent may buy from without a human. Supports "*.example.com". */
      allowlist: z.array(z.string()).default([]),
      /** Domains that are always refused. */
      blocklist: z.array(z.string()).default([]),
    })
    .default({ allowlist: [], blocklist: [] }),
  auto_approve: z
    .object({
      /** Spends strictly under this amount can be auto-approved. */
      max_amount: z.number().nonnegative().default(20),
      require_allowlisted_vendor: z.boolean().default(true),
      allow_recurring: z.boolean().default(false),
    })
    .default({ max_amount: 20, require_allowlisted_vendor: true, allow_recurring: false }),
  require_approval: z
    .object({
      /** Spends over this amount always go to a human. */
      over_amount: z.number().nonnegative().default(50),
      recurring: z.boolean().default(true),
      non_allowlisted_vendor: z.boolean().default(true),
    })
    .default({ over_amount: 50, recurring: true, non_allowlisted_vendor: true }),
  hard_limits: z
    .object({
      /** Spends over this amount are refused outright, even with a human. */
      max_amount: z.number().positive().default(1000),
      /** Total issued per agent per UTC day before every further spend needs a human. */
      per_agent_daily_budget: z.number().positive().default(200),
    })
    .default({ max_amount: 1000, per_agent_daily_budget: 200 }),
  intent: z
    .object({
      /** Require at least one alternative before paying. Missing alternatives route to a human. */
      require_alternatives: z.boolean().default(true),
      min_goal_length: z.number().int().nonnegative().default(15),
    })
    .default({ require_alternatives: true, min_goal_length: 15 }),
  idempotency: z
    .object({ window_minutes: z.number().positive().default(30) })
    .default({ window_minutes: 30 }),
  approvals: z
    .object({
      /** How long a pending or approved intent stays usable. */
      ttl_minutes: z.number().positive().default(24 * 60),
      /**
       * Make `pursestring approve` require the one-time code sent to Slack or Discord, so an agent with a shell
       * can't approve its own purchase. Left unset, it's on whenever Slack or Discord is configured.
       */
      require_code: z.boolean().optional(),
      /** Slack user IDs (U0123...) allowed to press Approve. Empty: anyone in the channel. */
      slack_approvers: z.array(z.string()).default([]),
    })
    .default({ ttl_minutes: 24 * 60, slack_approvers: [] }),
  notifications: z
    .object({
      slack_webhook_url: z.string().optional(),
      discord_webhook_url: z.string().optional(),
    })
    .default({}),
  adapter: z
    .object({
      /** The rail used when no route matches. */
      type: RailName.default("mock"),
      lithic: z
        .object({
          environment: z.enum(["sandbox", "production"]).default("sandbox"),
        })
        .default({ environment: "sandbox" }),
      airwallex: z
        .object({
          /** "sandbox" is Airwallex's demo environment. */
          environment: z.enum(["sandbox", "production"]).default("sandbox"),
          /** The cardholder agent cards are issued to; or AIRWALLEX_CARDHOLDER_ID. */
          cardholder_id: z.string().optional(),
        })
        .default({ environment: "sandbox" }),
    })
    .default({ type: "mock", lithic: { environment: "sandbox" }, airwallex: { environment: "sandbox" } }),
  /** Pick a rail per purchase. First matching route wins; otherwise adapter.type. */
  routes: z.array(RouteSchema).default([]),
  cards: z
    .object({
      /** Single-use cards are closed this many minutes after issue. Recurring cards don't expire. */
      ttl_minutes: z.number().positive().default(10),
    })
    .default({ ttl_minutes: 10 }),
  jit: z
    .object({
      /** Answer the issuer's real-time authorization webhook (Lithic ASA). */
      enabled: z.boolean().default(true),
      /** Allow an authorization this much above the approved amount (tax, FX). */
      tolerance_percent: z.number().nonnegative().default(0),
      /** Decline when the merchant descriptor doesn't mention the vendor's name. On by default: the card is for that vendor only. */
      require_merchant_match: z.boolean().default(true),
    })
    .default({ enabled: true, tolerance_percent: 0, require_merchant_match: true }),
});

export type Policy = z.infer<typeof PolicySchema>;

export interface Config {
  policy: Policy;
  policyPath: string | null;
  homeDir: string;
  env: {
    lithicApiKey?: string;
    privacyApiKey?: string;
    airwallexClientId?: string;
    airwallexApiKey?: string;
    airwallexCardholderId?: string;
    /** Lithic ASA HMAC secret (whsec_...), used to verify real-time authorization requests. */
    lithicWebhookSecret?: string;
    slackWebhookUrl?: string;
    /** Slack app signing secret; turns on Approve/Deny buttons answered at POST /slack/actions. */
    slackSigningSecret?: string;
    discordWebhookUrl?: string;
    /** Lithic event-subscription secret (whsec_...) for refund events at /webhooks/lithic. Not the ASA key. */
    lithicEventsSecret?: string;
    /** Where to POST refund events for your own systems, and the secret that signs them. */
    refundWebhookUrl?: string;
    refundWebhookSecret?: string;
  };
}

/** YAML turns a key with only commented-out children into null; treat that as "use the defaults". */
function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
  }
  return v;
}

export function parsePolicy(raw: unknown): Policy {
  const result = PolicySchema.safeParse(dropNulls(raw ?? {}));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid policy:\n${issues}`);
  }
  return result.data;
}

function findPolicyFile(homeDir: string): string | null {
  const candidates = [
    process.env.PURSESTRING_POLICY,
    resolve(process.cwd(), "policies.yaml"),
    join(homeDir, "policies.yaml"),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function loadConfig(): Config {
  const homeDir = process.env.PURSESTRING_HOME ?? join(homedir(), ".pursestring");
  const policyPath = findPolicyFile(homeDir);
  const policy = parsePolicy(policyPath ? parse(readFileSync(policyPath, "utf8")) : {});

  const env = {
    lithicApiKey: process.env.LITHIC_API_KEY || undefined,
    lithicWebhookSecret: process.env.LITHIC_WEBHOOK_SECRET || undefined,
    privacyApiKey: process.env.PRIVACY_API_KEY || undefined,
    airwallexClientId: process.env.AIRWALLEX_CLIENT_ID || undefined,
    airwallexApiKey: process.env.AIRWALLEX_API_KEY || undefined,
    airwallexCardholderId: process.env.AIRWALLEX_CARDHOLDER_ID || policy.adapter.airwallex.cardholder_id,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || policy.notifications.slack_webhook_url,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET || undefined,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || policy.notifications.discord_webhook_url,
    lithicEventsSecret: process.env.LITHIC_EVENTS_SECRET || undefined,
    refundWebhookUrl: process.env.REFUND_WEBHOOK_URL || undefined,
    refundWebhookSecret: process.env.REFUND_WEBHOOK_SECRET || undefined,
  };

  // A Lithic key in the environment switches the rail on without editing YAML.
  if (env.lithicApiKey && !process.env.PURSESTRING_ADAPTER && policy.adapter.type === "mock") {
    policy.adapter.type = "lithic";
  }
  const forced = process.env.PURSESTRING_ADAPTER;
  if (forced && (RAILS as readonly string[]).includes(forced)) {
    policy.adapter.type = forced as RailName;
  }

  return { policy, policyPath, homeDir, env };
}
