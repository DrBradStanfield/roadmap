/**
 * The `/authorize` query, the consent screen's sealed state, and PKCE
 * (US-32, design §4).
 *
 * NOTHING HERE MAY LOG A URL. A fault in `redirect_uri` or `client_id` can
 * never be reported by redirecting, so the checks below say which errors may
 * travel back to the client and which the route must render itself.
 */
import crypto from 'node:crypto';
import type { McpOAuthReason } from '../../packages/health-core/src/product-events';
import { issuer, resourceUrl } from './mcp-config.server';
import { isAllowedRedirect, redirectMatches, type McpClient } from './mcp-clients.server';
import { nowSeconds, STATE_LIFETIME_SECONDS, type StatePayload } from './mcp-grants.server';
import type { McpProvider } from './mcp-providers.server';
import { packSealed } from './mcp-seal.server';


/**
 * `state` is the CLIENT's opaque value and it must come back byte-identical.
 * We used to `.slice(0, 512)` it, which is the one thing a relying party can
 * never recover from: OpenAI's platform relay sends 521 characters, got a
 * 512-character stump back, and rejected every ChatGPT connection with
 * "Invalid OAuth state".
 *
 * So it is bounded instead of shortened, and the bound is set by the
 * `__Host-mcp-state` cookie. `sealState` pads to a fixed bucket; at this cap a
 * sealed state lands in the 2048 bucket and the whole Set-Cookie line is about
 * 3.1 KB, comfortably inside the 4096 bytes browsers allow. The next bucket up
 * puts it at ~5.8 KB, where the browser drops the cookie without a word and
 * the callback finds nothing. 1024 is twice what OpenAI sends and more than
 * Claude does, with the rest of the bucket left for a longer client id.
 */
export const MAX_STATE_LENGTH = 1024;

export interface AuthorizeRequest {
  client: McpClient;
  redirectUri: string;
  codeChallenge: string;
  clientState: string;
}

/** The client's host, or a label — never the id itself, which may be long. */
/**
 * Is this RFC 8707 `resource` us? A trailing slash is not a different
 * audience, and a client that names the issuer rather than the resource still
 * means this server — we are both. Anything else is refused, so this widens
 * the spelling and never the audience.
 */
function isThisResource(resource: string): boolean {
  const bare = (url: string) => url.replace(/\/$/, '');
  const named = bare(resource);
  // Both sides: MCP_ISSUER is a secret we do not control the spelling of, and a
  // trailing slash on it would otherwise make the server refuse its own issuer.
  return named === bare(resourceUrl()) || named === bare(issuer());
}

function clientHost(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return 'registered-client';
  }
}

export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; error: string; description: string; redirectable: boolean; reason: McpOAuthReason };

/**
 * The OAuth answer for each refusal word. One table, so the `error` code the
 * client reads and the `reason` the counter groups by cannot drift apart: a
 * new branch adds a row here and gets both halves at once.
 */
const OAUTH_FAILURES = {
  'redirect-uri': ['invalid_request', 'Unknown redirect_uri'],
  'response-type': ['unsupported_response_type', 'Only response_type=code'],
  pkce: ['invalid_request', 'PKCE S256 is required'],
  'code-challenge': ['invalid_request', 'Malformed code_challenge'],
  'state-too-long': ['invalid_request', 'state is too long'],
  resource: ['invalid_target', 'This server is not that resource'],
} as const satisfies Record<string, readonly [string, string]>;

function fail(reason: keyof typeof OAUTH_FAILURES, redirectable = true): AuthorizeCheck {
  const [error, description] = OAUTH_FAILURES[reason];
  return { ok: false, error, description, redirectable, reason };
}

/**
 * Validate an `/authorize` query. A fault in `redirect_uri` or `client_id` can
 * NEVER be reported by redirecting — that would make us an open redirector —
 * so `redirectable` tells the route which errors may go back to the client and
 * which must be rendered here.
 */
export function checkAuthorize(params: URLSearchParams, client: McpClient): AuthorizeCheck {
  const redirectUri = params.get('redirect_uri') ?? '';
  if (!client.redirectUris.some((registered) => redirectMatches(registered, redirectUri)) || !isAllowedRedirect(redirectUri)) {
    // The HOST only, never the URL or the query — this file may not log a URL.
    // A vendor quietly changing its callback shows up in Sentry as this line
    // with its own hostname; anything else is someone probing us.
    console.error(`[mcp] authorize refused: redirect_uri not allowed for client host ${clientHost(client.clientId)}`);
    return fail('redirect-uri', false);
  }
  if (params.get('response_type') !== 'code') return fail('response-type');
  if (params.get('code_challenge_method') !== 'S256') return fail('pkce');
  const codeChallenge = params.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) return fail('code-challenge');
  const clientState = params.get('state') ?? '';
  if (clientState.length > MAX_STATE_LENGTH) return fail('state-too-long');
  // RFC 8707. The audience must be this server, or a token we mint here could
  // be replayed somewhere else — the confused-deputy the MCP spec warns about.
  // An empty `resource=` names no audience, so it is absent, not wrong: a
  // client that serialises every parameter it knows sends the key with nothing
  // in it, and refusing that is refusing a connection over punctuation.
  const resource = params.get('resource');
  if (resource && !isThisResource(resource)) return fail('resource');
  return {
    ok: true,
    request: {
      client,
      redirectUri,
      codeChallenge,
      clientState,
    },
  };
}

/**
 * The state the consent screen holds. The nonce is empty here on purpose: it
 * is minted when the user presses Connect, so a state blob obtained from the
 * consent page alone can never satisfy the callback.
 */
export function sealState(request: AuthorizeRequest, provider: McpProvider, nowMs: number): string {
  const payload: StatePayload = {
    clientId: request.client.clientId,
    provider,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    clientState: request.clientState,
    nonce: '',
    exp: nowSeconds(nowMs) + STATE_LIFETIME_SECONDS,
  };
  return packSealed('state', request.client.clientId, payload);
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export function verifyPkce(codeVerifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) return false;
  const derived = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  const a = Buffer.from(derived);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
