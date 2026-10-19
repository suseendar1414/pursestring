import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Governance, GovernanceError } from "./governance.js";
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

function nextStep(rec: IntentRecord): string {
  switch (rec.status) {
    case "approved":
      return `Approved. Call request_ephemeral_card with intent_id "${rec.intent_id}".`;
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
  }
}

function view(rec: IntentRecord) {
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
    next_step: nextStep(rec),
  };
}

export function createMcpServer(gov: Governance): McpServer {
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
          existing_intent: existing ? view(existing) : null,
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
        return ok({ ...view(record), deduplicated });
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
        return ok(view(await gov.getStatus(intent_id, wait_seconds)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
