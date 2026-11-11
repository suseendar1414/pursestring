import type { Rails } from "./adapters/index.js";
import { hashApprovalCode, newApprovalCode, verifyApprovalCode, type ApprovalChannel } from "./approvals.js";
import type { Config } from "./config.js";
import type { Notifier, RefundNotice } from "./notify.js";
import { domainMatches, evaluate, evaluateToolCall, normalizeDomain, routeRail, toolCallAmount, vendorLabel } from "./policy.js";
import { createHash } from "node:crypto";
import { exponent, formatMinor, isWholeMinor, toMajor, toMinor } from "./money.js";
import { cardCostMinor, holdStatus, openHoldMinor, usedMinor } from "./holds.js";
import { idempotencyKey, spentToday, Store } from "./store.js";
import type {
  ActionRecord,
  AuthorizationRecord,
  CardDetails,
  IntentRecord,
  Payee,
  PaymentRecord,
  PolicyEvaluation,
  PurchaseIntent,
  RefundRecord,
  RefundStatus,
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

/** What an MCP tool returns, as far as governance cares. */
export interface ToolResult {
  isError?: boolean;
  content: unknown[];
  [key: string]: unknown;
}

export interface ToolCallMeta {
  agent_id: string;
  /** Why the agent wants to do this. Shown to the approver and kept in the audit log. */
  reason: string;
  /** Set when repeating a call that was paused for approval. */
  intent_id?: string;
}

export interface ToolCallResult {
  record: IntentRecord;
  result: ToolResult;
  /** True when the call had already run and PayPal's earlier answer was returned. */
  replayed: boolean;
}

/** Deterministic JSON: object keys sorted, so equal arguments always hash the same. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function toolArgsHash(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${tool}\u001f${stableJson(args)}`).digest("hex");
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
  /** The issuer's ID for this transaction, so later capture and reversal events can find the hold. */
  transaction_id?: string;
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

/** A merchant refund reported by the card issuer (or an admin, for rails without refund events). */
export interface RefundInput {
  /** The issuer's ID for this refund. Repeats of the same ID are ignored. */
  refund_id: string;
  /** Major units, positive. */
  amount: number;
  currency?: string;
  card_token?: string;
  intent_id?: string;
  merchant?: string;
  source: string;
}

/**
 * credited: budget given back. duplicate: this refund_id was already recorded. unmatched: no intent owns the card.
 * over_original: it would take refunds past what was charged, so nothing was credited and a human should look.
 */
export type RefundOutcome = "credited" | "duplicate" | "unmatched" | "over_original";

export interface RefundResult {
  outcome: RefundOutcome;
  message: string;
  intent_id?: string;
  credited: number;
  refunded_total?: number;
  refund_status?: RefundStatus;
}

/** What the card issuer says happened to a hold PurseString approved: captured (cleared) or released (reversed, voided, expired). */
export interface SettlementInput {
  /** The issuer's ID for this event. Repeats of the same ID are ignored. */
  event_id: string;
  kind: "capture" | "release";
  /** The transaction the hold belongs to (what `authorize` got as transaction_id). */
  transaction_id?: string;
  /** Used to find the hold when the transaction ID is unknown: works when the card has exactly one open hold. */
  card_token?: string;
  /** Major units, positive. Leave it out on a release to release the whole remaining hold. */
  amount?: number;
  currency?: string;
  /** The issuer's event type, for the audit log, e.g. CLEARING. */
  type?: string;
  source: string;
}

/**
 * captured / released: applied. duplicate: this event_id was already applied.
 * unmatched: no approved hold matches, so nothing changed and a human may want to look.
 */
export type SettlementOutcome = "captured" | "released" | "duplicate" | "unmatched";

export interface SettlementResult {
  outcome: SettlementOutcome;
  message: string;
  intent_id?: string;
  hold_status?: "held" | "captured" | "released";
  /** Totals on the hold after this event, in major units. */
  captured?: number;
  released?: number;
  still_held?: number;
}

/** The currency an intent's money moved in: its card's, else what the agent asked for. */
const recordCurrency = (rec: IntentRecord) => rec.card?.currency ?? rec.intent.currency;

/**
 * What was actually charged on an intent's card, in minor units: for approved real-time authorizations, what was
 * captured plus what is still held (a released hold counts nothing); without them, what the card has cost.
 */
function chargedMinor(rec: IntentRecord): number {
  const cur = recordCurrency(rec);
  const approved = (rec.authorizations ?? []).filter((a) => a.approved);
  if (approved.length) return approved.reduce((sum, a) => sum + usedMinor(a, cur), 0);
  return cardCostMinor(rec);
}

/** What was actually charged on an intent's card: captured or still held on approved authorizations, else the card's limit. */
export function chargedAmount(rec: IntentRecord): number {
  return toMajor(chargedMinor(rec), recordCurrency(rec));
}

/** Refuse an amount finer than its currency allows (15.001 USD, 1500.5 JPY) instead of silently rounding it. */
function checkAmount(intent: PurchaseIntent): void {
  if (!isWholeMinor(intent.amount, intent.currency)) {
    const places = exponent(intent.currency);
    throw new GovernanceError(
      `${intent.amount} ${intent.currency.toUpperCase()} has more decimals than ${intent.currency.toUpperCase()} allows (${places === 0 ? "none" : places}).`,
      "bad_amount",
    );
  }
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
    checkAmount(intent);
    const key = idempotencyKey(intent);
    const out = this.store.transact((intents, now) => ({
      evaluation: evaluate(this.config.policy, intent, {
        spentTodayByAgent: spentToday(intents, intent.agent_id, now, this.config.policy.currency),
      }),
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

  /** How an intent is ruled on: the purchase policy, or the PayPal-tool policy for a governed tool call. */
  private evaluateRecord(intent: PurchaseIntent, action: ActionRecord | undefined, intents: Record<string, IntentRecord>, now: Date) {
    const spent = spentToday(intents, intent.agent_id, now, this.config.policy.currency);
    return action
      ? evaluateToolCall(this.config.policy, action.tool, action.args, { agentId: intent.agent_id, spentTodayByAgent: spent })
      : evaluate(this.config.policy, intent, { spentTodayByAgent: spent });
  }

  async submitIntent(intent: PurchaseIntent, action?: ActionRecord): Promise<SubmitResult> {
    checkAmount(intent);
    const key = idempotencyKey(intent);
    let approvalCode: string | undefined;
    const result = this.store.transact((intents, now): SubmitResult => {
      const existing = this.findRecent(intents, key, now);
      if (existing) return { record: existing, deduplicated: true };

      const evaluation = this.evaluateRecord(intent, action, intents, now);
      const status =
        evaluation.decision === "auto_approve" ? "approved" : evaluation.decision === "deny" ? "denied" : "pending_approval";
      const ts = now.toISOString();
      const rail = action ? "paypal" : routeRail(this.config.policy, intent).rail;
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
        ...(action ? { action } : {}),
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
          ...(action ? { paypal_tool: action.tool, paypal_args: action.args } : {}),
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
        `Intent ${intentId} is ${rec.status}: ${rec.decision_note || rec.evaluation.summary}. Do not attempt this purchase.`,
        rec.status,
      );
    }
    if (rec.approved_by === "policy:auto_approve") {
      const fresh = this.evaluateRecord(rec.intent, rec.action, intents, now);
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

  /**
   * Govern a call to one of PayPal's own MCP tools. The call becomes an intent ruled on by the paypal_tools policy:
   * allowed calls run once, through `run`; others pause for a human or are refused. Repeating the same call returns
   * the same intent, so after approval the agent repeats it to run it, and repeating it again returns PayPal's
   * first answer instead of refunding twice.
   */
  async governToolCall(
    tool: string,
    args: Record<string, unknown>,
    meta: ToolCallMeta,
    run: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): Promise<ToolCallResult> {
    const hash = toolArgsHash(tool, args);
    let intentId: string;
    if (meta.intent_id) {
      const rec = this.store.get(meta.intent_id);
      if (!rec) throw new GovernanceError(`No intent ${meta.intent_id}.`, "not_found");
      if (rec.action?.args_hash !== hash) {
        throw new GovernanceError(
          `Intent ${meta.intent_id} approved a different call. Repeat exactly the approved ${rec.action?.tool ?? "call"} with the same arguments.`,
          "args_mismatch",
        );
      }
      intentId = rec.intent_id;
    } else {
      const { amount, currency } = toolCallAmount(args);
      const intent: PurchaseIntent = {
        agent_id: meta.agent_id,
        task_id: `${tool}:${hash.slice(0, 16)}`,
        task_goal: `${tool}: ${meta.reason}`,
        vendor_domain: "paypal.com",
        amount: amount ?? 0,
        currency: currency ?? this.config.policy.currency,
        is_recurring: false,
        alternatives_attempted: [],
        reasoning: [],
      };
      const { record } = await this.submitIntent(intent, { tool, args, args_hash: hash });
      intentId = record.intent_id;
    }

    type Claim = { kind: "replay"; record: IntentRecord } | { kind: "run"; record: IntentRecord };
    const claim = this.store.transact((intents, now): Claim => {
      const rec = intents[intentId];
      if (rec.status === "executed") return { kind: "replay", record: rec };
      if (rec.status === "executing") {
        if (now.getTime() - new Date(rec.updated_at).getTime() < ISSUING_STALE_MS) {
          throw new GovernanceError(`${tool} for ${intentId} is running right now. Retry in a few seconds.`, "in_progress");
        }
        throw new GovernanceError(
          `${tool} for ${intentId} was interrupted and may or may not have gone through. Check in PayPal before doing anything else.`,
          "outcome_unknown",
        );
      }
      this.assertSpendable(rec, intents, now);
      rec.status = "executing";
      rec.updated_at = now.toISOString();
      return { kind: "run", record: rec };
    });

    if (claim.kind === "replay") {
      this.store.audit("paypal_tool_replayed", {
        intent_id: intentId,
        tool,
        note: "Call already ran: returned PayPal's earlier answer, nothing sent to PayPal.",
      });
      return { record: claim.record, result: claim.record.action!.result as ToolResult, replayed: true };
    }

    const revert = () =>
      this.store.transact((intents, now) => {
        intents[intentId].status = "approved";
        intents[intentId].updated_at = now.toISOString();
        return intents[intentId];
      });
    let result: ToolResult;
    try {
      result = await run(args);
    } catch (err) {
      revert();
      this.store.audit("paypal_tool_failed", { intent_id: intentId, tool, error: String(err) });
      throw new GovernanceError(`PayPal MCP error: ${(err as Error).message}`, "adapter_error");
    }
    if (result.isError) {
      // PayPal refused, so nothing happened; the approval still stands for a retry.
      const record = revert();
      this.store.audit("paypal_tool_rejected", { intent_id: intentId, tool, result: result.content });
      return { record, result, replayed: false };
    }
    const record = this.store.transact((intents, now) => {
      const r = intents[intentId];
      r.status = "executed";
      r.updated_at = now.toISOString();
      r.action = { ...r.action!, executed_at: now.toISOString(), result };
      return r;
    });
    this.store.audit("paypal_tool_executed", {
      intent_id: intentId,
      tool,
      args,
      amount: record.intent.amount,
      approved_by: record.approved_by,
    });
    return { record, result, replayed: false };
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
            ...(req.transaction_id ? { transaction_id: req.transaction_id } : {}),
            approved: code === "approved",
            reason,
            ...(code === "approved" ? { hold_status: "held" as const } : {}),
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
      // All in whole minor units of the card's currency. The tolerance is applied in basis points and rounded down,
      // so a 10% tolerance on 15.00 allows exactly 16.50 and never a fraction of a cent more.
      const cur = card.currency;
      const fmt = (minor: number) => formatMinor(minor, cur);
      const limit = toMinor(card.spend_limit, cur);
      const toleranceBp = Math.round(jit.tolerance_percent * 100);
      const cap = limit + Math.floor((limit * toleranceBp) / 10_000);
      const amount = toMinor(req.amount, cur);
      if (card.single_use) {
        // A hold the merchant released (a hotel or gas station re-authorizing, say) doesn't use the card up.
        if (approvedBefore.some((a) => usedMinor(a, cur) > 0)) return decide("already_used", "Single-use card was already charged once.");
        if (amount > cap) {
          return decide("over_amount", `${fmt(amount)} is over the approved ${fmt(limit)} ${cur}.`);
        }
      } else {
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        // Captured amounts plus holds still open. A released hold gives its room back; a smaller capture frees the rest.
        const spentThisMonth = approvedBefore
          .filter((a) => new Date(a.ts) >= monthStart)
          .reduce((sum, a) => sum + usedMinor(a, cur), 0);
        if (spentThisMonth + amount > cap) {
          return decide(
            "over_amount",
            `${fmt(amount)} would take this month to ${fmt(spentThisMonth + amount)}, over the approved ${fmt(limit)} ${cur}/month.`,
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
    this.store.audit("jit_authorization", {
      ...decision,
      card_token: req.card_token,
      transaction_id: req.transaction_id,
      amount: req.amount,
      merchant: req.merchant,
      mcc: req.mcc,
    });
    return decision;
  }

  /**
   * Apply what the issuer reports about a hold PurseString approved. A capture records what the merchant actually
   * took and ends the hold, so a capture smaller than the hold frees the difference. A release (reversal, void,
   * expiry) frees part or all of the hold, and a single-use card whose only hold was released can be authorized again.
   * Safe to call with the same event twice: the second call is a no-op.
   */
  recordSettlement(input: SettlementInput): SettlementResult {
    if (!input.event_id || (input.kind !== "capture" && input.kind !== "release")) {
      throw new GovernanceError("A settlement needs an event_id and a kind of capture or release.", "bad_settlement");
    }
    if (input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount < 0)) {
      throw new GovernanceError("A settlement amount must be zero or more.", "bad_settlement");
    }
    if (input.kind === "capture" && input.amount === undefined) {
      throw new GovernanceError("A capture needs an amount.", "bad_settlement");
    }
    const result = this.store.transact((intents, now): SettlementResult => {
      let rec: IntentRecord | undefined;
      let auth: AuthorizationRecord | undefined;
      if (input.transaction_id) {
        for (const r of Object.values(intents)) {
          auth = r.authorizations?.find((a) => a.approved && a.transaction_id === input.transaction_id);
          if (auth) {
            rec = r;
            break;
          }
        }
      }
      if (!auth && input.card_token) {
        // No transaction ID on file (a rail without one, or a hold approved before this was tracked): fall back to the
        // card, but only when exactly one approved hold on it is still open, so an event can't land on the wrong charge.
        const r = Object.values(intents).find((x) => x.card?.token === input.card_token);
        const open = (r?.authorizations ?? []).filter(
          (a) => a.approved && !a.transaction_id && openHoldMinor(a, recordCurrency(r!)) > 0,
        );
        if (r && open.length === 1) {
          rec = r;
          auth = open[0];
        }
      }
      if (!rec || !auth) {
        return { outcome: "unmatched", message: "No approved hold matches this event, so nothing changed." };
      }
      const cur = recordCurrency(rec);
      const fmt = (minor: number) => `${formatMinor(minor, cur)} ${cur}`;
      const totals = (): Omit<SettlementResult, "outcome" | "message"> => ({
        intent_id: rec!.intent_id,
        hold_status: holdStatus(auth!, cur),
        captured: toMajor(toMinor(auth!.captured ?? 0, cur), cur),
        released: toMajor(toMinor(auth!.released ?? 0, cur), cur),
        still_held: toMajor(openHoldMinor(auth!, cur), cur),
      });
      if ((auth.event_ids ?? []).includes(input.event_id)) {
        return { outcome: "duplicate", message: `Event ${input.event_id} was already applied on ${rec.intent_id}.`, ...totals() };
      }
      auth.event_ids = [...(auth.event_ids ?? []), input.event_id];
      let message: string;
      if (input.kind === "capture") {
        const amountMinor = toMinor(input.amount!, cur);
        const heldMinor = openHoldMinor(auth, cur);
        auth.captured = toMajor(toMinor(auth.captured ?? 0, cur) + amountMinor, cur);
        auth.settled_at ??= now.toISOString();
        message =
          heldMinor > amountMinor
            ? `Captured ${fmt(amountMinor)} of a ${fmt(heldMinor)} hold; the other ${fmt(heldMinor - amountMinor)} no longer counts.`
            : `Captured ${fmt(amountMinor)}.`;
      } else {
        const openMinor = openHoldMinor(auth, cur);
        const amountMinor = input.amount === undefined ? openMinor : Math.min(openMinor, toMinor(input.amount, cur));
        auth.released = toMajor(toMinor(auth.released ?? 0, cur) + amountMinor, cur);
        message = `Released ${fmt(amountMinor)}; ${fmt(openMinor - amountMinor)} still held.`;
      }
      auth.hold_status = holdStatus(auth, cur);
      rec.updated_at = now.toISOString();
      return { outcome: input.kind === "capture" ? "captured" : "released", message, ...totals() };
    });
    this.store.audit(result.outcome === "duplicate" || result.outcome === "unmatched" ? `settlement_${result.outcome}` : `hold_${result.outcome}`, {
      intent_id: result.intent_id,
      event_id: input.event_id,
      type: input.type,
      transaction_id: input.transaction_id,
      card_token: input.card_token,
      amount: input.amount,
      currency: input.currency,
      source: input.source,
      hold_status: result.hold_status,
      captured: result.captured,
      released: result.released,
      still_held: result.still_held,
    });
    return result;
  }

  /**
   * Record a merchant refund against the intent that paid for it and give the budget back. The original intent is never
   * edited; the refund is appended next to it. Safe to call with the same refund twice: the second call is a no-op.
   * Refunds are never credited past what was charged, so a bad or replayed event can't hand an agent extra budget.
   */
  async recordRefund(input: RefundInput): Promise<RefundResult> {
    if (!input.refund_id || !Number.isFinite(input.amount) || input.amount <= 0) {
      throw new GovernanceError("A refund needs a refund_id and a positive amount.", "bad_refund");
    }
    // Audit and error text use the amount as given; the transaction below works in the record's minor units.
    let amount = input.amount;
    type Out = { result: RefundResult; notice?: RefundNotice };
    const out = this.store.transact((intents, now): Out => {
      const rec = input.intent_id
        ? intents[input.intent_id]
        : Object.values(intents).find((r) => input.card_token && r.card?.token === input.card_token);
      const currency = input.currency ?? rec?.card?.currency ?? rec?.intent.currency ?? this.config.policy.currency;
      const amountMinor = toMinor(input.amount, currency);
      amount = toMajor(amountMinor, currency);
      const fmt = (minor: number) => formatMinor(minor, currency);
      const refund: RefundRecord = {
        refund_id: input.refund_id,
        ts: now.toISOString(),
        amount,
        currency,
        source: input.source,
        ...(input.merchant ? { merchant: input.merchant } : {}),
      };
      const budget = this.config.policy.hard_limits.per_agent_daily_budget;
      if (!rec) {
        return {
          result: { outcome: "unmatched", credited: 0, message: "No PurseString intent owns this card, so nothing was credited." },
          notice: { outcome: "unmatched", refund, daily_budget: budget },
        };
      }
      if ((rec.refunds ?? []).some((r) => r.refund_id === input.refund_id)) {
        return {
          result: {
            outcome: "duplicate",
            intent_id: rec.intent_id,
            credited: 0,
            refunded_total: rec.refunded_total,
            refund_status: rec.refund_status,
            message: `Refund ${input.refund_id} was already recorded on ${rec.intent_id}.`,
          },
        };
      }
      const chargedM = chargedMinor(rec);
      const charged = toMajor(chargedM, currency);
      const beforeM = toMinor(rec.refunded_total ?? 0, currency);
      const before = toMajor(beforeM, currency);
      if (beforeM + amountMinor > chargedM) {
        return {
          result: {
            outcome: "over_original",
            intent_id: rec.intent_id,
            credited: 0,
            refunded_total: before,
            refund_status: rec.refund_status,
            message: `Refund of ${fmt(amountMinor)} would take refunds on ${rec.intent_id} to ${fmt(beforeM + amountMinor)}, over the ${fmt(chargedM)} charged. Nothing was credited; check it by hand.`,
          },
          notice: { outcome: "over_original", refund, record: rec, charged, daily_budget: budget },
        };
      }
      rec.refunds = [...(rec.refunds ?? []), refund];
      rec.refunded_total = toMajor(beforeM + amountMinor, currency);
      rec.refund_status = beforeM + amountMinor >= chargedM ? "refunded" : "partially_refunded";
      rec.updated_at = now.toISOString();
      const spent = spentToday(intents, rec.intent.agent_id, now, this.config.policy.currency);
      return {
        result: {
          outcome: "credited",
          intent_id: rec.intent_id,
          credited: amount,
          refunded_total: rec.refunded_total,
          refund_status: rec.refund_status,
          message: `Credited ${fmt(amountMinor)} ${refund.currency} back to ${rec.intent.agent_id}.`,
        },
        notice: { outcome: "credited", refund, record: rec, charged, spent_today: spent, daily_budget: budget },
      };
    });

    const { result, notice } = out;
    this.store.audit(result.outcome === "credited" ? "refund_credited" : `refund_${result.outcome}`, {
      intent_id: result.intent_id,
      refund_id: input.refund_id,
      amount,
      currency: input.currency,
      card_token: input.card_token,
      merchant: input.merchant,
      source: input.source,
      credited: result.credited,
      refunded_total: result.refunded_total,
      refund_status: result.refund_status,
    });
    if (notice) {
      try {
        await this.notifier.refundRecorded?.(notice);
      } catch (err) {
        this.store.audit("refund_notify_failed", { intent_id: result.intent_id, refund_id: input.refund_id, error: String(err) });
      }
    }
    return result;
  }
}
