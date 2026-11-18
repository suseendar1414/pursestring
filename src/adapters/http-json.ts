/** Shared fetch helper for payout rails: one place that turns a non-2xx answer into an error with the rail's message. */
export async function callRail<T>(
  rail: string,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${rail} ${init.method} ${new URL(url).pathname} failed: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export const basicAuth = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
