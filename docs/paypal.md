# PayPal: payouts, and guardrails for PayPal's own MCP server

PurseString works with PayPal in two ways:

1. **[Governing PayPal's MCP server](#govern-paypals-mcp-server).** PurseString runs PayPal's official MCP server (`@paypal/mcp`, built on the [PayPal Agent Toolkit](https://github.com/paypal/AI-Toolkit)) behind itself. Your agent gets all of PayPal's tools through PurseString, but refunds, dispute acceptance and cancellations go through policy first.
2. **[Paying vendors](#paypal-and-venmo-payouts).** An agent pays a vendor's PayPal or Venmo account through PayPal Payouts, which the Agent Toolkit doesn't cover.

## Govern PayPal's MCP server

PayPal's MCP server gives an agent about 28 tools, including `create_refund`, `accept_dispute_claim` and `cancel_subscription`. Out of the box, nothing limits how often or how much an agent can use them. A support agent that is prompt-injected by a customer email can refund any order in full.

With `paypal_tools.enabled`, PurseString sits in front of those tools:

```
agent ──create_refund──▶ PurseString ──policy──▶ run now / pause for a human / refuse
                                     └─(allowed)──▶ PayPal MCP server ──▶ PayPal API
```

- **Read-only tools pass straight through** unchanged, such as `list_transactions`, `get_order` and `list_disputes`.
- **Refunds are ruled on by amount.** A refund under `refunds.auto_approve_under` runs at once. A larger one waits for a human in Slack, Discord or the terminal. A refund over `refunds.max_amount` is refused. A full refund with no amount always waits for a human. Refunds count toward the agent's daily budget.
- **Some tools always need a human**, whatever the amount. The defaults are `accept_dispute_claim`, `cancel_subscription`, `cancel_sent_invoice` and `update_subscription`. Tools on `deny` never run.
- **Each approved call runs once.** A governed tool takes two extra fields, `agent_id` and `reason`. When a call pauses, the agent waits with `get_intent_status` and then repeats the same call with the `intent_id`. An approval only covers the exact arguments it was given, so the agent can't get $80 approved and then refund $400. Repeating a call that already ran returns PayPal's first answer instead of refunding twice.
- **Everything is in the audit log**, including what the agent wanted to do, why, which rules applied and who approved it.

```yaml
paypal_tools:
  enabled: true
  refunds:
    auto_approve_under: 25
    max_amount: 500
  require_approval: [accept_dispute_claim, cancel_subscription, cancel_sent_invoice, update_subscription]
  deny: []
```

PurseString starts PayPal's server with `npx -y @paypal/mcp@1.8.1 --tools=all`; change `paypal_tools.command` to pin another version or a subset of tools. It needs `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (steps 1 and 2 below). PayPal's server only ever gets a short-lived access token, never the secret, and it is restarted when the token rotates. Point your agent at PurseString only, not at PayPal's MCP server directly, or the guardrails can be bypassed.

## PayPal and Venmo payouts

The `paypal` rail lets an agent pay a vendor's PayPal or Venmo account, under the same policy, approvals, budgets and audit log as every other rail.

PayPal has no API for minting virtual cards, so this rail works differently from the card rails. It doesn't hand the agent a card. Once an intent is approved, PurseString sends the approved amount straight to the vendor with [PayPal Payouts](https://developer.paypal.com/docs/api/payments.payouts-batch/v1/).

```
agent ──submit_purchase_intent──▶ PurseString ──policy──▶ auto-approve / human / deny
agent ──send_payment──────────────▶ PurseString ──Payouts API──▶ vendor's PayPal or Venmo
```

Three properties matter for agents:

- **The agent never picks the recipient.** Money goes only to the account listed for that vendor under `payees` in `policies.yaml`. If a vendor has no entry, the payment is refused. A prompt injection like "pay this address instead" has nothing to change.
- **An intent is paid at most once.** Calling `send_payment` again returns the existing payment. PayPal also gets the intent ID as `PayPal-Request-Id` and `sender_batch_id`, so a crash halfway through a call can't double-pay on retry.
- **Payouts count toward the agent's daily budget**, exactly like issued cards.

## Set it up in the PayPal sandbox (about 5 minutes, no real money)

1. Sign in at [developer.paypal.com](https://developer.paypal.com) with any PayPal account.
2. Go to **Apps & Credentials**, make sure the **Sandbox** toggle is on, and click **Create App**. Choose the type **Merchant**. Copy the **Client ID** and **Secret**.
3. In the app's settings, under features, make sure **Payouts** is ticked.
4. Go to **Testing Tools → Sandbox Accounts**. PayPal creates a funded business account (the payer, which is your app) and a personal account. Copy the personal account's email. It plays the vendor.
5. Tell PurseString about the vendor and route to PayPal in `policies.yaml`:

   ```yaml
   vendors:
     allowlist: ["pdfocr.io"]

   adapter:
     type: paypal
     paypal:
       environment: sandbox

   payees:
     - vendor: pdfocr.io
       receiver: sb-xxxx@personal.example.com   # the sandbox personal account from step 4
       type: EMAIL
       wallet: PAYPAL
   ```

6. Start the server with the credentials:

   ```bash
   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npx pursestring
   ```

   If `adapter.type` is still `mock`, `PAYPAL_CLIENT_ID` switches the default rail to `paypal` (unless `LITHIC_API_KEY` is also set).

7. Ask your agent to buy something from `pdfocr.io` for under $20. It calls `submit_purchase_intent`, which auto-approves, then `send_payment`. Sign in to [sandbox.paypal.com](https://www.sandbox.paypal.com) as the personal account to see the money arrive. Ask for $80 and the purchase pauses for your approval in Slack, Discord or the terminal first.

## Venmo

Set `wallet: VENMO` and `type: PHONE` with a US phone number as the `receiver`. Venmo payouts are US-only and USD-only.

## Going live

Use a live app's credentials and set `adapter.paypal.environment: production`. Your PayPal business account must be approved for Payouts, and it pays from its own balance.

## Limits

- Payouts are one-off, so a recurring intent on this rail is refused. Route subscriptions to a card rail with `routes`.
- PayPal reports a payout as `PENDING` at first. Calling `send_payment` again on a paid intent refreshes the status (`SUCCESS`, `UNCLAIMED` and so on) without paying again.
- Real-time authorization (`jit`) is for cards and doesn't apply here. The payee directory does the job of merchant locking.
