# Test real-time charge approval with Cloudflare Tunnel

Lithic will ask PurseString "approve this charge?" every time a sandbox card is charged. You need three terminal windows and your Lithic **sandbox** API key. Keep the key out of chat, screenshots and commits.

Commands are for macOS/Linux. On Windows PowerShell, write `$env:NAME="value"` instead of `export NAME=value`.

## 1. Install cloudflared

```bash
brew install cloudflared                      # macOS
# Windows: winget install --id Cloudflare.cloudflared
```

No Cloudflare account is needed for a quick tunnel.

## 2. Get Lithic's signing secret (terminal 1)

```bash
export LITHIC_API_KEY=your-sandbox-key
curl -s https://sandbox.lithic.com/v1/auth_stream/secret -H "Authorization: $LITHIC_API_KEY"
```

It prints something like `{"secret":"whsec_..."}`. Copy the value inside the quotes. This is how PurseString knows a request really comes from Lithic.

## 3. Start PurseString as a web server (terminal 1)

```bash
export LITHIC_WEBHOOK_SECRET=the-secret-from-step-2
export PURSESTRING_TOKEN=$(openssl rand -hex 24)
npx -y github:suseendar1414/pursestring serve --http
```

`PURSESTRING_TOKEN` matters: the tunnel makes the server public, and the token stops strangers from using its purchase tools. Leave this window running.

## 4. Open the tunnel (terminal 2)

```bash
cloudflared tunnel --url http://localhost:8787
```

It prints an address like `https://random-words.trycloudflare.com`. Check it from terminal 3:

```bash
curl https://random-words.trycloudflare.com/healthz
```

You should see `"rail":"lithic"`. Leave terminal 2 running too.

## 5. Tell Lithic to ask PurseString (terminal 3)

```bash
export LITHIC_API_KEY=your-sandbox-key
curl -s -X POST https://sandbox.lithic.com/v1/responder_endpoints \
  -H "Authorization: $LITHIC_API_KEY" -H "Content-Type: application/json" \
  -d '{"type":"AUTH_STREAM_ACCESS","url":"https://random-words.trycloudflare.com/jit/lithic"}'
```

Use your own tunnel address, ending in `/jit/lithic`.

## 6. Get a fresh card from Claude

In Claude Desktop, in a new chat:

> Use PurseString to buy $12 of OCR credits at pdfocr.io for task lithic-2. I tried pypdf first and it returned empty text. It's a one-time purchase.

The card closes after 10 minutes, so do step 7 straight away.

## 7. Charge it from Lithic

Open the new card in the Lithic dashboard and simulate a $12 charge. Or from terminal 3, with the card number Claude showed you:

```bash
curl -s -X POST https://sandbox.lithic.com/v1/simulate/authorize \
  -H "Authorization: $LITHIC_API_KEY" -H "Content-Type: application/json" \
  -d '{"pan":"CARD_NUMBER","amount":1200,"descriptor":"PDFOCR.IO"}'
```

Then try another $12 charge on the same card.

## 8. See PurseString's answers

```bash
npx -y github:suseendar1414/pursestring log -n 5
```

You should see `jit_authorization` entries: the first $12 `approved`, the second `already_used`, each with how many milliseconds it took. That entry is the proof that Lithic asked PurseString. Lithic's own card limits can decline some charges before asking, so a decline with no log entry came from Lithic, not PurseString.


## 9. Switch it off afterwards

While Lithic is set to ask PurseString, every sandbox charge is declined if the tunnel is down. When you're done:

```bash
curl -s -X DELETE "https://sandbox.lithic.com/v1/responder_endpoints?type=AUTH_STREAM_ACCESS" \
  -H "Authorization: $LITHIC_API_KEY"
```

Then press Ctrl+C in terminals 1 and 2. The quick-tunnel address changes every time, so repeat step 5 if you test again.

| Problem | Fix |
|---|---|
| `healthz` works locally but not through the tunnel | Wait 30 seconds after cloudflared prints the address, then retry. |
| Every charge is declined with no log entry | Check the step 5 address ends in `/jit/lithic`, and that terminals 1 and 2 are still running. |
| Still declined with no log entry, and both terminals are running | Lithic can take a few minutes to start signing requests after step 2, and PurseString refuses unsigned ones. Wait and retry. If it persists, [open an issue](https://github.com/suseendar1414/pursestring/issues/new/choose). |
| `unknown_card` in the log | The card was issued before this setup or in another folder. Get a fresh card (step 6). |
