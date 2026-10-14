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

Auto-approvals are checked again against the daily budget when the card is requested, so two quick purchases can't both slip under it.

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

notifications:
  slack_webhook_url:              # or SLACK_WEBHOOK_URL
  discord_webhook_url:            # or DISCORD_WEBHOOK_URL

adapter:
  type: mock                      # mock | lithic
  lithic:
    environment: sandbox          # sandbox | production
```

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
