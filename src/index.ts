#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAdapter } from "./adapters/index.js";
import { loadConfig } from "./config.js";
import { Governance, GovernanceError } from "./governance.js";
import { startHttp } from "./http.js";
import { WebhookNotifier } from "./notify.js";
import { createMcpServer, VERSION } from "./server.js";
import { Store } from "./store.js";

const HELP = `pursestring ${VERSION}: spend policy for AI agents (MCP server)

Usage:
  pursestring                      Run the MCP server over stdio (for Claude Desktop, Cursor, etc.)
  pursestring serve --http [--port 8787] [--host 0.0.0.0]
                                Run the MCP server over Streamable HTTP (for Docker / remote agents)
  pursestring init                 Write an example policies.yaml in the current directory
  pursestring pending              List intents waiting for a human
  pursestring approve <intent_id> [--by name] [--note text]
  pursestring deny <intent_id> [--by name] [--note text]
  pursestring log [-n 20]          Show the latest decision-log entries
  pursestring policy               Print the active policy and where it was loaded from

Environment:
  PURSESTRING_HOME        State + decision log directory (default ~/.pursestring)
  PURSESTRING_POLICY      Path to policies.yaml (default ./policies.yaml, then $PURSESTRING_HOME/policies.yaml)
  SLACK_WEBHOOK_URL    Slack incoming webhook for approval requests
  DISCORD_WEBHOOK_URL  Discord webhook for approval requests
  LITHIC_API_KEY       Use Lithic virtual cards (sandbox by default) instead of the mock rail
  PURSESTRING_TOKEN       Bearer token required on /mcp in HTTP mode
  PURSESTRING_ADMIN_TOKEN Bearer token for the HTTP approval API
`;

function build() {
  const config = loadConfig();
  const store = new Store(config.homeDir);
  const gov = new Governance(config, store, createAdapter(config), new WebhookNotifier(config));
  return { config, store, gov };
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      http: { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      by: { type: "string" },
      note: { type: "string" },
      n: { type: "string", short: "n" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [cmd = "serve", arg] = positionals;

  if (values.help || cmd === "help") return void process.stdout.write(HELP);
  if (values.version) return void console.log(VERSION);

  switch (cmd) {
    case "serve": {
      const { config, gov } = build();
      if (values.http || process.env.PURSESTRING_TRANSPORT === "http") {
        startHttp(gov, Number(values.port ?? process.env.PORT ?? 8787), values.host ?? process.env.HOST ?? "127.0.0.1");
        return;
      }
      const server = createMcpServer(gov);
      await server.connect(new StdioServerTransport());
      console.error(
        `[pursestring] stdio server ready (rail: ${gov.adapter.name}, policy: ${config.policyPath ?? "built-in defaults"}, home: ${config.homeDir})`,
      );
      return;
    }
    case "init": {
      const target = resolve("policies.yaml");
      if (existsSync(target)) throw new Error(`${target} already exists`);
      const here = dirname(fileURLToPath(import.meta.url));
      copyFileSync(join(here, "..", "examples", "policies.yaml"), target);
      console.log(`Wrote ${target}. Edit the allowlist, then restart your MCP client.`);
      return;
    }
    case "pending": {
      const { store } = build();
      const rows = store.list((r) => r.status === "pending_approval");
      if (!rows.length) return void console.log("Nothing waiting for approval.");
      for (const r of rows) {
        const i = r.intent;
        console.log(`${r.intent_id}  ${i.amount.toFixed(2)} ${i.currency}  ${i.vendor_domain}${i.is_recurring ? " (recurring)" : ""}  agent=${i.agent_id} task=${i.task_id}`);
        console.log(`    goal: ${i.task_goal}`);
        console.log(`    why:  ${r.evaluation.summary}`);
      }
      return;
    }
    case "approve":
    case "deny": {
      if (!arg) throw new Error(`usage: pursestring ${cmd} <intent_id>`);
      const { gov } = build();
      const rec = gov.decide(arg, cmd === "approve", values.by ?? process.env.USER ?? "cli", values.note);
      console.log(`${rec.intent_id} is now ${rec.status}.`);
      return;
    }
    case "log": {
      const { store } = build();
      for (const e of store.readAudit(Number(values.n ?? 20))) console.log(JSON.stringify(e));
      return;
    }
    case "policy": {
      const { config } = build();
      console.log(`# loaded from: ${config.policyPath ?? "built-in defaults"}  (rail: ${config.policy.adapter.type})`);
      console.log(JSON.stringify(config.policy, null, 2));
      return;
    }
    default:
      process.stderr.write(HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof GovernanceError ? `error (${err.code}): ${err.message}` : `error: ${err.message ?? err}`);
  process.exit(1);
});
