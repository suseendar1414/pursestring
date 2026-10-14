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
  issueCard(req: IssueCardRequest): Promise<CardDetails>;
  /** Re-fetch full card details from a stored reference, used to replay idempotent requests. */
  getCard(ref: CardReference): Promise<CardDetails>;
}
