import type { Config } from "./config.js";
import type { IntentRecord } from "./types.js";

export interface Notifier {
  approvalRequested(rec: IntentRecord): Promise<void>;
}

function summaryLines(rec: IntentRecord): string[] {
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
    `Approve: \`pursestring approve ${rec.intent_id}\`   Deny: \`pursestring deny ${rec.intent_id}\``,
  ];
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`webhook returned ${res.status}`);
}

/** Pings Slack and/or Discord incoming webhooks. Failures are logged, never thrown at the agent. */
export class WebhookNotifier implements Notifier {
  constructor(
    private readonly config: Config,
    private readonly log: (msg: string) => void = (m) => console.error(m),
  ) {}

  async approvalRequested(rec: IntentRecord): Promise<void> {
    const lines = summaryLines(rec);
    const title = `:rotating_light: Agent spend needs approval: ${rec.intent.amount.toFixed(2)} ${rec.intent.currency} at ${rec.intent.vendor_domain}`;
    const jobs: Promise<void>[] = [];
    const { slackWebhookUrl, discordWebhookUrl } = this.config.env;
    if (slackWebhookUrl) {
      jobs.push(
        post(slackWebhookUrl, {
          text: title,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*${title}*` } },
            { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
            { type: "context", elements: [{ type: "mrkdwn", text: `intent ${rec.intent_id} · expires ${rec.expires_at}` }] },
          ],
        }),
      );
    }
    if (discordWebhookUrl) {
      jobs.push(post(discordWebhookUrl, { content: [title.replace(":rotating_light:", "🚨"), ...lines].join("\n").replace(/\*/g, "**") }));
    }
    if (jobs.length === 0) {
      this.log(`[pursestring] approval needed for ${rec.intent_id}; no SLACK_WEBHOOK_URL or DISCORD_WEBHOOK_URL set, approve with: pursestring approve ${rec.intent_id}`);
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === "rejected") this.log(`[pursestring] notification failed: ${r.reason}`);
  }
}
