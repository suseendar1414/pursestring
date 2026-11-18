import type { Config, RailName } from "../config.js";
import { AirwallexAdapter } from "./airwallex.js";
import { AirwallexPayoutsAdapter } from "./airwallex-payouts.js";
import { LithicAdapter } from "./lithic.js";
import { ModernTreasuryAdapter } from "./modern-treasury.js";
import { MockAdapter } from "./mock.js";
import { PayPalAdapter } from "./paypal.js";
import { planned } from "./planned.js";
import { PrivacyAdapter } from "./privacy.js";
import { RazorpayXAdapter } from "./razorpayx.js";
import { StripeConnectAdapter } from "./stripe-connect.js";
import { X402Rail } from "./x402.js";
import type { CardAdapter } from "./types.js";

export type { CardAdapter, IssueCardRequest, PayoutRequest, PayoutResult } from "./types.js";

/** All rails, built on first use so an unconfigured rail only errors if a purchase is routed to it. */
export class Rails {
  private readonly cache = new Map<string, CardAdapter>();

  constructor(
    private readonly config: Config,
    overrides: Partial<Record<RailName, CardAdapter>> = {},
  ) {
    for (const [name, adapter] of Object.entries(overrides)) if (adapter) this.cache.set(name, adapter);
  }

  get default(): RailName {
    return this.config.policy.adapter.type;
  }

  get(name: string): CardAdapter {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const adapter = this.build(name);
    this.cache.set(name, adapter);
    return adapter;
  }

  private build(name: string): CardAdapter {
    switch (name) {
      case "mock":
        return new MockAdapter();
      case "lithic":
        if (!this.config.env.lithicApiKey) throw new Error("A purchase was routed to 'lithic' but LITHIC_API_KEY is not set.");
        return new LithicAdapter(this.config.env.lithicApiKey, this.config.policy.adapter.lithic.environment);
      case "privacy":
        if (!this.config.env.privacyApiKey) throw new Error("A purchase was routed to 'privacy' but PRIVACY_API_KEY is not set.");
        return new PrivacyAdapter(this.config.env.privacyApiKey);
      case "airwallex":
      case "airwallex_payouts": {
        const { airwallexClientId: clientId, airwallexApiKey: apiKey, airwallexCardholderId: cardholderId, airwallexAccountId } =
          this.config.env;
        const aw = this.config.policy.adapter.airwallex;
        const needCardholder = name === "airwallex";
        if (!clientId || !apiKey || (needCardholder && !cardholderId)) {
          throw new Error(
            `A purchase was routed to '${name}' but AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY` +
              (needCardholder ? " and AIRWALLEX_CARDHOLDER_ID are not all set." : " are not both set."),
          );
        }
        const client = {
          clientId,
          apiKey,
          environment: aw.environment,
          loginAs: airwallexAccountId,
          apiVersion: aw.api_version,
          baseUrl: aw.base_url,
        };
        return needCardholder
          ? new AirwallexAdapter({ ...client, cardholderId: cardholderId!, createdBy: aw.created_by })
          : new AirwallexPayoutsAdapter({ ...client, reason: aw.payout_reason, transferMethod: aw.transfer_method });
      }
      case "paypal": {
        const { paypalClientId: clientId, paypalClientSecret: clientSecret } = this.config.env;
        if (!clientId || !clientSecret) {
          throw new Error("A purchase was routed to 'paypal' but PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not both set.");
        }
        return new PayPalAdapter({ clientId, clientSecret, environment: this.config.policy.adapter.paypal.environment });
      }
      case "stripe_connect": {
        const key = this.config.env.stripeSecretKey;
        if (!key) throw new Error("A purchase was routed to 'stripe_connect' but STRIPE_SECRET_KEY is not set.");
        return new StripeConnectAdapter({ secretKey: key, environment: this.config.policy.adapter.stripe_connect.environment });
      }
      case "razorpayx": {
        const { razorpayxKeyId: keyId, razorpayxKeySecret: keySecret, razorpayxAccountNumber: accountNumber } = this.config.env;
        if (!keyId || !keySecret || !accountNumber) {
          throw new Error(
            "A purchase was routed to 'razorpayx' but RAZORPAYX_KEY_ID, RAZORPAYX_KEY_SECRET and RAZORPAYX_ACCOUNT_NUMBER are not all set.",
          );
        }
        const rx = this.config.policy.adapter.razorpayx;
        return new RazorpayXAdapter({ keyId, keySecret, accountNumber, mode: rx.mode, purpose: rx.purpose, environment: rx.environment });
      }
      case "modern_treasury": {
        const { modernTreasuryOrgId: organizationId, modernTreasuryApiKey: apiKey, modernTreasuryOriginatingAccountId: originatingAccountId } =
          this.config.env;
        if (!organizationId || !apiKey || !originatingAccountId) {
          throw new Error(
            "A purchase was routed to 'modern_treasury' but MODERN_TREASURY_ORGANIZATION_ID, MODERN_TREASURY_API_KEY and " +
              "MODERN_TREASURY_ORIGINATING_ACCOUNT_ID are not all set.",
          );
        }
        return new ModernTreasuryAdapter({
          organizationId,
          apiKey,
          originatingAccountId,
          paymentType: this.config.policy.adapter.modern_treasury.payment_type,
        });
      }
      case "x402":
        return new X402Rail();
      case "highnote":
      case "marqeta":
      case "amex":
      case "network_token":
      case "ach":
        return planned[name]();
      default:
        throw new Error(`Unknown rail '${name}'.`);
    }
  }
}
