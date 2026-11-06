import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cardCostMinor } from "./holds.js";
import { formatMajor, toMajor, toMinor } from "./money.js";
import { normalizeDomain } from "./policy.js";
import type { IntentRecord, PurchaseIntent } from "./types.js";

/**
 * Deterministic idempotency key: SHA256(agent_id | task_id | vendor | amount).
 * Fields are joined with a separator so "a"+"bc" and "ab"+"c" never collide,
 * the vendor is normalized and the amount is written with the currency's own decimals ("15.00" USD, "1500" JPY,
 * "1.234" KWD), so two amounts that differ by one minor unit never share a key.
 */
export function idempotencyKey(
  intent: Pick<PurchaseIntent, "agent_id" | "task_id" | "vendor_domain" | "amount"> & { currency?: string },
): string {
  const parts = [
    intent.agent_id.trim(),
    intent.task_id.trim(),
    normalizeDomain(intent.vendor_domain),
    formatMajor(intent.amount, intent.currency ?? "USD"),
  ];
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

/** prev of the first chained entry. */
export const AUDIT_GENESIS = "0".repeat(64);
/** A chained line ends with its hash: `...,"hash":"sha256:<hex>"}` or `"hmac:<hex>"` when PURSESTRING_AUDIT_KEY is set. */
const HASH_SUFFIX = /,"hash":"(sha256|hmac):([0-9a-f]{64})"\}$/;

export interface AuditVerification {
  ok: boolean;
  /** Lines in the log. */
  entries: number;
  /** Lines written before hash chaining existed. They can't be verified. */
  legacy_entries: number;
  /** "hmac" when entries are keyed with PURSESTRING_AUDIT_KEY, "sha256" otherwise. */
  mode: "sha256" | "hmac" | null;
  /** Hash of the last good entry. Write it down somewhere else to catch truncation later. */
  head: string | null;
  /** The first line that fails, 1-based, and why. Everything after it is untrusted. */
  broken_at?: { line: number; seq?: number; reason: string };
}

function chainHash(body: string, key: string | undefined): string {
  return key
    ? `hmac:${createHmac("sha256", key).update(body).digest("hex")}`
    : `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/**
 * Check every link of an audit log. Each chained entry carries `seq`, `prev` (the previous entry's hash) and `hash`
 * (SHA-256, or HMAC-SHA256 with the audit key, over the exact line without the hash). Editing, deleting, inserting or
 * reordering a line breaks the chain at that line. Lines from before chaining are counted as legacy, but only at the start.
 */
export function verifyAuditLog(text: string, key?: string): AuditVerification {
  const lines = text.split("\n").filter(Boolean);
  const result: AuditVerification = { ok: true, entries: lines.length, legacy_entries: 0, mode: null, head: null };
  const fail = (line: number, reason: string, seq?: number) => {
    result.ok = false;
    result.broken_at = { line, ...(seq === undefined ? {} : { seq }), reason };
    return result;
  };
  let prev: string | null = null;
  let expectedSeq = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      return fail(n, "not valid JSON");
    }
    const m = HASH_SUFFIX.exec(line);
    if (!m) {
      if (prev === null && entry.hash === undefined) {
        result.legacy_entries++;
        continue;
      }
      return fail(n, "entry has no hash: added or edited outside PurseString");
    }
    const seq = typeof entry.seq === "number" ? entry.seq : undefined;
    const mode = m[1] as "sha256" | "hmac";
    // Turning a key on mid-log is fine (sha256 -> hmac): the first keyed entry pins everything before it.
    if (result.mode === "hmac" && mode === "sha256") return fail(n, "entry is not keyed but earlier entries are", seq);
    result.mode = mode;
    if (mode === "hmac" && !key) return fail(n, "entries are keyed: set PURSESTRING_AUDIT_KEY to verify them", seq);
    if (seq !== expectedSeq) return fail(n, `expected seq ${expectedSeq}, found ${seq ?? "none"}: an entry was removed, inserted or moved`, seq);
    if (entry.prev !== (prev ?? AUDIT_GENESIS)) return fail(n, "prev does not match the previous entry's hash", seq);
    const hash = `${mode}:${m[2]}`;
    const body = line.slice(0, m.index) + "}";
    if (chainHash(body, mode === "hmac" ? key : undefined) !== hash) {
      return fail(n, mode === "hmac" ? "hash mismatch: entry was edited, or the key is wrong" : "hash mismatch: entry was edited", seq);
    }
    prev = hash;
    expectedSeq++;
  }
  if (key && result.mode === "sha256") {
    return fail(lines.length, "PURSESTRING_AUDIT_KEY is set but no entry is keyed: the chain may have been rebuilt without the key");
  }
  result.head = prev;
  return result;
}

/** The last line of a file, read from the end so big logs stay cheap. */
function lastLine(path: string): string | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size === 0) return null;
  const fd = openSync(path, "r");
  try {
    let len = Math.min(size, 4096);
    for (;;) {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const text = buf.toString("utf8").replace(/\n+$/, "");
      const nl = text.lastIndexOf("\n");
      if (nl >= 0 || len === size) return text.slice(nl + 1);
      len = Math.min(size, len * 4);
    }
  } finally {
    closeSync(fd);
  }
}

interface StateFile {
  version: 1;
  intents: Record<string, IntentRecord>;
}

const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Local JSON state shared by the MCP server and the `pursestring approve` CLI.
 * Every mutation takes a directory lock, re-reads the file and writes atomically,
 * so a human approving from a terminal never races the running server.
 */
export class Store {
  readonly statePath: string;
  readonly auditPath: string;
  private readonly lockPath: string;
  private readonly auditLockPath: string;
  private readonly auditKey: string | undefined;

  /** `auditKey` (default: PURSESTRING_AUDIT_KEY) turns the audit hash chain into an HMAC chain. */
  constructor(readonly dir: string, opts: { auditKey?: string } = {}) {
    mkdirSync(dir, { recursive: true });
    this.statePath = join(dir, "state.json");
    this.auditPath = join(dir, "decisions.jsonl");
    this.lockPath = join(dir, "state.lock");
    this.auditLockPath = join(dir, "audit.lock");
    this.auditKey = opts.auditKey ?? (process.env.PURSESTRING_AUDIT_KEY || undefined);
  }

  private read(): StateFile {
    if (!existsSync(this.statePath)) return { version: 1, intents: {} };
    return JSON.parse(readFileSync(this.statePath, "utf8")) as StateFile;
  }

  private write(state: StateFile) {
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }

  private withLock<T>(fn: () => T, lockPath = this.lockPath): T {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        mkdirSync(lockPath);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { recursive: true, force: true });
        } catch {
          /* lock vanished between calls */
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lockPath}`);
        sleepSync(25);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  /** Read-modify-write under the lock. Expired intents are swept on every pass. */
  transact<T>(fn: (intents: Record<string, IntentRecord>, now: Date) => T): T {
    return this.withLock(() => {
      const state = this.read();
      const now = new Date();
      for (const rec of Object.values(state.intents)) {
        if ((rec.status === "pending_approval" || rec.status === "approved") && new Date(rec.expires_at) <= now) {
          rec.status = "expired";
          rec.updated_at = now.toISOString();
        }
      }
      const result = fn(state.intents, now);
      this.write(state);
      return result;
    });
  }

  get(intentId: string): IntentRecord | undefined {
    return this.transact((intents) => intents[intentId]);
  }

  list(filter?: (r: IntentRecord) => boolean): IntentRecord[] {
    return this.transact((intents) =>
      Object.values(intents)
        .filter(filter ?? (() => true))
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    );
  }

  newId(): string {
    return `int_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  }

  /**
   * Append one decision to the audit log. Lines are JSON objects, one per event, hash-chained:
   * `seq` counts up from 1, `prev` is the previous line's hash and `hash` covers the line itself. See verifyAuditLog.
   */
  audit(event: string, data: Record<string, unknown>) {
    this.withLock(() => {
      let seq = 1;
      let prev = AUDIT_GENESIS;
      const last = lastLine(this.auditPath);
      if (last) {
        try {
          const e = JSON.parse(last) as { seq?: unknown; hash?: unknown };
          if (typeof e.seq === "number" && typeof e.hash === "string") {
            seq = e.seq + 1;
            prev = e.hash;
          }
        } catch {
          /* a torn last line: verify will report it; keep logging */
        }
      }
      const { seq: _s, prev: _p, hash: _h, ...rest } = data;
      const body = JSON.stringify({ ts: new Date().toISOString(), event, ...rest, seq, prev });
      const line = `${body.slice(0, -1)},"hash":"${chainHash(body, this.auditKey)}"}`;
      appendFileSync(this.auditPath, line + "\n", { mode: 0o600 });
    }, this.auditLockPath);
  }

  /** Check the whole audit log's hash chain. */
  verifyAudit(): AuditVerification {
    return verifyAuditLog(existsSync(this.auditPath) ? readFileSync(this.auditPath, "utf8") : "", this.auditKey);
  }

  readAudit(limit = 50): Record<string, unknown>[] {
    if (!existsSync(this.auditPath)) return [];
    const lines = readFileSync(this.auditPath, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  }
}

/**
 * Total an agent has spent since 00:00 UTC: card spend limits issued, or what was captured once a single-use card's
 * charge settles (less what merchants refunded on those cards),
 * payouts sent and PayPal refunds made through governed tools. Summed in whole minor units of `currency`, so a
 * hundred 0.10 spends come to exactly 10.00. Returns major units.
 */
export function spentToday(intents: Record<string, IntentRecord>, agentId: string, now: Date, currency = "USD"): number {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const m = (n: number) => toMinor(n, currency);
  let sum = 0;
  for (const r of Object.values(intents)) {
    if (r.intent.agent_id !== agentId) continue;
    if (r.card && new Date(r.card.issued_at) >= dayStart) {
      const cost = m(toMajor(cardCostMinor(r), r.card.currency));
      sum += Math.max(0, cost - m(r.refunded_total ?? 0));
    }
    if (r.payment && new Date(r.payment.sent_at) >= dayStart) sum += m(r.payment.amount);
    if (r.action?.executed_at && !r.action.is_error && new Date(r.action.executed_at) >= dayStart) sum += m(r.intent.amount);
  }
  return toMajor(sum, currency);
}
