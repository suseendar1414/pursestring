/**
 * Money is counted in whole minor units (cents for USD, yen for JPY, fils for KWD) wherever PurseString adds,
 * subtracts or compares amounts, so totals never drift the way 0.1 + 0.2 does in floating point.
 * Major units ("49.99") are used only at the edges: what agents and policies.yaml say, what rails are sent,
 * and what people read. A major amount that has been through `normalize` converts back to minor units exactly.
 */

/** ISO 4217 currencies whose minor unit is not 1/100. Everything else has two decimals. */
const EXPONENTS: Record<string, number> = {
  // No minor unit.
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Thousandths.
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // Ten-thousandths.
  CLF: 4, UYW: 4,
};

/** Decimal places in a currency's minor unit: USD 2, JPY 0, KWD 3. */
export function exponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

/** 49.99 USD -> 4999. Rounds to the nearest minor unit. */
export function toMinor(major: number, currency: string): number {
  const minor = Math.round(major * 10 ** exponent(currency));
  // Math.round(-0.4) is -0; keep zero plain so it serializes and compares cleanly.
  return minor === 0 ? 0 : minor;
}

/** 4999 USD -> 49.99. */
export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** exponent(currency);
}

/** Round a major amount to the currency's minor unit: 15.004 USD -> 15. */
export function normalize(major: number, currency: string): number {
  return toMajor(toMinor(major, currency), currency);
}

/** Whether a major amount is a whole number of minor units: 15.5 is fine for USD, not for JPY. */
export function isWholeMinor(major: number, currency: string): boolean {
  const scaled = major * 10 ** exponent(currency);
  return Number.isFinite(scaled) && Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** 4999 USD -> "49.99", 1500 JPY -> "1500", 1234 KWD -> "1.234". Built from integers, so no float formatting quirks. */
export function formatMinor(minor: number, currency: string): string {
  const e = exponent(currency);
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(Math.round(minor))).padStart(e + 1, "0");
  return e === 0 ? sign + digits : `${sign}${digits.slice(0, -e)}.${digits.slice(-e)}`;
}

/** 49.99 USD -> "49.99": a major amount, written with exactly the currency's decimals. */
export function formatMajor(major: number, currency: string): string {
  return formatMinor(toMinor(major, currency), currency);
}

/** 49.99 USD -> "49.99 USD". */
export function formatMoney(major: number, currency: string): string {
  return `${formatMajor(major, currency)} ${currency.toUpperCase()}`;
}
