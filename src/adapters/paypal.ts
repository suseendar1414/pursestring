import { formatMinor, toMinor } from "../money.js";
import type { CardDetails } from "../types.js";
import type { CardAdapter, PayoutRequest, PayoutResult } from "./types.js";

export interface PayPalOptions {
  clientId: string;
  clientSecret: string;
  environment?: "sandbox" | "production";
}

interface PayoutBatch {
  batch_header: { payout_batch_id: string; batch_status: string };
  items?: { transaction_status?: string }[];
}

/** Currencies PayPal takes with no decimal places. */
const ZERO_DECIMAL = new Set(["HUF", "JPY", "TWD"]);

/**
 * PayPal Payouts (https://developer.paypal.com/docs/api/payments.payouts-batch/v1/).
 * PayPal has no API for minting virtual cards, so instead of handing the agent a card this rail pays the vendor
 * directly: the approved amount goes to the vendor's PayPal or Venmo account from the payee directory in
 * policies.yaml. The agent never chooses where the money goes, so a prompt-injected "pay this address instead"
 * has nothing to change. The intent ID is the PayPal-Request-Id and sender_batch_id, so a retried call can never
 * pay twice. "sandbox" uses api-m.sandbox.paypal.com and moves no real money.
 */
export class PayPalAdapter implements CardAdapter {
  readonly name = "paypal";
  readonly kind = "payout" as const;
  private readonly baseUrl: string;
  private token?: { value: string; expiresAt: number };

  constructor(private readonly opts: PayPalOptions) {
    this.baseUrl = opts.environment === "production" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  }

  /** OAuth client-credentials token, refreshed a minute before it expires. Also handed to PayPal's MCP server. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await fetch(this.baseUrl + "/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`PayPal login failed: ${res.status} ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { access_token: string; expires_in?: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 900) * 1000 };
    return body.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`PayPal ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  private static result(batch: PayoutBatch): PayoutResult {
    return {
      payment_id: batch.batch_header.payout_batch_id,
      status: batch.items?.[0]?.transaction_status ?? batch.batch_header.batch_status,
    };
  }

  async sendPayout(req: PayoutRequest): Promise<PayoutResult> {
    const cur = req.currency.toUpperCase();
    // PayPal wants the currency's own decimals ("49.99", "1500"), except HUF and TWD, which it takes as whole units.
    const value = ZERO_DECIMAL.has(cur) ? String(Math.round(req.amount)) : formatMinor(toMinor(req.amount, cur), cur);
    const batch = await this.call<PayoutBatch>(
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: {
          sender_batch_id: req.intent_id,
          email_subject: "You have a payment",
          email_message: req.note.slice(0, 1000),
        },
        items: [
          {
            recipient_type: req.payee.type,
            recipient_wallet: req.payee.wallet,
            receiver: req.payee.receiver,
            amount: { value, currency: req.currency.toUpperCase() },
            note: req.note.slice(0, 4000),
            sender_item_id: req.intent_id,
          },
        ],
      },
      req.intent_id,
    );
    return PayPalAdapter.result(batch);
  }

  async getPayout(paymentId: string): Promise<PayoutResult> {
    return PayPalAdapter.result(await this.call<PayoutBatch>("GET", `/v1/payments/payouts/${encodeURIComponent(paymentId)}`));
  }

  private cardless(): never {
    throw new Error("The paypal rail pays the vendor directly and issues no card. Call send_payment instead.");
  }

  async issueCard(): Promise<CardDetails> {
    this.cardless();
  }

  async getCard(): Promise<CardDetails> {
    this.cardless();
  }
}
