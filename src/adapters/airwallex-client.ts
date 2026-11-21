/**
 * The one place PurseString talks to the Airwallex API: login, the bearer token, the pinned API version and error
 * parsing. Shared by the card rail (airwallex.ts) and the payout rail (airwallex-payouts.ts).
 *
 * Every detail here follows Airwallex's own published sources, so it behaves the way their tooling does:
 * - Login is POST /api/v1/authentication/login with x-client-id and x-api-key headers and no body, answering
 *   { token, expires_at }; tokens last 30 minutes. Source: the OpenAPI spec at
 *   https://github.com/airwallex/airwallex-openapi (2026-08-21, "Obtain Access Token"), and the official Node SDK
 *   (@airwallex/node-sdk, MIT), which sends the same headers and logs in again every 20 minutes.
 * - x-login-as picks the account when one scoped API key covers several (spec, same operation; the SDK sends it from
 *   its accountId option).
 * - x-api-version pins the request and response shapes. The spec README says to pin it; the SDK always sends one.
 * - Sandbox host api-demo.airwallex.com is the one the official SDK and Airwallex's developer MCP server use. The
 *   spec now also lists https://api.sandbox.airwallex.com; set adapter.airwallex.base_url to use that instead.
 * - Errors come back as { code, message, source?, details? } (spec, components.schemas.Error).
 */

/** The OpenAPI spec version every Airwallex request and test payload in PurseString was checked against. */
export const AIRWALLEX_API_VERSION = "2026-08-21";

export const AIRWALLEX_HOSTS = {
  sandbox: "https://api-demo.airwallex.com",
  production: "https://api.airwallex.com",
} as const;

/** The SDK clears its token every 20 minutes (TIMEOUT_REFRESH_TOKEN); use that when expires_at is missing. */
const FALLBACK_TOKEN_MS = 20 * 60_000;

export interface AirwallexClientOptions {
  clientId: string;
  apiKey: string;
  /**
   * "sandbox" (the default) talks to Airwallex's sandbox, where production credentials can't log in, so a live key
   * can't move real money until policies.yaml says environment: production.
   */
  environment?: "sandbox" | "production";
  /** Account to act as when one scoped API key covers several accounts (the x-login-as login header). */
  loginAs?: string;
  apiVersion?: string;
  /** Overrides the host, e.g. https://api.sandbox.airwallex.com. */
  baseUrl?: string;
}

/** A non-2xx answer from Airwallex, with its error code when the body had one. */
export class AirwallexApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AirwallexApiError";
  }
}

export class AirwallexClient {
  readonly baseUrl: string;
  readonly environment: "sandbox" | "production";
  private token?: { value: string; expiresAt: number };
  private pendingLogin?: Promise<string>;

  constructor(private readonly opts: AirwallexClientOptions) {
    this.environment = opts.environment === "production" ? "production" : "sandbox";
    this.baseUrl = (opts.baseUrl ?? AIRWALLEX_HOSTS[this.environment]).replace(/\/+$/, "");
    if (this.environment === "sandbox" && new URL(this.baseUrl).hostname === "api.airwallex.com") {
      throw new Error(
        "adapter.airwallex.base_url points at Airwallex production while environment is sandbox. " +
          "Set adapter.airwallex.environment: production to use production.",
      );
    }
  }

  private static async fail(method: string, path: string, res: Response): Promise<never> {
    const text = await res.text();
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    let message = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as { code?: string; message?: string; details?: Record<string, unknown> };
      code = body.code;
      details = body.details;
      if (body.message) message = `${body.code ? body.code + ": " : ""}${body.message}`;
    } catch {
      /* not JSON; keep the raw text */
    }
    throw new AirwallexApiError(`Airwallex ${method} ${path} failed: ${res.status} ${message}`, res.status, code, details);
  }

  /** A valid bearer token, logging in at most once at a time and again a minute before it expires. */
  private async bearer(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    this.pendingLogin ??= this.login().finally(() => {
      this.pendingLogin = undefined;
    });
    return this.pendingLogin;
  }

  private async login(): Promise<string> {
    const path = "/api/v1/authentication/login";
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        "x-client-id": this.opts.clientId,
        "x-api-key": this.opts.apiKey,
        "Content-Type": "application/json",
        ...(this.opts.loginAs ? { "x-login-as": this.opts.loginAs } : {}),
      },
    });
    if (!res.ok) await AirwallexClient.fail("POST", path, res);
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token) throw new Error("Airwallex login answered without a token.");
    const expiresAt = body.expires_at ? Date.parse(body.expires_at) : NaN;
    this.token = { value: body.token, expiresAt: Number.isNaN(expiresAt) ? Date.now() + FALLBACK_TOKEN_MS : expiresAt };
    return body.token;
  }

  /**
   * Call the API. A 401 means the token went stale early, so log in again and retry once; that is safe for writes
   * too, because every PurseString write carries a request_id that Airwallex dedupes on.
   */
  async request<T>(method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.baseUrl + path + qs, {
        method,
        headers: {
          Authorization: `Bearer ${await this.bearer()}`,
          "Content-Type": "application/json",
          "x-api-version": this.opts.apiVersion ?? AIRWALLEX_API_VERSION,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (res.status === 401 && attempt === 0) {
        this.token = undefined;
        continue;
      }
      if (!res.ok) await AirwallexClient.fail(method, path, res);
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
  }
}
