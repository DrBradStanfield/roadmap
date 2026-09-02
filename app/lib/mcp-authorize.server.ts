/**
 * The `/authorize` query, the consent screen's sealed state, and PKCE
 * (US-32, design §4).
 *
 * NOTHING HERE MAY LOG A URL. A fault in `redirect_uri` or `client_id` can
 * never be reported by redirecting, so the checks below say which errors may
 * travel back to the client and which the route must render itself.
 */
import crypto from 'node:crypto';
import { resourceUrl } from './mcp-config.server';
import { isAllowedRedirect, redirectMatches, type McpClient } from './mcp-clients.server';
import { nowSeconds, type StatePayload } from './mcp-grants.server';
import type { McpProvider } from './mcp-providers.server';
import { packSealed } from './mcp-seal.server';

const STATE_LIFETIME_SECONDS = 10 * 60;

export interface AuthorizeRequest {
  client: McpClient;
  redirectUri: string;
  codeChallenge: string;
  clientState: string;
}

/** The client's host, or a label — never the id itself, which may be long. */
function clientHost(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return 'registered-client';
  }
}

export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; error: string; description: string; redirectable: boolean };

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
    return { ok: false, error: 'invalid_request', description: 'Unknown redirect_uri', redirectable: false };
  }
  const fail = (error: string, description: string): AuthorizeCheck =>
    ({ ok: false, error, description, redirectable: true });

  if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code');
  if (params.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE S256 is required');
  const codeChallenge = params.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) return fail('invalid_request', 'Malformed code_challenge');
  // RFC 8707. The audience must be this server, or a token we mint here could
  // be replayed somewhere else — the confused-deputy the MCP spec warns about.
  const resource = params.get('resource');
  if (resource !== null && resource !== resourceUrl()) {
    return fail('invalid_target', 'This server is not that resource');
  }
  return {
    ok: true,
    request: {
      client,
      redirectUri,
      codeChallenge,
      clientState: (params.get('state') ?? '').slice(0, 512),
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
