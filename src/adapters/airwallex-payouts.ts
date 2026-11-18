import { formatMajor } from "../money.js";
import type { CardDetails } from "../types.js";
import { AirwallexApiError, AirwallexClient, type AirwallexClientOptions } from "./airwallex-client.js";
import type { CardAdapter, PayoutRequest, PayoutResult } from "./types.js";

export interface AirwallexPayoutsOptions extends AirwallexClientOptions {
  /** reason on the transfer. The spec types it as free text ("Reason for the transfer instruction."). */
  reason?: string;
  /** LOCAL or SWIFT. Unset: the first method the beneficiary was saved with. */
  transferMethod?: "LOCAL" | "SWIFT";
}

/** Spec: "Get a Beneficiary" 200. Only the fields PurseString checks. */
interface Beneficiary {
  id: string;
  transfer_methods?: string[];
  beneficiary?: { bank_details?: { account_currency?: string } };
}

/** Spec: "Create a Transfer" 201 / "Get a Transfer" 200. */
interface Transfer {
  id: string;
  status: string;
  request_id?: string;
}

/**
 * Airwallex Payouts transfers (https://www.airwallex.com/docs/payouts). Pays the approved amount from your
 * Airwallex balance to a beneficiary already saved in Airwallex, whose ID is listed under payees in policies.yaml
 * (airwallex_beneficiary). The agent never supplies bank details: beneficiaries are created and validated in
 * Airwallex first, the way Airwallex's own AgentOS beneficiary-creation skill does it.
 *
 * The transfer body mirrors the create_transfer tool in Airwallex's developer MCP server (@airwallex/developer-mcp,
 * MIT): beneficiary_id, reason, reference, request_id, source_currency, transfer_amount, transfer_currency,
 * transfer_method, POST /api/v1/transfers/create. Field types follow the OpenAPI spec (2026-08-21), where
 * transfer_amount is a decimal string, so it is written straight from integer minor units with no float formatting.
 *
 * No currency conversion: the money leaves from the balance in the same currency the vendor receives, so the
 * approved amount is exactly what leaves the account apart from Airwallex's transfer fee (fee_paid_by PAYER).
 */
export class AirwallexPayoutsAdapter implements CardAdapter {
  readonly name = "airwallex_payouts";
  readonly kind = "payout" as const;
  readonly payeeField = "airwallex_beneficiary" as const;
  private readonly client: AirwallexClient;

  constructor(private readonly opts: AirwallexPayoutsOptions) {
    this.client = new AirwallexClient(opts);
  }

  private static result(t: Transfer): PayoutResult {
    return { payment_id: t.id, status: t.status };
  }

  /** Pick the transfer method and check the currency before any money moves, so a mismatch fails cleanly. */
  private async route(beneficiaryId: string, currency: string): Promise<string> {
    const b = await this.client.request<Beneficiary>("GET", `/api/v1/beneficiaries/${encodeURIComponent(beneficiaryId)}`);
    const accountCurrency = b.beneficiary?.bank_details?.account_currency?.toUpperCase();
    if (accountCurrency && accountCurrency !== currency) {
      throw new Error(
        `Airwallex beneficiary ${beneficiaryId} receives ${accountCurrency}, but this payment is in ${currency}. ` +
          "Submit the intent in the beneficiary's currency, or save a beneficiary for this currency in Airwallex.",
      );
    }
    const methods = b.transfer_methods ?? [];
    if (this.opts.transferMethod) {
      if (methods.length && !methods.includes(this.opts.transferMethod)) {
        throw new Error(
          `Airwallex beneficiary ${beneficiaryId} is saved for ${methods.join(", ")}, not ${this.opts.transferMethod} ` +
            "(adapter.airwallex.transfer_method).",
        );
      }
      return this.opts.transferMethod;
    }
    if (!methods[0]) throw new Error(`Airwallex beneficiary ${beneficiaryId} has no transfer method. Set adapter.airwallex.transfer_method.`);
    return methods[0];
  }

  /**
   * Spec, request_id on "Create a Transfer": "Payout creation requests with a request_id that has been used in the
   * past 7 days are treated as duplicated payout and cannot be processed. When you are not sure about the outcome
   * ... you can try to get a payout with this request_id." So a retry after a crash gets a 400 request_id_duplicate
   * (or 409 request_pending) and looks the transfer up instead of paying twice: by the transfer id the spec's
   * request_id_duplicate example carries in details.id, else by listing transfers with this request_id.
   */
  private async findExisting(requestId: string, err: AirwallexApiError): Promise<Transfer | undefined> {
    const id = err.details?.id;
    if (typeof id === "string" && id) {
      const t = await this.client.request<Transfer>("GET", `/api/v1/transfers/${encodeURIComponent(id)}`).catch(() => undefined);
      if (t?.id && (t.request_id === undefined || t.request_id === requestId)) return t;
    }
    // page=0 lifts the default 30-day window (spec: "Get list of transfers", page parameter).
    const page = await this.client.request<{ items?: Transfer[] }>("GET", "/api/v1/transfers", {
      query: { request_id: requestId, page: "0" },
    });
    return page.items?.find((t) => t.request_id === undefined || t.request_id === requestId);
  }

  async sendPayout(req: PayoutRequest): Promise<PayoutResult> {
    const beneficiaryId = req.payee.airwallex_beneficiary;
    if (!beneficiaryId) throw new Error("No airwallex_beneficiary on this payee.");
    const currency = req.currency.toUpperCase();
    const transferMethod = await this.route(beneficiaryId, currency);
    const body = {
      request_id: req.intent_id,
      beneficiary_id: beneficiaryId,
      transfer_currency: currency,
      // "49.99", "1500" or "1.234": exact decimals from integer minor units.
      transfer_amount: formatMajor(req.amount, currency),
      source_currency: currency,
      transfer_method: transferMethod,
      fee_paid_by: "PAYER",
      reason: this.opts.reason ?? "professional_business_services",
      // Shown on the vendor's bank statement. Some local rails allow only 18 letters and digits, so keep it to that.
      reference: `PS${req.intent_id.replace(/^int_/, "").replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 18),
      // Not passed to the beneficiary.
      remarks: req.note.slice(0, 140),
      metadata: { pursestring_intent_id: req.intent_id },
    };
    try {
      return AirwallexPayoutsAdapter.result(await this.client.request<Transfer>("POST", "/api/v1/transfers/create", { body }));
    } catch (err) {
      if (!(err instanceof AirwallexApiError)) throw err;
      if (err.code === "request_id_duplicate" || err.code === "request_pending" || err.status === 409) {
        const existing = await this.findExisting(req.intent_id, err);
        if (existing) return AirwallexPayoutsAdapter.result(existing);
        throw new Error(
          `Airwallex already has a transfer with request_id ${req.intent_id} but didn't list it yet. ` +
            "Nothing was sent twice. Retry in a minute, or check Payouts > Transfers in the Airwallex web app.",
        );
      }
      throw err;
    }
  }

  async getPayout(paymentId: string): Promise<PayoutResult> {
    return AirwallexPayoutsAdapter.result(
      await this.client.request<Transfer>("GET", `/api/v1/transfers/${encodeURIComponent(paymentId)}`),
    );
  }

  private cardless(): never {
    throw new Error("The airwallex_payouts rail pays the vendor's bank account and issues no card. Call send_payment instead.");
  }

  async issueCard(): Promise<CardDetails> {
    this.cardless();
  }

  async getCard(): Promise<CardDetails> {
    this.cardless();
  }
}
