import type { CardDetails } from "../types.js";
import type { CardAdapter } from "./types.js";

const REPO = "https://github.com/suseendar1414/pursestring";

/**
 * A rail that routing can already target but that isn't implemented yet.
 * Selecting it in policies.yaml is valid; issuing through it fails with a pointer to the tracking issue,
 * so a misrouted purchase stops safely instead of falling back to another rail.
 */
export class PlannedAdapter implements CardAdapter {
  constructor(
    readonly name: string,
    readonly kind: "card" | "bank_transfer",
    private readonly description: string,
    private readonly issue: string,
  ) {}

  private fail(): never {
    throw new Error(`The ${this.name} rail (${this.description}) isn't implemented yet. Track or build it: ${this.issue}`);
  }

  async issueCard(): Promise<CardDetails> {
    this.fail();
  }

  async getCard(): Promise<CardDetails> {
    this.fail();
  }
}

export const planned = {
  highnote: () =>
    new PlannedAdapter("highnote", "card", "Highnote virtual cards, incl. commercial charge cards", `${REPO}/issues/13`),
  marqeta: () => new PlannedAdapter("marqeta", "card", "Marqeta JIT-funded virtual cards", `${REPO}/issues/14`),
  amex: () =>
    new PlannedAdapter("amex", "card", "American Express single-use virtual card numbers on a corporate credit line", `${REPO}/issues/15`),
  network_token: () =>
    new PlannedAdapter(
      "network_token",
      "card",
      "the user's own Visa / Mastercard via Visa Intelligent Commerce and Mastercard Agent Pay",
      `${REPO}/issues/20`,
    ),
  ach: () =>
    new PlannedAdapter("ach", "bank_transfer", "ACH / wire / SEPA from a corporate bank account via treasury APIs", `${REPO}/issues/16`),
};
