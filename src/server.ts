import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Governance, GovernanceError } from "./governance.js";
import type { Upstream } from "./paypal-mcp.js";
import { isGovernedTool } from "./policy.js";
import { PurchaseIntentSchema, PurchaseIntentShape, type IntentRecord } from "./types.js";

export const VERSION = "0.1.0";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(
        err instanceof GovernanceError ? { error: err.code, message: err.message } : { error: "internal", message: String(err) },
        null,
        2,
      ),
    },
  ],
});

function nextStep(rec: IntentRecord, payout: boolean): string {
  switch (rec.status) {
    case "approved":
      if (rec.action) {
        return `Approved. Call ${rec.action.tool} again with exactly the same arguments and intent_id "${rec.intent_id}" to run it.`;
      }
      return payout
        ? `Approved. Call send_payment with intent_id "${rec.intent_id}" to pay the vendor directly.`
        : `Approved. Call request_ephemeral_card with intent_id "${rec.intent_id}".`;
    case "pending_approval":
      return `Paused for human approval. Do not buy another way. Call get_intent_status with intent_id "${rec.intent_id}" and wait_seconds to wait for a decision.`;
    case "denied":
      return "Denied. Do not attempt this purchase; tell the user why and look for a free alternative.";
    case "card_issued":
      return `A card was already issued for this intent. Call request_ephemeral_card with "${rec.intent_id}" to get the same card again. Do not create a new purchase.`;
    case "issuing":
      return "A card is being issued right now. Retry request_ephemeral_card in a few seconds.";
    case "expired":
      return "This intent expired. Submit a fresh intent if the purchase is still needed.";
    case "paying":
      return "The payment is being sent right now. Call send_payment again in a few seconds; it will not pay twice.";
    case "paid":
      return "Paid. The vendor has the money; do not pay again. Calling send_payment again only returns this payment.";
    case "executing":
      return `${rec.action?.tool ?? "The call"} is running right now. Check again in a few seconds.`;
    case "executed":
      return `${rec.action?.tool ?? "The call"} already ran. Do not repeat it.`;
  }
}

function view(gov: Governance, rec: IntentRecord) {
  let payout = false;
  try {
    payout = gov.isPayout(rec);
  } catch {
    /* rail not configured: the card path's error explains it */
  }
  return {
    intent_id: rec.intent_id,
    status: rec.status,
    rail: rec.rail,
    decision: rec.evaluation.decision,
    summary: rec.evaluation.summary,
    failed_rules: rec.evaluation.rules.filter((r) => !r.passed).map(({ rule, detail }) => ({ rule, detail })),
    approved_by: rec.approved_by,
    denied_by: rec.denied_by,
    decision_note: rec.decision_note,
    expires_at: rec.expires_at,
    card_last_four: rec.card?.last_four,
    payment: rec.payment
      ? { payment_id: rec.payment.payment_id, status: rec.payment.status, paid_to: rec.payment.payee.receiver }
      : undefined,
    next_step: nextStep(rec, payout),
  };
}

/** Fields PurseString adds to every governed PayPal tool. */
const GOVERNANCE_FIELDS = {
  agent_id: z.string().min(1).describe("Stable identifier of the calling agent, e.g. 'support-bot'."),
  reason: z.string().min(1).describe("Why you are doing this, e.g. 'Customer 4411 was double-charged for order 991'. Shown to the approver."),
  intent_id: z
    .string()
    .optional()
    .describe("Only when repeating a call that was paused for approval: the intent_id PurseString returned."),
};

/** PayPal's JSON Schema as zod, so the MCP SDK can list and validate it. Unreadable schemas accept any object. */
function toZod(schema: Record<string, unknown>) {
  try {
    const s = z.fromJSONSchema(schema);
    if (s instanceof z.ZodObject) return s.loose();
  } catch {
    /* fall through */
  }
  return z.object({}).loose();
}

/**
 * Re-expose PayPal's MCP tools. Read-only tools pass straight through. Tools that move money or can't be undone
 * (refunds, accepting disputes, cancellations) take agent_id and reason too, and run only when policy or a human
 * allows them.
 */
function registerPayPalTools(server: McpServer, gov: Governance, upstream: Upstream, taken: Set<string>) {
  for (const tool of upstream.tools) {
    if (taken.has(tool.name)) continue;
    const base = toZod(tool.inputSchema);
    if (!isGovernedTool(gov.config.policy, tool.name)) {
      server.registerTool(
        tool.name,
        { title: tool.title, description: tool.description, inputSchema: base, annotations: tool.annotations },
        async (args: Record<string, unknown>) => {
          try {
            return (await upstream.call(tool.name, args)) as never;
          } catch (err) {
            return fail(err);
          }
        },
      );
      continue;
    }
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description:
          `${tool.description ?? ""}\n\nGoverned by PurseString: pass agent_id and reason. Policy may run this at once, ` +
          "pause it for a human (then wait with get_intent_status and call again with the same arguments and the " +
          "intent_id), or refuse it. Repeating a call that already ran returns the first result; it never runs twice.",
        inputSchema: base.extend(GOVERNANCE_FIELDS),
        annotations: { ...tool.annotations, destructiveHint: true, idempotentHint: true },
      },
      async (input: Record<string, unknown>) => {
        const { agent_id, reason, intent_id, ...args } = input as Record<string, unknown> & {
          agent_id: string;
          reason: string;
          intent_id?: string;
        };
        try {
          const { record, result, replayed } = await gov.governToolCall(tool.name, args, { agent_id, reason, intent_id }, (a) =>
            upstream.call(tool.name, a),
          );
          const note = {
            type: "text" as const,
            text: JSON.stringify({
              pursestring: {
                intent_id: record.intent_id,
                approved_by: record.approved_by,
                replayed,
                note: replayed
                  ? "Already ran: this is PayPal's earlier answer. Nothing was sent to PayPal again."
                  : result.isError
                    ? "PayPal refused the call, so nothing happened. The approval still stands if you fix the cause and retry."
                    : "Ran once through PurseString policy.",
              },
            }),
          };
          return { ...result, content: [...(result.content as never[]), note] } as never;
        } catch (err) {
          if (err instanceof GovernanceError) {
            const rec = intent_id ? gov.store.get(intent_id) : undefined;
            const id = err.message.match(/int_[a-z0-9]+/)?.[0] ?? rec?.intent_id;
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ error: err.code, message: err.message, intent_id: id }, null, 2),
                },
              ],
            };
          }
          return fail(err);
        }
      },
    );
  }
}

export function createMcpServer(gov: Governance, upstream?: Upstream): McpServer {
  const server = new McpServer(
    { name: "pursestring", version: VERSION },
    {
      instructions:
        "PurseString governs every purchase you make. Before spending money: call submit_purchase_intent with your goal, " +
        "the exact amount, the vendor domain, whether it recurs, and the free alternatives you tried. Only pay with a card " +
        "from request_ephemeral_card. If a checkout hangs or errors, call request_ephemeral_card again with the same " +
        "intent_id: you will get the same card, not a new charge. Never pay by any other means.",
    },
  );

  server.registerTool(
    "check_policy_compliance",
    {
      title: "Check policy compliance (dry run)",
      description:
        "Evaluate a purchase against the spend policy without submitting it. Returns the decision " +
        "(auto_approve, require_approval or deny) and every rule that was checked. No card is issued and no human is pinged.",
      inputSchema: PurchaseIntentShape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      try {
        const intent = PurchaseIntentSchema.parse(args);
        const { evaluation, idempotency_key, existing } = gov.checkCompliance(intent);
        return ok({
          decision: evaluation.decision,
          summary: evaluation.summary,
          rules: evaluation.rules,
          idempotency_key,
          existing_intent: existing ? view(gov, existing) : null,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "submit_purchase_intent",
    {
      title: "Submit purchase intent",
      description:
        "Declare a purchase before making it. Policy decides: auto-approve, pause for a human (Slack/Discord), or deny. " +
        "Submitting the same agent_id + task_id + vendor + amount again inside the idempotency window returns the " +
        "original intent instead of creating a second one.",
      inputSchema: PurchaseIntentShape,
      annotations: { idempotentHint: true },
    },
    async (args) => {
      try {
        const intent = PurchaseIntentSchema.parse(args);
        const { record, deduplicated } = await gov.submitIntent(intent);
        return ok({ ...view(gov, record), deduplicated });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "request_ephemeral_card",
    {
      title: "Request ephemeral card",
      description:
        "Get a single-use virtual card for an approved intent, capped at the approved amount. Calling this again for the " +
        "same intent_id inside the idempotency window returns the same card: safe to retry after a hung checkout.",
      inputSchema: { intent_id: z.string().describe("The intent_id returned by submit_purchase_intent.") },
      annotations: { idempotentHint: true },
    },
    async ({ intent_id }) => {
      try {
        const { card, record, replayed } = await gov.requestCard(intent_id);
        return ok({
          intent_id,
          replayed,
          note: replayed
            ? "Duplicate prevented: this is the card already issued for this intent. No new transaction was created."
            : card.single_use
              ? `New single-use card issued. Use it once, before ${card.expires_at}; after that it is closed.`
              : "New merchant-locked recurring card issued, capped per month.",
          card: {
            number: card.pan,
            cvv: card.cvv,
            exp_month: card.exp_month,
            exp_year: card.exp_year,
            last_four: card.last_four,
            spend_limit: card.spend_limit,
            currency: card.currency,
            single_use: card.single_use,
            expires_at: card.expires_at,
            rail: card.adapter,
          },
          intended_vendor: record.intent.vendor_domain,
          vendor_enforcement: gov.config.policy.jit.require_merchant_match
            ? "Charges from other merchants are declined by real-time authorization."
            : card.single_use
              ? "Not locked to this vendor: the card is capped at the amount and works once. Use it only here."
              : "Locked to the first merchant that charges it, where the rail supports merchant locking.",
          card_details_location:
            "The full card details are only in this result. PurseString has no dashboard and never stores card numbers; " +
            "to see them again, call request_ephemeral_card with this intent_id before the card expires.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "send_payment",
    {
      title: "Send payment",
      description:
        "Pay an approved intent through a payout rail (PayPal or Venmo). The approved amount goes to the vendor's " +
        "account on file in the policy; you can't choose the recipient. Each intent is paid at most once: calling " +
        "again returns the existing payment, so it is safe to retry.",
      inputSchema: { intent_id: z.string().describe("The intent_id returned by submit_purchase_intent.") },
      annotations: { idempotentHint: true },
    },
    async ({ intent_id }) => {
      try {
        const { payment, record, replayed } = await gov.sendPayment(intent_id);
        return ok({
          intent_id,
          replayed,
          note: replayed
            ? "Duplicate prevented: this intent was already paid. No money moved."
            : `Sent ${payment.amount.toFixed(2)} ${payment.currency} to ${record.intent.vendor_domain} via ${payment.adapter}.`,
          payment: {
            payment_id: payment.payment_id,
            status: payment.status,
            amount: payment.amount,
            currency: payment.currency,
            paid_to: payment.payee.receiver,
            wallet: payment.payee.wallet,
            rail: payment.adapter,
            sent_at: payment.sent_at,
          },
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_intent_status",
    {
      title: "Get intent status",
      description:
        "Check an intent's status. Pass wait_seconds (up to 300) to block until a human approves or denies it, " +
        "which is how the agent pauses for human-in-the-loop approval.",
      inputSchema: {
        intent_id: z.string(),
        wait_seconds: z.number().int().min(0).max(300).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ intent_id, wait_seconds }) => {
      try {
        return ok(view(gov, await gov.getStatus(intent_id, wait_seconds)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  if (upstream) {
    registerPayPalTools(
      server,
      gov,
      upstream,
      new Set(["check_policy_compliance", "submit_purchase_intent", "request_ephemeral_card", "send_payment", "get_intent_status"]),
    );
  }

  return server;
}
