/**
 * Every hosted-MCP door, behind one splat (US-32 Phase 1, design §2).
 *
 *   POST /mcp             the MCP endpoint itself (JSON-RPC)
 *   GET  /mcp/authorize   our consent screen
 *   POST /mcp/authorize   consent given — on to Dropbox
 *   GET  /mcp/callback    Dropbox returns; we mint an authorization code
 *   POST /mcp/token       code and refresh grants (form-encoded)
 *   POST /mcp/register    DCR fallback (JSON)
 *
 * Two body parsers in one file is a real trap, so it is stated once here:
 * `/token` is `application/x-www-form-urlencoded` and `/register` is
 * `application/json`, per RFC 6749 and RFC 7591 respectively.
 *
 * NOTHING IN THIS FILE MAY LOG A REQUEST URL. The `code`, `state` and
 * `code_verifier` all travel in query strings.
 *
 * The whole feature is inert until `MCP_SEAL_KEYS` exists: every path 404s,
 * so this code ships before the secrets do.
 */
import crypto from 'node:crypto';
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { getClientIp } from '../lib/local-first-route.server';
import { mcpEndpoint, originRejected } from '../lib/mcp.server';
import {
  allowAuthorize,
  allowToken,
  checkAuthorize,
  claimCode,
  CODE_LIFETIME_SECONDS,
  dropboxAuthorizeUrl,
  dropboxConfigured,
  dropboxExchange,
  isMcpEnabled,
  issuer,
  issueTokens,
  packSealed,
  readCapped,
  registerClient,
  resolveClient,
  sealState,
  unpackSealed,
  verifyPkce,
  type CodePayload,
  type RefreshPayload,
  type StatePayload,
} from '../lib/mcp-auth.server';

/**
 * The consent screen is the only place a Dropbox trip may start, and this
 * cookie is what proves it did. The sealed state rides in the cookie — first
 * party, `__Host-`, HttpOnly — and Dropbox is handed a 32-byte nonce that the
 * cookie's state names. So a forged `/mcp/callback` from anywhere else has no
 * cookie and gets a 400, and the ~1 KB blob never has to survive a provider's
 * `state` parameter (Dropbox's documented limit is 500 bytes; verify it live
 * at the first connection, per the runbook).
 */
const STATE_COOKIE = '__Host-mcp-state';
const STATE_COOKIE_ATTRS = 'Secure; HttpOnly; SameSite=Lax; Path=/';
const CLEAR_STATE_COOKIE = `${STATE_COOKIE}=; ${STATE_COOKIE_ATTRS}; Max-Age=0`;

/** 64 KB at the OAuth doors: a registration document is the largest honest body. */
const AUTH_BODY_CAP = 64 * 1024;



function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

/** No CORS headers, ever (design §6) — and no caching of an OAuth answer. */
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function oauthError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status, headers: NO_STORE });
}

/** Client-supplied text reaches HTML here, so it is escaped, never trusted. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function tooLarge(): Response {
  return oauthError('invalid_request', 'That request body is too large', 413);
}

/** Read a form or JSON body, capped, or null when it is over the cap. */
async function cappedBody(request: Request): Promise<string | null> {
  try {
    return await readCapped(request, AUTH_BODY_CAP);
  } catch {
    return null;
  }
}

function redirectTo(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...NO_STORE, ...headers } });
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

function sameNonce(returned: string, expected: string): boolean {
  const a = Buffer.from(returned, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function segment(params: Record<string, string | undefined>): string {
  return (params['*'] ?? '').replace(/^\/+|\/+$/g, '');
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (!isMcpEnabled()) return notFound();
  if (originRejected(request)) return new Response('Forbidden', { status: 403 });
  const path = segment(params);
  const url = new URL(request.url);

  // 405 on GET at the MCP endpoint: there is no event stream to open, and no
  // session to resume. `Mcp-Session-Id` and `Last-Event-ID` are ignored.
  if (path === '') return mcpEndpoint(request);
  if (path === 'authorize') return authorizeScreen(request, url);
  if (path === 'callback') return dropboxCallback(request, url);
  return notFound();
}

/**
 * Our own consent screen. It is not decoration: we forward the user to a
 * STATIC upstream Dropbox client id, so without an explicit consent step here
 * we would be a confused deputy — a second client could ride a first client's
 * already-granted upstream session. The MCP spec requires this screen for
 * exactly that reason.
 */
async function authorizeScreen(request: Request, url: URL): Promise<Response> {
  // Rate-limit BEFORE resolving the client: resolving may fetch a URL the
  // caller chose, which is the expensive and abusable half (design §4).
  if (!allowAuthorize(getClientIp(request, 'fly'))) {
    return new Response('Too many requests', { status: 429 });
  }
  if (!dropboxConfigured()) return oauthError('temporarily_unavailable', 'Dropbox is not configured', 503);

  const client = await resolveClient(url.searchParams.get('client_id') ?? '');
  // An unknown client can never be answered by redirecting — that would make
  // this an open redirector.
  if (!client) return htmlError('We do not recognise the app that sent you here.');

  const checked = checkAuthorize(url.searchParams, client);
  if (!checked.ok) {
    if (!checked.redirectable) return htmlError('That sign-in link is malformed.');
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    back.searchParams.set('error', checked.error);
    back.searchParams.set('error_description', checked.description);
    back.searchParams.set('iss', issuer());
    const state = url.searchParams.get('state');
    if (state) back.searchParams.set('state', state);
    return redirectTo(back.toString());
  }

  const sealed = sealState(checked.request, Date.now());
  return html(consentPage(client.name, sealed));
}

/**
 * Dropbox has sent the user back. Exchange the code for the refresh token we
 * will seal, then hand the CLIENT its own authorization code — a 60-second
 * blob carrying the PKCE challenge it must answer.
 */
async function dropboxCallback(request: Request, url: URL): Promise<Response> {
  // The cookie is the whole check: without it this browser never saw our
  // consent screen, so there is nothing to continue and nothing to redirect to.
  const held = readCookie(request, STATE_COOKIE);
  const state = held ? unpackSealed<StatePayload>('state', held) : null;
  if (!state) {
    return htmlError('That sign-in did not start here, or it took too long. Please start again from your assistant.');
  }
  const clear = { 'Set-Cookie': CLEAR_STATE_COOKIE };
  if (!state.nonce || !sameNonce(url.searchParams.get('state') ?? '', state.nonce)) {
    return htmlError('That sign-in could not be matched to this browser. Please start again from your assistant.', clear);
  }

  const denied = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const back = new URL(state.redirectUri);
  back.searchParams.set('iss', issuer());
  if (state.clientState) back.searchParams.set('state', state.clientState);

  if (denied || !code) {
    back.searchParams.set('error', 'access_denied');
    return redirectTo(back.toString(), clear);
  }

  const refreshToken = await dropboxExchange(code);
  if (!refreshToken) {
    back.searchParams.set('error', 'server_error');
    back.searchParams.set('error_description', 'Dropbox would not complete the connection');
    return redirectTo(back.toString(), clear);
  }

  const payload: CodePayload = {
    clientId: state.clientId,
    redirectUri: state.redirectUri,
    codeChallenge: state.codeChallenge,
    rt: refreshToken,
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + CODE_LIFETIME_SECONDS,
  };
  back.searchParams.set('code', packSealed('code', state.clientId, payload));
  return redirectTo(back.toString(), clear);
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function action({ request, params }: ActionFunctionArgs) {
  if (!isMcpEnabled()) return notFound();
  if (originRejected(request)) return new Response('Forbidden', { status: 403 });
  const path = segment(params);

  if (path === '') return mcpEndpoint(request);
  if (path === 'authorize') return consentGiven(request);
  if (path === 'token') return tokenEndpoint(request);
  if (path === 'register') return registerEndpoint(request);
  // DELETE at the MCP endpoint: there is no session to end.
  return notFound();
}

/**
 * The user pressed Connect. This is where the flow becomes bound to THIS
 * browser: we mint a nonce, seal it into the state, put the state in a cookie,
 * and hand Dropbox the nonce alone.
 */
async function consentGiven(request: Request): Promise<Response> {
  const body = await cappedBody(request);
  if (body === null) return tooLarge();
  const state = unpackSealed<StatePayload>('state', new URLSearchParams(body).get('state') ?? '');
  if (!state) return htmlError('That sign-in took too long. Please start again from your assistant.');

  const nonce = crypto.randomBytes(32).toString('base64url');
  const sealed = packSealed('state', state.clientId, { ...state, nonce });
  return redirectTo(dropboxAuthorizeUrl(nonce), {
    'Set-Cookie': `${STATE_COOKIE}=${sealed}; ${STATE_COOKIE_ATTRS}; Max-Age=600`,
  });
}

/**
 * `/token`. Both grants answer `invalid_grant` on ANY dead grant — expired,
 * replayed, tampered, wrong client — because a custom code is one Claude never
 * recovers from, and a specific one tells an attacker which check they failed.
 *
 * Claude allows 10 seconds here and the code grant does a Dropbox exchange
 * inside that budget. Measure it (design §7).
 */
async function tokenEndpoint(request: Request): Promise<Response> {
  // A flood brake only: a whole vendor's users share one egress range, so this
  // limit is generous by design (design §4, "useless when distributed").
  if (!allowToken(getClientIp(request, 'fly'))) return new Response('Too many requests', { status: 429 });
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/x-www-form-urlencoded')) {
    return oauthError('invalid_request', 'Send application/x-www-form-urlencoded');
  }
  const body = await cappedBody(request);
  if (body === null) return tooLarge();
  const form = new URLSearchParams(body);
  const clientId = form.get('client_id') ?? '';
  const grant = form.get('grant_type');

  if (grant === 'authorization_code') {
    const code = unpackSealed<CodePayload>('code', form.get('code') ?? '');
    if (!code || code.clientId !== clientId) return oauthError('invalid_grant', 'That code is not usable');
    if (form.get('redirect_uri') !== code.redirectUri) return oauthError('invalid_grant', 'That code is not usable');
    if (!verifyPkce(form.get('code_verifier') ?? '', code.codeChallenge)) {
      return oauthError('invalid_grant', 'That code is not usable');
    }
    // Best-effort, per machine: OAuth 2.1 wants single-use codes and stateless
    // cannot promise it across Fly machines. Redemption still needs the
    // verifier, which never leaves the client (design §4).
    if (!claimCode(code.jti)) return oauthError('invalid_grant', 'That code is not usable');
    return Response.json(issueTokens(clientId, code.rt, Date.now()), { headers: NO_STORE });
  }

  if (grant === 'refresh_token') {
    const refresh = unpackSealed<RefreshPayload>('refresh', form.get('refresh_token') ?? '');
    if (!refresh || refresh.clientId !== clientId) return oauthError('invalid_grant', 'Please reconnect');
    // The original expiry travels through, so 90 days runs from consent.
    return Response.json(issueTokens(clientId, refresh.rt, Date.now(), refresh.exp), { headers: NO_STORE });
  }

  return oauthError('unsupported_grant_type', 'Only authorization_code and refresh_token');
}

/**
 * RFC 7591 dynamic registration, with no registry: the `client_id` we return
 * carries its own metadata under an HMAC, so a later `/authorize` can verify
 * it without a row. Clients that support CIMD never come here.
 */
async function registerEndpoint(request: Request): Promise<Response> {
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
    return oauthError('invalid_client_metadata', 'Send application/json');
  }
  const text = await cappedBody(request);
  if (text === null) return tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return oauthError('invalid_client_metadata', 'That is not JSON');
  }
  const client = registerClient(body);
  if (!client) {
    return oauthError('invalid_redirect_uri', 'This server registers only known assistant redirect URIs');
  }
  return Response.json(
    {
      client_id: client.clientId,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    { status: 201, headers: NO_STORE },
  );
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      // `same-origin`, NOT `no-referrer`: under `no-referrer` a browser posts the
      // consent form with `Origin: null`, which `originRejected` refuses — the
      // consent step could not complete in a real browser at all. That Origin
      // check IS the CSRF defence on this POST: the cookie is SET by it, so
      // SameSite protects nothing here, and browsers attach an Origin to every
      // cross-site POST (as `null` when the referrer is suppressed).
      'Referrer-Policy': 'same-origin',
      ...NO_STORE,
      ...headers,
    },
  });
}

function htmlError(message: string, headers: Record<string, string> = {}): Response {
  return html(page('Something went wrong', `<p>${escapeHtml(message)}</p>`), 400, headers);
}

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:2.5rem 1.25rem;max-width:34rem;
margin-inline:auto;color:#1b1b1b;background:#fbfbf9}h1{font-size:1.4rem}
ul{padding-left:1.1rem}button{font:inherit;padding:.7rem 1.4rem;border:0;border-radius:.4rem;
background:#1b5e4b;color:#fff;cursor:pointer}small{color:#555}</style>
</head><body><h1>${escapeHtml(title)}</h1>${inner}</body></html>`;
}

/**
 * What the user is actually agreeing to, in the words §1 approved. The
 * assistant's name is text it chose, so it is escaped.
 */
function consentPage(clientName: string, sealedState: string): string {
  return page(
    'Connect your health record',
    `<p><strong>${escapeHtml(clientName)}</strong> is asking to read and add to your health record.</p>
<p>Your record still lives only in your Dropbox. Our server reads it, in memory, to answer your
assistant, and your assistant holds a sealed credential only we can open. We keep no copy.</p>
<ul>
<li>It can read your record and compute your plan.</li>
<li>It can add measurements and lab results, and correct a recent value. It cannot delete anything.</li>
<li>You cancel it at <span>dropbox.com/account/connected_apps</span>. That also disconnects this
website from your folder, and you can reconnect in one click.</li>
</ul>
<form method="post">
<input type="hidden" name="state" value="${escapeHtml(sealedState)}">
<button type="submit">Continue to Dropbox</button>
</form>
<p><small>Educational, not medical advice.</small></p>`,
  );
}

