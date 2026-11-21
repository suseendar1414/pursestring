import type { Rails } from "./adapters/index.js";
import { hashApprovalCode, newApprovalCode, verifyApprovalCode, type ApprovalChannel } from "./approvals.js";
import type { Config } from "./config.js";
import type { Notifier, RefundNotice } from "./notify.js";
import { activeHalt, haltKey, similarRecent, type HaltRecord, type Halts } from "./killswitch.js";
import { domainMatches, evaluate, evaluateToolCall, normalizeDomain, routeRail, toolCallAmount, vendorLabel, withRule } from "./policy.js";
import { createHash } from "node:crypto";
import { exponent, formatMinor, isWholeMinor, toMajor, toMinor } from "./money.js";
import { cardCostMinor, holdStatus, openHoldMinor, usedMinor } from "./holds.js";
import { idempotencyKey, spentToday, Store } from "./store.js";
import { velocityRule } from "./velocity.js";
import {
  atomicToCents,
  paymentHeader,
  parseChallenge,
  parseSettlement,
  unsupportedReason,
  X402Wallet,
  type X402Requirement,
} from "./x402.js";
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
  X402Record,
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
  | "merchant_mismatch"
  | "halted";

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

export interface X402FetchInput {
  agent_id: string;
  task_id: string;
  task_goal: string;
  url: string;
  method?: "GET" | "POST";
  /** Request body for POST, sent as is. */
  body?: string;
  content_type?: string;
  alternatives_attempted?: string[];
  reasoning?: string[];
  /** Set when repeating a call that was paused for approval. */
  intent_id?: string;
}

export interface X402Response {
  status: number;
  content_type?: string;
  body: string;
  truncated: boolean;
}

export interface X402FetchResult {
  /** True when this call (or an earlier one, if replayed) paid. False for free resources and paused intents. */
  paid: boolean;
  /** True when the intent was already paid and the stored response was returned; nothing was paid again. */
  replayed: boolean;
  record?: IntentRecord;
  response?: X402Response;
  transaction?: string;
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
    const out = this.store.transact((intents, now) => {
      let evaluation = evaluate(this.config.policy, intent, {
        spentTodayByAgent: spentToday(intents, intent.agent_id, now, this.config.policy.currency),
      });
      const velocity = velocityRule(this.config.policy, intents, intent.agent_id, now);
      if (velocity) evaluation = withRule(evaluation, velocity);
      return { evaluation, existing: this.findRecent(intents, key, now) };
    });
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

  async submitIntent(
    intent: PurchaseIntent,
    action?: ActionRecord,
    extra: { rail?: string; x402?: X402Record } = {},
  ): Promise<SubmitResult> {
    checkAmount(intent);
    const key = idempotencyKey(intent);
    let approvalCode: string | undefined;
    let resumeCode: string | undefined;
    let tripped: HaltRecord | undefined;
    const result = this.store.transact((intents, now, halts): SubmitResult => {
      const existing = this.findRecent(intents, key, now);
      if (existing) return { record: existing, deduplicated: true };

      const intentId = this.store.newId();
      let evaluation = this.evaluateRecord(intent, action, intents, now);
      const halt = activeHalt(halts, intent.agent_id);
      const ld = this.config.policy.kill_switch.loop_detection;
      if (!halt) {
        // Counted in the same transaction as the write, like the budget, so parallel requests can't all slip under it.
        const velocity = velocityRule(this.config.policy, intents, intent.agent_id, now);
        if (velocity) evaluation = withRule(evaluation, velocity);
      }
      if (halt) {
        evaluation = withRule(evaluation, {
          rule: "kill_switch",
          passed: false,
          effect: "deny",
          detail: `spending is halted for ${halt.scope === "all" ? "all agents" : intent.agent_id}: ${halt.reason}`,
        });
      } else if (ld.enabled && !action) {
        // Checked in the same transaction as the write, so two racing requests can't both slip under the limit.
        const prior = similarRecent(this.config.policy, intents, halts, intent, now);
        if (prior.length + 1 >= ld.max_similar) {
          const vendor = normalizeDomain(intent.vendor_domain);
          const reason =
            `loop detected: ${prior.length + 1} near-identical purchases (${vendor}, amounts within ` +
            `${ld.amount_tolerance_percent}%) in ${ld.window_minutes} minutes under different task IDs`;
          tripped = {
            scope: "agent",
            agent_id: intent.agent_id.trim(),
            reason,
            by: "policy:loop_detection",
            via: "loop_detector",
            tripped_at: now.toISOString(),
            intent_ids: [...prior.map((r) => r.intent_id), intentId],
          };
          if (this.requireCode && this.canSendCode) {
            resumeCode = newApprovalCode();
            tripped.resume_code = hashApprovalCode(resumeCode);
          }
          halts[haltKey(intent.agent_id)] = tripped;
          evaluation = withRule(evaluation, { rule: "kill_switch.loop_detection", passed: false, effect: "deny", detail: reason });
        }
      }
      const status =
        evaluation.decision === "auto_approve" ? "approved" : evaluation.decision === "deny" ? "denied" : "pending_approval";
      const ts = now.toISOString();
      const rail = action ? "paypal" : (extra.rail ?? routeRail(this.config.policy, intent).rail);
      const record: IntentRecord = {
        intent_id: intentId,
        idempotency_key: key,
        intent,
        evaluation,
        status,
        created_at: ts,
        updated_at: ts,
        expires_at: new Date(now.getTime() + this.config.policy.approvals.ttl_minutes * 60_000).toISOString(),
        rail,
        ...(action ? { action } : {}),
        ...(extra.x402 ? { x402: extra.x402 } : {}),
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
          ...(extra.x402
            ? { x402: { url: extra.x402.url, network: extra.x402.network, pay_to: extra.x402.pay_to, amount_atomic: extra.x402.amount_atomic } }
            : {}),
        },
        status: record.status,
        policy_file: this.config.policyPath,
      });
      if (record.status === "pending_approval") await this.notifier.approvalRequested(record, { code: approvalCode });
    }
    if (tripped) await this.haltNotice(tripped, resumeCode);
    return result;
  }

  private railFor(rec: IntentRecord) {
    return this.rails.get(rec.rail ?? this.rails.default);
  }

  /**
   * The checks every way of moving money shares: the intent must be approved and live, and an auto-approval is
   * re-checked against today's budget, since other spends may have happened since submit. Runs inside a transaction.
   */
  private assertSpendable(rec: IntentRecord, intents: Record<string, IntentRecord>, now: Date, halts: Halts) {
    const intentId = rec.intent_id;
    this.assertNotHalted(rec, halts);
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

  /** The kill switch: nothing moves money for a halted agent, whatever was approved before the halt. */
  private assertNotHalted(rec: IntentRecord, halts: Halts) {
    const halt = activeHalt(halts, rec.intent.agent_id);
    if (halt) {
      throw new GovernanceError(
        `Spending is halted for ${halt.scope === "all" ? "all agents" : rec.intent.agent_id} (${halt.reason}). ` +
          "Stop and tell the user; a human has to resume spending. Do not retry or pay another way.",
        "halted",
      );
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
    if (existing && this.railFor(existing).kind === "x402") {
      throw new GovernanceError(`${intentId} pays an x402 resource. Call x402_fetch with this intent_id.`, "x402_rail");
    }
    if (existing && this.railFor(existing).kind === "payout") {
      throw new GovernanceError(
        `Policy routes ${intentId} to the '${existing.rail}' rail, which pays the vendor directly instead of issuing a card. ` +
          "Call send_payment with this intent_id.",
        "payout_rail",
      );
    }
    type Claim = { kind: "replay"; record: IntentRecord } | { kind: "issue"; record: IntentRecord };
    const claim = this.store.transact((intents, now, halts): Claim => {
      const rec = intents[intentId];
      if (!rec) throw new GovernanceError(`No intent ${intentId}. Call submit_purchase_intent first.`, "not_found");
      // Halted agents don't get card details again either: the card itself declines, but don't hand it out.
      this.assertNotHalted(rec, halts);

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
      this.assertSpendable(rec, intents, now, halts);
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
   * Pay an approved intent through a payout rail (PayPal, Venmo, Stripe Connect, RazorpayX, Modern Treasury). The money goes to the vendor's account from the
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
          (adapter.kind === "card" ? " Call request_ephemeral_card instead." : "") +
          (adapter.kind === "x402" ? " Call x402_fetch with this intent_id instead." : ""),
        "not_payout_rail",
      );
    }

    type Claim = { kind: "replay"; record: IntentRecord } | { kind: "pay"; record: IntentRecord; payee: Payee };
    const claim = this.store.transact((intents, now, halts): Claim => {
      const rec = intents[intentId];
      if (rec.status === "paid" && rec.payment) return { kind: "replay", record: rec };
      this.assertNotHalted(rec, halts);
      if (rec.status === "paying" && now.getTime() - new Date(rec.updated_at).getTime() < ISSUING_STALE_MS) {
        throw new GovernanceError(`A payment for ${intentId} is being sent right now. Retry in a few seconds.`, "in_progress");
      }
      // A stale "paying" means a crash mid-call. Retrying is safe: the rail dedupes on the intent ID.
      if (rec.status !== "paying") this.assertSpendable(rec, intents, now, halts);
      if (rec.intent.is_recurring) {
        throw new GovernanceError(
          `${intentId} is recurring, and a payout is a one-off payment. Route recurring spend to a card rail in policies.yaml.`,
          "recurring_not_supported",
        );
      }
      // The first payee entry for this vendor that has a destination this rail can pay.
      const field = adapter.payeeField ?? "receiver";
      const entry = this.config.policy.payees.find((p) => domainMatches(rec.intent.vendor_domain, p.vendor) && p[field]);
      if (!entry) {
        throw new GovernanceError(
          `No payee on file for ${normalizeDomain(rec.intent.vendor_domain)} on the '${adapter.name}' rail (it pays to a payee's ` +
            `${field}), so PurseString doesn't know where to send the money. ` +
            "Ask a human to add the vendor to payees in policies.yaml. Do not pay another way.",
          "no_payee",
        );
      }
      rec.status = "paying";
      rec.updated_at = now.toISOString();
      const { vendor: _vendor, ...payee } = entry;
      return { kind: "pay", record: rec, payee };
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
        paid_to: claim.payee[adapter.payeeField ?? "receiver"],
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
      paid_to: updated.payment!.paid_to,
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
    const claim = this.store.transact((intents, now, halts): Claim => {
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
      this.assertSpendable(rec, intents, now, halts);
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

  private wallet?: X402Wallet;
  private x402Wallet(): X402Wallet {
    if (!this.config.env.x402PrivateKey) {
      throw new GovernanceError("x402 payments need a wallet: set X402_PRIVATE_KEY.", "x402_not_configured");
    }
    return (this.wallet ??= new X402Wallet(this.config.env.x402PrivateKey));
  }

  private async readResponse(res: Response): Promise<X402Response> {
    const buf = Buffer.from(await res.arrayBuffer());
    const max = this.config.policy.x402.max_response_bytes;
    return {
      status: res.status,
      content_type: res.headers.get("content-type") ?? undefined,
      body: buf.subarray(0, max).toString("utf8"),
      truncated: buf.length > max,
    };
  }

  /**
   * Fetch a URL that may charge over x402. A free answer is returned as is. A 402 becomes a purchase intent for the
   * exact price, ruled on like any other: auto-approved ones are paid at once, others wait for a human (repeat the
   * call with the intent_id once approved), and denials pay nothing. Each intent signs at most one authorization and
   * a retry re-sends that same one, whose nonce can settle on chain only once, so a retried call can't pay twice.
   */
  async x402Fetch(input: X402FetchInput): Promise<X402FetchResult> {
    const cfg = this.config.policy.x402;
    if (!cfg.enabled) throw new GovernanceError("x402 payments are off. Set x402.enabled: true in policies.yaml.", "x402_disabled");
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new GovernanceError(`${input.url} isn't a URL.`, "bad_url");
    }
    if (url.protocol !== "https:") throw new GovernanceError("x402 resources must be https.", "bad_url");
    const method = input.method ?? "GET";
    const request = (headers: Record<string, string> = {}) =>
      fetch(url, {
        method,
        redirect: "manual",
        headers: { ...(input.content_type ? { "Content-Type": input.content_type } : {}), ...headers },
        body: method === "POST" ? input.body : undefined,
      });

    let rec: IntentRecord | undefined;
    if (input.intent_id) {
      rec = this.store.get(input.intent_id);
      if (!rec?.x402) throw new GovernanceError(`No x402 intent ${input.intent_id}.`, "not_found");
      if (rec.x402.url !== url.href) {
        throw new GovernanceError(`Intent ${input.intent_id} is for ${rec.x402.url}, not ${url.href}.`, "url_mismatch");
      }
      if (rec.status === "paid") return this.x402Replay(rec);
    }

    // A previously signed authorization is re-sent as is: no need to ask the server for the price again.
    if (rec?.x402?.authorization) return this.x402Pay(rec.intent_id, request, undefined);

    const first = await request();
    if (first.status !== 402) {
      if (rec) throw new GovernanceError(`${url.href} no longer asks for payment (HTTP ${first.status}). Nothing was paid.`, "not_402");
      return { paid: false, replayed: false, response: await this.readResponse(first) };
    }
    const bodyText = await first.text();
    const challenge = parseChallenge(first.headers, bodyText);
    if (!challenge || challenge.accepts.length === 0) {
      throw new GovernanceError(`${url.href} answered 402 but not with an x402 payment request PurseString can read.`, "not_x402");
    }
    const vendor = normalizeDomain(url.hostname);
    const pins = cfg.pay_to.filter((p) => domainMatches(vendor, p.vendor));
    const reasons: string[] = [];
    const usable = challenge.accepts.filter((r) => {
      const why = unsupportedReason(r, cfg.networks) ??
        (pins.length && !pins.some((p) => p.address.toLowerCase() === r.pay_to.toLowerCase())
          ? `payTo ${r.pay_to} isn't the address pinned for ${vendor} in x402.pay_to`
          : null);
      if (why) reasons.push(why);
      return !why;
    });

    let requirement: X402Requirement | undefined;
    if (rec) {
      // Repeating a paused call: pay only exactly what was approved.
      const x = rec.x402!;
      requirement = usable.find(
        (r) => r.network === x.network && r.asset.toLowerCase() === x.asset.toLowerCase() && r.pay_to.toLowerCase() === x.pay_to.toLowerCase() && r.amount === x.amount_atomic,
      );
      if (!requirement) {
        throw new GovernanceError(
          `${url.href} now asks for something other than what ${rec.intent_id} approved. Nothing was paid; call x402_fetch without intent_id to get a new decision.`,
          "price_changed",
        );
      }
    } else {
      // Cheapest usable option.
      requirement = usable.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1))[0];
      if (!requirement) {
        this.store.audit("x402_unpayable", { url: url.href, agent_id: input.agent_id, reasons });
        throw new GovernanceError(`PurseString can't pay ${url.href}: ${reasons.join("; ")}.`, "x402_unsupported");
      }
      const cents = atomicToCents(requirement.amount);
      const intent: PurchaseIntent = {
        agent_id: input.agent_id,
        task_id: input.task_id,
        task_goal: input.task_goal,
        vendor_domain: vendor,
        amount: toMajor(cents, "USD"),
        currency: "USD",
        is_recurring: false,
        alternatives_attempted: input.alternatives_attempted ?? [],
        reasoning: input.reasoning ?? [],
      };
      const x402: X402Record = {
        url: url.href,
        method,
        network: requirement.network,
        asset: requirement.asset,
        pay_to: requirement.pay_to,
        amount_atomic: requirement.amount,
      };
      rec = (await this.submitIntent(intent, undefined, { rail: "x402", x402 })).record;
      if (rec.status === "paid") return this.x402Replay(rec);
      if (!rec.x402 || rec.x402.pay_to.toLowerCase() !== requirement.pay_to.toLowerCase() || rec.x402.amount_atomic !== requirement.amount) {
        throw new GovernanceError(
          `${rec.intent_id} already exists for this task with different payment terms. Use a new task_id.`,
          "intent_conflict",
        );
      }
    }
    if (rec.status !== "approved") return { paid: false, replayed: false, record: rec };
    return this.x402Pay(rec.intent_id, request, { requirement, resource: challenge.resource });
  }

  private x402Replay(rec: IntentRecord): X402FetchResult {
    this.store.audit("payment_replayed", {
      intent_id: rec.intent_id,
      payment_id: rec.payment?.payment_id,
      note: "x402 resource already paid: returned the stored response, nothing paid again.",
    });
    return { paid: true, replayed: true, record: rec, response: rec.x402?.response, transaction: rec.x402?.transaction };
  }

  private async x402Pay(
    intentId: string,
    request: (headers: Record<string, string>) => Promise<Response>,
    fresh: { requirement: X402Requirement; resource: unknown } | undefined,
  ): Promise<X402FetchResult> {
    type Claim = { kind: "replay"; record: IntentRecord } | { kind: "pay"; record: IntentRecord; header: { name: string; value: string } };
    const claim = this.store.transact((intents, now, halts): Claim => {
      const rec = intents[intentId];
      if (rec.status === "paid") return { kind: "replay", record: rec };
      this.assertNotHalted(rec, halts);
      if (rec.status === "paying" && now.getTime() - new Date(rec.updated_at).getTime() < ISSUING_STALE_MS) {
        throw new GovernanceError(`A payment for ${intentId} is being sent right now. Retry in a few seconds.`, "in_progress");
      }
      if (rec.status !== "paying") this.assertSpendable(rec, intents, now, halts);
      const x = rec.x402!;
      let header: { name: string; value: string };
      if (x.authorization) {
        if (new Date(Number(x.authorization.valid_before) * 1000) <= now) {
          throw new GovernanceError(
            `The payment authorization for ${intentId} expired at ${new Date(Number(x.authorization.valid_before) * 1000).toISOString()}. ` +
              `If it never settled (check nonce ${x.authorization.nonce} on ${x.network}), submit a new intent with a new task_id.`,
            "authorization_expired",
          );
        }
        header = x.authorization.header;
      } else {
        if (!fresh) throw new GovernanceError(`No payment terms for ${intentId}.`, "not_found");
        const cap = this.config.policy.x402.max_timeout_seconds;
        const r = { ...fresh.requirement, max_timeout_seconds: Math.min(fresh.requirement.max_timeout_seconds, cap) };
        const signed = this.x402Wallet().authorize(r, now);
        header = paymentHeader(r, fresh.resource, signed);
        x.authorization = {
          signature: signed.signature,
          nonce: signed.authorization.nonce,
          valid_before: signed.authorization.validBefore,
          from: signed.authorization.from,
          header,
        };
      }
      rec.status = "paying";
      rec.updated_at = now.toISOString();
      return { kind: "pay", record: rec, header };
    });
    if (claim.kind === "replay") return this.x402Replay(claim.record);

    const revert = () =>
      this.store.transact((intents, now) => {
        intents[intentId].status = "approved";
        intents[intentId].updated_at = now.toISOString();
        return intents[intentId];
      });
    let res: Response;
    try {
      res = await request({ [claim.header.name]: claim.header.value });
    } catch (err) {
      revert();
      this.store.audit("payment_failed", { intent_id: intentId, adapter: "x402", error: String(err) });
      throw new GovernanceError(`x402 request failed: ${(err as Error).message}. Retrying re-sends the same authorization.`, "adapter_error");
    }
    const settlement = parseSettlement(res.headers);
    const response = await this.readResponse(res);
    if (!res.ok || settlement?.success === false) {
      revert();
      this.store.audit("payment_failed", {
        intent_id: intentId,
        adapter: "x402",
        http_status: res.status,
        reason: settlement?.errorReason,
      });
      throw new GovernanceError(
        `The server didn't accept the payment for ${intentId} (HTTP ${res.status}${settlement?.errorReason ? `, ${settlement.errorReason}` : ""}). ` +
          "Retrying re-sends the same authorization, so it can't pay twice.",
        "payment_refused",
      );
    }
    const record = this.store.transact((intents, now) => {
      const r = intents[intentId];
      const x = r.x402!;
      r.status = "paid";
      r.updated_at = now.toISOString();
      x.paid_at = now.toISOString();
      if (settlement?.transaction) x.transaction = settlement.transaction;
      x.response = response;
      r.payment = {
        adapter: "x402",
        payment_id: settlement?.transaction || x.authorization!.nonce,
        status: settlement?.transaction ? "settled" : "accepted",
        amount: r.intent.amount,
        currency: "USD",
        payee: {},
        paid_to: x.pay_to,
        sent_at: now.toISOString(),
      };
      return r;
    });
    this.store.audit("payment_sent", {
      intent_id: intentId,
      adapter: "x402",
      payment_id: record.payment!.payment_id,
      network: record.x402!.network,
      asset: record.x402!.asset,
      paid_to: record.x402!.pay_to,
      amount_atomic: record.x402!.amount_atomic,
      amount: record.intent.amount,
      currency: "USD",
      from: record.x402!.authorization!.from,
      approved_by: record.approved_by,
    });
    return { paid: true, replayed: false, record, response, transaction: record.x402!.transaction };
  }

  /** The kill switch's current state: every halt still in force. */
  activeHalts(): HaltRecord[] {
    return this.store.transact((_i, _n, halts) =>
      Object.values(halts)
        .filter((h) => !h.resumed_at)
        .map(({ resume_code: _code, ...h }) => h),
    );
  }

  /**
   * Pull the kill switch for one agent, or for every agent when agent_id is left out. Safe to call from anywhere,
   * agents included: halting can only stop money. Halting what's already halted keeps the first halt.
   */
  async halt(opts: { agent_id?: string; reason: string; by: string; via: ApprovalChannel }): Promise<HaltRecord> {
    let code: string | undefined;
    const out = this.store.transact((_intents, now, halts) => {
      const key = haltKey(opts.agent_id);
      const current = halts[key];
      if (current && !current.resumed_at) return { halt: current, fresh: false };
      const halt: HaltRecord = {
        scope: opts.agent_id ? "agent" : "all",
        ...(opts.agent_id ? { agent_id: opts.agent_id.trim() } : {}),
        reason: opts.reason,
        by: opts.by,
        via: opts.via,
        tripped_at: now.toISOString(),
      };
      if (this.requireCode && this.canSendCode) {
        code = newApprovalCode();
        halt.resume_code = hashApprovalCode(code);
      }
      halts[key] = halt;
      return { halt, fresh: true };
    });
    if (out.fresh) await this.haltNotice(out.halt, code);
    const { resume_code: _c, ...shown } = out.halt;
    return shown;
  }

  /**
   * Lift a halt. Like approving, a terminal resume needs the one-time code sent to Slack or Discord when codes are
   * required, so an agent with a shell can't switch itself back on. Lifting an agent's halt leaves a global one alone.
   */
  resume(opts: { agent_id?: string; by: string; via: ApprovalChannel; code?: string }): HaltRecord {
    const key = haltKey(opts.agent_id);
    const out = this.store.transact((_intents, now, halts): { halt: HaltRecord; error?: GovernanceError } => {
      const h = halts[key];
      const who = opts.agent_id ? `agent ${opts.agent_id}` : "all agents";
      if (!h || h.resumed_at) throw new GovernanceError(`Spending isn't halted for ${who}.`, "not_halted");
      if (opts.via === "cli" && this.requireCode) {
        if (!h.resume_code) {
          throw new GovernanceError(`This halt has no resume code, so resume it over the HTTP admin API (POST /resume).`, "code_unavailable");
        }
        if (!opts.code) {
          throw new GovernanceError(
            `Resuming from the terminal needs the one-time code from the Slack or Discord message: pursestring resume${opts.agent_id ? ` --agent ${opts.agent_id}` : ""} --code XXXXX-XXXXX`,
            "code_required",
          );
        }
        if (!verifyApprovalCode(opts.code, h.resume_code)) {
          // Too many wrong codes leaves the halt in place (it already stops everything) and drops the code,
          // so from then on only the HTTP admin API can resume.
          h.resume_code_attempts = (h.resume_code_attempts ?? 0) + 1;
          if (h.resume_code_attempts >= MAX_CODE_ATTEMPTS) h.resume_code = undefined;
          return { halt: h, error: new GovernanceError(`Wrong resume code for ${who}.`, "bad_code") };
        }
      }
      h.resumed_at = now.toISOString();
      h.resumed_by = opts.by;
      h.resumed_via = opts.via;
      h.resume_code = undefined;
      return { halt: h };
    });
    if (out.error) {
      this.store.audit("resume_code_rejected", { key, by: opts.by, via: opts.via, attempts: out.halt.resume_code_attempts });
      throw out.error;
    }
    this.store.audit("kill_switch_resumed", { scope: out.halt.scope, agent_id: out.halt.agent_id, by: opts.by, via: opts.via });
    return out.halt;
  }

  private async haltNotice(halt: HaltRecord, code?: string) {
    const { resume_code: _c, ...entry } = halt;
    this.store.audit("kill_switch_tripped", entry);
    try {
      await this.notifier.killSwitchTripped?.(halt, { code });
    } catch (err) {
      this.store.audit("kill_switch_notify_failed", { agent_id: halt.agent_id, error: String(err) });
    }
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
    const result = this.store.transact((intents, now, halts) => {
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
      const halt = activeHalt(halts, rec.intent.agent_id);
      if (halt) return decide("halted", `Spending is halted: ${halt.reason}`);
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
