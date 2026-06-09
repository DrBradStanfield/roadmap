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
 * then strips ?code/&state from the URL itself.
 */
export function claimRedirectCode(pkceKey: string): { code: string; verifier: string } | null {
  const code = new URLSearchParams(window.location.search).get('code');
  if (!code) return null;
  let stored: { verifier: string; state: string } | null = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(pkceKey) || 'null');
  } catch {
    stored = null;
  }
  if (!stored) return null; // not our flow (another adapter's return)
  try {
    sessionStorage.removeItem(pkceKey); // one-shot — consumed on any outcome
  } catch {
    /* ignore */
  }
  const state = new URLSearchParams(window.location.search).get('state');
  if (stored.state !== state) return null; // stale entry or CSRF — don't exchange
  return { code, verifier: stored.verifier };
}
