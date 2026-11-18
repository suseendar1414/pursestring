import type { CardDetails } from "../types.js";
import type { CardAdapter } from "./types.js";

/** Marks intents paid over x402. The payment itself happens in Governance.x402Fetch, against the resource's URL. */
export class X402Rail implements CardAdapter {
  readonly name = "x402";
  readonly kind = "x402" as const;

  private wrong(): never {
    throw new Error("x402 intents are paid by repeating x402_fetch with the intent_id, not with a card.");
  }

  async issueCard(): Promise<CardDetails> {
    this.wrong();
  }

  async getCard(): Promise<CardDetails> {
    this.wrong();
  }
}
