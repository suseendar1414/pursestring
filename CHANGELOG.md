# Changelog

## Unreleased

### Explain and re-check every decision

- **Policy hash on every audit entry.** Each decision-log line now carries `policy_hash`, the SHA-256 of the policy in force, and `pursestring policy` prints it, so any approval or denial can be traced to the exact rules that made it, even after `policies.yaml` changes. Each intent stores its `evidence`: the policy hash, when it was ruled on, the vendor, the rail, and the payee or x402 `payTo` it would pay, with where each came from. Approval messages now show who a payout or x402 payment goes to. The hash chain and HMAC mode are unchanged, and old logs still verify.
- **Re-check at execution time.** Right before a card is issued, a payout is sent, an x402 authorization is signed or re-sent, or a governed PayPal tool runs, PurseString re-checks the facts the approval was based on. If the policy changed, the intent is ruled on again and a deny wins over the earlier approval. A swapped or removed payee, a changed rail route or an unpinned x402 `payTo` also refuses it. Refusals deny the intent, log `execution_recheck_failed` and return `stale_evidence`; nothing is paid.

### Upgrading

- Intents approved before this version have no stored evidence. They are re-checked against the current policy only.
- An approved intent whose vendor you remove from the allowlist, or whose payee you change, can no longer be paid. Submit a new intent with a new task_id.

## 0.2.0 (2026-11-21)

⚠️ Still alpha. Start with low limits. Rails marked "stub-tested" have only been run against recorded or stubbed API responses, never a live account.

### Stop a runaway agent

- **Kill switch** (#38). Halt one agent or all of them with `pursestring halt`, or over HTTP with `POST /halt`. A halt denies new intents, blocks cards and payouts for intents that were already approved, and declines live card authorizations. Resuming needs the one-time code sent to Slack or Discord when approval codes are on, so an agent with a shell can't switch itself back on.
- **Loop detection** (#38, on by default). The 5th near-identical intent from one agent in 10 minutes (same vendor, amount within 10%) halts that agent and posts the resume command.
- **Velocity limit** (#41, on by default). `hard_limits.velocity` denies the 21st new intent from one agent in 10 minutes, across any vendor or rail. It is checked under the same lock as the budget check. Retries with the same idempotency key don't count.

### New ways to pay

- **x402 pay-per-request** (#38). A new `x402_fetch` tool pays for HTTP resources that answer `402 Payment Required`, in USDC. Each payment is a normal purchase intent and goes through every policy rule. Off by default, testnet by default, and not yet run against a live facilitator.
- **Stripe Connect, RazorpayX and Modern Treasury payouts** (#38). Pay a vendor account pinned in `policies.yaml`; the agent never supplies account details. Stub-tested only.
- **Airwallex payouts** (#39). A new `airwallex_payouts` rail pays a beneficiary already saved in Airwallex, pinned per vendor in `policies.yaml` (`airwallex_beneficiary`). Built from Airwallex's own open-source API spec, SDK and AI tooling, but stub-tested only: not yet run against a live Airwallex account. The default transfer `reason` and the 18-character bank `reference` are unverified for some countries; both can be changed in `policies.yaml`.
- **Airwallex cards, hardened** (#39). The card rail now pins the Airwallex API version, waits for a new card to become active before reading its details, and recovers the card if a retried create is refused. Still stub-tested only.
- **PayPal and Venmo payouts** (#27). Pay a vendor's PayPal account on file. Tested on the PayPal sandbox.
- **Guardrails for PayPal's own MCP server** (#27). Read-only PayPal tools pass through; refunds, dispute acceptance and cancellations need policy or a human.

### Money and audit correctness

- Money is counted in whole minor units, so totals never drift (#31).
- Card holds are tracked separately from captures (#32).
- Merchant refunds are recorded and give the budget back (#26).
- Card charges are bound to the approved merchant by default (#25).
- The audit log is a hash chain, checked with `pursestring verify-log`. Set `PURSESTRING_AUDIT_KEY` to make it an HMAC chain (#30).

### Packaging and docs

- Official MCP Registry metadata (`server.json`) and an MCPB bundle manifest (#37). The bundle manifest now lists `x402_fetch`.
- A demo console page and Render blueprint for self-hosting a demo (#27, #28, #29, #33, #34). Hosted demo links were removed from the README (#40).

### Upgrading from 0.1.0

- The velocity limit and loop detection are on by default. An agent that makes more than 20 purchase requests in 10 minutes, or repeats the same purchase 5 times, will now be denied or halted. Raise `hard_limits.velocity.max_intents` or `kill_switch.loop_detection.max_similar`, or set `enabled: false`, if your agents legitimately buy in bursts.
- Card charges must now match the approved merchant (`require_merchant_match: true`). Set it to `false` for merchants whose card descriptor doesn't include their name.
- Airwallex card users: set `adapter.airwallex.created_by` to the full legal name of the person requesting cards (Airwallex asks for this; it defaults to "PurseString").

## 0.1.0 (2026-10-27)

First public alpha. MCP server over stdio and Streamable HTTP with OAuth, intent checks, duplicate-charge protection, risk-based human approval, single-use capped Lithic cards, an append-only audit log and `policies.yaml`.
