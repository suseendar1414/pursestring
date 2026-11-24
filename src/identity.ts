import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { GovernanceError } from "./governance.js";
import type { IntentRecord } from "./types.js";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Header an HTTP caller sends its agent key in. The key may also be sent as the bearer token. */
export const AGENT_KEY_HEADER = "x-pursestring-agent-key";

/**
 * The agent keys from policies.yaml (agents.keys). Only SHA-256 hashes are held in memory: key_sha256 entries as
 * given, key_env entries hashed from the environment once at load. A key_env whose variable is unset still reserves
 * its agent_id, so nobody can use that id until the key is set.
 */
export class AgentKeys {
  private readonly entries: { agent_id: string; hash?: Buffer }[];
  /** Agents listed with key_env whose variable is empty: they can't sign in until it's set. */
  readonly missing: string[] = [];
  /** True when every caller needs a key (agents.require_key, on by default once keys are listed). */
  readonly required: boolean;

  constructor(policy: Config["policy"], env: NodeJS.ProcessEnv = process.env) {
    this.entries = policy.agents.keys.map((k) => {
      if (k.key_sha256) return { agent_id: k.agent_id, hash: Buffer.from(k.key_sha256, "hex") };
      const key = env[k.key_env!];
      if (!key) this.missing.push(k.agent_id);
      return { agent_id: k.agent_id, hash: key ? sha256(key) : undefined };
    });
    this.required = policy.agents.require_key ?? this.entries.length > 0;
  }

  /** True when identity checks apply at all. With no keys and require_key unset, PurseString behaves as before. */
  get enabled(): boolean {
    return this.required || this.entries.length > 0;
  }

  /** The agent_id a key belongs to, or undefined. Every entry is compared, in constant time, so timing leaks nothing. */
  resolve(key: string | undefined): string | undefined {
    if (!key) return undefined;
    const got = sha256(key);
    let found: string | undefined;
    for (const e of this.entries) {
      if (e.hash && timingSafeEqual(got, e.hash) && !found) found = e.agent_id;
    }
    return found;
  }

  /** True when this agent_id is registered with a key, so only its key holder may use it. */
  isKeyed(agentId: string): boolean {
    const id = agentId.trim();
    return this.entries.some((e) => e.agent_id === id);
  }
}

const cache = new WeakMap<Config, AgentKeys>();

/** The AgentKeys for a config, built once: the HTTP server makes a new MCP server per request. */
export function agentKeysFor(config: Config): AgentKeys {
  let keys = cache.get(config);
  if (!keys) cache.set(config, (keys = new AgentKeys(config.policy)));
  return keys;
}

const KEY_HINT =
  "Set PURSESTRING_AGENT_KEY in this MCP server's environment (stdio), or send the key in the X-PurseString-Agent-Key " +
  "header or as the bearer token (HTTP).";

/**
 * Checks one connection's tool calls against its verified identity. `verified` is the agent_id its key proved, or
 * undefined for a caller that sent no key. Every refusal is written to the decision log.
 */
export class CallerGuard {
  constructor(
    private readonly keys: AgentKeys,
    readonly verified: string | undefined,
    private readonly audit: (event: string, data: Record<string, unknown>) => void,
  ) {}

  private refuse(code: string, message: string, data: Record<string, unknown>): never {
    this.audit("agent_identity_refused", { code, verified_agent: this.verified ?? null, ...data });
    throw new GovernanceError(message, code);
  }

  /**
   * The agent_id to act as. A verified caller must name its own id; an unkeyed caller may not borrow a keyed id, and
   * is refused outright when keys are required.
   */
  agentFor(claimed: string, tool: string): string {
    const id = claimed.trim();
    if (this.verified) {
      if (id !== this.verified) {
        this.refuse(
          "agent_identity_mismatch",
          `This connection is verified as agent "${this.verified}", but the call says agent_id "${id}". Use agent_id "${this.verified}".`,
          { claimed_agent: id, tool },
        );
      }
      return this.verified;
    }
    if (this.keys.required) {
      this.refuse("agent_key_required", `This PurseString server only accepts verified agents. ${KEY_HINT}`, { claimed_agent: id, tool });
    }
    if (this.keys.isKeyed(id)) {
      this.refuse("agent_key_required", `agent_id "${id}" is registered with a key, so calls as it need that key. ${KEY_HINT}`, {
        claimed_agent: id,
        tool,
      });
    }
    return id;
  }

  /**
   * Check that the caller may act on an existing intent (get a card, pay it, read it). A missing record is left for
   * governance to report as not found.
   */
  checkOwner(rec: IntentRecord | undefined, tool: string): void {
    if (!rec || !this.keys.enabled) return;
    const owner = rec.intent.agent_id.trim();
    if (this.verified) {
      if (owner !== this.verified) {
        // Don't say whose it is: a caller shouldn't learn other agents' ids from intent ids.
        this.refuse("agent_identity_mismatch", `Intent ${rec.intent_id} belongs to another agent.`, { intent_id: rec.intent_id, tool });
      }
      return;
    }
    if (this.keys.required || this.keys.isKeyed(owner)) {
      this.refuse("agent_key_required", `Intent ${rec.intent_id} belongs to a verified agent. ${KEY_HINT}`, { intent_id: rec.intent_id, tool });
    }
  }
}
