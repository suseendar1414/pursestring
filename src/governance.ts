import type { CardAdapter } from "./adapters/index.js";
import type { Config } from "./config.js";
import type { Notifier } from "./notify.js";
import { evaluate } from "./policy.js";
import { idempotencyKey, spentToday, Store } from "./store.js";
import type { CardDetails, IntentRecord, PolicyEvaluation, PurchaseIntent } from "./types.js";

export class GovernanceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface SubmitResult {
  record: IntentRecord;
  /** True when an identical intent inside the idempotency window was returned instead of a new one. */
  deduplicated: boolean;
}

export interface CardResult {
  card: CardDetails;
  record: IntentRecord;
  /** True when this is a replay of a card already issued for this intent. */
  replayed: boolean;
}

const ISSUING_STALE_MS = 2 * 60_000;

/** The control plane: intent in, decision out, card only when the decision allows it. */
export class Governance {
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly adapter: CardAdapter,
    readonly notifier: Notifier,
  ) {}

  private get windowMs() {
    return this.config.policy.idempotency.window_minutes * 60_000;
  }

  private findRecent(intents: Record<string, IntentRecord>, key: string, now: Date): IntentRecord | undefined {
    return Object.values(intents)
      .filter((r) => r.idempotency_key === key && r.status !== "expired")
      .filter((r) => now.getTime() - new Date(r.created_at).getTime() < this.windowMs)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  }

  /** Dry run: what would happen if this intent were submitted now. Changes nothing but the audit log. */
  checkCompliance(intent: PurchaseIntent): { evaluation: PolicyEvaluation; idempotency_key: string; existing?: IntentRecord } {
    const key = idempotencyKey(intent);
    const out = this.store.transact((intents, now) => ({
      evaluation: evaluate(this.config.policy, intent, { spentTodayByAgent: spentToday(intents, intent.agent_id, now) }),
      existing: this.findRecent(intents, key, now),
    }));
    this.store.audit("policy_checked", {
      idempotency_key: key,
      intent,
      decision: out.evaluation.decision,
      rules: out.evaluation.rules,
    });
    return { ...out, idempotency_key: key };
  }

  async submitIntent(intent: PurchaseIntent): Promise<SubmitResult> {
    const key = idempotencyKey(intent);
    const result = this.store.transact((intents, now): SubmitResult => {
      const existing = this.findRecent(intents, key, now);
      if (existing) return { record: existing, deduplicated: true };

      const evaluation = evaluate(this.config.policy, intent, {
        spentTodayByAgent: spentToday(intents, intent.agent_id, now),
      });
      const status =
        evaluation.decision === "auto_approve" ? "approved" : evaluation.decision === "deny" ? "denied" : "pending_approval";
      const ts = now.toISOString();
      const record: IntentRecord = {
        intent_id: this.store.newId(),
        idempotency_key: key,
        intent,
        evaluation,
        status,
        created_at: ts,
        updated_at: ts,
        expires_at: new Date(now.getTime() + this.config.policy.approvals.ttl_minutes * 60_000).toISOString(),
        ...(status === "approved" ? { approved_by: "policy:auto_approve" } : {}),
        ...(status === "denied" ? { denied_by: "policy" } : {}),
      };
      intents[record.intent_id] = record;
      return { record, deduplicated: false };
    });

    const { record, deduplicated } = result;
    if (deduplicated) {
      this.store.audit("duplicate_intent_blocked", {
        intent_id: record.intent_id,
        idempotency_key: key,
        status: record.status,
        retry_of: intent,
      });
    } else {
      // The "black box" entry: what the agent wanted, why, what it tried, and how each rule ruled.
      this.store.audit("intent_submitted", {
        intent_id: record.intent_id,
        idempotency_key: key,
        intent,
        reasoning_tree: {
          goal: intent.task_goal,
          alternatives_attempted: intent.alternatives_attempted,
          agent_reasoning: intent.reasoning,
          policy_rules: record.evaluation.rules,
          decision: record.evaluation.decision,
          summary: record.evaluation.summary,
        },
        status: record.status,
        policy_file: this.config.policyPath,
      });
      if (record.status === "pending_approval") await this.notifier.approvalRequested(record);
    }
    return result;
  }

  async requestCard(intentId: string): Promise<CardResult> {
    type Claim = { kind: "replay"; record: IntentRecord } | { kind: "issue"; record: IntentRecord };
    const claim = this.store.transact((intents, now): Claim => {
      const rec = intents[intentId];
      if (!rec) throw new GovernanceError(`No intent ${intentId}. Call submit_purchase_intent first.`, "not_found");

      if (rec.status === "card_issued" && rec.card) {
        const age = now.getTime() - new Date(rec.card.issued_at).getTime();
        if (age < this.windowMs) return { kind: "replay", record: rec };
        throw new GovernanceError(
          `A card was already issued for ${intentId} at ${rec.card.issued_at} and the replay window has closed. ` +
            "If this is genuinely a new purchase, submit a new intent with a new task_id.",
          "already_issued",
        );
      }
      if (rec.status === "issuing" && now.getTime() - new Date(rec.updated_at).getTime() < ISSUING_STALE_MS) {
        throw new GovernanceError(`A card for ${intentId} is being issued right now. Retry in a few seconds.`, "in_progress");
      }
      if (rec.status === "pending_approval") {
        throw new GovernanceError(
          `Intent ${intentId} is waiting for human approval. Poll get_intent_status; do not resubmit or buy another way.`,
          "pending_approval",
        );
      }
      if (rec.status === "denied" || rec.status === "expired") {
        throw new GovernanceError(
          `Intent ${intentId} is ${rec.status}${rec.decision_note ? `: ${rec.decision_note}` : ""}. Do not attempt this purchase.`,
          rec.status,
        );
      }

      // Auto-approvals are re-checked against today's budget, since other cards may have been issued since submit.
      if (rec.approved_by === "policy:auto_approve") {
        const fresh = evaluate(this.config.policy, rec.intent, {
          spentTodayByAgent: spentToday(intents, rec.intent.agent_id, now),
        });
        if (fresh.decision !== "auto_approve") {
          rec.evaluation = fresh;
          rec.status = fresh.decision === "deny" ? "denied" : "pending_approval";
          rec.approved_by = undefined;
          rec.updated_at = now.toISOString();
          throw new GovernanceError(`Intent ${intentId} no longer qualifies for auto-approval: ${fresh.summary}`, rec.status);
        }
      }

      rec.status = "issuing";
      rec.updated_at = now.toISOString();
      return { kind: "issue", record: rec };
    });

    if (claim.kind === "replay") {
      const card = await this.adapter.getCard(claim.record.card!);
      this.store.audit("card_replayed", {
        intent_id: intentId,
        card_token: card.token,
        last_four: card.last_four,
        note: "Identical request inside the idempotency window: returned the existing card, no new transaction.",
      });
      return { card, record: claim.record, replayed: true };
    }

    const rec = claim.record;
    const singleUse = !rec.intent.is_recurring;
    let card: CardDetails;
    try {
      card = await this.adapter.issueCard({
        intent_id: rec.intent_id,
        amount: rec.intent.amount,
        currency: rec.intent.currency,
        vendor_domain: rec.intent.vendor_domain,
        single_use: singleUse,
        memo: `pursestring ${rec.intent_id} ${rec.intent.agent_id}/${rec.intent.task_id} ${rec.intent.vendor_domain}`,
      });
    } catch (err) {
      this.store.transact((intents, now) => {
        intents[intentId].status = "approved";
        intents[intentId].updated_at = now.toISOString();
      });
      this.store.audit("card_issue_failed", { intent_id: intentId, adapter: this.adapter.name, error: String(err) });
      throw new GovernanceError(`Card issuer error: ${(err as Error).message}`, "adapter_error");
    }

    const updated = this.store.transact((intents, now) => {
      const r = intents[intentId];
      r.status = "card_issued";
      r.updated_at = now.toISOString();
      r.card = {
        adapter: card.adapter,
        token: card.token,
        last_four: card.last_four,
        issued_at: card.issued_at,
        spend_limit: card.spend_limit,
        currency: card.currency,
        single_use: card.single_use,
      };
      return r;
    });
    this.store.audit("card_issued", {
      intent_id: intentId,
      adapter: card.adapter,
      card_token: card.token,
      last_four: card.last_four,
      spend_limit: card.spend_limit,
      currency: card.currency,
      single_use: card.single_use,
      approved_by: updated.approved_by,
    });
    return { card, record: updated, replayed: false };
  }

  async getStatus(intentId: string, waitSeconds = 0): Promise<IntentRecord> {
    const deadline = Date.now() + Math.min(waitSeconds, 300) * 1000;
    for (;;) {
      const rec = this.store.get(intentId);
      if (!rec) throw new GovernanceError(`No intent ${intentId}.`, "not_found");
      if (rec.status !== "pending_approval" || Date.now() >= deadline) return rec;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  decide(intentId: string, approve: boolean, by: string, note?: string): IntentRecord {
    const rec = this.store.transact((intents, now) => {
      const r = intents[intentId];
      if (!r) throw new GovernanceError(`No intent ${intentId}.`, "not_found");
      if (r.status !== "pending_approval") {
        throw new GovernanceError(`Intent ${intentId} is ${r.status}, not pending approval.`, "not_pending");
      }
      // Hard denials stay denied: a human cannot approve past a deny rule.
      r.status = approve ? "approved" : "denied";
      if (approve) r.approved_by = by;
      else r.denied_by = by;
      r.decision_note = note;
      r.updated_at = now.toISOString();
      return r;
    });
    this.store.audit(approve ? "human_approved" : "human_denied", { intent_id: intentId, by, note });
    return rec;
  }
}
