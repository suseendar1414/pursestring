# Deploying PurseString

PurseString runs in two modes:

| Mode | Use it when | Transport |
|---|---|---|
| **Local (stdio)** | One developer, an MCP client on the same machine (Claude Desktop, Claude Code, Cursor, Windsurf) | stdin/stdout |
| **Server (HTTP)** | Agents running in containers, CI, or on other machines; a team sharing one policy | Streamable HTTP at `/mcp` |

Both modes use the same policy file and keep their state in one directory (`PURSESTRING_HOME`, default `~/.pursestring`):

```
~/.pursestring/
├── policies.yaml     # optional, if you don't keep it next to your project
├── state.json        # intents, approvals, card references (never card numbers)
└── decisions.jsonl   # the audit log, one JSON object per decision
```

**Contents**

- [Requirements](#requirements)
- [1. Local with an MCP client](#1-local-with-an-mcp-client)
- [2. Docker](#2-docker)
- [3. From source](#3-from-source)
- [Slack and Discord approvals](#slack-and-discord-approvals)
- [Approving over HTTP](#approving-over-http)
- [Lithic virtual cards](#lithic-virtual-cards)
- [Environment variables](#environment-variables)
- [Production checklist](#production-checklist)
- [Troubleshooting](#troubleshooting)

## Requirements

- Node.js 20 or newer (for `npx` and source installs), **or** Docker
- Optional: a Slack or Discord incoming webhook, a Lithic API key

## 1. Local with an MCP client

### Claude Desktop

Open *Settings → Developer → Edit Config* and add:

```json
{
  "mcpServers": {
    "pursestring": {
      "command": "npx",
      "args": ["-y", "github:suseendar1414/pursestring"],
      "env": {
        "PURSESTRING_POLICY": "/absolute/path/to/policies.yaml",
        "SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/..."
      }
    }
  }
}
```

Restart Claude Desktop. You should see four PurseString tools in the tools menu.

### Claude Code

```bash
claude mcp add pursestring \
  -e PURSESTRING_POLICY=$PWD/policies.yaml \
  -e SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
  -- npx -y github:suseendar1414/pursestring
```

### Cursor

Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all projects) with the same `mcpServers` block as Claude Desktop.

### Install the CLI

The approve/deny commands and the policy checker live in the same package:

```bash
npm i -g github:suseendar1414/pursestring
pursestring init          # writes a commented policies.yaml here
pursestring policy        # shows the active policy and where it was loaded from
pursestring pending       # intents waiting for a human
pursestring approve <id>  # or: pursestring deny <id> --note "use the free tier"
pursestring log -n 20     # latest audit log entries
```

The CLI and the MCP server share `PURSESTRING_HOME`, so an approval in your terminal unblocks the agent immediately.

## 2. Docker

The image runs the HTTP server on port 8787 as a non-root user, keeps state in the `/data` volume and reads the policy from `/config/policies.yaml`.

### docker compose (recommended)

```bash
git clone https://github.com/suseendar1414/pursestring.git
cd pursestring
cp examples/policies.yaml policies.yaml      # edit the allowlist
cp .env.example .env                         # set tokens and webhooks
docker compose up -d
curl http://localhost:8787/healthz           # {"ok":true,"version":"0.1.0","rail":"mock"}
```

The compose file binds to `127.0.0.1` only. Put a reverse proxy with TLS in front of it before exposing it to other machines.

### docker run

```bash
docker build -t pursestring .
docker run -d --name pursestring \
  -p 127.0.0.1:8787:8787 \
  -e PURSESTRING_TOKEN=agent-secret \
  -e PURSESTRING_ADMIN_TOKEN=admin-secret \
  -e SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
  -v $PWD/policies.yaml:/config/policies.yaml:ro \
  -v pursestring-data:/data \
  pursestring
```

CLI commands work inside the container:

```bash
docker exec pursestring pursestring pending
docker exec pursestring pursestring approve int_...
```

### Connecting an agent to the HTTP server

Any MCP client that speaks Streamable HTTP can connect to `http://<host>:8787/mcp`. Send `Authorization: Bearer $PURSESTRING_TOKEN` if you set one. In Claude Code:

```bash
claude mcp add --transport http pursestring http://localhost:8787/mcp \
  --header "Authorization: Bearer agent-secret"
```

For a stdio-only client, run the container in stdio mode instead:

```json
{
  "mcpServers": {
    "pursestring": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "PURSESTRING_TRANSPORT=stdio",
               "-v", "pursestring-data:/data", "pursestring"]
    }
  }
}
```

## 3. From source

```bash
git clone https://github.com/suseendar1414/pursestring.git
cd pursestring
npm install          # also builds dist/
npm test
node dist/index.js serve --http --port 8787
```

## Slack and Discord approvals

When an intent needs a human, PurseString posts the agent, task, goal, amount, vendor, the alternatives it tried, the rules that triggered, and the exact approve/deny command.

**Slack:** create an app at <https://api.slack.com/apps>, enable *Incoming Webhooks*, add one to your approvals channel, and set `SLACK_WEBHOOK_URL`.

**Discord:** *Channel settings → Integrations → Webhooks → New Webhook*, copy the URL, set `DISCORD_WEBHOOK_URL`.

You can set both. If neither is set, the request is printed to the server's stderr. Webhook failures are logged and never block the agent: the intent simply stays pending.

While an intent is pending, the agent is told not to buy another way and to call `get_intent_status` with `wait_seconds` (up to 300) to wait for your answer.

## Approving over HTTP

In HTTP mode, set `PURSESTRING_ADMIN_TOKEN` to enable a small approval API:

```bash
# list pending intents
curl -H "Authorization: Bearer $PURSESTRING_ADMIN_TOKEN" \
  "http://localhost:8787/intents?status=pending_approval"

# approve or deny
curl -X POST -H "Authorization: Bearer $PURSESTRING_ADMIN_TOKEN" \
  -d '{"by":"alice","note":"ok for one month"}' \
  http://localhost:8787/intents/int_.../approve
```

Without `PURSESTRING_ADMIN_TOKEN` the API is disabled.

## Lithic virtual cards

1. Sign up at <https://lithic.com> and copy your **sandbox** API key.
2. Set `LITHIC_API_KEY`. PurseString switches from the mock rail to Lithic automatically and uses the sandbox unless your policy says `adapter.lithic.environment: production`.
3. One-time spends get a `SINGLE_USE` card capped at the approved amount for one transaction. Approved recurring spends get a `MERCHANT_LOCKED` card with a monthly cap.

Card numbers come back to the agent in the tool result and are never written to `state.json` or the log; replays re-fetch the card from Lithic by its token. Your Lithic key needs access to card PAN/CVV for this to work.

To force a rail regardless of the policy file, set `PURSESTRING_ADAPTER=mock` or `PURSESTRING_ADAPTER=lithic`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PURSESTRING_HOME` | `~/.pursestring` (`/data` in Docker) | State and audit log directory |
| `PURSESTRING_POLICY` | `./policies.yaml`, then `$PURSESTRING_HOME/policies.yaml` | Policy file |
| `PURSESTRING_TRANSPORT` | `stdio` (`http` in Docker) | `http` runs the HTTP server without `--http` |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | HTTP bind address |
| `PURSESTRING_TOKEN` | unset | Bearer token required on `/mcp` |
| `PURSESTRING_ADMIN_TOKEN` | unset | Enables the approval API |
| `SLACK_WEBHOOK_URL` | unset | Slack approval requests |
| `DISCORD_WEBHOOK_URL` | unset | Discord approval requests |
| `LITHIC_API_KEY` | unset | Use Lithic cards |
| `PURSESTRING_ADAPTER` | from policy | Force `mock` or `lithic` |

## Production checklist

- [ ] Start on the Lithic **sandbox** and run your agent end to end before switching to production.
- [ ] Keep `vendors.allowlist` short and `auto_approve.max_amount` low. Widen them once the audit log shows what your agents actually buy.
- [ ] Set `PURSESTRING_TOKEN` and `PURSESTRING_ADMIN_TOKEN` to long random values, and serve HTTP only behind TLS.
- [ ] Back up the `/data` volume. `decisions.jsonl` is your audit trail.
- [ ] Run one PurseString instance per state directory. Several processes on one machine can share it safely (writes are locked), but don't put it on a network file system shared between hosts.
- [ ] Keep payment keys in your secret manager, not in `policies.yaml`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid policy: ...` on startup | The message names the bad key. Compare with [`examples/policies.yaml`](../examples/policies.yaml). |
| Tools don't appear in Claude Desktop | Check *Settings → Developer* for the server log. `npx` needs Node 20+ on your `PATH`. |
| Everything needs approval | Check the vendor is on the allowlist, the amount is under `auto_approve.max_amount`, and the agent listed `alternatives_attempted`. `check_policy_compliance` shows which rule failed. |
| No Slack message | Run with the webhook set and watch stderr for `notification failed`. |
| `Lithic did not return PAN/CVV` | Your Lithic key lacks card-data access. Ask Lithic to enable it, or use the mock rail. |
| `401 unauthorized` on `/mcp` | Send `Authorization: Bearer $PURSESTRING_TOKEN`. |

Still stuck? Ask in [Discord](https://discord.gg/YOUR_INVITE) or [open an issue](https://github.com/suseendar1414/pursestring/issues/new/choose).
