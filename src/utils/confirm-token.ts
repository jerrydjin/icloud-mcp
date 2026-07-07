// HMAC-SHA256 sign + verify for the triage proposal flow (M4.2).
//
// Triage returns a structured plan plus a confirmToken. triage_commit verifies
// the token before performing the writes. The token covers the canonicalized
// proposal hash + an `exp` claim so a stale or tampered proposal is rejected
// before any write hits iCloud.
//
// Why this is small and explicit:
//  - No JWT library; Web Crypto subtle.* is built into Bun + Vercel Node 20
//  - Signing is HMAC-SHA256 over a fixed-shape JSON envelope
//  - No clock skew tolerance; clients re-call triage() after expiration
//
// Threat model (single-user MCP server):
//  - The signing key (CONFIRM_TOKEN_SECRET) lives in Vercel env vars and is
//    separate from AUTH_TOKEN. If AUTH_TOKEN leaks, attackers can call the MCP
//    but cannot forge confirmTokens. If CONFIRM_TOKEN_SECRET also leaks, an
//    attacker with both secrets could replay arbitrary proposals; threat model
//    is "make leaks not catastrophic" rather than full key isolation.
//  - Tokens are stateless. Single-use enforcement is best-effort because the
//    Vercel runtime has no shared memory across invocations. Per-leg
//    idempotency keys do the correctness work; tokens just guarantee freshness
//    and integrity.

const TOKEN_VERSION = 1;
const DEFAULT_TTL_SEC = 600; // 10 min

export interface SignedTokenPayload {
  v: number; // token version, currently 1
  hash: string; // hex SHA-256 of canonicalized proposal
  exp: number; // unix seconds
}

export interface VerifyResult {
  valid: boolean;
  expired: boolean;
  /** True when token format is OK but the proposal hash doesn't match what was signed. */
  mismatch: boolean;
  /** Reason string for diagnostic surfacing; safe to relay to the LLM. */
  reason?: string;
}

/**
 * Sign a proposal: returns `<base64url-payload>.<base64url-mac>`.
 *
 * Throws if the secret is undefined or shorter than 32 bytes. This is a
 * deliberate hard gate: a missing or weak signing key would let attackers forge
 * confirmTokens, and triage_commit's idempotency model relies on the token
 * being unforgeable.
 */
export async function signProposal(
  proposal: unknown,
  secret: string | undefined,
  ttlSec: number = DEFAULT_TTL_SEC
): Promise<string> {
  assertSecret(secret);
  const hash = await sha256Hex(canonicalize(proposal));
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload: SignedTokenPayload = { v: TOKEN_VERSION, hash, exp };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payloadJson));
  const mac = await hmacSha256(payloadB64, secret!);
  return `${payloadB64}.${mac}`;
}

/**
 * Verify a token against the proposal it claims to sign. The result discriminates:
 *   - valid: signature OK, not expired, hash matches
 *   - expired: signature OK but the 10-min window has passed
 *   - mismatch: signature OK but caller's proposal doesn't match the signed hash
 *   - !valid && !expired && !mismatch: signature is bad (forgery / tampered / wrong key)
 *
 * Throws on the same secret-strength gate as signProposal.
 */
export async function verifyToken(
  token: string,
  proposal: unknown,
  secret: string | undefined
): Promise<VerifyResult> {
  assertSecret(secret);

  const dot = token.indexOf(".");
  if (dot === -1) {
    return { valid: false, expired: false, mismatch: false, reason: "malformed_token" };
  }
  const payloadB64 = token.slice(0, dot);
  const macClaimed = token.slice(dot + 1);

  const macExpected = await hmacSha256(payloadB64, secret!);
  if (!constantTimeEqual(macClaimed, macExpected)) {
    return { valid: false, expired: false, mismatch: false, reason: "bad_signature" };
  }

  let payload: SignedTokenPayload;
  try {
    const json = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(json);
  } catch {
    return { valid: false, expired: false, mismatch: false, reason: "malformed_payload" };
  }

  if (payload.v !== TOKEN_VERSION) {
    return { valid: false, expired: false, mismatch: false, reason: "unknown_version" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    return { valid: false, expired: true, mismatch: false, reason: "expired" };
  }

  const claimedHash = await sha256Hex(canonicalize(proposal));
  if (claimedHash !== payload.hash) {
    return { valid: false, expired: false, mismatch: true, reason: "proposal_hash_mismatch" };
  }

  return { valid: true, expired: false, mismatch: false };
}

// ── Internals ──

function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret) {
    throw new Error(
      "CONFIRM_TOKEN_SECRET is not set. Triage cannot sign or verify tokens. " +
        "Set CONFIRM_TOKEN_SECRET (32+ random bytes, hex or base64) in your environment."
    );
  }
  // Hex / base64 / opaque — all eventually become bytes via UTF-8 in HMAC. We
  // gate on raw character length rather than decoded byte length so users who
  // paste a 32-character random string aren't surprised by stricter rules; if
  // they paste a 16-byte hex string (32 chars), entropy is 64 bits which is
  // weak but the gate doesn't catch it. Document the recommendation in
  // .env.example: 32+ random bytes hex-encoded (64 hex chars) or base64.
  if (secret.length < 32) {
    throw new Error(
      `CONFIRM_TOKEN_SECRET is too short (${secret.length} chars). ` +
        "Use 32+ random bytes (hex-encoded recommended; produce with: openssl rand -hex 32)."
    );
  }
}

/**
 * Canonicalize an arbitrary JSON-shaped value to a deterministic string.
 * Object keys sorted alphabetically at every level. Used as the input to
 * SHA-256 so the same logical proposal always hashes identically regardless of
 * key order from the caller.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = sortKeys(obj[k]);
  }
  return sorted;
}

async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256(message: string, secret: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(secret);
  const messageBytes = new TextEncoder().encode(message);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, messageBytes);
  return base64UrlEncode(new Uint8Array(sig));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Constant-time string equality for HMAC comparison. Avoids the timing-leak
 * pattern that early-returns on first mismatch.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
