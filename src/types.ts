import type { ApprovalChannel, ApprovalCodeHash } from "./approvals.js";
import { z } from "zod";

/** Structured intent an agent must provide before any money moves. */
export const PurchaseIntentShape = {
  agent_id: z.string().min(1).describe("Stable identifier of the calling agent, e.g. 'invoice-bot'."),
  task_id: z.string().min(1).describe("Identifier of the task this purchase serves, e.g. '102'."),
  task_goal: z.string().min(1).describe("What the agent is trying to accomplish and why this purchase is needed."),
  vendor_domain: z.string().min(1).describe("Merchant domain, e.g. 'pdfocr.io'."),
  amount: z.number().positive().describe("Amount to spend, in major units of the currency (e.g. 15.00)."),
  currency: z.string().length(3).default("USD").describe("ISO 4217 currency code."),
  is_recurring: z.boolean().describe("True if this creates a subscription, trial that auto-renews, or any repeat charge."),
  alternatives_attempted: z
    .array(z.string())
    .default([])
    .describe("Free or already-owned options the agent tried first, and why they failed."),
  reasoning: z
    .array(z.string())
    .default([])
    .describe("Optional step-by-step reasoning that led to this purchase. Stored in the audit log."),
};

export const PurchaseIntentSchema = z.object(PurchaseIntentShape);
export type PurchaseIntent = z.infer<typeof PurchaseIntentSchema>;

export type Decision = "auto_approve" | "require_approval" | "deny";

export interface RuleResult {
  rule: string;
  passed: boolean;
  detail: string;
  /** What a failure of this rule means for the decision. */
  effect: Decision;
}

export interface PolicyEvaluation {
  decision: Decision;
  rules: RuleResult[];
  summary: string;
}

export type IntentStatus =
  | "approved"
  | "pending_approval"
  | "denied"
  | "expired"
  | "issuing"
  | "card_issued"
  /** A payout rail is sending the money. */
  | "paying"
  /** A payout rail sent the money to the vendor's account on file. */
  | "paid"
  /** A governed PayPal MCP tool call is running. */
  | "executing"
  /** A governed PayPal MCP tool call ran. */
  | "executed";

export interface IntentRecord {
  intent_id: string;
  idempotency_key: string;
  intent: PurchaseIntent;
  evaluation: PolicyEvaluation;
  status: IntentStatus;
  created_at: string;
  updated_at: string;
  expires_at: string;
  approved_by?: string;
  denied_by?: string;
  decision_note?: string;
  /** How the human decision arrived: cli, http or slack. */
  decided_via?: ApprovalChannel;
  /** Hash of the one-time code sent to the approver. The code itself is never stored. */
  approval_code?: ApprovalCodeHash;
  /** Wrong codes tried so far; too many denies the intent. */
  approval_code_attempts?: number;
  /** The rail chosen by policy routing at submit time. */
  rail: string;
  card?: CardReference;
  /** Set when a payout rail (PayPal, Venmo) paid the vendor directly instead of issuing a card. */
  payment?: PaymentRecord;
  /** Set when this intent pays for an HTTP resource over x402. */
  x402?: X402Record;
  /** Set when this intent governs a call to one of PayPal's own MCP tools instead of a purchase. */
  action?: ActionRecord;
  /** Real-time authorization decisions made against this intent's card. */
  authorizations?: AuthorizationRecord[];
  /** Merchant refunds credited back against this intent. The original charge is never edited. */
  refunds?: RefundRecord[];
  /** Sum of `refunds`, never more than what was charged. */
  refunded_total?: number;
  /** Set once any refund lands. Kept apart from `status` so a refunded subscription card keeps working. */
  refund_status?: RefundStatus;
  /** What the decision was based on, captured when the intent was ruled on. Re-checked before money moves. */
  evidence?: Evidence;
  /** The last re-check before money moved (or before it was refused). */
  recheck?: RecheckRecord;
}

/**
 * The facts an intent was ruled on: which policy, and where the payment would go, with where each fact came from and
 * when it was seen. Intents written before evidence existed have none, and are re-checked on policy alone.
 */
export interface Evidence {
  /** policyHash() of the policy that ruled on the intent. */
  policy_hash: string;
  /** The policies.yaml it was loaded from, or null for built-in defaults. */
  policy_file: string | null;
  /** When the evidence below was gathered. */
  observed_at: string;
  /** The vendor, normalized. */
  vendor: string;
  /** The rail policy routing chose. */
  rail: string;
  /** Payout rails: the destination from the payee directory the approver was shown. */
  payee?: {
    source: "policies.yaml#payees";
    /** The payee field this rail pays to. */
    field: PayeeDestinationField;
    destination: string;
    /** SHA-256 of the whole payee entry, so a changed type or wallet is caught too. */
    fingerprint: string;
  };
  /** Set when the payee was added to policies.yaml after the decision and first seen when paying. */
  payee_added_after_decision?: string;
  /** x402: the payment terms the resource asked for, read from its 402 answer. */
  x402?: { source: string; pay_to: string; network: string; asset: string; amount_atomic: string };
}

export interface RecheckRecord {
  checked_at: string;
  /** Hash of the policy in force at the re-check. */
  policy_hash: string;
  /**
   * unchanged: same policy as the decision. re_evaluated: the policy changed and the intent still passes.
   * no_evidence: an intent from before evidence was recorded, checked against today's policy only. rejected: refused.
   */
  outcome: "unchanged" | "re_evaluated" | "no_evidence" | "rejected";
  problems?: string[];
}

export type RefundStatus = "partially_refunded" | "refunded";

export interface RefundRecord {
  /** The issuer's ID for this refund (Lithic event token). Seen twice means it's a retry, not a second refund. */
  refund_id: string;
  ts: string;
  amount: number;
  currency: string;
  /** Where the refund came from: "lithic" or "http". */
  source: string;
  merchant?: string;
}

export interface AuthorizationRecord {
  ts: string;
  amount: number;
  merchant: string;
  /** The issuer's ID for the merchant (Lithic acceptor_id), when it sends one. */
  merchant_id?: string;
  mcc?: string;
  approved: boolean;
  reason: string;
  /** The issuer's ID for the transaction (Lithic's ASA `token`), so later capture and reversal events find this hold. */
  transaction_id?: string;
  /** Captured by the merchant so far, in major units. Can be less than `amount` (partial capture) or more (tips). */
  captured?: number;
  /** Released without being captured (reversal, void, or the hold expiring), in major units. */
  released?: number;
  /** When the first capture landed. Capture ends the hold: anything not captured stops counting. */
  settled_at?: string;
  /** held, captured or released. Updated by issuer events. */
  hold_status?: "held" | "captured" | "released";
  /** Issuer event IDs already applied, so a retried webhook never counts twice. */
  event_ids?: string[];
}

/** What we persist about an issued card. Never the PAN or CVV. */
export interface CardReference {
  adapter: string;
  token: string;
  last_four: string;
  issued_at: string;
  spend_limit: number;
  currency: string;
  single_use: boolean;
  /** Single-use cards stop working after this time. */
  expires_at?: string;
  closed_at?: string;
}

export interface CardDetails extends CardReference {
  pan: string;
  cvv: string;
  exp_month: string;
  exp_year: string;
}

export type PayeeType = "EMAIL" | "PHONE" | "PAYPAL_ID";
export type PayeeWallet = "PAYPAL" | "VENMO";

/**
 * Where a payout rail sends money. Comes from the payee directory in policies.yaml, never from the agent.
 * Each rail reads its own field: paypal `receiver` (with `type` and `wallet`), stripe_connect `stripe_account`,
 * razorpayx `razorpayx_fund_account`, modern_treasury `modern_treasury_account`, airwallex_payouts `airwallex_beneficiary`.
 */
export interface Payee {
  receiver?: string;
  type?: PayeeType;
  wallet?: PayeeWallet;
  /** Stripe connected account ID (acct_...). */
  stripe_account?: string;
  /** RazorpayX fund account ID (fa_...). */
  razorpayx_fund_account?: string;
  /** Modern Treasury external account ID (the receiving account). */
  modern_treasury_account?: string;
  /** Airwallex beneficiary ID (a UUID), saved and validated in Airwallex beforehand. */
  airwallex_beneficiary?: string;
}

/** The payee fields a payout rail can pay to. */
export type PayeeDestinationField =
  | "receiver"
  | "stripe_account"
  | "razorpayx_fund_account"
  | "modern_treasury_account"
  | "airwallex_beneficiary";

/** What we persist about a payout. */
export interface PaymentRecord {
  adapter: string;
  /** The rail's ID for the payment, e.g. a PayPal payout_batch_id. */
  payment_id: string;
  /** The rail's status, e.g. PENDING, PROCESSING, SUCCESS. */
  status: string;
  amount: number;
  currency: string;
  payee: Payee;
  /** The account the money went to, as the rail names it: a PayPal email, acct_..., fa_..., an external account ID. */
  paid_to?: string;
  sent_at: string;
}

/** What PurseString agreed to pay for an x402 resource, and what came back. */
export interface X402Record {
  url: string;
  method: "GET" | "POST";
  /** CAIP-2 network, e.g. eip155:84532. */
  network: string;
  /** Token contract (USDC). */
  asset: string;
  pay_to: string;
  /** Exact price in the token's atomic units (USDC: millionths of a dollar). The intent amount is this rounded up to a cent. */
  amount_atomic: string;
  /** The signed authorization, kept so a retry re-sends the same one: its nonce can settle on chain only once. */
  authorization?: {
    signature: string;
    nonce: string;
    valid_before: string;
    from: string;
    /** The exact payment header sent (PAYMENT-SIGNATURE or X-PAYMENT). */
    header: { name: string; value: string };
  };
  /** On-chain transaction the server reported settling. */
  transaction?: string;
  paid_at?: string;
  /** The paid response, kept so a repeat returns it without paying again. Cut to x402.max_response_bytes. */
  response?: { status: number; content_type?: string; body: string; truncated: boolean };
}

/** A call to a PayPal MCP tool, held until policy or a human allows it, then run once. */
export interface ActionRecord {
  tool: string;
  /** The arguments PayPal will get, exactly as approved. */
  args: Record<string, unknown>;
  /** SHA-256 of tool + args, so a re-call with different arguments can't ride an approval. */
  args_hash: string;
  executed_at?: string;
  /** PayPal's answer, returned again if the agent repeats the call. */
  result?: unknown;
  is_error?: boolean;
}
