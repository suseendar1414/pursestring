# Policy reference

PurseString reads one YAML file, `policies.yaml`. Every key is optional; anything you leave out uses the default shown here. Start from the commented example with `pursestring init`, and check what's active with `pursestring policy`.

## How a decision is made

Every rule is evaluated for every intent and recorded in the audit log, pass or fail. Then:

1. If any **deny** rule fails, the intent is **denied**. Nobody can approve it.
2. Otherwise, if any **approval** rule fails, the intent is **paused for a human**.
3. Otherwise it's **auto-approved** and a card can be issued.

| Rule | Fails when | Effect |
|---|---|---|
| `hard_limits.max_amount` | amount is over the hard cap | deny |
| `vendors.blocklist` | vendor matches the blocklist | deny |
| `currency` | intent currency differs from the policy currency | deny |
| `intent.task_goal` | goal is shorter than `intent.min_goal_length` | human |
| `intent.alternatives_attempted` | no alternatives listed (if `require_alternatives`) | human |
| `require_approval.recurring` | `is_recurring: true` | human |
| `require_approval.over_amount` | amount is over the approval threshold | human |
| `vendors.allowlist` | vendor isn't allowlisted (if `non_allowlisted_vendor`) | human |
| `hard_limits.per_agent_daily_budget` | this spend would take the agent over today's budget | human |
| `auto_approve` | spend falls outside the auto-approve envelope | human |

Auto-approvals are checked again against the daily budget when the card is requested, so two quick purchases can't both slip under it. After a card is issued, every charge on it is checked again in real time; see [just-in-time authorization](how-it-works.md#just-in-time-authorization).

## Full schema with defaults

```yaml
version: 1
currency: USD                     # one currency per policy

vendors:
  allowlist: []                   # e.g. [openai.com, "*.github.com"]
  blocklist: []

auto_approve:
  max_amount: 20                  # strictly under this
  require_allowlisted_vendor: true
  allow_recurring: false

require_approval:
  over_amount: 50
  recurring: true
  non_allowlisted_vendor: true

hard_limits:
  max_amount: 1000
  per_agent_daily_budget: 200     # sum of cards issued to one agent_id since 00:00 UTC

intent:
  require_alternatives: true
  min_goal_length: 15

idempotency:
  window_minutes: 30

approvals:
  ttl_minutes: 1440               # pending/approved intents expire after this
  # require_code: true            # terminal approvals need the code sent to Slack/Discord (default: on when either is set)
  slack_approvers: []             # Slack user IDs allowed to press Approve; empty = anyone in the channel

notifications:
  slack_webhook_url:              # or SLACK_WEBHOOK_URL
  discord_webhook_url:            # or DISCORD_WEBHOOK_URL

adapter:
  type: mock                      # default rail: mock | lithic | privacy | airwallex | highnote | marqeta | amex | network_token | ach
  lithic:
    environment: sandbox          # sandbox | production
  airwallex:
    environment: sandbox          # sandbox (Airwallex demo) | production
    cardholder_id:                # or AIRWALLEX_CARDHOLDER_ID

routes: []                        # see "Rail routing" below

cards:
  ttl_minutes: 10                 # single-use cards close this long after issue

jit:
  enabled: true                   # answer the issuer's real-time authorization webhook
  tolerance_percent: 0            # allow this much over the approved amount
  require_merchant_match: true    # decline when the descriptor doesn't mention the vendor
```

## Rail routing

Each route can match on `min_amount` (inclusive), `max_amount` (exclusive), `recurring` and `vendors` (allowlist syntax). The first route whose conditions all match picks the rail; with no match, `adapter.type` is used.

```yaml
routes:
  - rail: ach                     # big B2B invoices where cards aren't accepted
    min_amount: 1000
  - rail: amex                    # the company's corporate Amex line
    vendors: ["*.salesforce.com"]
  - rail: lithic                  # everything else under $500 on BaaS virtual cards
    max_amount: 500
```

`privacy` issues [Privacy.com](https://privacy.com) cards funded from the user's own bank account or debit card; set `PRIVACY_API_KEY`. Privacy.com has no sandbox, so these are real cards, and it only takes whole-dollar limits, so a $12.40 approval gets a $13 cap. It also has no real-time authorization hook, so the `jit` checks don't apply to it.

`airwallex` issues [Airwallex Issuing](https://www.airwallex.com/docs/issuing) virtual cards, which work for businesses outside the US (Airwallex issues in 50+ countries, including the UK, the EEA, Australia, Canada, Hong Kong, Singapore and New Zealand). Set `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY` and `AIRWALLEX_CARDHOLDER_ID`; the key needs Issuing and card-details access, and the cardholder must be `READY`. Cards are capped in the purchase's own currency, so a EUR approval gets a EUR limit. One-time spends get a single-use card; recurring spends get a multi-use card with a monthly cap, which unlike Lithic is not locked to one merchant. `adapter.airwallex.environment` defaults to `sandbox`, which is Airwallex's demo environment. Airwallex's real-time authorization (Remote Authorization) isn't wired up yet, so the `jit` checks don't apply to it.

`highnote`, `marqeta`, `amex`, `network_token` and `ach` are planned: you can route to them now, and a purchase that lands there stops with a link to the tracking issue rather than using another rail.

## Vendor matching

Vendors are compared as domains. `https://www.PDFocr.io/checkout` becomes `pdfocr.io` before matching.

| Pattern | Matches | Doesn't match |
|---|---|---|
| `openai.com` | `openai.com`, `www.openai.com` | `api.openai.com`, `evilopenai.com` |
| `*.openai.com` | `openai.com`, `api.openai.com`, `a.b.openai.com` | `evilopenai.com` |

## Idempotency

The key is `SHA256(agent_id ␟ task_id ␟ normalized vendor ␟ amount to the cent)`, with a separator between fields so different splits can't collide. Within `idempotency.window_minutes`:

- `submit_purchase_intent` with the same key returns the original intent (and doesn't ping Slack again).
- `request_ephemeral_card` for an intent that already has a card returns that same card.

After the window, a card that was already issued is never re-issued for the same intent. A genuinely new purchase needs a new `task_id`.

## Recipes

**Let agents buy API credits freely, but nothing else**

```yaml
vendors:
  allowlist: [openai.com, anthropic.com, "*.together.ai"]
auto_approve:
  max_amount: 50
require_approval:
  over_amount: 50
```

**Everything goes to a human (pilot mode)**

```yaml
auto_approve:
  max_amount: 0
```

**Allow known SaaS subscriptions without a human**

```yaml
vendors:
  allowlist: [github.com, vercel.com]
auto_approve:
  max_amount: 25
  allow_recurring: true
require_approval:
  recurring: false
```

Approved recurring spend always gets a merchant-locked card with a monthly cap.

**Tight budget for an experimental agent**

```yaml
hard_limits:
  max_amount: 100
  per_agent_daily_budget: 30
```

Have a policy others would find useful? Add it here in a PR.
