import { toMinor } from "../money.js";
import type { CardDetails } from "../types.js";
import { basicAuth, callRail } from "./http-json.js";
import type { CardAdapter, PayoutRequest, PayoutResult } from "./types.js";

export interface RazorpayXOptions {
  keyId: string;
  keySecret: string;
  /** Your RazorpayX business account number: the account the money leaves from. */
  accountNumber: string;
  /** IMPS, NEFT, RTGS or UPI. Must suit the vendor's fund account (UPI for a VPA, the others for a bank account). */
  mode?: string;
  /** RazorpayX payout purpose, e.g. "vendor bill" or "payout". */
  purpose?: string;
  /** "sandbox" accepts only test-mode keys (rzp_test_), so a live key can't move real money by accident. */
  environment?: "sandbox" | "production";
}

interface Payout {
  id: string;
  status: string;
}

/**
 * RazorpayX Payouts (https://razorpay.com/docs/api/x/payouts/). Pays INR from your RazorpayX account to the vendor's
 * fund account (fa_...) listed under payees in policies.yaml. The intent ID goes in X-Payout-Idempotency and as
 * reference_id, so a retried call can't pay twice. Amounts are sent in paise.
 */
export class RazorpayXAdapter implements CardAdapter {
  readonly name = "razorpayx";
  readonly kind = "payout" as const;
  readonly payeeField = "razorpayx_fund_account" as const;
  private readonly baseUrl = "https://api.razorpay.com";

  constructor(private readonly opts: RazorpayXOptions) {
    if (!opts.keyId.startsWith("rzp_test_") && opts.environment !== "production") {
      throw new Error("RAZORPAYX_KEY_ID is not a test-mode key. Use rzp_test_... or set adapter.razorpayx.environment: production.");
    }
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      Authorization: basicAuth(this.opts.keyId, this.opts.keySecret),
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "X-Payout-Idempotency": idempotencyKey } : {}),
    };
  }

  async sendPayout(req: PayoutRequest): Promise<PayoutResult> {
    const fundAccount = req.payee.razorpayx_fund_account;
    if (!fundAccount) throw new Error("No razorpayx_fund_account on this payee.");
    const cur = req.currency.toUpperCase();
    if (cur !== "INR") throw new Error(`RazorpayX pays out in INR only, not ${cur}.`);
    const p = await callRail<Payout>("RazorpayX", `${this.baseUrl}/v1/payouts`, {
      method: "POST",
      headers: this.headers(req.intent_id),
      body: JSON.stringify({
        account_number: this.opts.accountNumber,
        fund_account_id: fundAccount,
        amount: toMinor(req.amount, cur),
        currency: cur,
        mode: this.opts.mode ?? "IMPS",
        purpose: this.opts.purpose ?? "vendor bill",
        // Fail instead of sitting in a queue: a queued payout would go out later, after the approval was given.
        queue_if_low_balance: false,
        reference_id: req.intent_id,
        // Narration shows on the vendor's bank statement: letters, digits and spaces, kept short.
        narration: req.note.replace(/[^A-Za-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30),
        notes: { pursestring_intent_id: req.intent_id },
      }),
    });
    return { payment_id: p.id, status: p.status };
  }

  async getPayout(paymentId: string): Promise<PayoutResult> {
    const p = await callRail<Payout>("RazorpayX", `${this.baseUrl}/v1/payouts/${encodeURIComponent(paymentId)}`, {
      method: "GET",
      headers: this.headers(),
    });
    return { payment_id: p.id, status: p.status };
  }

  private cardless(): never {
    throw new Error("The razorpayx rail pays the vendor's bank or UPI account and issues no card. Call send_payment instead.");
  }

  async issueCard(): Promise<CardDetails> {
    this.cardless();
  }

  async getCard(): Promise<CardDetails> {
    this.cardless();
  }
}
