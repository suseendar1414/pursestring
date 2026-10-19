import { LithicAdapter } from "./lithic.js";

/**
 * Privacy.com virtual cards (https://developers.privacy.com/docs/cards), funded from the user's own
 * bank account or debit card. Same card API shape as Lithic, so it reuses that adapter.
 * Privacy only accepts spend limits in whole dollars, so the cap rounds up to the next dollar.
 * There is no sandbox and no real-time authorization hook: every card is real money.
 */
export class PrivacyAdapter extends LithicAdapter {
  override readonly name = "privacy";
  protected override readonly label = "Privacy.com";

  constructor(apiKey: string) {
    super(apiKey, "production");
    this.baseUrl = "https://api.privacy.com/v1";
  }

  protected override spendLimitCents(amount: number): number {
    return Math.ceil(amount) * 100;
  }
}
