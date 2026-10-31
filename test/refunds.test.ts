import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startHttp } from "../src/http.js";
import { WebhookNotifier, type RefundNotice } from "../src/notify.js";
import { spentToday } from "../src/store.js";
import { signStandardWebhook, verifyStandardWebhook } from "../src/webhooks.js";
import { intent, POLICY, setup } from "./helpers.js";

async function charged(amount = 15, env = {}) {
  const ctx = setup(POLICY, env);
  const notices: RefundNotice[] = [];
  ctx.gov.notifier.refundRecorded = async (n) => void notices.push(n);
  const { record } = await ctx.gov.submitIntent(intent({ amount }));
  const { card } = await ctx.gov.requestCard(record.intent_id);
  ctx.gov.authorize({ card_token: card.token, amount, merchant: "PDFOCR.IO" });
  return { ...ctx, record, card, notices };
}

const spent = (ctx: Awaited<ReturnType<typeof charged>>) =>
  ctx.store.transact((intents, now) => spentToday(intents, "invoice-bot", now));

test("a refund is logged against the original intent and gives the budget back", async () => {
  const ctx = await charged();
  assert.equal(spent(ctx), 15);
  const r = await ctx.gov.recordRefund({ refund_id: "evt_1", amount: 15, card_token: ctx.card.token, source: "lithic" });
  assert.equal(r.outcome, "credited");
  assert.equal(r.refund_status, "refunded");
  assert.equal(spent(ctx), 0);
  const rec = ctx.store.get(ctx.record.intent_id)!;
  assert.equal(rec.status, "card_issued", "the original intent's status is left alone");
  assert.equal(rec.intent.amount, 15);
  assert.equal(rec.refunds?.length, 1);
  assert.equal(ctx.notices[0].outcome, "credited");
  assert.equal(ctx.notices[0].spent_today, 0);
  const audit = ctx.store.readAudit().map((e) => e.event);
  assert.ok(audit.includes("refund_credited"));
});

test("the same refund delivered twice only credits once", async () => {
  const ctx = await charged();
  await ctx.gov.recordRefund({ refund_id: "evt_1", amount: 5, card_token: ctx.card.token, source: "lithic" });
  const again = await ctx.gov.recordRefund({ refund_id: "evt_1", amount: 5, card_token: ctx.card.token, source: "lithic" });
  assert.equal(again.outcome, "duplicate");
  assert.equal(again.refunded_total, 5);
  assert.equal(spent(ctx), 10);
  assert.equal(ctx.notices.length, 1, "no second notification for a retry");
});

test("partial refunds add up and can never pass what was charged", async () => {
  const ctx = await charged();
  const a = await ctx.gov.recordRefund({ refund_id: "a", amount: 10, intent_id: ctx.record.intent_id, source: "http" });
  assert.equal(a.refund_status, "partially_refunded");
  const over = await ctx.gov.recordRefund({ refund_id: "b", amount: 10, intent_id: ctx.record.intent_id, source: "http" });
  assert.equal(over.outcome, "over_original");
  assert.equal(over.credited, 0);
  assert.equal(spent(ctx), 5);
  assert.equal(ctx.notices.at(-1)?.outcome, "over_original");
  const rest = await ctx.gov.recordRefund({ refund_id: "c", amount: 5, intent_id: ctx.record.intent_id, source: "http" });
  assert.equal(rest.refund_status, "refunded");
  assert.equal(spent(ctx), 0);
});

test("refunds on cards PurseString doesn't own are flagged, not credited", async () => {
  const ctx = await charged();
  const r = await ctx.gov.recordRefund({ refund_id: "x", amount: 3, card_token: "someone-else", source: "lithic" });
  assert.equal(r.outcome, "unmatched");
  assert.equal(ctx.notices[0].outcome, "unmatched");
  assert.equal(spent(ctx), 15);
});

test("budget given back lets the agent spend again today", async () => {
  const ctx = setup({ ...POLICY, hard_limits: { per_agent_daily_budget: 20 } });
  const first = await ctx.gov.submitIntent(intent({ amount: 15 }));
  const { card } = await ctx.gov.requestCard(first.record.intent_id);
  const blocked = await ctx.gov.submitIntent(intent({ amount: 15, task_id: "103" }));
  assert.notEqual(blocked.record.status, "approved");
  await ctx.gov.recordRefund({ refund_id: "r1", amount: 15, card_token: card.token, source: "lithic" });
  const after = await ctx.gov.submitIntent(intent({ amount: 15, task_id: "104" }));
  assert.equal(after.record.status, "approved");
});

test("POST /webhooks/lithic checks the signature, credits RETURN events and ignores retries", async () => {
  const secret = Buffer.from("events-secret").toString("base64");
  const ctx = await charged(15, { lithicEventsSecret: secret });
  const server = startHttp(ctx.gov, 0, "127.0.0.1", { quiet: true });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const body = JSON.stringify({
    event_type: "card_transaction.updated",
    payload: {
      token: "tx_1",
      card_token: ctx.card.token,
      currency: "USD",
      merchant: { descriptor: "PDFOCR.IO" },
      events: [
        { token: "ev_auth", type: "AUTHORIZATION", amount: 1500, result: "APPROVED" },
        { token: "ev_ret", type: "RETURN", amount: -600, result: "APPROVED" },
      ],
    },
  });
  const post = (id: string, signed = true) => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/webhooks/lithic`, {
      method: "POST",
      headers: {
        "webhook-id": id,
        "webhook-timestamp": String(ts),
        "webhook-signature": signed ? signStandardWebhook(secret, id, ts, body) : "v1,bad",
      },
      body,
    });
  };
  try {
    assert.equal((await post("m1", false)).status, 401);
    const ok = (await (await post("m1")).json()) as { refunds: { outcome: string; credited: number }[] };
    assert.deepEqual(ok.refunds, [{ outcome: "credited", intent_id: ctx.record.intent_id, credited: 6 }]);
    const retry = (await (await post("m2")).json()) as { refunds: { outcome: string }[] };
    assert.equal(retry.refunds[0].outcome, "duplicate");
    assert.equal(spent(ctx), 9);
  } finally {
    server.close();
  }
});

test("refund notifications reach Slack and a signed POST to REFUND_WEBHOOK_URL", async () => {
  const secret = Buffer.from("receiver-secret").toString("base64");
  const ctx = await charged();
  const got: { url: string; headers: Record<string, string>; body: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    got.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
    return new Response("ok");
  }) as typeof fetch;
  try {
    ctx.gov.config.env.slackWebhookUrl = "https://hooks.slack.com/services/x";
    ctx.gov.config.env.refundWebhookUrl = "https://example.com/hooks/pursestring";
    ctx.gov.config.env.refundWebhookSecret = secret;
    const notifier = new WebhookNotifier(ctx.gov.config, () => {});
    await ctx.gov.recordRefund({ refund_id: "evt_9", amount: 4, card_token: ctx.card.token, source: "lithic" });
    await notifier.refundRecorded(ctx.notices[0]);
  } finally {
    globalThis.fetch = realFetch;
  }
  const slack = got.find((g) => g.url.includes("slack"))!;
  assert.match(slack.body, /Refund 4\.00 USD from pdfocr\.io/);
  assert.match(slack.body, /Today's spend now:\* 11\.00 of 200\.00/);
  const hook = got.find((g) => g.url.includes("example.com"))!;
  assert.ok(verifyStandardWebhook(secret, hook.headers, hook.body), "receivers can verify the signature");
  const event = JSON.parse(hook.body);
  assert.equal(event.type, "intent.refunded");
  assert.equal(event.intent_id, ctx.record.intent_id);
  assert.equal(event.refunded_total, 4);
});
