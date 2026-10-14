import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { normalizeDomain } from "./policy.js";
import type { IntentRecord, PurchaseIntent } from "./types.js";

/**
 * Deterministic idempotency key: SHA256(agent_id | task_id | vendor | amount).
 * Fields are joined with a separator so "a"+"bc" and "ab"+"c" never collide,
 * the vendor is normalized and the amount is fixed to cents.
 */
export function idempotencyKey(intent: Pick<PurchaseIntent, "agent_id" | "task_id" | "vendor_domain" | "amount">): string {
  const parts = [
    intent.agent_id.trim(),
    intent.task_id.trim(),
    normalizeDomain(intent.vendor_domain),
    intent.amount.toFixed(2),
  ];
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
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

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.statePath = join(dir, "state.json");
    this.auditPath = join(dir, "decisions.jsonl");
    this.lockPath = join(dir, "state.lock");
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

  private withLock<T>(fn: () => T): T {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        mkdirSync(this.lockPath);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) rmSync(this.lockPath, { recursive: true, force: true });
        } catch {
          /* lock vanished between calls */
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${this.lockPath}`);
        sleepSync(25);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
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

  /** Append one decision to the audit log. Lines are JSON objects, one per event. */
  audit(event: string, data: Record<string, unknown>) {
    appendFileSync(this.auditPath, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n", {
      mode: 0o600,
    });
  }

  readAudit(limit = 50): Record<string, unknown>[] {
    if (!existsSync(this.auditPath)) return [];
    const lines = readFileSync(this.auditPath, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  }
}

/** Total of card spend limits issued to an agent since 00:00 UTC. */
export function spentToday(intents: Record<string, IntentRecord>, agentId: string, now: Date): number {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Object.values(intents)
    .filter((r) => r.intent.agent_id === agentId && r.card && new Date(r.card.issued_at) >= dayStart)
    .reduce((sum, r) => sum + (r.card?.spend_limit ?? 0), 0);
}
