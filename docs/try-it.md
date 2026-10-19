# Try PurseString in 10 minutes

This walks you through testing PurseString with Claude, using test cards. No money moves and no bank account is involved.

## What you need

| | Needed? | Why |
|---|---|---|
| **Node.js 20 or newer** | Yes | Runs the server. Check with `node -v`; get it from [nodejs.org](https://nodejs.org). |
| **Claude Desktop** or **Claude Code** | Yes | The AI agent that will try to buy things. |
| A terminal | Yes | To approve purchases and read the log. |
| A Slack incoming webhook | Optional | To see approval requests arrive in Slack. Without it, they're printed in the server log and you approve from the terminal. |
| A Lithic sandbox API key | Optional | Real sandbox Visa cards instead of test numbers. Not needed for this guide. |

## 1. Create a policy

The policy decides what the agent may buy. This writes an example one into `~/.pursestring`, where PurseString finds it automatically:

```bash
mkdir -p ~/.pursestring && cd ~/.pursestring
npx -y github:suseendar1414/pursestring init
```

On Windows, use `%USERPROFILE%\.pursestring` instead of `~/.pursestring`.

The example allows small one-time purchases at `pdfocr.io`, `openai.com`, `anthropic.com` and `*.github.com`, and blocks `giftcards.com`. The first `npx` run downloads and builds PurseString, so give it a minute.

## 2. Connect it to Claude

**Claude Desktop:** open *Settings → Developer → Edit Config*, add this, and restart Claude Desktop:

```json
{
  "mcpServers": {
    "pursestring": {
      "command": "npx",
      "args": ["-y", "github:suseendar1414/pursestring"]
    }
  }
}
```

In a new chat, the tools menu should now list four PurseString tools.

**Claude Code:** run `claude mcp add pursestring -- npx -y github:suseendar1414/pursestring`, then start `claude`.

## 3. Try these prompts

Use a new chat and send them in order.

**A. A small purchase that's approved automatically**

> Use PurseString to buy $12 of OCR credits at pdfocr.io for task demo-1. I tried pypdf first and it returned empty text. It's a one-time purchase.

You should see: status `approved`, and a test card number starting with `4000` capped at $12 that closes after 10 minutes.

**B. The double-charge retry**

> The checkout page timed out. Try the exact same purchase again.

You should see: the **same card number** and "Duplicate prevented: ... No new transaction was created." No second card is issued.

**C. A subscription that waits for you**

> Use PurseString to subscribe to pdfocr.io Pro for $15 a month for task demo-2. I tried pypdf first and it returned empty text.

You should see: status `pending_approval`. Claude is told to wait and not to pay another way. In your terminal:

```bash
npx -y github:suseendar1414/pursestring pending
npx -y github:suseendar1414/pursestring approve <intent_id>
```

Then tell Claude: *"I approved it. Check the status and get the card."* You should get a recurring card capped at $15 a month (on a real rail like Lithic it is also locked to that merchant).

**D. A blocked vendor**

> Use PurseString to buy a $5 gift card at giftcards.com for task demo-3. Nothing else works for this.

You should see: status `denied`. A blocklisted vendor can't be approved, even by a human.

## 4. Read the audit log

Every decision, with the agent's goal and every rule that was checked, is in the log:

```bash
npx -y github:suseendar1414/pursestring log -n 10
```

## 5. Optional extras

**Slack approvals.** Create an incoming webhook (Slack → *Apps* → *Incoming Webhooks*) and add it to the config, then restart Claude Desktop:

```json
"env": { "SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/..." }
```

Prompt C will now post an approval request in your Slack channel.

**A merchant charging the card.** Within 10 minutes of prompt A (after that the card has closed), see what happens when the merchant charges it:

```bash
npx -y github:suseendar1414/pursestring simulate-charge <intent_id> 12    # APPROVED
npx -y github:suseendar1414/pursestring simulate-charge <intent_id> 12    # DECLINED: already used
```

**Real-time approval on Lithic.** With a Lithic sandbox key, Lithic can ask PurseString to approve each charge as it happens. [real-time-approval.md](real-time-approval.md) sets this up from your laptop with a free Cloudflare tunnel.

**Change the rules.** Edit `~/.pursestring/policies.yaml` (for example, add a vendor to `allowlist`) and restart Claude Desktop. See [policies.md](policies.md).

## If something doesn't work

| Problem | Fix |
|---|---|
| No PurseString tools in Claude Desktop | Claude Desktop may not find `npx`. Run `which npx` (macOS/Linux) or `where npx` (Windows) and put that full path in `"command"`. The server log is in `~/Library/Logs/Claude/mcp-server-pursestring.log` on macOS and `%APPDATA%\Claude\logs` on Windows. |
| Everything goes to `pending_approval` | The vendor isn't on the allowlist, the amount is $20 or more, or no alternatives were given. Ask Claude to run `check_policy_compliance` to see which rule failed. |
| `pending` shows nothing | The CLI and Claude must use the same folder. Both use `~/.pursestring` unless you set `PURSESTRING_HOME`. |
| Claude pays without using PurseString | Say "use PurseString" in the prompt. |

Questions? [Open an issue](https://github.com/suseendar1414/pursestring/issues/new/choose).
