import type { Config } from "../config.js";
import { LithicAdapter } from "./lithic.js";
import { MockAdapter } from "./mock.js";
import type { CardAdapter } from "./types.js";

export type { CardAdapter, IssueCardRequest } from "./types.js";

export function createAdapter(config: Config): CardAdapter {
  switch (config.policy.adapter.type) {
    case "lithic":
      if (!config.env.lithicApiKey) throw new Error("adapter.type is 'lithic' but LITHIC_API_KEY is not set.");
      return new LithicAdapter(config.env.lithicApiKey, config.policy.adapter.lithic.environment);
    case "mock":
    default:
      return new MockAdapter();
  }
}
