import { toMinor } from "../money.js";
import type { CardDetails } from "../types.js";
import { basicAuth, callRail } from "./http-json.js";
import type { CardAdapter, PayoutRequest, PayoutResult } from "./types.js";

export interface ModernTreasuryOptions {
  organizationId: string;
  apiKey: string;
  /** The internal account (your bank account in Modern Treasury) the money leaves from. */
  originatingAccountId: string;
  /** Payment type: ach, wire, rtp, sepa, ... Must suit both accounts. */
  paymentType?: string;
}

interface PaymentOrder {
  id: string;
  status: string;
}

/**
 * Modern Treasury payment orders (https://docs.moderntreasury.com/payments/reference/create-payment-order).
 * Sends a credit (ACH by default) from your internal account to the vendor's external account listed under payees
 * in policies.yaml. The intent ID is the Idempotency-Key, so a retried call can't create a second payment order.
 * Whether money really moves depends on the organization: a sandbox organization never touches a bank.
 */
export class ModernTreasuryAdapter implements CardAdapter {
  readonly name = "modern_treasury";
  readonly kind = "payout" as const;
  readonly payeeField = "modern_treasury_account" as const;
  private readonly baseUrl = "https://app.moderntreasury.com";

  constructor(private readonly opts: ModernTreasuryOptions) {}

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      Authorization: basicAuth(this.opts.organizationId, this.opts.apiKey),
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    };
  }

  async sendPayout(req: PayoutRequest): Promise<PayoutResult> {
    const receiving = req.payee.modern_treasury_account;
    if (!receiving) throw new Error("No modern_treasury_account on this payee.");
    const cur = req.currency.toUpperCase();
    const po = await callRail<PaymentOrder>("Modern Treasury", `${this.baseUrl}/api/payment_orders`, {
      method: "POST",
      headers: this.headers(req.intent_id),
      body: JSON.stringify({
        type: this.opts.paymentType ?? "ach",
        direction: "credit",
        amount: toMinor(req.amount, cur),
        currency: cur,
        originating_account_id: this.opts.originatingAccountId,
        receiving_account_id: receiving,
        description: req.note.slice(0, 500),
        metadata: { pursestring_intent_id: req.intent_id },
      }),
    });
    return { payment_id: po.id, status: po.status };
  }

  async getPayout(paymentId: string): Promise<PayoutResult> {
    const po = await callRail<PaymentOrder>("Modern Treasury", `${this.baseUrl}/api/payment_orders/${encodeURIComponent(paymentId)}`, {
      method: "GET",
      headers: this.headers(),
    });
    return { payment_id: po.id, status: po.status };
  }

  private cardless(): never {
    throw new Error("The modern_treasury rail pays the vendor's bank account and issues no card. Call send_payment instead.");
  }

  async issueCard(): Promise<CardDetails> {
    this.cardless();
  }

  async getCard(): Promise<CardDetails> {
    this.cardless();
  }
}
