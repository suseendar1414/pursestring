import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolResult } from "./governance.js";
import { VERSION } from "./server.js";

/**
 * PayPal's toolkit reports API failures as ordinary content, {"ok":false,"status":403,...}, not as an MCP error.
 * Treat those as errors so a failed refund is never recorded as done.
 */
function paypalFailed(result: ToolResult): boolean {
  const first = result.content?.[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== "text" || !first.text?.trimStart().startsWith("{")) return false;
  try {
    return (JSON.parse(first.text) as { ok?: unknown }).ok === false;
  } catch {
    return false;
  }
}

/** A tool as PayPal's MCP server lists it. */
export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** An MCP server whose tools PurseString re-exposes behind its own policy. */
export interface Upstream {
  readonly tools: UpstreamTool[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * PayPal's own MCP server (@paypal/mcp, built on the PayPal Agent Toolkit), run as a child process behind
 * PurseString. It is given a short-lived OAuth token, not the client secret; when the token rotates the server
 * is restarted with the new one.
 */
export class PayPalMcpUpstream implements Upstream {
  tools: UpstreamTool[] = [];
  private client?: Client;
  private token?: string;
  private connecting?: Promise<Client>;

  constructor(
    private readonly connectTransport: (accessToken: string) => Transport,
    private readonly accessToken: () => Promise<string>,
  ) {}

  /** Spawn `command` (e.g. npx -y @paypal/mcp --tools=all) with PAYPAL_ACCESS_TOKEN and PAYPAL_ENVIRONMENT set. */
  static spawn(command: string[], environment: "sandbox" | "production", accessToken: () => Promise<string>) {
    const [cmd, ...args] = command;
    return new PayPalMcpUpstream(
      (token) =>
        new StdioClientTransport({
          command: cmd,
          args,
          env: {
            ...(process.env as Record<string, string>),
            PAYPAL_ACCESS_TOKEN: token,
            PAYPAL_ENVIRONMENT: environment === "production" ? "PRODUCTION" : "SANDBOX",
          },
          stderr: "inherit",
        }),
      accessToken,
    );
  }

  private async connect(): Promise<Client> {
    const token = await this.accessToken();
    if (this.client && token === this.token) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.client?.close().catch(() => {});
      const client = new Client({ name: "pursestring", version: VERSION });
      await client.connect(this.connectTransport(token));
      this.client = client;
      this.token = token;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  /** Connect and read PayPal's tool list. Call once at startup, before building MCP servers. */
  async start(): Promise<this> {
    const client = await this.connect();
    const tools: UpstreamTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...(page.tools as UpstreamTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = tools;
    return this;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = await this.connect();
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    return { ...result, isError: Boolean(result.isError) || paypalFailed(result) };
  }

  async close() {
    await this.client?.close();
  }
}
