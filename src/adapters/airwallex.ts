import type { CardDetails, CardReference } from "../types.js";
import type { CardAdapter, IssueCardRequest } from "./types.js";

interface AirwallexCard {
  card_id: string;
  card_status?: string;
  created_at?: string;
}

interface AirwallexCardDetails {
  card_number: string;
  cvv: string;
  expiry_month: number;
  expiry_year: number;
}

export interface AirwallexOptions {
  clientId: string;
  apiKey: string;
  /** Every Airwallex card belongs to a cardholder; agent cards are issued to this one. */
  cardholderId: string;
  environment?: "sandbox" | "production";
}

/**
 * Airwallex Issuing virtual cards (https://www.airwallex.com/docs/issuing), issued in 50+ countries
 * and capped in the purchase's own currency. One-time spends get a SINGLE-use card limited to the
 * approved amount per transaction; approved recurring spends get a MULTIPLE-use card with a monthly cap.
 * Airwallex can't lock a card to one merchant, so a recurring card is only capped, not merchant-locked.
 * "sandbox" is Airwallex's demo environment (api-demo.airwallex.com).
 */
export class AirwallexAdapter implements CardAdapter {
  readonly name = "airwallex";
  readonly kind = "card" as const;
  private readonly baseUrl: string;
  private token?: { value: string; expiresAt: number };

  constructor(private readonly opts: AirwallexOptions) {
    this.baseUrl = opts.environment === "production" ? "https://api.airwallex.com/api/v1" : "https://api-demo.airwallex.com/api/v1";
  }

  /** Bearer tokens last about 30 minutes; log in again a minute before expiry. */
  private async bearer(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const res = await fetch(this.baseUrl + "/authentication/login", {
      method: "POST",
      headers: { "x-client-id": this.opts.clientId, "x-api-key": this.opts.apiKey, "Content-Type": "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Airwallex login failed: ${res.status} ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { token: string; expires_at?: string };
    const expiresAt = body.expires_at ? Date.parse(body.expires_at) : NaN;
    this.token = { value: body.token, expiresAt: Number.isNaN(expiresAt) ? Date.now() + 25 * 60_000 : expiresAt };
    return body.token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${await this.bearer()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Airwallex ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  /** PAN and CVV come from a separate endpoint that needs card-details access on the API key. */
  private async details(cardId: string, ref: Omit<CardReference, "adapter" | "token" | "last_four">): Promise<CardDetails> {
    const d = await this.call<AirwallexCardDetails>("GET", `/issuing/cards/${encodeURIComponent(cardId)}/details`);
    if (!d.card_number || !d.cvv) {
      throw new Error("Airwallex did not return the card number and CVV. Your API key may not have card-details access.");
    }
    return {
      ...ref,
      adapter: this.name,
      token: cardId,
      last_four: d.card_number.slice(-4),
      pan: d.card_number,
      cvv: d.cvv,
      exp_month: String(d.expiry_month).padStart(2, "0"),
      exp_year: String(d.expiry_year),
    };
  }

  async issueCard(req: IssueCardRequest): Promise<CardDetails> {
    const card = await this.call<AirwallexCard>("POST", "/issuing/cards/create", {
      // The intent id makes a retried create return the same card instead of minting a second one.
      request_id: req.intent_id,
      cardholder_id: this.opts.cardholderId,
      created_by: "PurseString",
      form_factor: "VIRTUAL",
      is_personalized: false,
      activate_on_issue: true,
      program: { purpose: "COMMERCIAL" },
      nick_name: req.memo.slice(0, 50),
      metadata: { intent_id: req.intent_id, vendor_domain: req.vendor_domain },
      authorization_controls: {
        allowed_transaction_count: req.single_use ? "SINGLE" : "MULTIPLE",
        transaction_limits: {
          currency: req.currency,
          limits: [{ amount: req.amount, interval: req.single_use ? "PER_TRANSACTION" : "MONTHLY" }],
        },
      },
    });
    return this.details(card.card_id, {
      issued_at: card.created_at ?? new Date().toISOString(),
      spend_limit: req.amount,
      currency: req.currency,
      single_use: req.single_use,
    });
  }

  async getCard(ref: CardReference): Promise<CardDetails> {
    return this.details(ref.token, ref);
  }

  async closeCard(ref: CardReference): Promise<void> {
    await this.call("POST", `/issuing/cards/${encodeURIComponent(ref.token)}/update`, { card_status: "CLOSED" });
  }
}
