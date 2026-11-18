import { toMinor } from "../money.js";
import type { CardDetails } from "../types.js";
import { callRail } from "./http-json.js";
import type { CardAdapter, PayoutRequest, PayoutResult } from "./types.js";

export interface StripeConnectOptions {
  secretKey: string;
  /** "sandbox" accepts only test-mode keys (sk_test_, rk_test_), so a live key can't move real money by accident. */
  environment?: "sandbox" | "production";
}

interface Transfer {
  id: string;
  reversed?: boolean;
  amount_reversed?: number;
}

/**
 * ISO 4217 says these have no minor unit, but Stripe still takes them with two decimals
 * (https://docs.stripe.com/currencies#special-cases).
 */
const STRIPE_TWO_DECIMAL = new Set(["ISK", "UGX"]);

/**
 * Stripe Connect transfers (https://docs.stripe.com/api/transfers/create). Moves the approved amount from the
 * platform's Stripe balance to the vendor's connected account (acct_...) listed under payees in policies.yaml.
 * Stripe then pays that account out to its bank on the account's own payout schedule. The intent ID is the
 * Idempotency-Key, so a retried call can't transfer twice.
 */
export class StripeConnectAdapter implements CardAdapter {
  readonly name = "stripe_connect";
  readonly kind = "payout" as const;
  readonly payeeField = "stripe_account" as const;
  private readonly baseUrl = "https://api.stripe.com";

  constructor(private readonly opts: StripeConnectOptions) {
    const live = !/^(sk|rk)_test_/.test(opts.secretKey);
    if (live && opts.environment !== "production") {
      throw new Error(
        "STRIPE_SECRET_KEY is not a test-mode key. Use sk_test_... or set adapter.stripe_connect.environment: production.",
      );
    }
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    };
  }

  private static result(t: Transfer): PayoutResult {
    return { payment_id: t.id, status: t.reversed ? "reversed" : (t.amount_reversed ?? 0) > 0 ? "partially_reversed" : "transferred" };
  }

  async sendPayout(req: PayoutRequest): Promise<PayoutResult> {
    const destination = req.payee.stripe_account;
    if (!destination) throw new Error("No stripe_account on this payee.");
    const cur = req.currency.toUpperCase();
    // Integer minor units, as Stripe wants: 15.00 USD -> 1500, 1500 JPY -> 1500.
    const amount = STRIPE_TWO_DECIMAL.has(cur) ? Math.round(req.amount) * 100 : toMinor(req.amount, cur);
    const form = new URLSearchParams({
      amount: String(amount),
      currency: cur.toLowerCase(),
      destination,
      transfer_group: req.intent_id,
      description: req.note.slice(0, 500),
      "metadata[pursestring_intent_id]": req.intent_id,
    });
    const t = await callRail<Transfer>("Stripe", `${this.baseUrl}/v1/transfers`, {
      method: "POST",
      headers: this.headers(req.intent_id),
      body: form.toString(),
    });
    return StripeConnectAdapter.result(t);
  }

  async getPayout(paymentId: string): Promise<PayoutResult> {
    const t = await callRail<Transfer>("Stripe", `${this.baseUrl}/v1/transfers/${encodeURIComponent(paymentId)}`, {
      method: "GET",
      headers: this.headers(),
    });
    return StripeConnectAdapter.result(t);
  }

  private cardless(): never {
    throw new Error("The stripe_connect rail pays the vendor's connected account and issues no card. Call send_payment instead.");
  }

  async issueCard(): Promise<CardDetails> {
    this.cardless();
  }

  async getCard(): Promise<CardDetails> {
    this.cardless();
  }
}
