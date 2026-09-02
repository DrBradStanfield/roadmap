/**
 * What a sealed blob carries, what `/token` hands back, and the two counters
 * that bound abuse (US-32, design §2/§3/§4).
 *
 * NOTHING HERE MAY LOG A URL.
 */
import { createRateLimiter } from './rate-limiter';
import { resetMcpWarnings } from './mcp-config.server';
import { resetCimdCache } from './mcp-clients.server';
import { hash, packSealed } from './mcp-seal.server';
import type { McpProvider } from './mcp-providers.server';

export const CODE_LIFETIME_SECONDS = 60;
export const ACCESS_LIFETIME_SECONDS = 60 * 60;
export const REFRESH_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
/**
 * Weighted write allowance (design §3, mitigation 4): N weighted writes per
 * connection per hour, per machine. A correction costs five adds — the
 * silent-falsification attack needs one correction per metric, so weighting
 * corrections is what actually bounds it, while a real session adds in batches
 * (a lab panel is ONE add of many rows) and corrects a handful of times.
 *
 * There is no lifetime pool. One was tried and removed: a sealed pool spent by
 * REFRESHING rather than by writing charged an honest client for refreshes it
 * had to make, so fifty refreshes and zero writes left a user permanently
 * unable to write; and because a replayed refresh blob mints a fresh access
 * blob from the same unchanged ciphertext, it bounded nobody. It was a lie in
 * one direction and a no-op in the other.
 */
export const WRITES_PER_HOUR = 60;
export const WRITE_COST = { add: 1, correct: 5 } as const;
const WRITE_WINDOW_MS = 60 * 60 * 1000;

export interface StatePayload {
  clientId: string;
  /** Chosen at the consent screen. Sealed, so the callback cannot be talked
   *  into finishing at a provider the user did not pick. */
  provider: McpProvider;
  redirectUri: string;
  codeChallenge: string;
  clientState: string;
  /** The value Dropbox echoes. Set at consent, held only in the cookie. */
  nonce: string;
  exp: number;
}

export interface CodePayload {
  clientId: string;
  provider: McpProvider;
  redirectUri: string;
  codeChallenge: string;
  /** The provider's refresh token. Never leaves a sealed blob. */
  rt: string;
  jti: string;
  exp: number;
}

export interface AccessPayload {
  clientId: string;
  provider: McpProvider;
  rt: string;
  exp: number;
}

export interface RefreshPayload {
  clientId: string;
  provider: McpProvider;
  rt: string;
  exp: number;
}

export function nowSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

/**
 * Mint the access/refresh pair a `/token` response carries.
 *
 * `refreshExp` carries the ORIGINAL refresh expiry through a refresh grant, so
 * the 90 days run from consent and not from the last refresh. Without it the
 * lifetime slides: a client that refreshes hourly never reaches an expiry, and
 * "90 days" bounds nothing. Omitted on the code grant, where the clock starts.
 */
export function issueTokens(
  clientId: string,
  provider: McpProvider,
  rt: string,
  nowMs: number,
  refreshExp?: number,
) {
  const access: AccessPayload = { clientId, provider, rt, exp: nowSeconds(nowMs) + ACCESS_LIFETIME_SECONDS };
  const refresh: RefreshPayload = {
    clientId,
    provider,
    rt,
    exp: refreshExp ?? nowSeconds(nowMs) + REFRESH_LIFETIME_SECONDS,
  };
  return {
    access_token: packSealed('access', clientId, access),
    refresh_token: packSealed('refresh', clientId, refresh),
    token_type: 'Bearer',
    // Honest, because Claude refreshes proactively five minutes before this.
    expires_in: ACCESS_LIFETIME_SECONDS,
    scope: 'health.read health.append',
  };
}

// ---------------------------------------------------------------------------
// Best-effort in-memory state — counted, not free (design §2)
// ---------------------------------------------------------------------------

/**
 * Authorization codes are single-use in OAuth 2.1 and statelessness cannot
 * enforce that. This set is per-machine and NOT authoritative: across Fly
 * machines a code could be redeemed twice inside its 60-second window.
 * Redemption still needs the PKCE `code_verifier`, which never leaves the
 * client, so a passive interceptor gains nothing. Documented in §4, not
 * papered over.
 */
const spentCodes = new Map<string, number>();

export function claimCode(jti: string, nowMs = Date.now()): boolean {
  for (const [id, at] of spentCodes) if (nowMs - at > CODE_LIFETIME_SECONDS * 1000) spentCodes.delete(id);
  if (spentCodes.has(jti)) return false;
  spentCodes.set(jti, nowMs);
  return true;
}

/**
 * Writes already spent by one CONNECTION this hour, per machine. Keyed on the
 * hash of the provider refresh token, which is what a connection is: minting a
 * second access token over the same connection lands on the same counter, so
 * extra tokens buy no extra writes. Best-effort across Fly machines, like the
 * code set — N machines multiply the allowance by N, and §4 says so.
 */
const spentWrites = new Map<string, { used: number; at: number }>();

/** The connection a sealed credential belongs to, named without naming it. */
export function connectionKey(rt: string): string {
  return hash(rt);
}

export function spendWrites(connection: string, cost: number, nowMs = Date.now()): boolean {
  for (const [id, entry] of spentWrites) {
    if (nowMs - entry.at > WRITE_WINDOW_MS) spentWrites.delete(id);
  }
  const entry = spentWrites.get(connection) ?? { used: 0, at: nowMs };
  if (entry.used + cost > WRITES_PER_HOUR) return false;
  entry.used += cost;
  spentWrites.set(connection, entry);
  return true;
}

/** Test seam — the maps are process-global and would leak between cases. */
export function resetMcpMemory(): void {
  spentCodes.clear();
  spentWrites.clear();
  resetCimdCache();
  resetMcpWarnings();
  allowAuthorize.reset();
  allowToken.reset();
  allowToolCall.reset();
}

/** Per-IP, before any CIMD fetch — the fetch is the expensive, abusable half. */
export const allowAuthorize = createRateLimiter(20, 60_000, 10 * 60_000);

/**
 * Per-IP at `/token`, and per-connection at `tools/call`. Both are flood
 * brakes, not quotas: a whole vendor's traffic arrives from one egress range,
 * so an IP here can be thousands of users and the limit has to be generous or
 * it locks out the honest ones. The per-connection one also bounds how often
 * one connection can make us refresh a Dropbox access token.
 */
export const allowToken = createRateLimiter(300, 60_000, 10 * 60_000);
export const allowToolCall = createRateLimiter(120, 60_000, 10 * 60_000);
