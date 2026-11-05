import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { IntentRecord, RefundRecord } from "./types.js";
import { signStandardWebhook } from "./webhooks.js";

export interface ApprovalRequestExtras {
  /** One-time approval code. Only the human's channel ever sees it. */
  code?: string;
}

/** A refund PurseString acted on, or one it refused and wants a human to look at. */
export interface RefundNotice {
  outcome: "credited" | "unmatched" | "over_original";
  refund: RefundRecord;
  record?: IntentRecord;
  /** What was charged on the intent's card. */
  charged?: number;
  /** The agent's spend today after the credit. */
  spent_today?: number;
  daily_budget: number;
}

export interface Notifier {
  approvalRequested(rec: IntentRecord, extras?: ApprovalRequestExtras): Promise<void>;
  refundRecorded?(notice: RefundNotice): Promise<void>;
}

/** The JSON sent to REFUND_WEBHOOK_URL. Stable field names: other systems parse this. */
export function refundEventBody(n: RefundNotice) {
  const r = n.record;
  return {
    type: n.outcome === "credited" ? "intent.refunded" : "refund.needs_review",
    outcome: n.outcome,
    refund_id: n.refund.refund_id,
    amount: n.refund.amount,
    currency: n.refund.currency,
    merchant: n.refund.merchant,
    source: n.refund.source,
    ts: n.refund.ts,
    intent_id: r?.intent_id,
    agent_id: r?.intent.agent_id,
    task_id: r?.intent.task_id,
    vendor_domain: r?.intent.vendor_domain,
    charged: n.charged,
    refunded_total: r?.refunded_total,
    refund_status: r?.refund_status,
    spent_today: n.spent_today,
    daily_budget: n.daily_budget,
  };
}

function refundLines(n: RefundNotice): { title: string; lines: string[] } {
  const amt = `${n.refund.amount.toFixed(2)} ${n.refund.currency}`;
  const r = n.record;
  if (n.outcome === "unmatched") {
    return {
      title: `:mag: Refund needs a look: ${amt}${n.refund.merchant ? ` from ${n.refund.merchant}` : ""}`,
      lines: [`No PurseString purchase owns this card, so no budget was given back. Refund ${n.refund.refund_id}.`],
    };
  }
  const who = `*Agent:* ${r!.intent.agent_id}   *Task:* ${r!.intent.task_id}   *Intent:* ${r!.intent_id}`;
  if (n.outcome === "over_original") {
    return {
      title: `:mag: Refund needs a look: ${amt} at ${r!.intent.vendor_domain}`,
      lines: [
        who,
        `It would take refunds past the ${n.charged?.toFixed(2)} charged (${(r!.refunded_total ?? 0).toFixed(2)} already refunded), so nothing was credited. Refund ${n.refund.refund_id}.`,
      ],
    };
  }
  return {
    title: `:money_with_wings: Refund ${amt} from ${r!.intent.vendor_domain}`,
    lines: [
      who,
      `*Budget back:* ${amt}   *Refunded so far:* ${(r!.refunded_total ?? 0).toFixed(2)} of ${n.charged?.toFixed(2)} (${r!.refund_status === "refunded" ? "fully refunded" : "partial"})`,
      `*Today's spend now:* ${(n.spent_today ?? 0).toFixed(2)} of ${n.daily_budget.toFixed(2)}`,
    ],
  };
}

function approveLine(rec: IntentRecord, code?: string): string {
  const approve = code ? `pursestring approve ${rec.intent_id} --code ${code}` : `pursestring approve ${rec.intent_id}`;
  return `Approve: \`${approve}\`   Deny: \`pursestring deny ${rec.intent_id}\``;
}

function summaryLines(rec: IntentRecord, code?: string): string[] {
  const i = rec.intent;
  const failed = rec.evaluation.rules.filter((r) => !r.passed);
  return [
    `*Agent:* ${i.agent_id}   *Task:* ${i.task_id}`,
    `*Goal:* ${i.task_goal}`,
    `*Spend:* ${i.amount.toFixed(2)} ${i.currency} at ${i.vendor_domain}${i.is_recurring ? "  (RECURRING)" : ""}`,
    `*Rail:* ${rec.rail}`,
    `*Alternatives tried:* ${i.alternatives_attempted.length ? i.alternatives_attempted.join("; ") : "none"}`,
    `*Why it needs you:* ${failed.map((r) => `${r.rule}: ${r.detail}`).join(" | ")}`,
    "",
    approveLine(rec, code),
    ...(code ? ["_Keep the code to yourself: it's what stops the agent approving its own purchase._"] : []),
  ];
}

export function slackButtons(intentId: string) {
  return {
    type: "actions",
    block_id: "pursestring_decision",
    elements: [
      { type: "button", action_id: "pursestring_approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: intentId },
      { type: "button", action_id: "pursestring_deny", style: "danger", text: { type: "plain_text", text: "Deny" }, value: intentId },
    ],
  };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`webhook returned ${res.status}`);
}

/** Pings Slack and/or Discord incoming webhooks. Failures are logged, never thrown at the agent. */
export class WebhookNotifier implements Notifier {
  constructor(
    private readonly config: Config,
    private readonly log: (msg: string) => void = (m) => console.error(m),
  ) {}

  async approvalRequested(rec: IntentRecord, extras: ApprovalRequestExtras = {}): Promise<void> {
    const lines = summaryLines(rec, extras.code);
    const title = `:rotating_light: Agent spend needs approval: ${rec.intent.amount.toFixed(2)} ${rec.intent.currency} at ${rec.intent.vendor_domain}`;
    const jobs: Promise<void>[] = [];
    const { slackWebhookUrl, slackSigningSecret, discordWebhookUrl } = this.config.env;
    if (slackWebhookUrl) {
      jobs.push(
        post(slackWebhookUrl, {
          text: title,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*${title}*` } },
            { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
            // Buttons only work when the webhook belongs to a Slack app whose interactivity URL points at /slack/actions.
            ...(slackSigningSecret ? [slackButtons(rec.intent_id)] : []),
            { type: "context", elements: [{ type: "mrkdwn", text: `intent ${rec.intent_id} · expires ${rec.expires_at}` }] },
          ],
        }),
      );
    }
    if (discordWebhookUrl) {
      jobs.push(post(discordWebhookUrl, { content: [title.replace(":rotating_light:", "🚨"), ...lines].join("\n").replace(/\*/g, "**") }));
    }
    if (jobs.length === 0) {
      this.log(
        `[pursestring] approval needed for ${rec.intent_id}; no SLACK_WEBHOOK_URL or DISCORD_WEBHOOK_URL set. ` +
          `Approve with \`pursestring approve ${rec.intent_id}\` (unless approvals.require_code is on) or the HTTP approval API.`,
      );
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === "rejected") this.log(`[pursestring] notification failed: ${r.reason}`);
  }

  /**
   * Tell the humans about a refund: a line in Slack and/or Discord, and a signed JSON POST to REFUND_WEBHOOK_URL so
   * accounting or internal tools can follow along. The POST uses Standard Webhooks headers, signed with
   * REFUND_WEBHOOK_SECRET when it's set, so receivers can check it came from PurseString.
   */
  async refundRecorded(n: RefundNotice): Promise<void> {
    const { title, lines } = refundLines(n);
    const jobs: Promise<void>[] = [];
    const { slackWebhookUrl, discordWebhookUrl, refundWebhookUrl, refundWebhookSecret } = this.config.env;
    if (slackWebhookUrl) {
      jobs.push(
        post(slackWebhookUrl, {
          text: title,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*${title}*` } },
            { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
          ],
        }),
      );
    }
    if (discordWebhookUrl) {
      const emoji = title.replace(":money_with_wings:", "💸").replace(":mag:", "🔍");
      jobs.push(post(discordWebhookUrl, { content: [emoji, ...lines].join("\n").replace(/\*/g, "**") }));
    }
    if (refundWebhookUrl) {
      const raw = JSON.stringify(refundEventBody(n));
      const id = `msg_${randomUUID().replace(/-/g, "")}`;
      const ts = Math.floor(Date.now() / 1000);
      jobs.push(
        post(refundWebhookUrl, raw, {
          "webhook-id": id,
          "webhook-timestamp": String(ts),
          ...(refundWebhookSecret ? { "webhook-signature": signStandardWebhook(refundWebhookSecret, id, ts, raw) } : {}),
        }),
      );
    }
    if (jobs.length === 0) this.log(`[pursestring] ${title.replace(/:[a-z_]+: /, "")}. ${lines.join(" ").replace(/\*/g, "")}`);
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === "rejected") this.log(`[pursestring] refund notification failed: ${r.reason}`);
  }
}
