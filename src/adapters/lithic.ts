import type { CardDetails, CardReference } from "../types.js";
import type { CardAdapter, IssueCardRequest } from "./types.js";

interface LithicCard {
  token: string;
  last_four: string;
  pan?: string;
  cvv?: string;
  exp_month?: string;
  exp_year?: string;
  spend_limit: number;
  type: string;
  created: string;
}

/**
 * Lithic virtual cards (https://docs.lithic.com/reference/postcards).
 * One-time spends get a SINGLE_USE card capped at the approved amount for one transaction.
 * Approved recurring spends get a MERCHANT_LOCKED card with a monthly cap,
 * so the subscription can renew but can't be reused anywhere else.
 */
export class LithicAdapter implements CardAdapter {
  readonly name: string = "lithic";
  readonly kind = "card" as const;
  protected baseUrl: string;
  /** Provider name used in error messages. */
  protected readonly label: string = "Lithic";

  constructor(
    private readonly apiKey: string,
    environment: "sandbox" | "production" = "sandbox",
  ) {
    this.baseUrl = environment === "production" ? "https://api.lithic.com/v1" : "https://sandbox.lithic.com/v1";
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${this.label} ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  private toDetails(card: LithicCard, req: { currency: string; single_use: boolean; spend_limit: number }): CardDetails {
    if (!card.pan || !card.cvv) {
      throw new Error(`${this.label} did not return PAN/CVV. Your API key may not have PCI card-data access.`);
    }
    return {
      adapter: this.name,
      token: card.token,
      last_four: card.last_four,
      issued_at: card.created ?? new Date().toISOString(),
      spend_limit: req.spend_limit,
      currency: req.currency,
      single_use: req.single_use,
      pan: card.pan,
      cvv: card.cvv,
      exp_month: card.exp_month ?? "",
      exp_year: card.exp_year ?? "",
    };
  }

  protected spendLimitCents(amount: number): number {
    return Math.round(amount * 100);
  }

  async issueCard(req: IssueCardRequest): Promise<CardDetails> {
    const card = await this.call<LithicCard>("POST", "/cards", {
      type: req.single_use ? "SINGLE_USE" : "MERCHANT_LOCKED",
      spend_limit: this.spendLimitCents(req.amount),
      spend_limit_duration: req.single_use ? "TRANSACTION" : "MONTHLY",
      memo: req.memo.slice(0, 100),
    });
    return this.toDetails(card, { currency: req.currency, single_use: req.single_use, spend_limit: req.amount });
  }

  async getCard(ref: CardReference): Promise<CardDetails> {
    const card = await this.call<LithicCard>("GET", `/cards/${encodeURIComponent(ref.token)}`);
    return { ...this.toDetails(card, ref), issued_at: ref.issued_at, expires_at: ref.expires_at };
  }

  async closeCard(ref: CardReference): Promise<void> {
    await this.call("PATCH", `/cards/${encodeURIComponent(ref.token)}`, { state: "CLOSED" });
  }
}
