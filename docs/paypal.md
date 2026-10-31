# PayPal and Venmo payouts

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
