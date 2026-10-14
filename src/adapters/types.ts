import type { CardDetails, CardReference } from "../types.js";

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

/**
 * A payment rail. PurseString decides; the adapter only moves money.
 * Add a rail by implementing these two methods (see CONTRIBUTING.md).
 */
export interface CardAdapter {
  readonly name: string;
  /** "card" rails mint virtual cards; "bank_transfer" rails move money by ACH / wire / SEPA. */
  readonly kind: "card" | "bank_transfer";
  issueCard(req: IssueCardRequest): Promise<CardDetails>;
  /** Re-fetch full card details from a stored reference, used to replay idempotent requests. */
  getCard(ref: CardReference): Promise<CardDetails>;
  /** Close a card so it can't be used again. Called when a single-use card's time is up. */
  closeCard?(ref: CardReference): Promise<void>;
}
