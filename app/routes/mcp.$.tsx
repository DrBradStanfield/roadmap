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
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { getClientIp } from '../lib/local-first-route.server';
import { mcpEndpoint, originRejected } from '../lib/mcp.server';
import {
  allowAuthorize,
  checkAuthorize,
  claimCode,
  CODE_LIFETIME_SECONDS,
  CONNECTION_WRITES,
  dropboxAuthorizeUrl,
  dropboxConfigured,
  dropboxExchange,
  isMcpEnabled,
  issuer,
  issueTokens,
  packSealed,
  registerClient,
  resolveClient,

  sealState,
  unpackSealed,
  verifyPkce,
  type CodePayload,
  type RefreshPayload,
  type StatePayload,
} from '../lib/mcp-auth.server';



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
  if (path === 'callback') return dropboxCallback(url);
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
  if (!allowAuthorize(getClientIp(request))) {
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
    return Response.redirect(back.toString(), 302);
  }

  const sealed = sealState(checked.request, Date.now());
  return html(consentPage(client.name, sealed));
}

/**
 * Dropbox has sent the user back. Exchange the code for the refresh token we
 * will seal, then hand the CLIENT its own authorization code — a 60-second
 * blob carrying the PKCE challenge it must answer.
 */
async function dropboxCallback(url: URL): Promise<Response> {
  const state = unpackSealed<StatePayload>('state', url.searchParams.get('state') ?? '');
  if (!state) return htmlError('That sign-in took too long. Please start again from your assistant.');

  const denied = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const back = new URL(state.redirectUri);
  back.searchParams.set('iss', issuer());
  if (state.clientState) back.searchParams.set('state', state.clientState);

  if (denied || !code) {
    back.searchParams.set('error', 'access_denied');
    return Response.redirect(back.toString(), 302);
  }

  const refreshToken = await dropboxExchange(code);
  if (!refreshToken) {
    back.searchParams.set('error', 'server_error');
    back.searchParams.set('error_description', 'Dropbox would not complete the connection');
    return Response.redirect(back.toString(), 302);
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
  return Response.redirect(back.toString(), 302);
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

/** The user pressed Connect. Everything we need is inside the sealed state. */
async function consentGiven(request: Request): Promise<Response> {
  const form = await request.formData();
  const sealed = String(form.get('state') ?? '');
  const state = unpackSealed<StatePayload>('state', sealed);
  if (!state) return htmlError('That sign-in took too long. Please start again from your assistant.');
  return Response.redirect(dropboxAuthorizeUrl(sealed), 302);
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
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/x-www-form-urlencoded')) {
    return oauthError('invalid_request', 'Send application/x-www-form-urlencoded');
  }
  const form = new URLSearchParams(await request.text());
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
    return Response.json(issueTokens(clientId, code.rt, CONNECTION_WRITES, Date.now()), { headers: NO_STORE });
  }

  if (grant === 'refresh_token') {
    const refresh = unpackSealed<RefreshPayload>('refresh', form.get('refresh_token') ?? '');
    if (!refresh || refresh.clientId !== clientId) return oauthError('invalid_grant', 'Please reconnect');
    return Response.json(issueTokens(clientId, refresh.rt, refresh.budget, Date.now()), { headers: NO_STORE });
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
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
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

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Referrer-Policy': 'no-referrer',
      ...NO_STORE,
    },
  });
}

function htmlError(message: string): Response {
  return html(page('Something went wrong', `<p>${escapeHtml(message)}</p>`), 400);
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

