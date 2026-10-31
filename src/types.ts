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
  /** Set when this intent governs a call to one of PayPal's own MCP tools instead of a purchase. */
  action?: ActionRecord;
  /** Real-time authorization decisions made against this intent's card. */
  authorizations?: AuthorizationRecord[];
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

/** Where a payout rail sends money. Comes from the payee directory in policies.yaml, never from the agent. */
export interface Payee {
  receiver: string;
  type: PayeeType;
  wallet: PayeeWallet;
}

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
  sent_at: string;
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
