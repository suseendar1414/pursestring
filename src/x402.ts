/**
 * x402 (https://github.com/coinbase/x402): a server answers HTTP 402 with what it accepts, the client signs a
 * payment and repeats the request with it. PurseString supports the "exact" scheme on EVM chains with USDC, paid by
 * an EIP-3009 transferWithAuthorization the wallet signs (no gas, no transaction sent by PurseString: the server's
 * facilitator settles it). Both protocol versions are read: v2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
 * PAYMENT-RESPONSE headers, CAIP-2 networks) and v1 (JSON body, X-PAYMENT / X-PAYMENT-RESPONSE, named networks).
 *
 * Written from the public x402 specs; no third-party x402 code is used.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "node:crypto";

/** USDC contracts PurseString will pay with, by chain ID. USDC is budgeted 1:1 as USD. */
export const USDC: Record<number, { address: string; label: string; testnet: boolean }> = {
  8453: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", label: "Base", testnet: false },
  84532: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", label: "Base Sepolia", testnet: true },
};
/** USDC has 6 decimals: 1 USD = 1,000,000 atomic units, 1 cent = 10,000. */
export const USDC_DECIMALS = 6;
const ATOMIC_PER_CENT = 10n ** BigInt(USDC_DECIMALS - 2);

/** v1 network names, as v1 servers send them. */
const V1_NETWORKS: Record<string, number> = { base: 8453, "base-sepolia": 84532 };

/** One payment option from a 402 answer, normalized across protocol versions. */
export interface X402Requirement {
  version: 1 | 2;
  scheme: string;
  /** CAIP-2, e.g. eip155:84532. v1 names are converted. */
  network: string;
  chain_id: number | null;
  /** Atomic units of `asset`, as a decimal string. */
  amount: string;
  asset: string;
  pay_to: string;
  max_timeout_seconds: number;
  extra: Record<string, unknown>;
  /** The option exactly as the server sent it, echoed back in the payment. */
  raw: Record<string, unknown>;
}

export interface X402Challenge {
  version: 1 | 2;
  accepts: X402Requirement[];
  /** v2 resource info, echoed back in the payment. */
  resource?: unknown;
  error?: string;
}

function decodeB64Json(v: string): unknown {
  return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
}

export const encodeB64Json = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");

function chainIdOf(network: string): number | null {
  const m = /^eip155:(\d+)$/.exec(network);
  if (m) return Number(m[1]);
  return V1_NETWORKS[network] ?? null;
}

/** Read a 402 answer. Returns null when it isn't an x402 challenge PurseString can read. */
export function parseChallenge(headers: Headers, bodyText: string): X402Challenge | null {
  let doc: Record<string, unknown> | undefined;
  const header = headers.get("payment-required");
  try {
    if (header) doc = decodeB64Json(header) as Record<string, unknown>;
    else if (bodyText) doc = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || !Array.isArray(doc.accepts)) return null;
  const version = doc.x402Version === 1 ? 1 : 2;
  const accepts: X402Requirement[] = [];
  for (const a of doc.accepts as Record<string, unknown>[]) {
    if (!a || typeof a !== "object") continue;
    const rawNetwork = String(a.network ?? "");
    const network = version === 1 && V1_NETWORKS[rawNetwork] ? `eip155:${V1_NETWORKS[rawNetwork]}` : rawNetwork;
    const amount = String((version === 1 ? a.maxAmountRequired : a.amount) ?? "");
    if (!/^\d+$/.test(amount)) continue;
    accepts.push({
      version,
      scheme: String(a.scheme ?? ""),
      network,
      chain_id: chainIdOf(network),
      amount,
      asset: String(a.asset ?? ""),
      pay_to: String(a.payTo ?? ""),
      max_timeout_seconds: Number(a.maxTimeoutSeconds ?? 60),
      extra: (a.extra && typeof a.extra === "object" ? a.extra : {}) as Record<string, unknown>,
      raw: a,
    });
  }
  return { version, accepts, resource: doc.resource, error: typeof doc.error === "string" ? doc.error : undefined };
}

/** Why PurseString can't pay this option, or null when it can. */
export function unsupportedReason(r: X402Requirement, allowedNetworks: string[]): string | null {
  if (r.scheme !== "exact") return `scheme ${r.scheme} (only "exact" is supported)`;
  if (!allowedNetworks.includes(r.network)) return `network ${r.network} isn't in x402.networks`;
  const usdc = r.chain_id === null ? undefined : USDC[r.chain_id];
  if (!usdc || usdc.address.toLowerCase() !== r.asset.toLowerCase()) return `asset ${r.asset} isn't USDC on ${r.network}`;
  const method = r.extra.assetTransferMethod;
  if (method !== undefined && method !== "eip3009") return `transfer method ${String(method)} (only eip3009 is supported)`;
  if (typeof r.extra.name !== "string" || typeof r.extra.version !== "string") return "no EIP-712 name/version in extra";
  if (!/^0x[0-9a-fA-F]{40}$/.test(r.pay_to)) return `payTo ${r.pay_to} isn't an EVM address`;
  if (BigInt(r.amount) === 0n) return "amount is zero";
  return null;
}

/** USDC atomic units -> whole US cents, rounded up so a sub-cent price is budgeted as a full cent, never as nothing. */
export function atomicToCents(atomic: string): number {
  const a = BigInt(atomic);
  const cents = (a + ATOMIC_PER_CENT - 1n) / ATOMIC_PER_CENT;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount too large");
  return Number(cents);
}

// ---- EIP-712 / EIP-3009 signing ----

const keccak = (b: Uint8Array) => keccak_256(b);
const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

function word(n: bigint): Uint8Array {
  if (n < 0n || n >= 1n << 256n) throw new Error("uint256 out of range");
  return fromHex(n.toString(16).padStart(64, "0"));
}
const addressWord = (a: string) => word(BigInt(a));
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

const DOMAIN_TYPE = keccak(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const TRANSFER_TYPE = keccak(
  utf8("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
);

export interface TransferAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** The EIP-712 digest a USDC contract checks for transferWithAuthorization. */
export function transferDigest(
  domain: { name: string; version: string; chainId: number; verifyingContract: string },
  auth: TransferAuthorization,
): Uint8Array {
  const domainSeparator = keccak(
    concat(DOMAIN_TYPE, keccak(utf8(domain.name)), keccak(utf8(domain.version)), word(BigInt(domain.chainId)), addressWord(domain.verifyingContract)),
  );
  const structHash = keccak(
    concat(
      TRANSFER_TYPE,
      addressWord(auth.from),
      addressWord(auth.to),
      word(BigInt(auth.value)),
      word(BigInt(auth.validAfter)),
      word(BigInt(auth.validBefore)),
      fromHex(auth.nonce),
    ),
  );
  return keccak(concat(fromHex("0x1901"), domainSeparator, structHash));
}

/** EIP-55 checksummed address. */
function checksum(addrHex: string): string {
  const lower = addrHex.toLowerCase().replace(/^0x/, "");
  const h = Buffer.from(keccak(utf8(lower))).toString("hex");
  return "0x" + [...lower].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

/** The agent-payments wallet: a private key in X402_PRIVATE_KEY. It signs; it never sends a transaction. */
export class X402Wallet {
  readonly address: string;
  private readonly key: Uint8Array;

  constructor(privateKeyHex: string) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKeyHex.trim())) throw new Error("X402_PRIVATE_KEY must be a 32-byte hex private key.");
    this.key = fromHex(privateKeyHex.trim());
    const pub = secp256k1.getPublicKey(this.key, false).slice(1);
    this.address = checksum(hex(keccak(pub).slice(-20)));
  }

  /** Sign an EIP-3009 authorization to pay `requirement`, valid from a minute ago until its timeout. */
  authorize(r: X402Requirement, now: Date): { signature: string; authorization: TransferAuthorization } {
    const t = Math.floor(now.getTime() / 1000);
    const authorization: TransferAuthorization = {
      from: this.address,
      to: r.pay_to,
      value: r.amount,
      validAfter: String(t - 60),
      validBefore: String(t + Math.max(1, r.max_timeout_seconds)),
      nonce: hex(randomBytes(32)),
    };
    const digest = transferDigest(
      { name: String(r.extra.name), version: String(r.extra.version), chainId: r.chain_id!, verifyingContract: r.asset },
      authorization,
    );
    // noble's "recovered" format is [recovery, r, s]; Ethereum wants r, s, v with v = 27 + recovery.
    const sig = secp256k1.sign(digest, this.key, { prehash: false, format: "recovered" });
    const signature = hex(concat(sig.slice(1, 65), Uint8Array.of(27 + sig[0])));
    return { signature, authorization };
  }
}

/** The payment header to send, for the challenge's protocol version. */
export function paymentHeader(
  r: X402Requirement,
  resource: unknown,
  payload: { signature: string; authorization: TransferAuthorization },
): { name: string; value: string } {
  if (r.version === 1) {
    return { name: "X-PAYMENT", value: encodeB64Json({ x402Version: 1, scheme: r.scheme, network: r.raw.network, payload }) };
  }
  return {
    name: "PAYMENT-SIGNATURE",
    value: encodeB64Json({ x402Version: 2, ...(resource ? { resource } : {}), accepted: r.raw, payload }),
  };
}

export interface X402Settlement {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

/** The server's settlement answer, if it sent one. */
export function parseSettlement(headers: Headers): X402Settlement | null {
  const v = headers.get("payment-response") ?? headers.get("x-payment-response");
  if (!v) return null;
  try {
    return decodeB64Json(v) as X402Settlement;
  } catch {
    return null;
  }
}
