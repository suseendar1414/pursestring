import { toMinor } from "./money.js";
import type { AuthorizationRecord, IntentRecord } from "./types.js";

/**
 * Card authorizations are holds, not charges. After PurseString approves one in real time, the issuer reports what
 * happened to it: the merchant captured it (all, part, or a little more, as with tips), or released it (a reversal,
 * a void, or the hold timing out). These helpers turn an authorization and those events into the amount that
 * actually counts, in whole minor units of the card's currency.
 */

/** What is still held on an authorization: nothing once it has been captured, since capture ends the hold. */
export function openHoldMinor(a: AuthorizationRecord, currency: string): number {
  if (!a.approved || a.settled_at) return 0;
  return Math.max(0, toMinor(a.amount, currency) - toMinor(a.captured ?? 0, currency) - toMinor(a.released ?? 0, currency));
}

/** What an approved authorization costs: what was captured, plus whatever is still held. A released hold costs nothing. */
export function usedMinor(a: AuthorizationRecord, currency: string): number {
  if (!a.approved) return 0;
  return toMinor(a.captured ?? 0, currency) + openHoldMinor(a, currency);
}

/** held: waiting for the merchant. captured: money moved. released: the hold fell away with nothing captured. */
export function holdStatus(a: AuthorizationRecord, currency: string): "held" | "captured" | "released" {
  if (toMinor(a.captured ?? 0, currency) > 0) return "captured";
  return openHoldMinor(a, currency) > 0 ? "held" : "released";
}

/**
 * What a card has cost, in minor units, for the daily budget and for refunds.
 * Before any approved authorization, or while a single-use card could still be charged, it's the card's limit,
 * reserved when the card was issued. Once a single-use card's charge has been captured, it's what was captured.
 * Recurring cards keep their limit reserved: they can still renew.
 */
export function cardCostMinor(rec: IntentRecord): number {
  const card = rec.card;
  if (!card) return 0;
  const limit = toMinor(card.spend_limit, card.currency);
  if (!card.single_use) return limit;
  const approved = (rec.authorizations ?? []).filter((a) => a.approved);
  if (!approved.some((a) => a.settled_at)) return limit;
  return approved.reduce((sum, a) => sum + usedMinor(a, card.currency), 0);
}
