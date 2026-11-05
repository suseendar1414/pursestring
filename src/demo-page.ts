/** The single-page UI for /demo. No build step, no external scripts. */
export const DEMO_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PurseString demo</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #16181d; --muted: #5b6270; --line: #e3e6eb;
  --accent: #0b5fff; --ok: #12805c; --warn: #b25e00; --bad: #c62828;
  --agent: #6d28d9; --ps: #0b5fff; --pp: #003087; --human: #12805c;
  --code: #f0f2f5;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1115; --panel: #171a21; --text: #e8eaee; --muted: #9aa3b2; --line: #2a2f3a;
    --accent: #6b9bff; --ok: #3ec28f; --warn: #f0a24a; --bad: #ff6b6b;
    --agent: #b392ff; --ps: #6b9bff; --pp: #7fa8ff; --human: #3ec28f; --code: #11141a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding: 20px 16px 8px; max-width: 1200px; margin: 0 auto; }
h1 { margin: 0; font-size: 22px; }
header p { margin: 6px 0 0; color: var(--muted); max-width: 760px; }
.pill { display: inline-block; font-size: 12px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--line); margin-top: 10px; margin-right: 6px; }
.pill.live { border-color: var(--ok); color: var(--ok); }
main { max-width: 1200px; margin: 0 auto; padding: 8px 16px 40px; display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 16px; }
@media (max-width: 860px) { main { grid-template-columns: minmax(0, 1fr); } }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 16px; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 10px; }
button { font: inherit; cursor: pointer; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 8px 12px; }
button:hover { border-color: var(--accent); }
button:disabled { opacity: .5; cursor: wait; }
.scenario { display: block; width: 100%; text-align: left; margin-bottom: 8px; }
.approve { background: var(--ok); border-color: var(--ok); color: #fff; }
.deny { background: transparent; border-color: var(--bad); color: var(--bad); }
.card { border: 1px solid var(--warn); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.card .row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.muted { color: var(--muted); font-size: 13px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
td, th { text-align: left; padding: 6px 4px; border-top: 1px solid var(--line); vertical-align: top; overflow-wrap: break-word; }
th, td.st, td.num { white-space: nowrap; }
#intents { overflow-x: auto; }
th { color: var(--muted); font-weight: 600; border-top: 0; }
.st { font-weight: 600; }
.st.paid, .st.executed, .st.approved { color: var(--ok); }
.st.pending_approval { color: var(--warn); }
.st.denied, .st.expired { color: var(--bad); }
#log { max-height: 75vh; overflow-y: auto; }
.entry { border-left: 3px solid var(--line); padding: 4px 0 4px 10px; margin-bottom: 8px; }
.entry .who { font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.entry.agent { border-color: var(--agent); } .entry.agent .who { color: var(--agent); }
.entry.pursestring { border-color: var(--ps); } .entry.pursestring .who { color: var(--ps); }
.entry.paypal { border-color: var(--pp); } .entry.paypal .who { color: var(--pp); }
.entry.human { border-color: var(--human); } .entry.human .who { color: var(--human); }
details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
pre { background: var(--code); padding: 8px; border-radius: 6px; overflow-x: auto; font-size: 12px; margin: 4px 0 0; }
.toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
</style>
</head>
<body>
<header>
  <h1>PurseString: guardrails for AI agents that spend money on PayPal</h1>
  <p>Pick something for the agent to do. It makes real MCP tool calls to a real PurseString server. Policy decides what runs, what waits for you and what's refused. You're the human approver.</p>
  <span id="mode" class="pill">loading…</span><span class="pill">Refunds: simulated PayPal MCP server</span>
</header>
<main>
  <div>
    <section>
      <h2>Give the agent a task</h2>
      <div id="scenarios"></div>
    </section>
    <section>
      <h2>Waiting for you</h2>
      <div id="pending"><p class="muted">Nothing is waiting. Try the $80 purchase or the $120 refund.</p></div>
    </section>
    <section>
      <div class="toolbar"><h2>Every intent</h2><button id="reset" title="Clear the demo state">Reset demo</button></div>
      <div id="intents"></div>
    </section>
  </div>
  <section>
    <h2>Live log: the agent's MCP calls, PurseString's decisions, PayPal's answers</h2>
    <div id="log"></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let busy = false, lastLog = -1;

async function api(path, method = "GET") {
  const r = await fetch(path, { method });
  const body = await r.json();
  if (!r.ok && body.message) alert(body.message);
  return body;
}

function render(s) {
  if (!s || !s.intents) return;
  $("mode").textContent = s.live_paypal ? "Payouts: live PayPal sandbox" : "Payouts: simulated (no PayPal keys)";
  $("mode").className = "pill" + (s.live_paypal ? " live" : "");
  if (!$("scenarios").childElementCount) {
    $("scenarios").innerHTML = s.scenarios.map((x) => '<button class="scenario" data-run="' + esc(x.id) + '">' + esc(x.title) + "</button>").join("");
  }
  const pending = s.intents.filter((i) => i.status === "pending_approval");
  $("pending").innerHTML = pending.length
    ? pending.map((i) =>
        '<div class="card"><div><strong>' + esc(i.agent_id) + "</strong> wants to <strong>" + esc(i.what) + "</strong> · " +
        esc(i.amount.toFixed(2)) + " " + esc(i.currency) + '</div><div class="muted">' + esc(i.goal) + '</div><div class="muted">Why it paused: ' +
        esc(i.summary) + '</div><div class="row"><button class="approve" data-decide="approve" data-id="' + esc(i.intent_id) +
        '">Approve</button><button class="deny" data-decide="deny" data-id="' + esc(i.intent_id) + '">Deny</button></div></div>').join("")
    : '<p class="muted">Nothing is waiting. Try the $80 purchase or the $120 refund.</p>';
  $("intents").innerHTML = s.intents.length
    ? "<table><tr><th>Agent</th><th>Action</th><th>Amount</th><th>Status</th><th>Detail</th></tr>" +
      s.intents.slice().reverse().map((i) =>
        "<tr><td>" + esc(i.agent_id) + "</td><td>" + esc(i.what) + '</td><td class="num">' + esc(i.amount.toFixed(2)) + " " + esc(i.currency) +
        '</td><td class="st ' + esc(i.status) + '">' + esc(i.status.replace("_", " ")) + "</td><td>" +
        esc(i.payment ? "PayPal " + i.payment.id + " (" + i.payment.status + ") to " + i.payment.to : i.approved_by || i.denied_by || "") + "</td></tr>").join("") +
      "</table>"
    : '<p class="muted">No intents yet.</p>';
  if (s.log.length !== lastLog) {
    lastLog = s.log.length;
    $("log").innerHTML = s.log.slice().reverse().map((e) =>
      '<div class="entry ' + esc(e.actor) + '"><span class="who">' + esc(e.actor) + "</span> " + esc(e.text) +
      (e.data === undefined ? "" : "<details><summary>details</summary><pre>" + esc(JSON.stringify(e.data, null, 2)) + "</pre></details>") +
      '<div class="muted">' + esc(new Date(e.ts).toLocaleTimeString()) + "</div></div>").join("");
  }
  document.querySelectorAll("button[data-run], button[data-decide], #reset").forEach((b) => (b.disabled = busy));
}

async function act(path) {
  busy = true; render(window.__s);
  try { const s = await api(path, "POST"); if (s.intents) window.__s = s; } finally { busy = false; render(window.__s); }
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b || busy) return;
  if (b.dataset.run) act("/demo/api/run/" + b.dataset.run);
  else if (b.dataset.decide) act("/demo/api/intents/" + b.dataset.id + "/" + b.dataset.decide);
  else if (b.id === "reset") act("/demo/api/reset");
});

async function poll() {
  try { window.__s = await api("/demo/api/state"); render(window.__s); } catch {}
}
poll();
setInterval(poll, 2000);
</script>
</body>
</html>
`;
