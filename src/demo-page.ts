/**
 * The single-page console for /demo. No build step, no external scripts. Everything it shows is live state from
 * this server's demo session: a scripted agent's real MCP calls and PurseString's real decisions.
 */
export const DEMO_PAGE = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#121a2a">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<title>PurseString console</title>
<style>
:root, :root[data-theme="light"] {
  --bg: #f6f8fa; --panel: #ffffff; --panel-2: #f6f8fa; --line: #e5e9ef; --line-2: #d6dce5;
  --text: #121826; --muted: #5d6676; --faint: #8b93a3;
  --accent: #178a62; --accent-ink: #ffffff; --accent-soft: #e6f6ef; --mint: #6fd0a6; --mint-2: #b5ead1;
  --good: #0ca30c; --good-ink: #006300; --warn: #e0a43a; --warn-ink: #8a5a00; --bad: #d03b3b; --bad-ink: #b42323;
  --human: #1f5fe0; --code: #f3f5f8; --shadow: none;
  --side: #121a2a; --side-text: #e9edf3; --side-muted: #9aa5b8; --side-line: #1d2739; --side-on: #1c2a36; --side-accent: #6fd8b0;
}
:root[data-theme="dark"] {
  --bg: #0d1320; --panel: #141c2c; --panel-2: #1a2336; --line: #232e43; --line-2: #2d3a52;
  --text: #e7ecf5; --muted: #95a0b4; --faint: #67738b;
  --accent: #4fd1a0; --accent-ink: #0b1a14; --accent-soft: rgba(79,209,160,.12); --mint: #4fbf8f; --mint-2: #2f7d5f;
  --good: #0ca30c; --good-ink: #3ecf5a; --warn: #fab219; --warn-ink: #fab219; --bad: #d03b3b; --bad-ink: #ff7a7a;
  --human: #6b9bff; --code: #0f1626; --shadow: none;
  --side: #0a101b; --side-text: #e9edf3; --side-muted: #8d98ac; --side-line: #172031; --side-on: #16242c; --side-accent: #6fd8b0;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.5 "Manrope", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.mono, .label, .card h2, .kpi .k, .tag, .crumb-time, .x-axis { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
button { font: inherit; color: inherit; cursor: pointer; }
a { color: var(--accent); }
.app { display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: 100vh; }

/* Sidebar */
.side { background: var(--side); color: var(--side-text); border-right: 1px solid var(--side-line); padding: 18px 14px; display: flex; flex-direction: column; gap: 18px; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; align-items: center; gap: 10px; padding: 0 6px; }
.logo { width: 30px; height: 34px; flex: none; color: var(--side-accent); }
.brand b { font-size: 16px; font-weight: 700; letter-spacing: .01em; }
.brand small { display: none; }
.label { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--side-muted); padding: 0 10px; margin: 18px 0 10px; }
nav { display: flex; flex-direction: column; gap: 2px; }
nav button { display: flex; align-items: center; gap: 10px; background: none; border: 0; padding: 11px 12px; border-radius: 8px; color: var(--side-muted); text-align: left; font-size: 14.5px; }
nav button:hover { background: var(--side-on); color: var(--side-text); }
nav button.on { background: var(--side-on); color: var(--side-accent); font-weight: 600; }
nav button svg { width: 14px; height: 14px; flex: none; }
.badge { margin-left: auto; min-width: 26px; padding: 0 6px; border-radius: 6px; background: #3a3220; color: #f3c769; font: 600 11px/22px "JetBrains Mono", ui-monospace, monospace; text-align: center; }
.badge.zero { background: var(--side-on); color: var(--side-muted); }
.side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: var(--side-muted); }
.side-foot a { color: var(--side-muted); }
.side .pill { border-color: var(--side-line); color: var(--side-muted); }
.side .ghost { background: transparent; border-color: var(--side-line); color: var(--side-muted); }
.side .ghost:hover { border-color: var(--side-accent); color: var(--side-text); }
.side-foot .row { display: flex; gap: 6px; }
.ghost { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; font-size: 12px; }
.ghost:hover { border-color: var(--accent); }

/* Main */
main { padding: 0 28px 48px; min-width: 0; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 26px 0 0; margin-bottom: 30px; flex-wrap: wrap; font-size: 12.5px; }
.crumb { color: var(--muted); }
.crumb b { color: var(--muted); font-weight: 400; }
.crumb-time { color: var(--muted); font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line-2); color: var(--muted); white-space: nowrap; }
.pill .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.pill.live { color: var(--good-ink); border-color: color-mix(in srgb, var(--good) 45%, transparent); }
.pill.live .dot { background: var(--good); box-shadow: 0 0 0 3px color-mix(in srgb, var(--good) 25%, transparent); }
h1 { font-size: 25px; font-weight: 700; margin: 0; letter-spacing: -.015em; }
.sub { color: var(--muted); margin: 4px 0 0; }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.tag { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); background: var(--accent-soft); padding: 5px 10px; border-radius: 6px; font-weight: 500; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; box-shadow: var(--shadow); min-width: 0; }
.card h2 { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0 0 16px; font-weight: 500; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.grid { display: grid; gap: 16px; }
.kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 16px; }
.ov { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); margin-bottom: 16px; }
.two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); margin-bottom: 16px; }
.kpi .k { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.kpi .v { font-size: 34px; font-weight: 700; margin-top: 14px; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.kpi .n { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
/* Run bar */
.runbar { display: flex; align-items: center; gap: 10px 14px; flex-wrap: wrap; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; }
.runbar .rl { font: 500 11.5px "JetBrains Mono", ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-right: 4px; }
.runbar .grp { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.runbar .gl { font-size: 12px; color: var(--faint); margin-right: 2px; }
.chip { border: 1px solid var(--line-2); background: var(--panel); border-radius: 999px; padding: 6px 12px; font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
.chip:hover { border-color: var(--accent); color: var(--accent); }
.chip:disabled { opacity: .55; cursor: wait; }
.chip .pl { color: var(--accent); font-size: 9px; }
.sep { width: 1px; height: 22px; background: var(--line); }
/* Volume chart */
.vol { position: relative; height: 200px; display: flex; align-items: flex-end; gap: 6px; border-bottom: 1px solid var(--line); padding-top: 8px; }
.vol .b { flex: 1; min-width: 0; height: 100%; display: flex; align-items: flex-end; cursor: default; }
.vol .b span { display: block; width: 100%; border-radius: 4px 4px 0 0; background: linear-gradient(180deg, var(--mint-2), var(--mint)); min-height: 0; transition: height .3s; }
.vol .b.zero span { background: var(--line); height: 2px !important; border-radius: 2px; }
.vol .b:hover span { filter: brightness(.95) saturate(1.2); }
.x-axis { display: flex; justify-content: space-between; color: var(--faint); font-size: 11.5px; margin-top: 10px; }
.tip { position: absolute; transform: translate(-50%, -110%); background: var(--text); color: var(--panel); font-size: 12px; padding: 6px 9px; border-radius: 6px; white-space: nowrap; pointer-events: none; display: none; z-index: 2; }
.vol-legend { font-size: 12px; color: var(--muted); margin: -8px 0 12px; }
/* Review list */
.rq { list-style: none; margin: 0; padding: 0; }
.rq li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--line); }
.rq li:last-child { border-bottom: 0; }
.rq .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn); }
.rq .t { font-weight: 600; font-size: 13.5px; }
.rq .s { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rq .r { display: flex; align-items: center; gap: 8px; }
.rq .amt { font-family: "JetBrains Mono", ui-monospace, monospace; font-weight: 500; }
.icb { width: 28px; height: 28px; border-radius: 7px; border: 1px solid var(--line-2); background: var(--panel); display: grid; place-items: center; font-size: 13px; padding: 0; }
.icb.ok { color: var(--good-ink); } .icb.ok:hover { background: var(--good); color: #fff; border-color: var(--good); }
.icb.no { color: var(--bad-ink); } .icb.no:hover { background: var(--bad); color: #fff; border-color: var(--bad); }
.icb:disabled { opacity: .5; cursor: wait; }

/* Run panel */
.run { margin-bottom: 16px; }
.run-groups { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.run-groups h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.run-groups h3 span { color: var(--muted); font-weight: 400; }
.task-old { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; margin-bottom: 8px; }
.task:hover { border-color: var(--accent); }
.task:disabled { opacity: .55; cursor: wait; }
.task .play { width: 22px; height: 22px; flex: none; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; font-size: 10px; }

/* Outcome chart */
.bars { display: flex; flex-direction: column; gap: 12px; }
.bar-row { display: grid; grid-template-columns: 178px minmax(0, 1fr) 36px; gap: 10px; align-items: center; }
.bar-row .l { font-size: 13px; display: flex; align-items: center; gap: 8px; }
.bar-track { height: 12px; border-radius: 0 4px 4px 0; background: transparent; position: relative; border-left: 1px solid var(--line-2); }
.bar-fill { height: 100%; border-radius: 0 4px 4px 0; min-width: 0; transition: width .3s; }
.bar-row .c { font-variant-numeric: tabular-nums; text-align: right; color: var(--text); font-weight: 600; }
.bar-row:hover .bar-fill { filter: brightness(1.15); }

/* Status */
.st { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.st i { width: 16px; height: 16px; border-radius: 50%; display: inline-grid; place-items: center; font-style: normal; font-size: 10px; color: #fff; flex: none; }
.st.good { color: var(--good-ink); } .st.good i { background: var(--good); }
.st.human { color: var(--human); } .st.human i { background: var(--human); }
.st.warn { color: var(--warn-ink); } .st.warn i { background: var(--warn); color: #0b0b0b; }
.st.bad { color: var(--bad-ink); } .st.bad i { background: var(--bad); }
.st.muted { color: var(--muted); } .st.muted i { background: var(--faint); }

/* Lists and tables */
.review { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; background: var(--panel-2); }
.review .t { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.review .why { color: var(--muted); font-size: 13px; margin-top: 4px; }
.actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.approve { background: var(--good); color: #fff; border: 1px solid var(--good); border-radius: 8px; padding: 7px 14px; font-weight: 600; }
.deny { background: transparent; color: var(--bad-ink); border: 1px solid var(--bad); border-radius: 8px; padding: 7px 14px; font-weight: 600; }
.link { background: none; border: 0; color: var(--accent); padding: 7px 4px; }
.approve:disabled, .deny:disabled { opacity: .55; cursor: wait; }
.empty { color: var(--muted); font-size: 13px; padding: 6px 0; }
.amt { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); font-weight: 600; padding: 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.tbl td { padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.tbl tr.row { cursor: pointer; }
.tbl tr.row:hover td { background: var(--panel-2); }
.tbl tr.sel td { background: var(--accent-soft); }
.tbl .mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.scroll { overflow-x: auto; }

/* Evidence */
.ev { border: 1px solid var(--line-2); border-radius: 12px; padding: 16px; background: var(--panel-2); }
.ev-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.ev-head h3 { margin: 0; font-size: 16px; }
.quote { border-left: 3px solid var(--accent); padding: 6px 12px; margin: 12px 0; color: var(--text); background: var(--panel); border-radius: 0 8px 8px 0; }
.quote small { display: block; color: var(--muted); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 2px; }
.ev-cols { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 18px; margin-top: 8px; }
.checks { list-style: none; margin: 0; padding: 0; }
.checks li { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 8px; padding: 7px 0; border-bottom: 1px dashed var(--line); }
.checks li:last-child { border-bottom: 0; }
.checks .ic { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff; margin-top: 1px; }
.checks .ok .ic { background: var(--good); } .checks .flag .ic { background: var(--warn); color: #0b0b0b; } .checks .no .ic { background: var(--bad); }
.checks b { font-weight: 600; font-size: 13px; }
.checks .d { color: var(--muted); font-size: 12px; }
.checks .eff { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); margin-left: 6px; }
.tl { list-style: none; margin: 0; padding: 0; position: relative; }
.tl li { position: relative; padding: 0 0 14px 22px; }
.tl li::before { content: ""; position: absolute; left: 6px; top: 6px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.tl li::after { content: ""; position: absolute; left: 9px; top: 16px; bottom: 0; width: 2px; background: var(--line-2); }
.tl li:last-child::after { display: none; }
.tl .when { color: var(--faint); font-size: 11px; }
.tl .what { font-size: 13px; }
details summary { cursor: pointer; color: var(--muted); font-size: 12px; margin-top: 10px; }
pre { background: var(--code); border: 1px solid var(--line); padding: 10px; border-radius: 8px; overflow-x: auto; font-size: 11.5px; margin: 6px 0 0; }

/* Live log */
.log { max-height: 520px; overflow-y: auto; }
.log.mini { max-height: 250px; }
.log.mini .entry { padding: 6px 0; }
.entry { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.who { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; font-weight: 700; padding-top: 2px; }
.who.agent { color: #b392ff; } .who.pursestring { color: var(--accent); } .who.paypal { color: #7fb0ff; } .who.human { color: var(--good-ink); }
:root[data-theme="light"] .who.agent { color: #6d28d9; } :root[data-theme="light"] .who.paypal { color: #003087; }
.when-s { color: var(--faint); font-size: 11px; }

/* Agents and policies */
.agents { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.meter { height: 8px; border-radius: 0 4px 4px 0; background: var(--panel-2); border-left: 1px solid var(--line-2); margin: 10px 0 6px; overflow: hidden; }
.meter span { display: block; height: 100%; background: var(--accent); border-radius: 0 4px 4px 0; }
.meter span.hot { background: var(--warn); }
.stats { display: flex; gap: 16px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.stats b { color: var(--text); font-size: 14px; display: block; }
.rules { list-style: none; padding: 0; margin: 0; }
.rules li { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.rules li:last-child { border-bottom: 0; }
.rules .eff { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.rules .eff.auto { color: var(--good-ink); } .rules .eff.human { color: var(--warn-ink); } .rules .eff.never { color: var(--bad-ink); }
.code-inline { font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: var(--code); border: 1px solid var(--line); padding: 1px 6px; border-radius: 5px; }
.note { font-size: 12px; color: var(--faint); margin-top: 18px; }
.toast { position: fixed; bottom: 18px; right: 18px; background: var(--panel); border: 1px solid var(--bad); color: var(--text); padding: 10px 14px; border-radius: 10px; max-width: 360px; box-shadow: 0 8px 24px rgba(0,0,0,.25); display: none; z-index: 5; }

@media (max-width: 980px) {
  .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .ov, .two, .ev-cols, .run-groups { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 760px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; height: auto; padding: 12px 16px; gap: 10px; border-right: 0; border-bottom: 1px solid var(--line); }
  .side .label, .side-foot .gh { display: none; }
  nav { flex-direction: row; overflow-x: auto; gap: 4px; padding-bottom: 2px; }
  nav button { white-space: nowrap; }
  .side-foot { margin-top: 0; flex-direction: row; align-items: center; flex-wrap: wrap; }
  main { padding: 0 16px 40px; }
  .bar-row { grid-template-columns: 116px minmax(0, 1fr) 28px; }
  .rules li { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .entry { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .kpi .v { font-size: 24px; }
  .kpis { grid-template-columns: minmax(0, 1fr); }
  .sep { display: none; }
  .vol { gap: 4px; height: 160px; }
}
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand"><svg class="logo" viewBox="0 0 30 34" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M15 2l11 4v9c0 7.5-4.8 13-11 16C8.8 28 4 22.5 4 15V6z"/><rect x="9.5" y="11" width="11" height="8.5" rx="1.6"/><path d="M9.5 14.2h11"/></svg><div><b>PurseString</b></div></div>
    <div>
      <div class="label">Workspace</div>
      <nav id="nav">
        <button data-view="overview"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>Overview</button>
        <button data-view="approvals"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8.5l3 3 7-7"/></svg>Approvals<span class="badge zero" id="badge">0</span></button>
        <button data-view="activity"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 8h3l2-5 3 10 2-5h3"/></svg>Activity</button>
        <button data-view="agents"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2v3M6 9h.01M10 9h.01"/></svg>Agents</button>
        <button data-view="policies"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5l5.5 2v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4z"/></svg>Policies</button>
      </nav>
    </div>
    <div class="side-foot">
      <span id="mode" class="pill"><span class="dot"></span>connecting…</span>
      <span class="pill" title="A real refund needs a real captured payment, so refunds go to a built-in stand-in for PayPal's MCP server"><span class="dot"></span>Refunds · simulated</span>
      <div class="row"><button class="ghost" id="reset" title="Clear this demo session">Reset demo</button><button class="ghost" id="theme" title="Switch light or dark">Theme</button></div>
      <a class="gh" href="https://github.com/suseendar1414/pursestring" target="_blank" rel="noopener">GitHub ↗</a>
    </div>
  </aside>
  <main>
    <div class="top">
      <div class="crumb">Workspace / <b id="crumb">Overview</b></div>
      <span class="crumb-time"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>This session · live</span>
    </div>
    <div id="view"></div>
    <p class="note">Every number here is live state from this server's demo session: a scripted agent's real MCP calls to a real PurseString server. Payouts go to the PayPal sandbox when the badge says so. Refunds go to a built-in stand-in for PayPal's MCP server, because a real refund needs a real captured payment. No real money moves.</p>
  </main>
</div>
<div class="toast" id="toast"></div>
<script>
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
var S = null, busy = false, sel = null;
var VIEWS = { overview: "Overview", approvals: "Approvals", activity: "Activity", agents: "Agents", policies: "Policies" };
function view() { var v = location.hash.slice(1); return VIEWS[v] ? v : "overview"; }
function money(n, c) { return (c === "USD" || !c ? "$" : "") + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (c && c !== "USD" ? " " + c : ""); }
function time(t) { return t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""; }

try { var saved = localStorage.getItem("ps-theme-v2"); if (saved) document.documentElement.dataset.theme = saved; } catch (e) {}

var RULES = {
  "hard_limits.max_amount": "Under the hard cap",
  "vendors.blocklist": "Vendor isn't blocklisted",
  "currency": "Currency matches the policy",
  "intent.task_goal": "Agent gave a reason",
  "intent.alternatives_attempted": "Agent tried free options first",
  "require_approval.recurring": "One-time charge",
  "require_approval.over_amount": "Under the human-review threshold",
  "vendors.allowlist": "Vendor is on the allowlist",
  "hard_limits.per_agent_daily_budget": "Within the agent's daily budget",
  "auto_approve": "Inside the auto-approve envelope",
  "paypal_tools.deny": "Tool isn't on the deny list",
  "paypal_tools.require_approval": "Tool always needs a human",
  "paypal_tools.refunds.amount": "Refund amount is stated",
  "paypal_tools.refunds.max_amount": "Under the refund cap",
  "paypal_tools.refunds.auto_approve_under": "Under the refund auto-approve limit"
};

var FAILS = {
  "hard_limits.max_amount": "Over the hard cap",
  "vendors.blocklist": "Vendor is blocklisted",
  "currency": "Wrong currency",
  "intent.task_goal": "No real reason given",
  "intent.alternatives_attempted": "No free options tried first",
  "require_approval.recurring": "Recurring charge",
  "require_approval.over_amount": "Over the human-review threshold",
  "vendors.allowlist": "Vendor isn't on the allowlist",
  "hard_limits.per_agent_daily_budget": "Past the agent's daily budget",
  "auto_approve": "Outside the auto-approve envelope",
  "paypal_tools.deny": "Tool is on the deny list",
  "paypal_tools.require_approval": "This tool always needs a human",
  "paypal_tools.refunds.amount": "Full refund with no amount stated",
  "paypal_tools.refunds.max_amount": "Over the refund cap",
  "paypal_tools.refunds.auto_approve_under": "Over the refund auto-approve limit"
};
var TOOLS = { create_refund: "Refund via PayPal", accept_dispute_claim: "Accept a PayPal dispute", cancel_subscription: "Cancel a PayPal subscription", cancel_sent_invoice: "Cancel a PayPal invoice", update_subscription: "Change a PayPal subscription" };
function ruleName(r) { return r.passed ? (RULES[r.rule] || r.rule) : (FAILS[r.rule] || RULES[r.rule] || r.rule); }

function outcome(i) {
  if (i.status === "pending_approval") return { k: "warn", ic: "!", t: "Waiting for review" };
  if (i.status === "denied") return { k: "bad", ic: "✕", t: i.denied_by && i.denied_by.indexOf("policy") === 0 ? "Refused by policy" : "Denied by a human" };
  if (i.status === "expired") return { k: "muted", ic: "–", t: "Expired" };
  if (i.blocked) return { k: "bad", ic: "✕", t: "Blocked: " + i.blocked };
  var human = i.approved_by && i.approved_by.indexOf("policy") !== 0;
  if (i.status === "paid" || i.status === "executed") return human ? { k: "human", ic: "✓", t: "Approved by a human" } : { k: "good", ic: "✓", t: "Ran automatically" };
  if (i.status === "approved") return { k: "muted", ic: "–", t: human ? "Approved, nothing moved" : "Approved, not run yet" };
  return { k: "muted", ic: "…", t: i.status.replace(/_/g, " ") };
}
function stHtml(o) { return '<span class="st ' + o.k + '"><i>' + o.ic + "</i>" + esc(o.t) + "</span>"; }
function moved(i) { return (i.status === "paid" || i.status === "executed") ? i.amount : 0; }
function label(i) { return i.kind === "paypal_tool" ? (TOOLS[i.what] || i.what.replace(/_/g, " ")) : "Pay " + i.vendor; }
function reasonOf(i) { return i.kind === "paypal_tool" ? i.goal.replace(/^[a-z_]+: /, "") : i.goal; }

function reviewCard(i, full) {
  var fails = i.rules.filter(function (r) { return !r.passed && r.rule !== "auto_approve"; }).map(ruleName);
  return '<div class="review"><div class="t"><div><b>' + esc(i.agent_id) + "</b> wants to <b>" + esc(label(i)) + '</b></div><span class="amt">' + money(i.amount, i.currency) + "</span></div>" +
    '<div class="why">“' + esc(reasonOf(i)) + '”</div>' +
    '<div class="why">Paused because: ' + esc(fails.length ? fails.join(" · ") : i.summary) + "</div>" +
    '<div class="actions"><button class="approve" data-decide="approve" data-id="' + esc(i.intent_id) + '">Approve</button><button class="deny" data-decide="deny" data-id="' + esc(i.intent_id) + '">Deny</button>' +
    (full ? "" : '<button class="link" data-open="' + esc(i.intent_id) + '">See evidence →</button>') + "</div>" +
    (full ? evidence(i, true) : "") + "</div>";
}

function evidence(i, inCard) {
  var rules = i.rules.map(function (r) {
    var cls = r.passed ? "ok" : r.effect === "deny" ? "no" : "flag";
    var ic = r.passed ? "✓" : r.effect === "deny" ? "✕" : "!";
    var eff = r.passed ? "" : '<span class="eff">' + (r.effect === "deny" ? "blocks" : "needs a human") + "</span>";
    return '<li class="' + cls + '"><span class="ic">' + ic + '</span><div><b>' + esc(ruleName(r)) + "</b>" + eff + '<div class="d">' + esc(r.detail) + "</div></div></li>";
  }).join("");
  var tl = ['<li><div class="what">Agent submitted the ' + (i.kind === "paypal_tool" ? "PayPal tool call" : "purchase") + '</div><div class="when">' + time(i.created_at) + "</div></li>"];
  var dec = { auto_approve: "Policy: safe to run without a human", require_approval: "Policy: paused for a human", deny: "Policy: refused, no human can override" }[i.decision];
  tl.push('<li><div class="what">' + esc(dec) + '</div><div class="when">' + time(i.created_at) + "</div></li>");
  if (i.approved_by && i.approved_by.indexOf("policy") !== 0) tl.push('<li><div class="what">Approved by ' + esc(i.approved_by) + (i.decided_via ? " via " + esc(i.decided_via) : "") + "</div></li>");
  if (i.denied_by && i.denied_by.indexOf("policy") !== 0) tl.push('<li><div class="what">Denied by ' + esc(i.denied_by) + "</div></li>");
  if (i.payment) tl.push('<li><div class="what">PayPal payout <span class="mono">' + esc(i.payment.id) + "</span> · " + esc(i.payment.status) + '</div><div class="when">' + time(i.payment.sent_at) + "</div></li>");
  if (i.executed_at) tl.push('<li><div class="what">PayPal ran ' + esc(i.what) + ' once</div><div class="when">' + time(i.executed_at) + "</div></li>");
  if (i.status === "approved" && i.kind === "purchase" && i.approved_by && i.approved_by.indexOf("policy") !== 0) tl.push('<li><div class="what">Payment refused: no payee on file for ' + esc(i.vendor) + ", so there was nowhere to send money</div></li>");
  var raw = { intent_id: i.intent_id, rail: i.rail, args: i.args, result: i.result, payment: i.payment };
  return '<div class="' + (inCard ? "" : "ev") + '" style="' + (inCard ? "margin-top:12px" : "") + '">' +
    (inCard ? "" : '<div class="ev-head"><div><h3>' + esc(label(i)) + ' · <span class="amt">' + money(i.amount, i.currency) + '</span></h3><div class="sub">' + esc(i.agent_id) + ' · <span class="mono">' + esc(i.intent_id) + "</span></div></div>" + stHtml(outcome(i)) + "</div>") +
    '<div class="quote"><small>The agent\\'s reason</small>' + esc(reasonOf(i)) + "</div>" +
    '<div class="ev-cols"><div><h2 style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 6px">Policy checks</h2><ul class="checks">' + rules + "</ul></div>" +
    '<div><h2 style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 6px">Decision trail</h2><ul class="tl">' + tl.join("") + "</ul></div></div>" +
    "<details><summary>Raw record</summary><pre>" + esc(JSON.stringify(raw, null, 2)) + "</pre></details></div>";
}

var SHORT = {
  "buy-small": "$15 purchase", "buy-large": "$80 purchase", "buy-injected": "Injected payee",
  "refund-small": "$10 refund + retry", "refund-large": "$120 refund", "refund-huge": "$900 refund"
};
function runBar() {
  var g = { purchases: [], refunds: [] };
  S.scenarios.forEach(function (x) { g[x.group].push(x); });
  var chip = function (x) { return '<button class="chip" data-run="' + esc(x.id) + '" title="' + esc(x.title) + '"' + (busy ? " disabled" : "") + '><span class="pl">▶</span>' + esc(SHORT[x.id] || x.title) + "</button>"; };
  return '<div class="runbar"><span class="rl">Run agent task</span>' +
    '<div class="grp"><span class="gl">procurement-bot</span>' + g.purchases.map(chip).join("") + "</div>" +
    '<div class="grp"><span class="gl">support-bot</span>' + g.refunds.map(chip).join("") + "</div></div>";
}

/** Requests per 15-second slot over the last 6 minutes of this session. */
var SLOT = 15000, SLOTS = 24;
function volume(I) {
  var N = SLOTS, now = Date.now(), start = now - N * SLOT, b = [];
  for (var k = 0; k < N; k++) b.push({ n: 0, t: start + k * SLOT });
  I.forEach(function (i) { var t = new Date(i.created_at).getTime(); var k = Math.floor((t - start) / SLOT); if (k >= 0 && k < N) b[k].n++; });
  var max = Math.max(1, Math.max.apply(null, b.map(function (x) { return x.n; })));
  var bars = b.map(function (x, k) {
    var lbl = new Date(x.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return '<div class="b' + (x.n ? "" : " zero") + '" data-tip="' + esc(lbl + " · " + x.n + (x.n === 1 ? " request" : " requests")) + '"><span style="height:' + (x.n / max * 100) + '%"></span></div>';
  }).join("");
  var tick = function (k) { return new Date(start + k * SLOT).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
  return '<div class="vol" id="vol">' + bars + '<div class="tip" id="tip"></div></div><div class="x-axis"><span>' + tick(0) + "</span><span>" + tick(8) + "</span><span>" + tick(16) + "</span><span>now</span></div>";
}

function firstFail(i) {
  var f = i.rules.filter(function (r) { return !r.passed && r.rule !== "auto_approve"; })[0] || i.rules.filter(function (r) { return !r.passed; })[0];
  return f ? ruleName(f) : "Needs review";
}

function overview() {
  var I = S.intents;
  var done = I.filter(function (i) { return moved(i) > 0; });
  var pend = I.filter(function (i) { return i.status === "pending_approval"; });
  var refused = I.filter(function (i) { return i.status === "denied" || i.blocked; });
  var sum = function (a) { return a.reduce(function (t, i) { return t + i.amount; }, 0); };
  var checks = I.reduce(function (a, i) { return a + i.rules.length; }, 0), passed = I.reduce(function (a, i) { return a + i.rules.filter(function (r) { return r.passed; }).length; }, 0);
  var kpi = function (k, v, n) { return '<div class="card kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="n">' + n + "</div></div>"; };
  var rq = pend.length ? '<ul class="rq">' + pend.slice(0, 5).map(function (i) {
    return '<li><span class="dot"></span><div style="min-width:0"><div class="t">' + esc(firstFail(i)) + '</div><div class="s">' + esc(i.agent_id + " · " + label(i)) + "</div></div>" +
      '<div class="r"><span class="amt">' + money(i.amount, i.currency) + '</span><button class="icb ok" title="Approve" data-decide="approve" data-id="' + esc(i.intent_id) + '">✓</button><button class="icb no" title="Deny" data-decide="deny" data-id="' + esc(i.intent_id) + '">✕</button></div></li>';
  }).join("") + "</ul>" : '<p class="empty">Nothing is waiting. Run the $80 purchase or the $120 refund.</p>';
  var recent = I.slice().reverse().slice(0, 5);
  return '<div class="head"><div><h1>Spend governance</h1><p class="sub">Signals from your agent activity</p></div><span class="tag">Live</span></div>' +
    runBar() +
    '<div class="grid kpis">' +
    kpi("Controlled spend", money(sum(I)), money(sum(done)) + " moved · " + money(sum(refused)) + " blocked") +
    kpi("Review queue", String(pend.length).padStart(2, "0"), pend.length ? money(sum(pend)) + " waiting on you" : "nothing waiting") +
    kpi("Policy checks", checks ? (passed / checks * 100).toFixed(1) + "%" : "—", passed + " of " + checks + " rule checks passed") +
    "</div>" +
    '<div class="grid ov"><div class="card"><h2>Live agent traffic <button class="link" data-goto="activity">Full log →</button></h2>' + traffic(7) + "</div>" +
    '<div class="card"><h2>Needs human review <button class="link" data-goto="approvals">All →</button></h2>' + rq + "</div></div>" +
    '<div class="card"><h2>Recent activity <button class="link" data-goto="activity">All →</button></h2>' + (recent.length ? table(recent, false) : '<p class="empty">No activity yet. Run an agent task above.</p>') + "</div>";
}

function table(rows, expandable) {
  return '<div class="scroll"><table class="tbl"><tr><th>Time</th><th>Agent</th><th>Action</th><th>Amount</th><th>Outcome</th></tr>' + rows.map(function (i) {
    var on = expandable && sel === i.intent_id;
    return '<tr class="row' + (on ? " sel" : "") + '" data-open="' + esc(i.intent_id) + '"><td class="mono">' + time(i.created_at) + "</td><td>" + esc(i.agent_id) + "</td><td>" + esc(label(i)) + '</td><td class="amt">' + money(i.amount, i.currency) + "</td><td>" + stHtml(outcome(i)) + "</td></tr>" +
      (on ? '<tr><td colspan="5" style="padding:12px 0">' + evidence(i, false) + "</td></tr>" : "");
  }).join("") + "</table></div>";
}

function approvals() {
  var pend = S.intents.filter(function (i) { return i.status === "pending_approval"; });
  return '<div class="head"><div><h1>Approvals</h1><p class="sub">Spend and PayPal actions that policy paused for a human. In production these also go to Slack or Discord.</p></div></div>' +
    (pend.length ? pend.map(function (i) { return '<div class="card" style="margin-bottom:16px">' + reviewCard(i, true) + "</div>"; }).join("")
      : '<div class="card"><p class="empty">Nothing is waiting for you. Go to Overview and run "Agent wants to spend $80" or "Support agent wants to refund $120".</p></div>');
}

/** The newest log lines, so the agent, PurseString and PayPal story reads on one screen. */
function traffic(n) {
  var rows = S.log.slice(-n).reverse().map(function (e) {
    return '<div class="entry"><div><div class="who ' + esc(e.actor) + '">' + esc(e.actor) + '</div><div class="when-s">' + time(e.ts) + "</div></div><div>" + esc(e.text) + "</div></div>";
  }).join("");
  return '<div class="log mini">' + (rows || '<p class="empty">Nothing yet. Run an agent task above.</p>') + "</div>";
}

function activity() {
  var rows = S.intents.slice().reverse();
  var log = S.log.slice().reverse().map(function (e) {
    return '<div class="entry"><div><div class="who ' + esc(e.actor) + '">' + esc(e.actor) + '</div><div class="when-s">' + time(e.ts) + "</div></div><div>" + esc(e.text) +
      (e.data === undefined ? "" : "<details><summary>payload</summary><pre>" + esc(JSON.stringify(e.data, null, 2)) + "</pre></details>") + "</div></div>";
  }).join("");
  return '<div class="head"><div><h1>Activity</h1><p class="sub">Every decision, with its evidence. Click a row to see why.</p></div></div>' +
    '<div class="card" style="margin-bottom:16px"><h2>Intents</h2>' + (rows.length ? table(rows, true) : '<p class="empty">No activity yet. Run an agent task from Overview.</p>') + "</div>" +
    '<div class="card"><h2>Agent MCP traffic <span class="tag">raw</span></h2><div class="log">' + (log || '<p class="empty">Nothing yet.</p>') + "</div></div>";
}

function agents() {
  var known = { "procurement-bot": "Buys software and services for the finance team", "support-bot": "Handles customer refunds through PayPal's MCP tools" };
  var list = S.agents.slice();
  Object.keys(known).forEach(function (a) { if (!list.some(function (x) { return x.agent_id === a; })) list.push({ agent_id: a, spent_today: 0, budget: S.policy.daily_budget, intents: 0, waiting: 0, refused: 0 }); });
  return '<div class="head"><div><h1>Agents</h1><p class="sub">What each agent has spent today against its budget. Past the budget, every request goes to a human.</p></div></div>' +
    '<div class="grid agents">' + list.map(function (a) {
      var pct = Math.min(100, a.spent_today / a.budget * 100);
      return '<div class="card"><b>' + esc(a.agent_id) + '</b><div class="sub" style="font-size:12px">' + esc(known[a.agent_id] || "") + '</div><div class="meter"><span class="' + (pct >= 80 ? "hot" : "") + '" style="width:' + pct + '%"></span></div>' +
        '<div class="sub" style="font-size:12px;margin-bottom:10px">' + money(a.spent_today) + " of " + money(a.budget) + " daily budget</div>" +
        '<div class="stats"><div><b>' + a.intents + "</b>intents</div><div><b>" + a.waiting + "</b>waiting</div><div><b>" + a.refused + "</b>refused</div></div></div>";
    }).join("") + "</div>" +
    '<div class="card" style="margin-top:16px"><h2>Request volume</h2><p class="vol-legend">Agent requests every 15 seconds, last 6 minutes</p>' + volume(S.intents) + "</div>";
}

function policies() {
  var p = S.policy;
  var rule = function (eff, cls, text) { return '<li><span class="eff ' + cls + '">' + eff + "</span><span>" + text + "</span></li>"; };
  return '<div class="head"><div><h1>Policies</h1><p class="sub">The rules this server enforces, in plain English. In a real deployment they live in <span class="code-inline">policies.yaml</span>.</p></div></div>' +
    '<div class="grid two"><div class="card"><h2>Purchases · PayPal Payouts</h2><ul class="rules">' +
    rule("Runs alone", "auto", "Under " + money(p.auto_approve_under) + ", one-time, and the vendor is on the allowlist (" + p.allowlist.map(esc).join(", ") + ").") +
    rule("Needs a human", "human", "Over " + money(p.approval_over) + ", a vendor not on the allowlist, or past the agent's " + money(p.daily_budget) + " daily budget.") +
    rule("Never", "never", "Over " + money(p.hard_max) + ", even with a human's approval.") +
    rule("Payee", "auto", "Money only goes to the account on file for each vendor (" + p.payees.map(function (x) { return esc(x.vendor) + " → " + esc(x.wallet); }).join(", ") + "). The agent can't choose where it goes.") +
    "</ul></div>" +
    '<div class="card"><h2>PayPal MCP tools · refunds and more</h2><ul class="rules">' +
    rule("Passes through", "auto", "Read-only tools such as list transactions, get order and list disputes.") +
    rule("Runs alone", "auto", "Refunds under " + money(p.refunds_auto_under) + ", inside the daily budget. A repeat of the same call returns PayPal's first answer instead of refunding twice.") +
    rule("Needs a human", "human", "Larger refunds, full refunds with no amount, and always: " + p.always_human.map(function (t) { return '<span class="code-inline">' + esc(t) + "</span>"; }).join(" ") + ".") +
    rule("Never", "never", "Refunds over " + money(p.refunds_max) + ", and any tool on the deny list.") +
    rule("Approvals", "human", "An approval covers only the exact arguments approved, so an agent can't get $80 approved and then refund $400.") +
    "</ul></div></div>";
}

function render() {
  if (!S) return;
  var v = view();
  document.querySelectorAll("#nav button").forEach(function (b) { b.classList.toggle("on", b.dataset.view === v); });
  $("crumb").textContent = VIEWS[v];
  var pend = S.intents.filter(function (i) { return i.status === "pending_approval"; }).length;
  $("badge").textContent = String(pend).padStart(2, "0");
  $("badge").className = "badge" + (pend ? "" : " zero");
  $("mode").className = "pill" + (S.live_paypal ? " live" : "");
  $("mode").innerHTML = '<span class="dot"></span>' + (S.live_paypal ? "Payouts · live PayPal sandbox" : "Payouts · simulated");
  var html = { overview: overview, approvals: approvals, activity: activity, agents: agents, policies: policies }[v]();
  var y = window.scrollY;
  $("view").innerHTML = html;
  window.scrollTo(0, y);
  document.querySelectorAll("button[data-run], button[data-decide], #reset").forEach(function (b) { b.disabled = busy; });
}

function toast(msg) { var t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(toast.h); toast.h = setTimeout(function () { t.style.display = "none"; }, 5000); }

function api(path, method) {
  return fetch(path, { method: method || "GET" }).then(function (r) {
    return r.json().then(function (body) { if (!r.ok && body.message) toast(body.message); return body; });
  });
}
function act(path) {
  busy = true; render();
  api(path, "POST").then(function (s) { if (s && s.intents) S = s; }).catch(function () { toast("The demo server didn't answer. It may be waking up; try again."); })
    .then(function () { busy = false; render(); });
}

document.addEventListener("click", function (ev) {
  var b = ev.target.closest("button, tr[data-open]");
  if (!b) return;
  if (b.dataset.view) { location.hash = b.dataset.view; return; }
  if (b.dataset.goto) { location.hash = b.dataset.goto; return; }
  if (b.id === "theme") {
    var next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("ps-theme-v2", next); } catch (e) {}
    return;
  }
  if (busy) return;
  if (b.dataset.run) act("/demo/api/run/" + b.dataset.run);
  else if (b.dataset.decide) act("/demo/api/intents/" + b.dataset.id + "/" + b.dataset.decide);
  else if (b.id === "reset") { sel = null; act("/demo/api/reset"); }
  else if (b.dataset.open) { sel = sel === b.dataset.open && view() === "activity" ? null : b.dataset.open; if (view() !== "activity") location.hash = "activity"; else render(); }
});
document.addEventListener("mouseover", function (ev) {
  var b = ev.target.closest && ev.target.closest(".vol .b"), tip = $("tip");
  if (!tip) return;
  if (!b) { tip.style.display = "none"; return; }
  var box = $("vol").getBoundingClientRect(), r = b.getBoundingClientRect(), bar = b.firstChild.getBoundingClientRect();
  tip.textContent = b.dataset.tip; tip.style.display = "block";
  tip.style.left = (r.left - box.left + r.width / 2) + "px"; tip.style.top = Math.max(0, bar.top - box.top - 4) + "px";
});
window.addEventListener("hashchange", function () { window.scrollTo(0, 0); render(); });

var last = "";
function poll() {
  api("/demo/api/state").then(function (s) {
    if (!s || !s.intents || busy) return;
    var j = JSON.stringify(s);
    if (j === last) return; // unchanged: keep open panels and scroll as they are
    last = j; S = s; render();
  }).catch(function () {});
}
poll();
setInterval(poll, 2500);
setInterval(function () { if (S && view() === "overview" && !busy) render(); }, SLOT);
</script>
</body>
</html>
`;
