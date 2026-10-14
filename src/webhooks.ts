import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Standard Webhooks signature (https://www.standardwebhooks.com), the scheme Lithic uses for
 * Events and Auth Stream Access: base64(HMAC-SHA256(secret, "<id>.<timestamp>.<body>")) in "webhook-signature".
 */
export function verifyStandardWebhook(
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
  const id = h("webhook-id");
  const ts = h("webhook-timestamp");
  const sigHeader = h("webhook-signature");
  if (!id || !ts || !sigHeader) return false;
  if (!/^\d+$/.test(ts) || Math.abs(nowSeconds - Number(ts)) > toleranceSeconds) return false;

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  return sigHeader.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export function signStandardWebhook(secret: string, id: string, ts: number, rawBody: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
}
