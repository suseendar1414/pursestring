# Use PurseString from ChatGPT

ChatGPT connects to MCP servers through **developer mode**, which is available on Plus, Pro, Business, Enterprise and Education plans on the web. ChatGPT can't start a program on your computer, so PurseString runs as a web server at a public HTTPS address, and ChatGPT signs in to it with OAuth. Only someone who knows your admin token can approve that sign-in.

> [!NOTE]
> OAuth sign-in is tested with the official MCP SDK client but not yet end to end inside ChatGPT. If a step doesn't match what you see, please [open an issue](https://github.com/suseendar1414/pursestring/issues/new/choose).

The same setup works for any remote MCP client that signs in with OAuth, such as custom connectors on claude.ai.

You need three terminal windows. Commands are for macOS/Linux; on Windows PowerShell write `$env:NAME="value"` instead of `export NAME=value`.

## 1. Open a tunnel (terminal 1)

```bash
brew install cloudflared            # once; Windows: winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8787
```

Copy the address it prints, like `https://random-words.trycloudflare.com`, and leave the window running. For a permanent setup, run the [Docker image](deploy.md#2-docker) behind your own domain instead.

## 2. Start PurseString with sign-in turned on (terminal 2)

```bash
export PURSESTRING_PUBLIC_URL=https://random-words.trycloudflare.com
export PURSESTRING_ADMIN_TOKEN=$(openssl rand -hex 24)
echo "Your admin token: $PURSESTRING_ADMIN_TOKEN"    # you'll paste this once, in step 4
export LITHIC_API_KEY=your-lithic-key                # optional; without it you get test cards
npx -y github:suseendar1414/pursestring serve --http
```

It should print `OAuth sign-in on: add https://random-words.trycloudflare.com/mcp as a connector`. With `PURSESTRING_PUBLIC_URL` set, every request to `/mcp` needs a token, so the public address isn't open to strangers.

## 3. Add PurseString to ChatGPT

1. In ChatGPT on the web, go to **Settings → Apps → Advanced settings** and turn on **Developer mode**.
2. Click **Create app**.
3. Name it `PurseString`, set the MCP server URL to your address plus `/mcp` (for example `https://random-words.trycloudflare.com/mcp`), and choose **OAuth** for authentication.

## 4. Approve the sign-in

ChatGPT opens a PurseString page that asks whether to connect it. Paste the admin token from step 2 and click **Allow**. You're sent back to ChatGPT, and PurseString's four tools appear in the app's details.

Five wrong tokens in a row lock the page for 10 minutes.

## 5. Try it

In a new chat, choose **Developer mode** from the **+** menu, select PurseString, and send:

> Use the PurseString app to buy $12 of OCR credits at pdfocr.io for task chatgpt-1. I tried pypdf first and it returned empty text. It's a one-time purchase. Get the card and show only its last four digits.

ChatGPT asks you to confirm each PurseString step. Then send the retry from the [try-it guide](try-it.md) to see the duplicate block.

## Signing out

```bash
npx -y github:suseendar1414/pursestring oauth revoke
```

This signs out every connected app, including on a running server. Changing `PURSESTRING_ADMIN_TOKEN` stops new sign-ins but doesn't end existing ones, so run `oauth revoke` too.

## How it works

PurseString includes a small OAuth 2.1 authorization server for its one owner, following the [MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization):

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | Tells clients that `/mcp` is protected and where to sign in (RFC 9728) |
| `/.well-known/oauth-authorization-server` | Sign-in endpoints and capabilities (RFC 8414) |
| `POST /oauth/register` | Dynamic client registration (RFC 7591); redirect addresses must be https, or http on localhost |
| `/oauth/authorize` | The consent page; needs `PURSESTRING_ADMIN_TOKEN` |
| `POST /oauth/token` | Authorization code with PKCE (S256 only), and refresh tokens that rotate on use |

Access tokens last 1 hour and refresh tokens 30 days. Tokens and client secrets are stored only as SHA-256 hashes, in `$PURSESTRING_HOME/oauth.json`. A static `PURSESTRING_TOKEN` keeps working alongside OAuth, for scripts and Claude Code.

| Problem | Fix |
|---|---|
| ChatGPT says it can't connect | Check `https://<your-address>/.well-known/oauth-protected-resource` opens in a browser, and that the URL you added ends in `/mcp`. |
| "Unknown app" on the consent page | The server's address changed, or `oauth revoke` ran. Delete the app in ChatGPT and create it again. |
| It worked, then stopped after a restart | Quick-tunnel addresses change every time. Update `PURSESTRING_PUBLIC_URL` and the app's URL, or use a fixed domain. |
