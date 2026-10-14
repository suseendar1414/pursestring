import { createHash, randomUUID } from "node:crypto";
import type { CardDetails, CardReference } from "../types.js";
import type { CardAdapter, IssueCardRequest } from "./types.js";

function luhnCheckDigit(partial: string): string {
  let sum = 0;
  for (let i = 0; i < partial.length; i++) {
    let d = Number(partial[partial.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

/** Card details derived from the token, so a replay returns the exact same card. */
function detailsFor(token: string) {
  const h = createHash("sha256").update(token).digest();
  const digits = Array.from(h.subarray(0, 9), (b) => String(b % 10)).join("");
  const partial = "400000" + digits; // 4000 00xx: a Visa test range, never a live card
  const pan = partial + luhnCheckDigit(partial);
  return {
    pan,
    cvv: String(100 + (h[10] * 256 + h[11]) % 900),
    exp_month: String(1 + (h[12] % 12)).padStart(2, "0"),
    exp_year: String(new Date().getUTCFullYear() + 2),
    last_four: pan.slice(-4),
  };
}

/** In-process sandbox rail. No network, no money. The default until a real rail is configured. */
export class MockAdapter implements CardAdapter {
  readonly name = "mock";
  readonly kind = "card" as const;
  readonly closed = new Set<string>();

  async issueCard(req: IssueCardRequest): Promise<CardDetails> {
    const token = `mock_${randomUUID()}`;
    const d = detailsFor(token);
    return {
      adapter: this.name,
      token,
      issued_at: new Date().toISOString(),
      spend_limit: req.amount,
      currency: req.currency,
      single_use: req.single_use,
      ...d,
    };
  }

  async getCard(ref: CardReference): Promise<CardDetails> {
    return { ...ref, ...detailsFor(ref.token) };
  }

  async closeCard(ref: CardReference): Promise<void> {
    this.closed.add(ref.token);
  }
}
