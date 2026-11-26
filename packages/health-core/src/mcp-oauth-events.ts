/**
 * The OAuth front door's closed words (US-32 AC34, AC48), split out of
 * product-events.ts, which re-exports them. Like it, this file imports nothing.
 */
/**
 * Why an OAuth connection ended where it did (US-32 AC34). Closed for the same
 * reason the list above is: the words a refusal knows are a `redirect_uri`, a
 * `client_id` and a `state`, and every one of them is caller-chosen text. Only
 * the NAME of the check that failed reaches a row.
 *
 * The first six are `checkAuthorize`'s own branches, which it now returns
 * rather than the route re-deriving them from an English description.
 */
export const MCP_OAUTH_REASONS = [
  /** The redirect the client asked for is not one it published, or not allow-listed. */
  'redirect-uri',
  /** Anything but `response_type=code`. */
  'response-type',
  /** PKCE missing or not S256. */
  'pkce',
  /** A `code_challenge` that is not 43–128 unreserved characters. */
  'code-challenge',
  /** A `state` longer than the cookie budget, which we bound rather than truncate. */
  'state-too-long',
  /** RFC 8707 `resource` naming a server that is not us. */
  'resource',
  /** No client document we would accept — the refusal OpenAI's reviewer met. */
  'unknown-client',
  /** The per-IP authorize brake. */
  'rate-limited',
  /** No storage provider is configured on this deployment. */
  'no-provider',
  /** The sealed state was dead, expired or absent when the user pressed Connect. */
  'state-expired',
  /** The provider the sealed state names is not offered any more. */
  'provider-unavailable',
  /** The callback arrived without the `__Host-mcp-state` cookie. */
  'no-cookie',
  /** The provider echoed a `state` that is not the nonce we minted. */
  'nonce-mismatch',
  /** The user said no at the provider, or it sent back no code. */
  'provider-denied',
  /** The provider would not trade its code for a refresh token. */
  'exchange-failed',
  // `/token` answers `invalid_grant` on every dead grant, deliberately: a
  // specific error tells an attacker which check they failed. The COUNTER may
  // say, because nobody outside reads it — these are the words for the last
  // door, where a connection that got a code still never becomes a token.
  // One word for both malformed bodies on purpose: neither has a grant to name,
  // and the pair below shares `token-client` the same way, across both grants.
  /** The body was not form-encoded, or was over the 64 KB cap. */
  'token-bad-request',
  /** Neither `authorization_code` nor `refresh_token`. */
  'token-grant-type',
  /** The authorization code was dead, expired or tampered with. */
  'token-dead-code',
  /** A grant redeemed by a client that is not the one it was minted for. */
  'token-client',
  /** The `redirect_uri` does not match the one the code was minted with. */
  'token-redirect',
  /** The `code_verifier` does not answer the PKCE challenge. */
  'token-pkce',
  /** A code redeemed twice — on this machine, which is all stateless can see. */
  'token-replayed',
  /** The refresh token was dead, expired or tampered with. */
  'token-dead-refresh',
  // US-32 AC38, AC49, the app reviewer sign-in on our own consent page.
  /** A wrong reviewer username or password. */
  'reviewer-credentials',
  /** A reviewer sign-in refused by the failures-only limiter. */
  'reviewer-rate-limited',
  /** A reviewer grant whose secrets were unset or rotated since it was minted. */
  'reviewer-generation',
  /** `/register` refused a redirect list (US-32 AC62). */
  'register-redirect',
] as const;

export type McpOAuthReason = (typeof MCP_OAUTH_REASONS)[number];

/**
 * Which branch of a refusal fired (US-32 AC48): one closed word per reason,
 * named only where the code already knows the branch. Three organic refusals
 * in 2026-10 could not be diagnosed from `reason` alone. Never a URL, host,
 * client id or any other caller-chosen text.
 */
export const MCP_OAUTH_DETAILS = {
  /** `resource` names another host, or this host with another path. */
  resource: ['other-host', 'other-path'],
  /** No `redirect_uri`; a host none of the client's redirects uses; or a
   *  known host differing in anything else, loopback when the registered
   *  redirect on that host is a loopback one. */
  'redirect-uri': ['missing', 'unknown-host', 'known-host-other-path', 'loopback-other-path'],
  /** Neither a DCR id nor an https URL; a DCR id that fails its HMAC or
   *  metadata; a CIMD URL refused before fetching; a fetch that failed; a
   *  document that is not ours to accept; one whose redirects we refuse. */
  'unknown-client': ['malformed', 'dcr-invalid', 'cimd-refused-url', 'cimd-fetch-failed', 'cimd-invalid', 'cimd-redirect-refused'],
  /** Nothing was sent, or what was sent would not unseal (expired or tampered). */
  'no-cookie': ['missing', 'unseal-failed'],
  'token-dead-code': ['missing', 'unseal-failed'],
  'token-dead-refresh': ['missing', 'unseal-failed'],
  /** A list holding a Google relay redirect that was not Gemini's exact shape, or anything else. */
  'register-redirect': ['gemini-like', 'other'],
} as const satisfies Partial<Record<McpOAuthReason, readonly string[]>>;

export type McpOAuthDetail<R extends keyof typeof MCP_OAUTH_DETAILS = keyof typeof MCP_OAUTH_DETAILS> =
  (typeof MCP_OAUTH_DETAILS)[R][number];
