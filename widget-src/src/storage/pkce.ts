/**
 * PKCE (Proof Key for Code Exchange) helpers for client-side OAuth — used by the
 * Dropbox and Google Drive adapters. No Brad server ever HOLDS a token — Drive's
 * code exchange transits Brad's stateless endpoint (decision record §14), but
 * tokens live only in the user's browser (implementation plan §4.2).
 */

/** Base64url-encode raw bytes (no padding) per RFC 7636. */
function base64UrlEncode(bytes: ArrayBuffer): string {
  let str = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) str += String.fromCharCode(view[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBytes(length: number): ArrayBuffer {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return arr.buffer;
}

/** A high-entropy code verifier (43–128 chars after base64url). */
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

/** The S256 code challenge for a verifier. */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

/** An opaque CSRF `state` value to round-trip through the auth redirect. */
export function generateState(): string {
  return base64UrlEncode(randomBytes(16));
}

/** Read and clear this flow's sessionStorage PKCE entry (null when none). */
function takePkce(pkceKey: string): { verifier: string; state: string } | null {
  let stored: { verifier: string; state: string } | null = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(pkceKey) || 'null');
  } catch {
    stored = null;
  }
  if (!stored) return null;
  try {
    sessionStorage.removeItem(pkceKey);
  } catch {
    /* ignore */
  }
  return stored;
}

/**
 * Claim the OAuth `?code` on a redirect-return page — but only if THIS flow
 * (identified by its sessionStorage PKCE entry) initiated it. Multiple OAuth
 * backends share one redirect page, so each adapter calls this with its own
 * key and gets null when the return isn't from its flow.
 *
 * Returns null when: no ?code in the URL, no PKCE entry under `pkceKey`, or
 * the state doesn't match (stale/forged — declining to exchange IS the CSRF
 * defense; the entry is cleared so it can't go stale-positive later). The
 * entry is consumed either way; on success the caller exchanges the code and
 * then strips ?code/&state from the URL itself. `scope` is the space-delimited
 * list of scopes the user actually approved, when the provider appends it
 * (Google does; Dropbox does not).
 */
export function claimRedirectCode(pkceKey: string): { code: string; verifier: string; scope?: string } | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return null;
  const stored = takePkce(pkceKey); // one-shot — consumed on any outcome
  if (!stored) return null; // not our flow (another adapter's return)
  if (stored.state !== params.get('state')) return null; // stale entry or CSRF — don't exchange
  return { code, verifier: stored.verifier, scope: params.get('scope') ?? undefined };
}

/**
 * The user pressed Cancel or Back at the provider: the redirect returns
 * `?error=access_denied&state=...` with no code (US-09 AC22). True only when THIS
 * flow started it (a PKCE entry under `pkceKey` whose state matches), so a
 * random `?error=` URL counts for nothing. The entry is consumed and the
 * error params stripped, so a refresh cannot count it twice.
 */
export function claimRedirectCancel(pkceKey: string): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get('error') !== 'access_denied' || params.get('code')) return false;
  if (takePkce(pkceKey)?.state !== params.get('state')) return false;
  for (const k of ['error', 'error_description', 'error_uri', 'state']) params.delete(k);
  const rest = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
  return true;
}
