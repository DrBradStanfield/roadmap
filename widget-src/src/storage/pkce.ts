/**
 * PKCE (Proof Key for Code Exchange) helpers for client-side OAuth — used by the
 * Dropbox and Google Drive adapters. All client-side, no Brad server (a server
 * holding tokens would be a "Brad can peek" vector — implementation plan §4.2).
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
