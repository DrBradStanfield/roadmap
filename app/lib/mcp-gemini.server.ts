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
 * The shape is the one Gemini sends (read from its "Copy redirect URI" button,
 * 2026-11-23), not documented by Google:
 * `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id>`,
 * the id 24 lowercase letters and digits, nothing after it. Google's
 * `oauth-redirect-sandbox` and `oauth-redirect-test` relay hosts are accepted
 * with the same path rule (owner ruling 2026-11-23): live, one redirect of the
 * shape above registered, while the Gemini app's own registration seconds
 * later was refused, so its list holds entries beyond that one.
 *
 * Nothing here may log a URL; `redirectShapes` logs shapes with every id masked.
 */
import type { McpOAuthDetail } from '../../packages/health-core/src/product-events';
import type { McpClient } from './mcp-clients.server';

/** Short, fixed and public: it is a name, not a secret. */
export const GEMINI_CLIENT_ID = 'gemini';

/** Gemini was seen sending 6; anything past 8 is not Gemini as observed. */
const GEMINI_MAX_REDIRECTS = 8;

/**
 * One of the three relay hosts, the prefix, then an id, then the end. The id
 * seen is 24 characters; 16 to 40 leaves room and bounds the state budget below.
 */
const GEMINI_REDIRECT = /^https:\/\/oauth-redirect(?:-sandbox|-test)?\.googleusercontent\.com\/r\/user_bound_custom-mcp-[a-z0-9]{16,40}$/;

/**
 * The longest `state` the Gemini client may send. Arithmetic, for the
 * byte checks in `checkAuthorize` (sealed payload + 4 <= 2048, cookie <= 4096):
 *
 *   payload JSON = 166 fixed bytes (keys, quotes, "gemini", "dropbox", a
 *   43-character nonce, a 10-digit exp) + redirect + challenge + state.
 *   redirect <= 77 (the sandbox relay prefix, 8 longer than the main one's
 *   69) + 40 (id) = 117;
 *   challenge <= 128 (the PKCE regex). So an ASCII state of 1536 gives
 *   166 + 117 + 128 + 1536 = 1947 <= 2044: it stays in the 2048 bucket.
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
 * The one redirect shape the Gemini client may use: one of the three relay
 * hosts, the exact path prefix, then an id
 * of 16 to 40 lowercase letters and digits, then the end of the string.
 * Matched on the raw string, so an uppercase host or id, a port, userinfo, a
 * percent-escape, a slash, a query, a fragment or any suffix fails the match.
 */
export function isGeminiRedirect(uri: string): boolean {
  return GEMINI_REDIRECT.test(uri);
}

/**
 * The switch (US-32 AC63, owner ruling 2026-11-23): the Gemini pin exists only
 * while the server's own `MCP_GEMINI` is exactly `on`. Off, `gemini` is no
 * client at all: registration refuses as before, `resolveClient` knows no such
 * id, and `unpackSealed` opens no blob minted for it, so turning it off ends
 * every Gemini connection. Off by default until one live attempt shows Google's
 * relay delivers a code only to the account its redirect names.
 */
export function geminiEnabled(): boolean {
  return process.env.MCP_GEMINI === 'on';
}

/**
 * null when no redirect is Gemini's (the ordinary path decides). Otherwise the
 * pinned client, only while switched on and only when EVERY redirect (1 to 8,
 * all strings) is Gemini's; any other list holding a Gemini redirect is
 * `refused`, in both switch states, before the ordinary path can truncate it.
 */
export function registerGemini(input: unknown): McpClient | 'refused' | null {
  const raw = (input as { redirect_uris?: unknown } | null)?.redirect_uris;
  const uris: unknown[] = Array.isArray(raw) ? raw : [];
  const gemini = uris.filter((u) => typeof u === 'string' && isGeminiRedirect(u));
  if (gemini.length === 0) return null;
  if (!geminiEnabled() || gemini.length !== uris.length || uris.length > GEMINI_MAX_REDIRECTS) return 'refused';
  return { clientId: GEMINI_CLIENT_ID, name: 'Gemini', redirectUris: gemini as string[] };
}

/** A refused registration's closed category for the counter: never a URI or host. */
export function registrationMiss(input: unknown): McpOAuthDetail<'register-redirect'> {
  const uris = (input as { redirect_uris?: unknown } | null)?.redirect_uris;
  const googleRelay = (u: unknown) => typeof u === 'string' && URL.canParse(u) && new URL(u).hostname.endsWith('.googleusercontent.com');
  return Array.isArray(uris) && uris.some(googleRelay) ? 'gemini-like' : 'other';
}

/** A run of 6+ letters and digits holding a digit: an id, masked to its length. */
const maskIds = (text: string) => text.replace(/[A-Za-z0-9]{6,}/g, (run) => (/\d/.test(run) ? `<id:${run.length}>` : run));

/** One redirect's shape: a Google host or `other-host`, the masked path, never a query or fragment value. */
function redirectShape(uri: unknown): string {
  if (typeof uri !== 'string') return 'non-string';
  if (!URL.canParse(uri)) return 'unparseable';
  const url = new URL(uri);
  const host = url.hostname.endsWith('.googleusercontent.com') ? url.hostname : 'other-host';
  return maskIds(host + url.pathname) + (url.search ? '?query' : '') + (url.hash ? '#fragment' : '');
}

/**
 * The one log line for a refused Gemini-like registration (US-32 AC66): why it
 * was refused, how many redirects, and each one's shape (8 listed, then "+N
 * more"), with every id masked. Capped at 600 characters.
 */
export function redirectShapes(input: unknown, switchOn: boolean): string {
  const raw = (input as { redirect_uris?: unknown } | null)?.redirect_uris;
  const uris: unknown[] = Array.isArray(raw) ? raw : [];
  const reason = !switchOn ? 'switch-off' : uris.length > GEMINI_MAX_REDIRECTS ? 'over-cap' : 'mixed';
  const shapes = uris.slice(0, GEMINI_MAX_REDIRECTS).map(redirectShape);
  if (uris.length > GEMINI_MAX_REDIRECTS) shapes.push(`+${uris.length - GEMINI_MAX_REDIRECTS} more`);
  return [`[mcp] gemini-like registration refused: reason=${reason} count=${uris.length}`, ...shapes].join(' ').slice(0, 600);
}
