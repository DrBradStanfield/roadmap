/**
 * Gemini as an accepted connector client (US-32 AC59-AC62, Brad 2026-11-23).
 *
 * Gemini's custom connector registers several redirects per user on Google's
 * relay host, and sends a `state` near 1,400 characters. A minted DCR id
 * carrying six redirects is ~900 characters and overflows the consent cookie,
 * so registration answers Gemini with ONE short pinned id instead, and the
 * redirect is judged by shape at `/authorize`. `/token` still wants the exact
 * string `/authorize` saw (`redirectMatches`).
 *
 * The shape is FIELD-OBSERVED, not documented by Google: public reports show
 * `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<USER_ID>-<slug>`
 * where the slug is the connector's host with dots as underscores
 * (mcpus.coros.com -> mcpus_coros_com). One live connection must confirm it.
 * The `-sandbox` and `-test` relay hosts some reports list are NOT accepted:
 * nothing shows the consumer app using them.
 *
 * NOTHING HERE MAY LOG A URL.
 */
import type { McpOAuthDetail } from '../../packages/health-core/src/product-events';
import type { McpClient } from './mcp-clients.server';
import { issuer } from './mcp-config.server';

/** Short, fixed and public: it is a name, not a secret. */
export const GEMINI_CLIENT_ID = 'gemini';

/** Gemini was seen sending 6; anything past 8 is not Gemini as observed. */
const GEMINI_MAX_REDIRECTS = 8;

/** Google user ids seen are ~21 digits; 64 leaves room and bounds the state budget below. */
const GEMINI_ID_MAX = 64;

const GEMINI_RELAY = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-';

/** This server's slug as Gemini spells it (field-observed form): mcp.drstanfield.com -> mcp_drstanfield_com. */
export function geminiServerSlug(): string {
  return new URL(issuer()).hostname.replace(/\./g, '_');
}

/**
 * The longest `state` the Gemini client may send. Arithmetic, for the
 * byte checks in `checkAuthorize` (sealed payload + 4 <= 2048, cookie <= 4096):
 *
 *   payload JSON = 166 fixed bytes (keys, quotes, "gemini", "dropbox", a
 *   43-character nonce, a 10-digit exp) + redirect + challenge + state.
 *   redirect <= 69 (relay prefix) + 64 (id) + 1 + 19 (mcp_drstanfield_com) = 153;
 *   challenge <= 128 (the PKCE regex). So an ASCII state of 1536 gives
 *   166 + 153 + 128 + 1536 = 1983 <= 2044: it stays in the 2048 bucket.
 *   That bucket seals to 175 + 1 + 2768 = 2944 characters, and the cookie is
 *   17 (name=) + 9 ("gemini" base64url + "~") + 2944 + 54 (attributes) = 3024
 *   <= 4096 (measured 2026-11-23). The long DCR id was the overflow; the
 *   pinned id removes it.
 *
 * The real byte checks still run on every request, so a state that escapes
 * or is not ASCII can still be refused below this cap.
 */
export const GEMINI_MAX_STATE_LENGTH = 1536;

/**
 * The one redirect shape the Gemini client may use: exact prefix, exact
 * suffix naming THIS server, and an id of word characters between them.
 * Matched on the raw string, so an uppercase host, a port, userinfo, a
 * percent-escape, a slash, a query or a fragment all fail the match.
 */
export function isGeminiRedirect(uri: string): boolean {
  const suffix = `-${geminiServerSlug()}`;
  if (!uri.startsWith(GEMINI_RELAY) || !uri.endsWith(suffix)) return false;
  const id = uri.slice(GEMINI_RELAY.length, uri.length - suffix.length);
  return id.length <= GEMINI_ID_MAX && /^[A-Za-z0-9_]+$/.test(id);
}

/** The pinned Gemini client, when EVERY redirect in a registration is Gemini's; else null. */
export function registerGemini(input: unknown): McpClient | null {
  const uris = (input as { redirect_uris?: unknown } | null)?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > GEMINI_MAX_REDIRECTS) return null;
  if (!uris.every((u): u is string => typeof u === 'string' && isGeminiRedirect(u))) return null;
  return { clientId: GEMINI_CLIENT_ID, name: 'Gemini', redirectUris: uris };
}

/** A refused registration's closed category for the counter: never a URI or host. */
export function registrationMiss(input: unknown): McpOAuthDetail<'register-redirect'> {
  const uris = (input as { redirect_uris?: unknown } | null)?.redirect_uris;
  const googleRelay = (u: unknown) => typeof u === 'string' && URL.canParse(u) && new URL(u).hostname.endsWith('.googleusercontent.com');
  return Array.isArray(uris) && uris.some(googleRelay) ? 'gemini-like' : 'other';
}
