/**
 * Every hosted-MCP door, behind one splat (US-32 Phase 1, design §2).
 *
 *   POST /mcp             the MCP endpoint itself (JSON-RPC)
 *   GET  /mcp/authorize   our consent screen
 *   POST /mcp/authorize   consent given — on to the provider the user picked
 *   GET  /mcp/callback    the provider returns; we mint an authorization code
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
import { mcpClientLabel, mcpEndpoint, originRejected } from '../lib/mcp.server';
import { recordServerEvent } from '../lib/product-events.server';
import { checkAuthorize, sealState, verifyPkce } from '../lib/mcp-authorize.server';
import { readCapped, redirectMatches, registerClient, resolveClient } from '../lib/mcp-clients.server';
import { isMcpEnabled, issuer } from '../lib/mcp-config.server';
import {
  allowAuthorize,
  allowToken,
  claimCode,
  CODE_LIFETIME_SECONDS,
  type CodePayload,
  issueTokens,
  type RefreshPayload,
  type StatePayload,
} from '../lib/mcp-grants.server';
import {
  availableProviders,
  isProvider,
  type McpProvider,
  providerAuthorizeUrl,
  providerExchange,
  providerLabel,
  providerRevokeUrl,
} from '../lib/mcp-providers.server';
import { packSealed, unpackSealed } from '../lib/mcp-seal.server';

/**
 * The consent screen is the only place a provider trip may start, and this
 * cookie is what proves it did. The sealed state rides in the cookie — first
 * party, `__Host-`, HttpOnly — and the provider is handed a 32-byte nonce that the
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
  if (path === 'callback') return providerCallback(request, url);
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
  // Only providers whose secrets exist are offered, so Drive stays invisible
  // until Brad finishes the Google console steps (design §7, phase-2 gate).
  const providers = availableProviders();
  if (providers.length === 0) {
    return oauthError('temporarily_unavailable', 'No storage provider is configured', 503);
  }

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

  // One sealed state per provider: the choice is inside the blob, so the POST
  // cannot be edited into a provider the user did not press.
  const offers = providers.map((provider) => ({
    provider,
    state: sealState(checked.request, provider, Date.now()),
  }));
  return html(consentPage(client.name, offers));
}

/**
 * The provider has sent the user back. Exchange the code for the refresh token
 * we will seal, then hand the CLIENT its own authorization code — a 60-second
 * blob carrying the PKCE challenge it must answer.
 */
async function providerCallback(request: Request, url: URL): Promise<Response> {
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

  const refreshToken = await providerExchange(state.provider, code);
  if (!refreshToken) {
    back.searchParams.set('error', 'server_error');
    back.searchParams.set('error_description', `${providerLabel(state.provider)} would not complete the connection`);
    return redirectTo(back.toString(), clear);
  }

  const payload: CodePayload = {
    clientId: state.clientId,
    provider: state.provider,
    redirectUri: state.redirectUri,
    codeChallenge: state.codeChallenge,
    rt: refreshToken,
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + CODE_LIFETIME_SECONDS,
  };
  back.searchParams.set('code', packSealed('code', state.clientId, payload));
  // One value-free row per completed connection: which assistant, which cloud.
  // Fire-and-forget — a counter never stands between the user and their record.
  void recordServerEvent('mcp_connect', {
    client: mcpClientLabel(state.clientId),
    provider: state.provider === 'google' ? 'google-drive' : 'dropbox',
  });
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
 * and hand the provider the nonce alone.
 */
async function consentGiven(request: Request): Promise<Response> {
  const body = await cappedBody(request);
  if (body === null) return tooLarge();
  const state = unpackSealed<StatePayload>('state', new URLSearchParams(body).get('state') ?? '');
  if (!state) return htmlError('That sign-in took too long. Please start again from your assistant.');
  // The provider is read from the sealed state, never from the form, and a
  // provider whose secrets have since gone is refused rather than half-tried.
  if (!isProvider(state.provider) || !availableProviders().includes(state.provider)) {
    return htmlError('That storage provider is not available here. Please start again from your assistant.');
  }

  const nonce = crypto.randomBytes(32).toString('base64url');
  const sealed = packSealed('state', state.clientId, { ...state, nonce });
  return redirectTo(providerAuthorizeUrl(state.provider, nonce), {
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
    if (!redirectMatches(code.redirectUri, form.get('redirect_uri') ?? '')) return oauthError('invalid_grant', 'That code is not usable');
    if (!verifyPkce(form.get('code_verifier') ?? '', code.codeChallenge)) {
      return oauthError('invalid_grant', 'That code is not usable');
    }
    // Best-effort, per machine: OAuth 2.1 wants single-use codes and stateless
    // cannot promise it across Fly machines. Redemption still needs the
    // verifier, which never leaves the client (design §4).
    if (!claimCode(code.jti)) return oauthError('invalid_grant', 'That code is not usable');
    return Response.json(issueTokens(clientId, code.provider, code.rt, Date.now()), { headers: NO_STORE });
  }

  if (grant === 'refresh_token') {
    const refresh = unpackSealed<RefreshPayload>('refresh', form.get('refresh_token') ?? '');
    if (!refresh || refresh.clientId !== clientId) return oauthError('invalid_grant', 'Please reconnect');
    // The original expiry travels through, so 90 days runs from consent.
    return Response.json(issueTokens(clientId, refresh.provider, refresh.rt, Date.now(), refresh.exp), {
      headers: NO_STORE,
    });
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

/**
 * One shell for every state the connect flow renders: the consent screen and
 * every error. Self-contained — inline styles only, so the `default-src 'none';
 * style-src 'unsafe-inline'` policy above needs no widening, and no webfont.
 */
function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--line:#e6e5e0;--ink:#16302a;--dim:#5f6b66;
--brand:#00a38b;--brand-ink:#00806d;--radius:14px}
@media (prefers-color-scheme:dark){:root{--bg:#101413;--card:#181d1c;--line:#2a3230;
--ink:#eef2f0;--dim:#9aa8a3;--brand:#26bfa6;--brand-ink:#26bfa6}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,
BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
-webkit-font-smoothing:antialiased;
padding:calc(env(safe-area-inset-top) + 28px) calc(env(safe-area-inset-right) + 16px)
calc(env(safe-area-inset-bottom) + 40px) calc(env(safe-area-inset-left) + 16px)}
main{max-width:30rem;margin-inline:auto}
.mark{display:flex;align-items:center;gap:8px;font-size:14px;letter-spacing:.02em;
color:var(--dim);margin-bottom:22px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--brand);flex:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
padding:26px 22px}
h1{margin:0 0 10px;font-size:1.5rem;line-height:1.25;letter-spacing:-.015em}
p{margin:0 0 14px}
.lede{color:var(--dim)}
.who{font-weight:600;color:var(--ink)}
form{margin:0}
.pick{display:flex;flex-direction:column;gap:10px;margin:22px 0 4px}
button{display:flex;width:100%;min-height:52px;align-items:center;gap:12px;
font:600 16px/1.2 inherit;color:#fff;background:var(--brand);border:0;
border-radius:12px;padding:14px 18px;cursor:pointer;text-align:left}
button:hover{background:var(--brand-ink)}
button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
button svg{flex:none}
h2{margin:26px 0 10px;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;
color:var(--dim)}
ul{margin:0;padding:0;list-style:none}
li{position:relative;padding:0 0 0 20px;margin-bottom:9px;color:var(--ink)}
li::before{content:"";position:absolute;left:2px;top:.62em;width:6px;height:6px;
border-radius:50%;background:var(--brand)}
.fine{margin-top:22px;padding-top:18px;border-top:1px solid var(--line);
font-size:14px;color:var(--dim)}
.fine p{margin:0 0 10px}
.fine p:last-child{margin:0}
a{color:var(--brand-ink);text-decoration:underline;text-underline-offset:2px}
.rev{overflow-wrap:anywhere}
</style>
</head><body><main>
<div class="mark"><span class="dot"></span>Health by Dr Brad</div>
<div class="card"><h1>${escapeHtml(title)}</h1>${inner}</div>
</main></body></html>`;
}

function htmlError(message: string, headers: Record<string, string> = {}): Response {
  return html(page('Something went wrong', `<p class="lede">${escapeHtml(message)}</p>`), 400, headers);
}

/** A provider's own glyph, drawn inline: no image request, no CSP widening. */
function providerMark(provider: McpProvider): string {
  if (provider === 'dropbox') {
    return `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="#fff">
<path d="M6 2 0 6l6 4 6-4-6-4Zm12 0-6 4 6 4 6-4-6-4ZM0 14l6 4 6-4-6-4-6 4Zm18-4-6 4 6 4 6-4-6-4ZM6 19.5 12 23.5l6-4-6-4-6 4Z"/></svg>`;
  }
  return `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="#fff">
<path d="M8.7 2.2h6.6l6.6 11.4h-6.6L8.7 2.2Z"/><path d="M7.1 4 .5 15.4l3.3 5.7 6.6-11.4L7.1 4Z"/>
<path d="M5.6 15.9h16.3l-3.3 5.7H2.3l3.3-5.7Z"/></svg>`;
}

/**
 * What the user is actually agreeing to, in the words §1 approved. The
 * assistant's name is text it chose, so it is escaped.
 */
function consentPage(clientName: string, offers: Array<{ provider: McpProvider; state: string }>): string {
  // One form per provider, each carrying its own sealed state. A button is a
  // choice of cloud, and the choice is sealed the moment it is offered.
  const buttons = offers
    .map(
      ({ provider, state }) => `<form method="post">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<button type="submit">${providerMark(provider)}<span>Continue to ${escapeHtml(providerLabel(provider))}</span></button>
</form>`,
    )
    .join('\n');
  const revoke = offers.map(({ provider }) => providerRevokeUrl(provider)).join(' or ');
  // Name only the clouds actually on offer: the sentence follows the buttons.
  const clouds = offers.map(({ provider }) => providerLabel(provider)).join(' or ');
  return page(
    'Where do you want to keep your health record?',
    `<p class="lede"><span class="who">${escapeHtml(clientName)}</span> wants to connect to your health record.</p>
<p class="lede">Your health record is yours, and yours alone. Keep it in your own ${escapeHtml(clouds)}. Your assistant reads and writes one file there. Nothing is stored on our server.</p>
<div class="pick">${buttons}</div>
<h2>What the assistant can do</h2>
<ul>
<li>Read your record and produce your plan.</li>
<li>Add measurements and lab results.</li>
<li>Correct a recent value. Nothing is ever deleted.</li>
<li>Update your sex, birth year, birth month and height.</li>
<li>File a bug report as a public issue on GitHub, in your words, without your health values, and
without asking again.</li>
</ul>
<div class="fine">
<p>We count calls, never your values.
<a href="https://drstanfield.com/pages/connector-privacy">Privacy notice</a> ·
<a href="https://drstanfield.com/pages/roadmap">Setup guide</a></p>
<p>Your record stays in your own storage. Our server reads it in memory to answer your assistant and
keeps no copy.</p>
<p class="rev">Disconnect any time at ${escapeHtml(revoke)}.</p>
<p>Educational, not medical advice.</p>
</div>`,
  );
}
