import type { Config, RailName } from "../config.js";
import { AirwallexAdapter } from "./airwallex.js";
import { LithicAdapter } from "./lithic.js";
import { MockAdapter } from "./mock.js";
import { planned } from "./planned.js";
import { PrivacyAdapter } from "./privacy.js";
import type { CardAdapter } from "./types.js";

export type { CardAdapter, IssueCardRequest } from "./types.js";

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
      case "airwallex": {
        const { airwallexClientId: clientId, airwallexApiKey: apiKey, airwallexCardholderId: cardholderId } = this.config.env;
        if (!clientId || !apiKey || !cardholderId) {
          throw new Error(
            "A purchase was routed to 'airwallex' but AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY and AIRWALLEX_CARDHOLDER_ID are not all set.",
          );
        }
        return new AirwallexAdapter({ clientId, apiKey, cardholderId, environment: this.config.policy.adapter.airwallex.environment });
      }
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
