import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const RAILS = [
  "mock",
  "lithic",
  "privacy",
  "airwallex",
  "airwallex_payouts",
  "paypal",
  "stripe_connect",
  "razorpayx",
  "modern_treasury",
  "highnote", "marqeta", "amex", "network_token", "ach"] as const;
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

const PayeeSchema = z
  .object({
    /** Vendor pattern, same syntax as the allowlist. */
    vendor: z.string().min(1),
    /** paypal rail: the vendor's PayPal email, phone number or PayPal account ID. */
    receiver: z.string().min(1).optional(),
    type: z.enum(["EMAIL", "PHONE", "PAYPAL_ID"]).default("EMAIL"),
    /** paypal rail: pay into the vendor's PayPal or Venmo account. */
    wallet: z.enum(["PAYPAL", "VENMO"]).default("PAYPAL"),
    /** stripe_connect rail: the vendor's connected account ID. */
    stripe_account: z.string().regex(/^acct_\w+$/, "must look like acct_...").optional(),
    /** razorpayx rail: the vendor's fund account ID. */
    razorpayx_fund_account: z.string().regex(/^fa_\w+$/, "must look like fa_...").optional(),
    /** modern_treasury rail: the vendor's external account ID (the receiving account). */
    modern_treasury_account: z.string().min(1).optional(),
    /** airwallex_payouts rail: the ID of a beneficiary already saved in Airwallex (a UUID). */
    airwallex_beneficiary: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be an Airwallex beneficiary ID (a UUID)")
      .optional(),
  })
  .refine((p) => p.receiver || p.stripe_account || p.razorpayx_fund_account || p.modern_treasury_account || p.airwallex_beneficiary, {
    message:
      "a payee needs at least one of receiver, stripe_account, razorpayx_fund_account, modern_treasury_account or airwallex_beneficiary",
  });
export type PayeeEntry = z.infer<typeof PayeeSchema>;

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
      /**
       * How many new spend intents one agent may submit in a rolling window, across every vendor and rail. Past it,
       * new intents are denied until older ones age out, so a looping agent can't burn the daily budget before a
       * human reads the alert. Retries of the same intent (same idempotency key) don't count.
       */
      velocity: z
        .object({
          enabled: z.boolean().default(true),
          max_intents: z.number().int().positive().default(20),
          window_minutes: z.number().positive().default(10),
        })
        .default({ enabled: true, max_intents: 20, window_minutes: 10 }),
    })
    .default({
      max_amount: 1000,
      per_agent_daily_budget: 200,
      velocity: { enabled: true, max_intents: 20, window_minutes: 10 },
    }),
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
          /** "sandbox" is Airwallex's sandbox (demo) environment, where production keys can't log in. Used by both Airwallex rails. */
          environment: z.enum(["sandbox", "production"]).default("sandbox"),
          /** The cardholder agent cards are issued to; or AIRWALLEX_CARDHOLDER_ID. */
          cardholder_id: z.string().optional(),
          /** created_by on new cards: the full legal name of the person requesting them. */
          created_by: z.string().min(1).optional(),
          /** Account to act as when one scoped API key covers several (x-login-as); or AIRWALLEX_ACCOUNT_ID. */
          account_id: z.string().optional(),
          /** Overrides the API host, e.g. https://api.sandbox.airwallex.com. */
          base_url: z.string().url().optional(),
          /** x-api-version sent on every call. Defaults to the version PurseString was checked against. */
          api_version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          /** airwallex_payouts rail: reason on each transfer. */
          payout_reason: z.string().min(1).optional(),
          /** airwallex_payouts rail: LOCAL or SWIFT. Unset: the first method the beneficiary was saved with. */
          transfer_method: z.enum(["LOCAL", "SWIFT"]).optional(),
        })
        .default({ environment: "sandbox" }),
      paypal: z
        .object({
          environment: z.enum(["sandbox", "production"]).default("sandbox"),
        })
        .default({ environment: "sandbox" }),
      stripe_connect: z
        .object({
          /** "sandbox" accepts only Stripe test-mode keys. */
          environment: z.enum(["sandbox", "production"]).default("sandbox"),
        })
        .default({ environment: "sandbox" }),
      razorpayx: z
        .object({
          /** "sandbox" accepts only RazorpayX test-mode keys. */
          environment: z.enum(["sandbox", "production"]).default("sandbox"),
          /** Your RazorpayX account number; or RAZORPAYX_ACCOUNT_NUMBER. */
          account_number: z.string().optional(),
          mode: z.enum(["IMPS", "NEFT", "RTGS", "UPI"]).default("IMPS"),
          purpose: z.string().min(1).default("vendor bill"),
        })
        .default({ environment: "sandbox", mode: "IMPS", purpose: "vendor bill" }),
      modern_treasury: z
        .object({
          /** The internal account money leaves from; or MODERN_TREASURY_ORIGINATING_ACCOUNT_ID. */
          originating_account_id: z.string().optional(),
          /** Payment order type: ach, wire, rtp, sepa, ... */
          payment_type: z.string().min(1).default("ach"),
        })
        .default({ payment_type: "ach" }),
    })
    .default({
      type: "mock",
      lithic: { environment: "sandbox" },
      airwallex: { environment: "sandbox" },
      paypal: { environment: "sandbox" },
      stripe_connect: { environment: "sandbox" },
      razorpayx: { environment: "sandbox", mode: "IMPS", purpose: "vendor bill" },
      modern_treasury: { payment_type: "ach" },
    }),
  /**
   * Where payout rails (PayPal, Venmo, Stripe Connect, RazorpayX, Modern Treasury, Airwallex) send money for each vendor. The agent never supplies a payee:
   * a vendor with no entry here can't be paid by payout.
   */
  payees: z.array(PayeeSchema).default([]),
  /**
   * Govern PayPal's own MCP server (@paypal/mcp): PurseString runs it behind itself and re-exposes its tools.
   * Read-only tools pass straight through; tools that move money or can't be undone go through policy first.
   */
  paypal_tools: z
    .object({
      enabled: z.boolean().default(false),
      /** The upstream PayPal MCP server, started with PAYPAL_ACCESS_TOKEN set from PAYPAL_CLIENT_ID / SECRET. */
      command: z.array(z.string()).min(1).default(["npx", "-y", "@paypal/mcp@1.8.1", "--tools=all"]),
      refunds: z
        .object({
          /** Refunds strictly under this amount run without a human. */
          auto_approve_under: z.number().nonnegative().default(25),
          /** Refunds over this amount are refused outright, even with a human. */
          max_amount: z.number().positive().default(500),
        })
        .default({ auto_approve_under: 25, max_amount: 500 }),
      /** Tools that always wait for a human, whatever the amount. */
      require_approval: z
        .array(z.string())
        .default(["accept_dispute_claim", "cancel_subscription", "cancel_sent_invoice", "update_subscription"]),
      /** Tools the agent can never call. */
      deny: z.array(z.string()).default([]),
    })
    .default({
      enabled: false,
      command: ["npx", "-y", "@paypal/mcp@1.8.1", "--tools=all"],
      refunds: { auto_approve_under: 25, max_amount: 500 },
      require_approval: ["accept_dispute_claim", "cancel_subscription", "cancel_sent_invoice", "update_subscription"],
      deny: [],
    }),
  /**
   * Stop agents spending. A human can halt one agent or all of them (pursestring halt, POST /halt); loop detection
   * halts an agent on its own when it keeps asking for the same purchase under new task IDs. While halted, new
   * intents are denied, approved intents can't be paid or get a card, and real-time card authorizations decline.
   */
  kill_switch: z
    .object({
      loop_detection: z
        .object({
          enabled: z.boolean().default(true),
          /** How far back to look for repeats. */
          window_minutes: z.number().positive().default(10),
          /** The intent that makes this many near-identical ones inside the window halts the agent. */
          max_similar: z.number().int().min(2).default(5),
          /** Amounts this close count as the same purchase: 10 means 15.00 and 16.50 match. */
          amount_tolerance_percent: z.number().nonnegative().max(100).default(10),
        })
        .default({ enabled: true, window_minutes: 10, max_similar: 5, amount_tolerance_percent: 10 }),
    })
    .default({ loop_detection: { enabled: true, window_minutes: 10, max_similar: 5, amount_tolerance_percent: 10 } }),
  /**
   * Pay for HTTP resources that answer 402 Payment Required (x402), in USDC from the wallet in X402_PRIVATE_KEY.
   * Every payment is a purchase intent like any other: same budgets, allowlist, approvals, kill switch and audit log.
   */
  x402: z
    .object({
      enabled: z.boolean().default(false),
      /** CAIP-2 networks PurseString may pay on. Base Sepolia (testnet) by default; add eip155:8453 for Base (real USDC). */
      networks: z.array(z.string().regex(/^eip155:\d+$/)).default(["eip155:84532"]),
      /** Optional: pin the address each vendor may be paid at. A vendor listed here can't be paid anywhere else. */
      pay_to: z
        .array(z.object({ vendor: z.string().min(1), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }))
        .default([]),
      /** Longest authorization PurseString will sign, whatever the server asks for. */
      max_timeout_seconds: z.number().int().positive().default(300),
      /** Response bodies longer than this are cut before they're returned to the agent. */
      max_response_bytes: z.number().int().positive().default(100_000),
    })
    .default({ enabled: false, networks: ["eip155:84532"], pay_to: [], max_timeout_seconds: 300, max_response_bytes: 100_000 }),
  /**
   * Verified agent identity. Without it, agent_id is whatever the agent says it is. List an agent here with a key and
   * that agent_id can only be used by a caller holding the key: over stdio from PURSESTRING_AGENT_KEY, over HTTP from
   * the X-PurseString-Agent-Key header (or as the bearer token). Budgets, velocity limits and the kill switch then key
   * on an id the agent proved, not one it typed.
   */
  agents: z
    .object({
      /**
       * Refuse every caller without a valid key. Left unset, it's on whenever keys are listed. Set false to let unkeyed
       * agents keep working under ids that aren't listed (listed ids still need their key).
       */
      require_key: z.boolean().optional(),
      keys: z
        .array(
          z
            .object({
              agent_id: z.string().trim().min(1),
              /** SHA-256 of the key, in hex, so policies.yaml holds no secret: `printf %s "$KEY" | sha256sum`. */
              key_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (the SHA-256 of the key)").optional(),
              /** Or the name of an environment variable holding the key itself. */
              key_env: z.string().min(1).optional(),
            })
            .refine((k) => Boolean(k.key_sha256) !== Boolean(k.key_env), { message: "give exactly one of key_sha256 or key_env" }),
        )
        .default([])
        .refine((ks) => new Set(ks.map((k) => k.agent_id)).size === ks.length, { message: "each agent_id may be listed once" }),
    })
    .default({ keys: [] }),
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
    airwallexAccountId?: string;
    paypalClientId?: string;
    paypalClientSecret?: string;
    stripeSecretKey?: string;
    razorpayxKeyId?: string;
    razorpayxKeySecret?: string;
    razorpayxAccountNumber?: string;
    modernTreasuryOrgId?: string;
    modernTreasuryApiKey?: string;
    modernTreasuryOriginatingAccountId?: string;
    /** Private key of the wallet that signs x402 payments. Never logged or stored. */
    x402PrivateKey?: string;
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

/** Deterministic JSON: object keys sorted and undefined dropped, so equal values always hash the same. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Fingerprint of the policy in force: SHA-256 over the parsed policy (defaults filled in, environment overrides such as
 * PURSESTRING_ADAPTER applied), so comments and key order in policies.yaml don't change it but any rule change does.
 * Stamped on every audit entry and every intent, so a decision can be traced to the exact rules that made it.
 */
export function policyHash(policy: Policy): string {
  return `sha256:${createHash("sha256").update(stableJson(policy)).digest("hex")}`;
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
    airwallexAccountId: process.env.AIRWALLEX_ACCOUNT_ID || policy.adapter.airwallex.account_id,
    paypalClientId: process.env.PAYPAL_CLIENT_ID || undefined,
    paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || undefined,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || undefined,
    razorpayxKeyId: process.env.RAZORPAYX_KEY_ID || undefined,
    razorpayxKeySecret: process.env.RAZORPAYX_KEY_SECRET || undefined,
    razorpayxAccountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER || policy.adapter.razorpayx.account_number,
    modernTreasuryOrgId: process.env.MODERN_TREASURY_ORGANIZATION_ID || undefined,
    modernTreasuryApiKey: process.env.MODERN_TREASURY_API_KEY || undefined,
    x402PrivateKey: process.env.X402_PRIVATE_KEY || undefined,
    modernTreasuryOriginatingAccountId:
      process.env.MODERN_TREASURY_ORIGINATING_ACCOUNT_ID || policy.adapter.modern_treasury.originating_account_id,
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
  } else if (env.paypalClientId && !process.env.PURSESTRING_ADAPTER && policy.adapter.type === "mock") {
    policy.adapter.type = "paypal";
  }
  const forced = process.env.PURSESTRING_ADAPTER;
  if (forced && (RAILS as readonly string[]).includes(forced)) {
    policy.adapter.type = forced as RailName;
  }

  return { policy, policyPath, homeDir, env };
}
