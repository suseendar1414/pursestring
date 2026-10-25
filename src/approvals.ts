import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** How an approval or denial reached PurseString. Recorded on the intent and in the audit log. */
export type ApprovalChannel = "cli" | "http" | "slack";

/** What we persist about an approval code: a salted scrypt hash, never the code itself. */
export interface ApprovalCodeHash {
  salt: string;
  hash: string;
}

/** Crockford base32: no I, L, O or U, so a code read off a phone is hard to mistype. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;

/**
 * A one-time approval code, 50 random bits, formatted "XXXXX-XXXXX". It goes only to the human's Slack or Discord,
 * so an agent that can run `pursestring approve` on the same machine still can't approve its own purchase.
 */
export function newApprovalCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** Uppercase, drop separators, and read the letters people confuse with digits as those digits. */
export function normalizeApprovalCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** scrypt, so reading state.json and guessing offline costs far more than the code is worth. */
export function hashApprovalCode(code: string, salt = randomBytes(16).toString("hex")): ApprovalCodeHash {
  return { salt, hash: scryptSync(normalizeApprovalCode(code), salt, 32).toString("hex") };
}

export function verifyApprovalCode(code: string, stored: ApprovalCodeHash): boolean {
  const got = Buffer.from(hashApprovalCode(code, stored.salt).hash, "hex");
  const want = Buffer.from(stored.hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Verify a Slack request signature (https://api.slack.com/authentication/verifying-requests-from-slack):
 * "v0=" + hex(HMAC-SHA256(signing secret, "v0:<timestamp>:<body>")) in X-Slack-Signature.
 */
export function verifySlackSignature(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const ts = h("x-slack-request-timestamp");
  const sig = h("x-slack-signature");
  if (!ts || !sig || !/^\d+$/.test(ts) || Math.abs(nowSeconds - Number(ts)) > toleranceSeconds) return false;
  const got = Buffer.from(sig);
  const want = Buffer.from(signSlackRequest(secret, Number(ts), rawBody));
  return got.length === want.length && timingSafeEqual(got, want);
}

export function signSlackRequest(secret: string, ts: number, rawBody: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
}
