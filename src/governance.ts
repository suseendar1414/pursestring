import type { Rails } from "./adapters/index.js";
import { hashApprovalCode, newApprovalCode, verifyApprovalCode, type ApprovalChannel } from "./approvals.js";
import type { Config } from "./config.js";
import type { Notifier } from "./notify.js";
import { domainMatches, evaluate, normalizeDomain, routeRail, vendorLabel } from "./policy.js";
import { idempotencyKey, spentToday, Store } from "./store.js";
import type {
  AuthorizationRecord,
  CardDetails,
  IntentRecord,
  Payee,
  PaymentRecord,
  PolicyEvaluation,
  PurchaseIntent,
} from "./types.js";

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

export interface PaymentResult {
  payment: PaymentRecord;
  record: IntentRecord;
  /** True when the intent was already paid and no money moved. */
  replayed: boolean;
}

export interface CardResult {
  card: CardDetails;
  record: IntentRecord;
  /** True when this is a replay of a card already issued for this intent. */
  replayed: boolean;
}

const ISSUING_STALE_MS = 2 * 60_000;
const MAX_CODE_ATTEMPTS = 5;

export interface DecideOptions {
  /** Where the decision came from. Terminal approvals need the one-time code when codes are required. */
  via: ApprovalChannel;
  code?: string;
}

/** A real-time authorization request from a card issuer: "merchant X wants $45 on card Y. Approve?" */
export interface AuthorizationRequest {
  card_token: string;
  amount: number;
  merchant: string;
  /** The issuer's stable ID for the merchant (Lithic acceptor_id). */
  merchant_id?: string;
  mcc?: string;
}

export type AuthorizationCode =
  | "approved"
  | "unknown_card"
  | "intent_not_active"
  | "card_expired"
  | "already_used"
  | "over_amount"
  | "merchant_mismatch";

export interface AuthorizationDecision {
  approved: boolean;
  code: AuthorizationCode;
  reason: string;
  intent_id?: string;
  latency_ms: number;
}

/** The control plane: intent in, decision out, card only when the decision allows it. */
export class Governance {
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly rails: Rails,
    readonly notifier: Notifier,
  ) {}

  /** Whether `pursestring approve` needs the one-time code. Unset in policy: on whenever Slack or Discord is set up. */
  get requireCode(): boolean {
    return this.config.policy.approvals.require_code ?? this.canSendCode;
  }

  /** Codes only go where the agent can't read them: Slack or Discord. */
  private get canSendCode(): boolean {
    return Boolean(this.config.env.slackWebhookUrl || this.config.env.discordWebhookUrl);
  }

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
    let approvalCode: string | undefined;
    const result = this.store.transact((intents, now): SubmitResult => {
      const existing = this.findRecent(intents, key, now);
      if (existing) return { record: existing, deduplicated: true };

      const evaluation = evaluate(this.config.policy, intent, {
        spentTodayByAgent: spentToday(intents, intent.agent_id, now),
      });
      const status =
        evaluation.decision === "auto_approve" ? "approved" : evaluation.decision === "deny" ? "denied" : "pending_approval";
      const ts = now.toISOString();
      const { rail } = routeRail(this.config.policy, intent);
      const record: IntentRecord = {
        intent_id: this.store.newId(),
        idempotency_key: key,
        intent,
        evaluation,
        status,
        created_at: ts,
        updated_at: ts,
        expires_at: new Date(now.getTime() + this.config.policy.approvals.ttl_minutes * 60_000).toISOString(),
        rail,
        ...(status === "approved" ? { approved_by: "policy:auto_approve" } : {}),
        ...(status === "denied" ? { denied_by: "policy" } : {}),
      };
      if (status === "pending_approval" && this.requireCode && this.canSendCode) {
        approvalCode = newApprovalCode();
        record.approval_code = hashApprovalCode(approvalCode);
      }
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
          rail: record.rail,
        },
        status: record.status,
        policy_file: this.config.policyPath,
      });
      if (record.status === "pending_approval") await this.notifier.approvalRequested(record, { code: approvalCode });
    }
    return result;
  }

  private railFor(rec: IntentRecord) {
    return this.rails.get(rec.rail ?? this.rails.default);
  }

  /**
   * The checks every way of moving money shares: the intent must be approved and live, and an auto-approval is
   * re-checked against today's budget, since other spends may have happened since submit. Runs inside a transaction.
   */
  private assertSpendable(rec: IntentRecord, intents: Record<string, IntentRecord>, now: Date) {
    const intentId = rec.intent_id;
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
  }

  /** Whether this intent's rail pays the vendor directly instead of issuing a card. */
  isPayout(rec: IntentRecord): boolean {
    return this.railFor(rec).kind === "payout";
  }

  async requestCard(intentId: string): Promise<CardResult> {
    const existing = this.store.get(intentId);
    if (existing && this.railFor(existing).kind === "bank_transfer") {
      throw new GovernanceError(
        `Policy routes ${intentId} to the '${existing.rail}' bank-transfer rail, so there is no card to issue. ` +
          "Bank transfers aren't supported yet; ask a human to pay this one.",
        "bank_transfer_rail",
      );
    }
    if (existing && this.railFor(existing).kind === "payout") {
      throw new GovernanceError(
        `Policy routes ${intentId} to the '${existing.rail}' rail, which pays the vendor directly instead of issuing a card. ` +
          "Call send_payment with this intent_id.",
        "payout_rail",
      );
    }
    type Claim = { kind: "replay"; record: IntentRecord } | { kind: "issue"; record: IntentRecord };
    const claim = this.store.transact((intents, now): Claim => {
      const rec = intents[intentId];
      if (!rec) throw new GovernanceError(`No intent ${intentId}. Call submit_purchase_intent first.`, "not_found");

      if (rec.status === "card_issued" && rec.card) {
        if (rec.card.closed_at || (rec.card.expires_at && new Date(rec.card.expires_at) <= now)) {
          throw new GovernanceError(
            `The card for ${intentId} expired at ${rec.card.expires_at}. Check whether the original purchase went through ` +
              "before trying again; if it didn't, submit a new intent with a new task_id.",
            "card_expired",
          );
        }
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
      this.assertSpendable(rec, intents, now);
      rec.status = "issuing";
      rec.updated_at = now.toISOString();
      return { kind: "issue", record: rec };
    });

    if (claim.kind === "replay") {
      const card = await this.railFor(claim.record).getCard(claim.record.card!);
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
    const adapter = this.railFor(rec);
    let card: CardDetails;
    try {
      card = await adapter.issueCard({
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
      this.store.audit("card_issue_failed", { intent_id: intentId, adapter: adapter.name, error: String(err) });
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
        ...(card.single_use
          ? { expires_at: new Date(now.getTime() + this.config.policy.cards.ttl_minutes * 60_000).toISOString() }
          : {}),
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
      expires_at: updated.card?.expires_at,
      approved_by: updated.approved_by,
    });
    return { card: { ...card, expires_at: updated.card?.expires_at }, record: updated, replayed: false };
  }

  /**
   * Pay an approved intent through a payout rail (PayPal, Venmo). The money goes to the vendor's account from the
   * payee directory in policies.yaml, never to an address the agent supplies. An intent is paid at most once:
   * calling again returns the existing payment, and the rail itself is told the intent ID so a crash mid-call
   * can't double-pay on retry either.
   */
  async sendPayment(intentId: string): Promise<PaymentResult> {
    const existing = this.store.get(intentId);
    if (!existing) throw new GovernanceError(`No intent ${intentId}. Call submit_purchase_intent first.`, "not_found");
    const adapter = this.railFor(existing);
    if (adapter.kind !== "payout" || !adapter.sendPayout) {
      throw new GovernanceError(
        `Policy routes ${intentId} to the '${existing.rail}' ${adapter.kind} rail, which doesn't pay vendors directly.` +
          (adapter.kind === "card" ? " Call request_ephemeral_card instead." : ""),
        "not_payout_rail",
      );
    }

    type Claim = { kind: "replay"; record: IntentRecord } | { kind: "pay"; record: IntentRecord; payee: Payee };
    const claim = this.store.transact((intents, now): Claim => {
      const rec = intents[intentId];
      if (rec.status === "paid" && rec.payment) return { kind: "replay", record: rec };
      if (rec.status === "paying" && now.getTime() - new Date(rec.updated_at).getTime() < ISSUING_STALE_MS) {
        throw new GovernanceError(`A payment for ${intentId} is being sent right now. Retry in a few seconds.`, "in_progress");
      }
      // A stale "paying" means a crash mid-call. Retrying is safe: the rail dedupes on the intent ID.
      if (rec.status !== "paying") this.assertSpendable(rec, intents, now);
      if (rec.intent.is_recurring) {
        throw new GovernanceError(
          `${intentId} is recurring, and a payout is a one-off payment. Route recurring spend to a card rail in policies.yaml.`,
          "recurring_not_supported",
        );
      }
      const entry = this.config.policy.payees.find((p) => domainMatches(rec.intent.vendor_domain, p.vendor));
      if (!entry) {
        throw new GovernanceError(
          `No payee on file for ${normalizeDomain(rec.intent.vendor_domain)}, so PurseString doesn't know where to send the money. ` +
            "Ask a human to add the vendor to payees in policies.yaml. Do not pay another way.",
          "no_payee",
        );
      }
      rec.status = "paying";
      rec.updated_at = now.toISOString();
      return { kind: "pay", record: rec, payee: { receiver: entry.receiver, type: entry.type, wallet: entry.wallet } };
    });

    if (claim.kind === "replay") {
      const rec = claim.record;
      let payment = rec.payment!;
      if (adapter.getPayout) {
        try {
          const latest = await adapter.getPayout(payment.payment_id);
          if (latest.status !== payment.status) {
            payment = this.store.transact((intents) => {
              intents[intentId].payment!.status = latest.status;
              return intents[intentId].payment!;
            });
          }
        } catch {
          /* status refresh is best-effort; the payment itself already happened */
        }
      }
      this.store.audit("payment_replayed", {
        intent_id: intentId,
        payment_id: payment.payment_id,
        note: "Intent already paid: returned the existing payment, no money moved.",
      });
      return { payment, record: { ...rec, payment }, replayed: true };
    }

    const rec = claim.record;
    let sent: { payment_id: string; status: string };
    try {
      sent = await adapter.sendPayout({
        intent_id: rec.intent_id,
        amount: rec.intent.amount,
        currency: rec.intent.currency,
        payee: claim.payee,
        note: `${rec.intent.task_goal} (PurseString ${rec.intent_id}, ${rec.intent.agent_id}/${rec.intent.task_id})`,
      });
    } catch (err) {
      this.store.transact((intents, now) => {
        intents[intentId].status = "approved";
        intents[intentId].updated_at = now.toISOString();
      });
      this.store.audit("payment_failed", { intent_id: intentId, adapter: adapter.name, error: String(err) });
      throw new GovernanceError(`Payment rail error: ${(err as Error).message}`, "adapter_error");
    }

    const updated = this.store.transact((intents, now) => {
      const r = intents[intentId];
      r.status = "paid";
      r.updated_at = now.toISOString();
      r.payment = {
        adapter: adapter.name,
        payment_id: sent.payment_id,
        status: sent.status,
        amount: r.intent.amount,
        currency: r.intent.currency,
        payee: claim.payee,
        sent_at: now.toISOString(),
      };
      return r;
    });
    this.store.audit("payment_sent", {
      intent_id: intentId,
      adapter: adapter.name,
      payment_id: sent.payment_id,
      status: sent.status,
      amount: rec.intent.amount,
      currency: rec.intent.currency,
      payee: claim.payee,
      approved_by: updated.approved_by,
    });
    return { payment: updated.payment!, record: updated, replayed: false };
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

  /**
   * Record a human decision. A terminal approval must carry the one-time code from Slack or Discord when codes are
   * required, because the agent may be able to run the same command. Denying never needs a code.
   */
  decide(intentId: string, approve: boolean, by: string, note?: string, opts: DecideOptions = { via: "cli" }): IntentRecord {
    const out = this.store.transact((intents, now): { rec: IntentRecord; error?: GovernanceError } => {
      const r = intents[intentId];
      if (!r) throw new GovernanceError(`No intent ${intentId}.`, "not_found");
      if (r.status !== "pending_approval") {
        throw new GovernanceError(`Intent ${intentId} is ${r.status}, not pending approval.`, "not_pending");
      }
      if (approve && opts.via === "cli" && this.requireCode) {
        if (!r.approval_code) {
          throw new GovernanceError(
            `${intentId} has no approval code, so it can't be approved from the terminal. Use the Slack button or the HTTP approval API.`,
            "code_unavailable",
          );
        }
        if (!opts.code) {
          throw new GovernanceError(
            `Approving from the terminal needs the one-time code from the Slack or Discord message: pursestring approve ${intentId} --code XXXXX-XXXXX`,
            "code_required",
          );
        }
        if (!verifyApprovalCode(opts.code, r.approval_code)) {
          const attempts = (r.approval_code_attempts ?? 0) + 1;
          r.approval_code_attempts = attempts;
          r.updated_at = now.toISOString();
          if (attempts >= MAX_CODE_ATTEMPTS) {
            r.status = "denied";
            r.denied_by = "policy:approval_code_attempts";
            r.decision_note = `${attempts} wrong approval codes`;
            r.approval_code = undefined;
            return { rec: r, error: new GovernanceError(`Too many wrong approval codes: ${intentId} is now denied.`, "denied") };
          }
          return {
            rec: r,
            error: new GovernanceError(`Wrong approval code for ${intentId}. ${MAX_CODE_ATTEMPTS - attempts} tries left.`, "bad_code"),
          };
        }
      }
      // Hard denials stay denied: a human cannot approve past a deny rule.
      r.status = approve ? "approved" : "denied";
      if (approve) r.approved_by = by;
      else r.denied_by = by;
      r.decision_note = note;
      r.decided_via = opts.via;
      r.approval_code = undefined;
      r.updated_at = now.toISOString();
      return { rec: r };
    });
    if (out.error) {
      this.store.audit("approval_code_rejected", {
        intent_id: intentId,
        by,
        via: opts.via,
        attempts: out.rec.approval_code_attempts,
        status: out.rec.status,
      });
      throw out.error;
    }
    this.store.audit(approve ? "human_approved" : "human_denied", { intent_id: intentId, by, via: opts.via, note });
    return out.rec;
  }

  /** Close single-use cards whose time is up. Runs on a timer in the server; safe to call any time. */
  async sweepExpiredCards(): Promise<number> {
    const due = this.store.list(
      (r) => Boolean(r.card?.expires_at && !r.card.closed_at && new Date(r.card.expires_at) <= new Date()),
    );
    let closed = 0;
    for (const rec of due) {
      try {
        await this.railFor(rec).closeCard?.(rec.card!);
      } catch (err) {
        this.store.audit("card_close_failed", { intent_id: rec.intent_id, error: String(err) });
        continue;
      }
      this.store.transact((intents, now) => {
        const c = intents[rec.intent_id].card;
        if (c) c.closed_at = now.toISOString();
      });
      this.store.audit("card_closed", { intent_id: rec.intent_id, card_token: rec.card!.token, reason: "ttl" });
      closed++;
    }
    return closed;
  }

  /**
   * Just-in-time authorization: the issuer asks, in real time, whether a charge on one of our cards should go through.
   * Approve only if it matches what was approved: right card, still live, within the amount, used once, right merchant.
   */
  authorize(req: AuthorizationRequest): AuthorizationDecision {
    const t0 = performance.now();
    const jit = this.config.policy.jit;
    const result = this.store.transact((intents, now) => {
      const rec = Object.values(intents).find((r) => r.card?.token === req.card_token);
      const decide = (code: AuthorizationCode, reason: string) => {
        if (rec) {
          const entry: AuthorizationRecord = {
            ts: now.toISOString(),
            amount: req.amount,
            merchant: req.merchant,
            ...(req.merchant_id ? { merchant_id: req.merchant_id } : {}),
            ...(req.mcc ? { mcc: req.mcc } : {}),
            approved: code === "approved",
            reason,
          };
          (rec.authorizations ??= []).push(entry);
        }
        return { approved: code === "approved", code, reason, intent_id: rec?.intent_id };
      };

      if (!rec?.card) return decide("unknown_card", "No PurseString intent owns this card.");
      const card = rec.card;
      if (rec.status !== "card_issued") return decide("intent_not_active", `Intent is ${rec.status}.`);
      if (card.closed_at || (card.expires_at && new Date(card.expires_at) <= now)) {
        return decide("card_expired", `Single-use card expired at ${card.expires_at}.`);
      }
      const approvedBefore = (rec.authorizations ?? []).filter((a) => a.approved);
      const cap = card.spend_limit * (1 + jit.tolerance_percent / 100);
      if (card.single_use) {
        if (approvedBefore.length > 0) return decide("already_used", "Single-use card was already charged once.");
        if (req.amount > cap + 1e-9) {
          return decide("over_amount", `${req.amount.toFixed(2)} is over the approved ${card.spend_limit.toFixed(2)} ${card.currency}.`);
        }
      } else {
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const spentThisMonth = approvedBefore
          .filter((a) => new Date(a.ts) >= monthStart)
          .reduce((sum, a) => sum + a.amount, 0);
        if (spentThisMonth + req.amount > cap + 1e-9) {
          return decide(
            "over_amount",
            `${req.amount.toFixed(2)} would take this month to ${(spentThisMonth + req.amount).toFixed(2)}, over the approved ${card.spend_limit.toFixed(2)} ${card.currency}/month.`,
          );
        }
      }
      if (jit.require_merchant_match) {
        const label = vendorLabel(rec.intent.vendor_domain);
        const descriptor = req.merchant.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!descriptor) return decide("merchant_mismatch", "The charge has no merchant descriptor, so it can't be matched to the vendor.");
        if (!label || !descriptor.includes(label)) {
          return decide(
            "merchant_mismatch",
            `Merchant "${req.merchant}" doesn't look like ${normalizeDomain(rec.intent.vendor_domain)}.`,
          );
        }
        // A subscription card is pinned to the merchant that first charged it, so a look-alike descriptor can't reuse it.
        const first = approvedBefore[0];
        if (first?.merchant_id && req.merchant_id !== first.merchant_id) {
          return decide("merchant_mismatch", `Merchant ID ${req.merchant_id ?? "(none)"} isn't the ${first.merchant_id} this card was first charged by.`);
        }
        if (first?.mcc && req.mcc && req.mcc !== first.mcc) {
          return decide("merchant_mismatch", `Merchant category ${req.mcc} isn't the ${first.mcc} this card was first charged under.`);
        }
      }
      return decide("approved", "Matches the approved intent.");
    });
    const decision = { ...result, latency_ms: Math.round((performance.now() - t0) * 100) / 100 };
    this.store.audit("jit_authorization", { ...decision, card_token: req.card_token, amount: req.amount, merchant: req.merchant, mcc: req.mcc });
    return decision;
  }
}
