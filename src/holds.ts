import { toMinor } from "./money.js";
import type { AuthorizationRecord, IntentRecord } from "./types.js";

/**
 * Card authorizations are holds, not charges. After PurseString approves one in real time, the issuer reports what
 * happened to it: the merchant captured it (all, part, or a little more, as with tips), or released it (a reversal,
 * a void, or the hold timing out). These helpers turn an authorization and those events into the amount that
 * actually counts, in whole minor units of the card's currency.
 *
 * A capture smaller than the hold doesn't end it: merchants split one order across shipments and capture each part
 * separately. The rest stays held until a later capture takes it, the issuer releases it, a capture marked final
 * closes the hold, or `jit.partial_capture_hold_days` pass after the first capture.
 */

/** Whether the hold on an authorization is over: nothing more can be captured against it. */
export function holdClosed(a: AuthorizationRecord, now: Date = new Date()): boolean {
  if (a.superseded_at) return true;
  if (a.hold_closed_at) return true;
  if (!a.settled_at) return false;
  // Records from before split captures were tracked: the first capture ended the hold.
  if (!a.leftover_until) return true;
  return new Date(a.leftover_until) <= now;
}

/** What is still held on an authorization: what was authorized less what was captured or released, until the hold closes. */
export function openHoldMinor(a: AuthorizationRecord, currency: string, now: Date = new Date()): number {
  if (!a.approved || holdClosed(a, now)) return 0;
  return Math.max(0, toMinor(a.amount, currency) - toMinor(a.captured ?? 0, currency) - toMinor(a.released ?? 0, currency));
}

/**
 * What an approved authorization costs: what was captured, plus whatever is still held. A released hold costs nothing,
 * and neither does one replaced by a re-authorization of the same transaction (the new one counts instead).
 */
export function usedMinor(a: AuthorizationRecord, currency: string, now: Date = new Date()): number {
  if (!a.approved || a.superseded_at) return 0;
  return toMinor(a.captured ?? 0, currency) + openHoldMinor(a, currency, now);
}

/** held: waiting for the merchant. captured: money moved (part may still be held). released: the hold fell away with nothing captured. */
export function holdStatus(a: AuthorizationRecord, currency: string, now: Date = new Date()): "held" | "captured" | "released" {
  if (toMinor(a.captured ?? 0, currency) > 0) return "captured";
  return openHoldMinor(a, currency, now) > 0 ? "held" : "released";
}

/** Whether a single-use card can't be charged any more: closed, or past its expiry. */
export function cardDone(rec: IntentRecord, now: Date = new Date()): boolean {
  const card = rec.card;
  return Boolean(card && (card.closed_at || (card.expires_at && new Date(card.expires_at) <= now)));
}

/**
 * What a card has cost, in minor units, for the daily budget and for refunds.
 * Before any approved authorization, or while a single-use card could still be charged, it's the card's limit,
 * reserved when the card was issued. Once a single-use card's charge has been captured, it's what was captured plus
 * any part of the hold still open. A single-use card that expired or closed unused costs nothing, but only when every
 * charge on it had to pass PurseString's real-time check (`jit_gated`): otherwise an unrecorded charge may exist.
 * Recurring cards keep their limit reserved: they can still renew.
 */
export function cardCostMinor(rec: IntentRecord, now: Date = new Date()): number {
  const card = rec.card;
  if (!card) return 0;
  const limit = toMinor(card.spend_limit, card.currency);
  if (!card.single_use) return limit;
  const approved = (rec.authorizations ?? []).filter((a) => a.approved);
  const used = approved.reduce((sum, a) => sum + usedMinor(a, card.currency, now), 0);
  if (approved.some((a) => a.settled_at)) return used;
  if (card.jit_gated && cardDone(rec, now) && used === 0) return 0;
  return limit;
}
