/**
 * What a sealed blob carries, what `/token` hands back, and the two counters
 * that bound abuse (US-32, design §2/§3/§4).
 *
 * NOTHING HERE MAY LOG A URL.
 */
import { createQuotaCounter, createRateLimiter, DAY_MS } from './rate-limiter';
import { resetMcpWarnings } from './mcp-config.server';
import { resetCimdCache } from './mcp-clients.server';
import { resetGithubIssues } from './github-issues.server';
import { hash, packSealed } from './mcp-seal.server';
import { reviewerFailures, reviewerGeneration, reviewerRefreshToken } from './mcp-reviewer.server';
import type { McpProvider } from './mcp-providers.server';
import { IMPORT_LIMITS } from '../../packages/health-core/src/import-hints';

/**
 * The whole consent trip, not just the part after the button. `sealState` is
 * stamped at the authorize GET and `consentGiven` re-seals WITHOUT restamping,
 * so this covers reading the screen, pressing Connect, signing in at Dropbox or
 * Google, creating an account if you have none, clearing the provider's device
 * check, and coming back. Ten minutes was a race; overrunning it renders a 400
 * on our own domain with no way back to the assistant.
 *
 * Lengthening it costs nothing, and not for the reasons it looks like: the
 * authorize GET is unauthenticated and mints a fresh state on demand, so this
 * lifetime never bounded anyone who wanted one. What bounds the flow is the
 * `__Host-` cookie, the 32-byte provider nonce, PKCE, and the 60-second
 * single-use code. The blob itself carries no credential (see StatePayload).
 *
 * A wrong reviewer login (US-32 AC38) re-renders the page with fresh states,
 * which restamps this clock. Harmless: a state only ever mints a code for the
 * PKCE challenge it was sealed with, which belongs to the client that started.
 */
export const STATE_LIFETIME_SECONDS = 30 * 60;
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
/** Files one connection may send to the extraction model in a day, per machine (US-35 AC10) — the number the quota hint names. */
export const IMPORT_FILES_PER_DAY = IMPORT_LIMITS.filesPerDay;

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

/**
 * What a code, access or refresh blob stands for. A real connection carries the
 * provider's refresh token, which never leaves a sealed blob. A reviewer grant
 * (US-32 AC38) carries the reviewer generation and an EMPTY token: the token
 * itself is a server secret, read only where a provider refresh needs it.
 */
export type Grant = { rt: string; rv?: undefined } | { rt: ''; rv: string };

export type CodePayload = Grant & {
  clientId: string;
  provider: McpProvider;
  redirectUri: string;
  codeChallenge: string;
  jti: string;
  exp: number;
};

export type AccessPayload = Grant & {
  clientId: string;
  provider: McpProvider;
  exp: number;
};

export type RefreshPayload = Grant & {
  clientId: string;
  provider: McpProvider;
  exp: number;
};

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
 *
 * Only the grant's own two fields are re-sealed, so a reviewer grant (US-32
 * AC38) stays the generation and never becomes a token.
 */
export function issueTokens(clientId: string, provider: McpProvider, from: Grant, nowMs: number, refreshExp?: number) {
  const grant: Grant = from.rv === undefined ? { rt: from.rt } : { rt: '', rv: from.rv };
  const access: AccessPayload = { clientId, provider, ...grant, exp: nowSeconds(nowMs) + ACCESS_LIFETIME_SECONDS };
  const refresh: RefreshPayload = {
    clientId,
    provider,
    ...grant,
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

/**
 * Proposal receipts already confirmed (US-36 AC9), per machine, the same
 * best-effort single-use as `spentCodes`: a replay on a second Fly machine
 * meets `not-active` on `correct_value` and an `expected` mismatch on
 * `update_profile`, and could file a second public issue. Pruned at the
 * receipt's own lifetime.
 */
const spentProposals = new Map<string, number>();

/** Spend one id once: prune what has outlived `lifetimeMs`, then refuse a repeat. */
function claimOnce(spent: Map<string, number>, jti: string, lifetimeMs: number, nowMs: number): boolean {
  for (const [id, at] of spent) if (nowMs - at > lifetimeMs) spent.delete(id);
  if (spent.has(jti)) return false;
  spent.set(jti, nowMs);
  return true;
}

export const claimCode = (jti: string, nowMs = Date.now()): boolean => claimOnce(spentCodes, jti, CODE_LIFETIME_SECONDS * 1000, nowMs);
export const claimProposal = (jti: string, lifetimeMs: number, nowMs = Date.now()): boolean => claimOnce(spentProposals, jti, lifetimeMs, nowMs);

/**
 * Writes already spent by one CONNECTION this hour, per machine. Keyed on the
 * hash of the provider refresh token, which is what a connection is: minting a
 * second access token over the same connection lands on the same counter, so
 * extra tokens buy no extra writes. Best-effort across Fly machines, like the
 * code set — N machines multiply the allowance by N, and §4 says so.
 */
const spentWrites = new Map<string, { used: number; at: number }>();

/**
 * The connection a sealed credential belongs to, named without naming it.
 * Every reviewer session shares one stated bucket (US-32 AC38): writes,
 * tool-call rate, import files, feedback dedup and confirm receipts.
 */
export function connectionKey(grant: Grant): string {
  return hash(grant.rv === undefined ? grant.rt : `reviewer:${grant.rv}`);
}

/** The provider refresh token a grant stands for: its own, or the reviewer's secret. */
export function grantRefreshToken(grant: Grant): string {
  return grant.rv === undefined ? grant.rt : reviewerRefreshToken();
}

/**
 * Is this grant still alive on our side? A real one always is (its expiry is
 * the seal's). A reviewer grant dies the moment its generation stops being the
 * current one: secrets unset, the token rotated, or the password changed.
 */
export function grantLive(grant: Grant): boolean {
  return grant.rv === undefined || grant.rv === reviewerGeneration();
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

/**
 * The allowance charged and, when spent, refused in words — the ONE wording,
 * whether the loop charges a tool's declared cost before it runs or the
 * import charges per file and per replace as it goes (US-35 AC10).
 */
export function chargeWrites(connection: string, cost: number): string | null {
  if (spendWrites(connection, cost)) return null;
  return (
    `This connection has spent its write allowance for the hour — ${WRITES_PER_HOUR} weighted writes an hour, ` +
    `where a correction counts as ${WRITE_COST.correct} and an import one per file. Reading still works. The allowance comes back with ` +
    'the hour; a new access token does not buy more. Ask the user to make this change in the app if it cannot wait.'
  );
}

/** Files extracted per connection today, beside the writes — the same key, the same reset. */
export const importFiles = createQuotaCounter(IMPORT_FILES_PER_DAY, DAY_MS, 30 * 60_000);

/** Test seam — the maps are process-global and would leak between cases. */
export function resetMcpMemory(): void {
  spentCodes.clear();
  spentProposals.clear();
  spentWrites.clear();
  importFiles.reset();
  reviewerFailures.reset();
  resetCimdCache();
  resetGithubIssues();
  resetMcpWarnings();
  allowAuthorize.reset();
  allowRateLimitEvent.reset();
  allowToken.reset();
  allowToolCall.reset();
}

/** Per-IP, before any CIMD fetch — the fetch is the expensive, abusable half. */
export const AUTHORIZE_PER_WINDOW = 20;
export const allowAuthorize = createRateLimiter(AUTHORIZE_PER_WINDOW, 60_000, 10 * 60_000);

/**
 * The brake's own counter, braked. A flood is exactly when the row is written
 * every time, so counting each refused request would turn a cheap in-memory
 * `false` into one Supabase insert per request on the shared admin pool — the
 * limiter paying the cost it exists to avoid. One row per IP per window says
 * the same thing.
 */
export const allowRateLimitEvent = createRateLimiter(1, 60_000, 10 * 60_000);

/**
 * Per-IP at `/token`, and per-connection at `tools/call`. Both are flood
 * brakes, not quotas: a whole vendor's traffic arrives from one egress range,
 * so an IP here can be thousands of users and the limit has to be generous or
 * it locks out the honest ones. The per-connection one also bounds how often
 * one connection can make us refresh a Dropbox access token.
 */
export const allowToken = createRateLimiter(300, 60_000, 10 * 60_000);
export const allowToolCall = createRateLimiter(120, 60_000, 10 * 60_000);
