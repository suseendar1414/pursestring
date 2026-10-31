import type { CardDetails, CardReference, Payee } from "../types.js";

export interface IssueCardRequest {
  intent_id: string;
  /** Spend limit in major units (e.g. 15.00). */
  amount: number;
  currency: string;
  vendor_domain: string;
  /** Single-use cards close after one authorization; recurring cards stay merchant-locked. */
  single_use: boolean;
  memo: string;
}

export interface PayoutRequest {
  intent_id: string;
  /** Amount in major units (e.g. 15.00). */
  amount: number;
  currency: string;
  payee: Payee;
  /** Shown to the vendor with the payment. */
  note: string;
}

export interface PayoutResult {
  payment_id: string;
  status: string;
}

/**
 * A payment rail. PurseString decides; the adapter only moves money.
 * Add a rail by implementing these two methods (see CONTRIBUTING.md).
 */
export interface CardAdapter {
  readonly name: string;
  /**
   * "card" rails mint virtual cards; "payout" rails send money straight to the vendor's account on file
   * (PayPal, Venmo); "bank_transfer" rails move money by ACH / wire / SEPA.
   */
  readonly kind: "card" | "payout" | "bank_transfer";
  issueCard(req: IssueCardRequest): Promise<CardDetails>;
  /** Re-fetch full card details from a stored reference, used to replay idempotent requests. */
  getCard(ref: CardReference): Promise<CardDetails>;
  /** Close a card so it can't be used again. Called when a single-use card's time is up. */
  closeCard?(ref: CardReference): Promise<void>;
  /** Payout rails: send the approved amount to the payee. Must be idempotent on intent_id. */
  sendPayout?(req: PayoutRequest): Promise<PayoutResult>;
  /** Payout rails: the payment's current status. */
  getPayout?(paymentId: string): Promise<PayoutResult>;
}
