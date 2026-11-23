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
 * Two shapes, neither documented by Google. Registration tolerates the list
 * Gemini sends (logged 2026-11-23): six entries, the three relay hosts
 * (main, `-sandbox`, `-test`) each with `/r/` and with one other one-letter
 * segment. Registration grants nothing for the pinned id, so tolerance there
 * costs nothing. `/authorize`, the sealed state and `/token` accept only
 * `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id>`
 * (the address Gemini's "Copy redirect URI" button shows), the id 24
 * lowercase letters and digits, nothing after it.
 *
 * Nothing here may log a URL; `redirectShapes` logs allow-listed words and lengths only.
 */
import type { McpOAuthDetail } from '../../packages/health-core/src/product-events';
import type { McpClient } from './mcp-clients.server';

/** Short, fixed and public: it is a name, not a secret. */
export const GEMINI_CLIENT_ID = 'gemini';

/** Gemini was seen sending 6; anything past 8 is not Gemini as observed. */
const GEMINI_MAX_REDIRECTS = 8;

/**
 * The relay prefix, then an id, then the end. The id seen is 24 characters;
 * 16 to 40 leaves room and bounds the state budget below.
 */
const GEMINI_REDIRECT = /^https:\/\/oauth-redirect\.googleusercontent\.com\/r\/user_bound_custom-mcp-[a-z0-9]{16,40}$/;

/** Registration only: any of the three relay hosts, any one lowercase letter where `/r/` sits. */
const GEMINI_REGISTRATION_REDIRECT = /^https:\/\/oauth-redirect(?:-sandbox|-test)?\.googleusercontent\.com\/[a-z]\/user_bound_custom-mcp-[a-z0-9]{16,40}$/;

/**
 * The longest `state` the Gemini client may send. Arithmetic, for the
 * byte checks in `checkAuthorize` (sealed payload + 4 <= 2048, cookie <= 4096):
 *
 *   payload JSON = 166 fixed bytes (keys, quotes, "gemini", "dropbox", a
 *   43-character nonce, a 10-digit exp) + redirect + challenge + state.
 *   redirect <= 69 (relay prefix) + 40 (id) = 109 (only the authorize shape
 *   reaches the state; the wider registration shape never does);
 *   challenge <= 128 (the PKCE regex). So an ASCII state of 1536 gives
 *   166 + 109 + 128 + 1536 = 1939 <= 2044: it stays in the 2048 bucket.
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
 * The one redirect shape the Gemini client may use: exact prefix, then an id
 * of 16 to 40 lowercase letters and digits, then the end of the string.
 * Matched on the raw string, so an uppercase host or id, a port, userinfo, a
 * percent-escape, a slash, a query, a fragment or any suffix fails the match.
 */
export function isGeminiRedirect(uri: string): boolean {
  return GEMINI_REDIRECT.test(uri);
}

/** The wider shape `registerGemini` checks a list against; never used at `/authorize` or `/token`. */
export function isGeminiRegistrationRedirect(uri: string): boolean {
  return GEMINI_REGISTRATION_REDIRECT.test(uri);
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
 * null when no redirect has the registration shape (the ordinary path decides).
 * Otherwise the pinned client, only while switched on, only when EVERY redirect
 * (1 to 8, all strings) has the registration shape, and only when at least one
 * has the authorize shape; any other list holding a Gemini-shaped redirect is
 * `refused`, in both switch states, before the ordinary path can truncate it.
 *
 * The answer lists only the authorize-shape entries, so the server never claims
 * a redirect `/authorize` would refuse. RFC 7591 section 3.2.1 lets a server
 * replace requested metadata and answer with the values it registered.
 */
export function registerGemini(input: unknown): McpClient | 'refused' | null {
  const raw = (input as { redirect_uris?: unknown } | null)?.redirect_uris;
  const uris: unknown[] = Array.isArray(raw) ? raw : [];
  const shaped = uris.filter((u): u is string => typeof u === 'string' && isGeminiRegistrationRedirect(u));
  if (shaped.length === 0) return null;
  const usable = shaped.filter(isGeminiRedirect);
  if (!geminiEnabled() || shaped.length !== uris.length || uris.length > GEMINI_MAX_REDIRECTS || usable.length === 0) return 'refused';
  return { clientId: GEMINI_CLIENT_ID, name: 'Gemini', redirectUris: usable };
}

/** A refused registration's closed category for the counter: never a URI or host. */
function registrationMiss(input: unknown): McpOAuthDetail<'register-redirect'> {
  const uris = (input as { redirect_uris?: unknown } | null)?.redirect_uris;
  const googleRelay = (u: unknown) => typeof u === 'string' && URL.canParse(u) && new URL(u).hostname.endsWith('.googleusercontent.com');
  return Array.isArray(uris) && uris.some(googleRelay) ? 'gemini-like' : 'other';
}

/** The only hosts a shape names; any other host is `other-google-host` or `other-host`. */
const RELAY_HOSTS = ['oauth-redirect', 'oauth-redirect-sandbox', 'oauth-redirect-test'].map((h) => `${h}.googleusercontent.com`);
/** The only path words a shape keeps; every other run is `<w:LEN>` or `<id:LEN>`. */
const PATH_WORDS = new Set(['r', 'user', 'bound', 'custom', 'mcp']);

/** A relay path in allow-listed words: other runs masked to their length, separators other than / - _ as `?`. */
const maskPath = (path: string) =>
  path.replace(/[A-Za-z0-9]+|[^A-Za-z0-9]/g, (t) =>
    /^[A-Za-z0-9]/.test(t) ? (PATH_WORDS.has(t) ? t : `<${/\d/.test(t) ? 'id' : 'w'}:${t.length}>`) : '/-_'.includes(t) ? t : '?');

/**
 * One redirect's shape, built from allow-listed words and numbers only: a relay
 * host with its masked path, or `other-google-host` / `other-host` with just the
 * path's segment count and length; port, userinfo, query and fragment as literals.
 */
function redirectShape(uri: unknown): string {
  if (typeof uri !== 'string') return 'non-string';
  if (!URL.canParse(uri)) return 'unparseable';
  const url = new URL(uri);
  const relay = RELAY_HOSTS.includes(url.hostname);
  const host = relay ? url.hostname : url.hostname.endsWith('.googleusercontent.com') ? 'other-google-host' : 'other-host';
  const path = relay ? maskPath(url.pathname) : `[segments=${url.pathname.split('/').filter(Boolean).length},len=${url.pathname.length}]`;
  // The port comes from the raw authority, since the parser drops a default one.
  const authority = uri.split('://')[1]?.split(/[/?#]/)[0] ?? '';
  const port = /:\d/.test(authority.slice(authority.lastIndexOf('@') + 1)) ? ':port' : '';
  return `${url.username || url.password ? 'userinfo@' : ''}${host}${port}${path}${url.search ? '?query' : ''}${url.hash ? '#fragment' : ''}${url.href !== uri ? '~normalized' : ''}`;
}

/**
 * The one log line for a refused Gemini-like registration (US-32 AC66): why it
 * was refused, how many redirects, and each one's shape (8 listed, then "+N
 * more"). Capped at 600 characters, cut at a whole entry.
 */
export function redirectShapes(input: unknown, switchOn: boolean): string {
  const raw = (input as { redirect_uris?: unknown } | null)?.redirect_uris;
  const uris: unknown[] = Array.isArray(raw) ? raw : [];
  const shaped = uris.filter((u): u is string => typeof u === 'string' && isGeminiRegistrationRedirect(u));
  const reason = shaped.length === 0 ? 'no-match' : !switchOn ? 'switch-off' : uris.length > GEMINI_MAX_REDIRECTS ? 'over-cap'
    : shaped.length !== uris.length ? 'mixed' : !shaped.some(isGeminiRedirect) ? 'no-authorize-shape'
    : 'accepted'; // Not reached from the route: such a list registers, so it is never logged.
  const shapes = uris.slice(0, GEMINI_MAX_REDIRECTS).map(redirectShape);
  if (uris.length > GEMINI_MAX_REDIRECTS) shapes.push(`+${uris.length - GEMINI_MAX_REDIRECTS} more`);
  const line = [`[mcp] gemini-like registration refused: reason=${reason} count=${uris.length}`, ...shapes].join(' ');
  return line.length <= 600 ? line : line.slice(0, line.lastIndexOf(' ', 600));
}

/**
 * Called only inside the route's per-IP refusal allowance (US-32 AC64): the
 * counter's closed category, plus the one shape line when it is `gemini-like`.
 */
export function registrationRefused(input: unknown): McpOAuthDetail<'register-redirect'> {
  const detail = registrationMiss(input);
  if (detail === 'gemini-like') console.warn(redirectShapes(input, geminiEnabled()));
  return detail;
}
