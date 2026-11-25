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
import { sameBytes } from '../lib/crypto-compare.server';
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { getClientIp } from '../lib/local-first-route.server';
import { cappedBody } from '../lib/capped-body.server';
import { mcpClientLabel, mcpEndpoint, originRejected } from '../lib/mcp.server';
import { recordServerEvent } from '../lib/product-events.server';
import { type AuthorizeRequest, checkAuthorize, sealState, verifyPkce } from '../lib/mcp-authorize.server';
import {
  redirectMatches,
  registerClient,
  registrationRefused,
  resolveClient,
  type ClientMiss,
  type McpClientLabel,
} from '../lib/mcp-clients.server';
import { isMcpEnabled, issuer } from '../lib/mcp-config.server';
import { allowAuthorize, allowRateLimitEvent, allowToken, claimCode, CODE_LIFETIME_SECONDS, grantLive, issueTokens, STATE_LIFETIME_SECONDS, type CodePayload, type Grant, type RefreshPayload, type StatePayload } from '../lib/mcp-grants.server';
import {
  availableProviders,
  isProvider,
  providerAuthorizeUrl,
  providerExchange,
  providerLabel,
  providerTag,
} from '../lib/mcp-providers.server';
import { packSealed, unpackSealed } from '../lib/mcp-seal.server';
import { reviewerClient, reviewerFailures, reviewerGeneration, reviewerLoginMatches, reviewerOffered } from '../lib/mcp-reviewer.server';
import type { McpOAuthDetail, McpOAuthReason } from '../../packages/health-core/src/product-events';
import { consentPage, html, htmlError, NO_STORE, page } from '../lib/mcp-pages.server';

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

/**
 * One shape for every funnel row, built in one place (US-32 AC34). A refused
 * connection knows a `client_id`, a `redirect_uri` and a `state`, all
 * caller-chosen text: what reaches a row is the client's LABEL, the provider
 * as the counter spells it, and the name of the check that failed.
 */
function authorizeRefused(reason: McpOAuthReason, client: McpClientLabel, detail?: McpOAuthDetail): void {
  void recordServerEvent('mcp_authorize_refused', { client, reason, detail });
}

/**
 * Whatever grant we have, when we have one: before a seal opens, a failure can
 * say only why. Any of the three payloads fits, and so does `/token`'s own
 * pair of a form `client_id` with the provider its grant names. `isProvider`
 * guards the provider key, because the seal is ours but the counter's
 * vocabulary is closed and this is the one word that could come from outside it.
 */
function connectFailed(reason: McpOAuthReason, grant?: { clientId: string; provider?: string }, detail?: McpOAuthDetail): void {
  void recordServerEvent('mcp_connect_failed', {
    ...(grant ? { client: mcpClientLabel(grant.clientId) } : {}),
    ...(grant && isProvider(grant.provider) ? { provider: providerTag(grant.provider) } : {}),
    reason,
    detail,
  });
}

/** Why a sealed blob did not open, as the counter's word: nothing sent, or it would not unseal (US-32 AC48). */
const sealMiss = (sent: string | null | undefined) => (sent ? 'unseal-failed' : 'missing') satisfies McpOAuthDetail;

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

function oauthError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status, headers: NO_STORE });
}

function tooLarge(): Response {
  return oauthError('invalid_request', 'That request body is too large', 413);
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
  return sameBytes(Buffer.from(returned, 'utf8'), Buffer.from(expected, 'utf8'));
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
  // A bare visit is a person who typed or followed the address, not a client
  // that failed a check: no row, no fetch, and a sentence that says where to go.
  if (!url.searchParams.get('client_id')) {
    return html(page('Start from your assistant', '<p class="lede">This page opens when you connect Health by Dr Brad from your assistant. Go back to your assistant and press Connect.</p>'));
  }
  // The label, not the id: a client id is caller-chosen text, and an id we do
  // not recognise is `other` — the same word every refusal below carries.
  const who = mcpClientLabel(url.searchParams.get('client_id') ?? '');
  // Rate-limit BEFORE resolving the client: resolving may fetch a URL the
  // caller chose, which is the expensive and abusable half (design §4).
  const ip = getClientIp(request, 'fly');
  if (!allowAuthorize(ip)) {
    // Once per IP per window: a flood is when this branch runs, so a row per
    // refused request would spend a database insert on every one of them.
    if (allowRateLimitEvent(ip)) authorizeRefused('rate-limited', who);
    return new Response('Too many requests', { status: 429 });
  }
  // Only providers whose secrets exist are offered, so Drive stays invisible
  // until Brad finishes the Google console steps (design §7, phase-2 gate).
  const providers = availableProviders();
  if (providers.length === 0) {
    authorizeRefused('no-provider', who);
    return oauthError('temporarily_unavailable', 'No storage provider is configured', 503);
  }

  const miss: ClientMiss = {};
  const client = await resolveClient(url.searchParams.get('client_id') ?? '', Date.now(), miss);
  // An unknown client can never be answered by redirecting — that would make
  // this an open redirector.
  if (!client) {
    authorizeRefused('unknown-client', who, miss.detail);
    return htmlError('We do not recognise the app that sent you here.');
  }

  const checked = checkAuthorize(url.searchParams, client);
  if (!checked.ok) {
    authorizeRefused(checked.reason, who, checked.detail);
    if (!checked.redirectable) return htmlError('That sign-in link is malformed.');
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    back.searchParams.set('error', checked.error);
    back.searchParams.set('error_description', checked.description);
    back.searchParams.set('iss', issuer());
    const state = url.searchParams.get('state');
    if (state) back.searchParams.set('state', state);
    return redirectTo(back.toString());
  }

  void recordServerEvent('mcp_authorize_shown', { client: who });
  return html(consentFor(checked.request));
}

/**
 * The consent page for one checked request. One sealed state per provider:
 * the choice is inside the blob, so the POST cannot be edited into a provider
 * the user did not press. Freshly sealed on every render, a reviewer retry's
 * included (US-32 AC38).
 */
function consentFor(request: AuthorizeRequest, error?: string): string {
  const offers = availableProviders().map((provider) => ({
    provider,
    state: sealState(request, provider, Date.now()),
  }));
  return consentPage(request.client, offers, error);
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
    connectFailed('no-cookie', undefined, sealMiss(held));
    return htmlError('That sign-in did not start here, or it took too long. Please start again from your assistant.');
  }
  const clear = { 'Set-Cookie': CLEAR_STATE_COOKIE };
  if (!state.nonce || !sameNonce(url.searchParams.get('state') ?? '', state.nonce)) {
    connectFailed('nonce-mismatch', state);
    return htmlError('That sign-in could not be matched to this browser. Please start again from your assistant.', clear);
  }

  const denied = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const back = clientReturn(state);

  if (denied || !code) {
    connectFailed('provider-denied', state);
    back.searchParams.set('error', 'access_denied');
    return redirectTo(back.toString(), clear);
  }

  const refreshToken = await providerExchange(state.provider, code);
  if (!refreshToken) {
    connectFailed('exchange-failed', state);
    back.searchParams.set('error', 'server_error');
    back.searchParams.set('error_description', `${providerLabel(state.provider)} would not complete the connection`);
    return redirectTo(back.toString(), clear);
  }

  return redirectTo(mintClientCode(state, { rt: refreshToken }), clear);
}

/** The client's own redirect, with `iss` (RFC 9207) and its `state`: every answer to it starts here. */
function clientReturn(state: StatePayload): URL {
  const back = new URL(state.redirectUri);
  back.searchParams.set('iss', issuer());
  if (state.clientState) back.searchParams.set('state', state.clientState);
  return back;
}

/**
 * Hand the CLIENT its own authorization code — a 60-second blob carrying the
 * PKCE challenge it must answer — and say where to send it. One door for both
 * ways in: a provider's refresh token, or a reviewer's generation with no
 * token at all (US-32 AC38).
 */
function mintClientCode(state: StatePayload, grant: Grant): string {
  const payload: CodePayload = {
    clientId: state.clientId,
    provider: state.provider,
    redirectUri: state.redirectUri,
    codeChallenge: state.codeChallenge,
    ...grant,
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + CODE_LIFETIME_SECONDS,
  };
  const back = clientReturn(state);
  back.searchParams.set('code', packSealed('code', state.clientId, payload));
  // One value-free row per code minted: which assistant, which cloud, and
  // whether it was the reviewer's door. Redemption failures are counted at
  // `/token` as `mcp_connect_failed`, so this row says the door opened, not
  // that the client walked through.
  // Fire-and-forget — a counter never stands between the user and their record.
  void recordServerEvent('mcp_connect', {
    client: mcpClientLabel(state.clientId),
    provider: providerTag(state.provider),
    ...(grant.rv === undefined ? {} : { via: 'reviewer' as const }),
  });
  return back.toString();
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
  const form = new URLSearchParams(body);
  const state = unpackSealed<StatePayload>('state', form.get('state') ?? '');
  if (!state) {
    connectFailed('state-expired');
    return htmlError('That sign-in took too long. Please start again from your assistant.');
  }
  const who = mcpClientLabel(state.clientId);
  // The provider is read from the sealed state, never from the form, and a
  // provider whose secrets have since gone is refused rather than half-tried.
  if (!isProvider(state.provider) || !availableProviders().includes(state.provider)) {
    connectFailed('provider-unavailable', state);
    return htmlError('That storage provider is not available here. Please start again from your assistant.');
  }
  if (form.get('reviewer') === '1') return reviewerSignIn(request, form, state);
  void recordServerEvent('mcp_consent_posted', { client: who, provider: providerTag(state.provider) });

  const nonce = crypto.randomBytes(32).toString('base64url');
  const sealed = packSealed('state', state.clientId, { ...state, nonce });
  return redirectTo(providerAuthorizeUrl(state.provider, nonce), {
    // Derived, never retyped: the cookie must outlive the seal or a timeout
    // reads as "that sign-in did not start here", which is the wrong sentence.
    // The seal still binds first — its clock started at the authorize GET.
    'Set-Cookie': `${STATE_COOKIE}=${sealed}; ${STATE_COOKIE_ATTRS}; Max-Age=${STATE_LIFETIME_SECONDS}`,
  });
}

/**
 * Anthropic's reviewer pressed Sign in (US-32 AC38, AC49). The exact pinned Claude
 * or Claude Code client, the Dropbox state, and the secrets set — or the page they came from
 * could not have shown the form. The password is the only security boundary;
 * the limiter counts failures alone and only stops noise. Nothing here logs
 * or echoes what was typed.
 */
function reviewerSignIn(request: Request, form: URLSearchParams, state: StatePayload): Response {
  const generation = reviewerGeneration();
  const client = reviewerClient(state.clientId);
  if (!client || !generation || !reviewerOffered(state.clientId, state.provider)) {
    return htmlError('That sign-in is not available here. Please start again from your assistant.');
  }
  const ip = getClientIp(request, 'fly');
  const retry = (reason: 'reviewer-credentials' | 'reviewer-rate-limited', message: string, status: number) => {
    // One row per IP per window, per reason: a flood is when these run.
    if (allowRateLimitEvent(`${reason}:${ip}`)) connectFailed(reason, state);
    const again: AuthorizeRequest = {
      client,
      redirectUri: state.redirectUri,
      codeChallenge: state.codeChallenge,
      clientState: state.clientState,
    };
    return html(consentFor(again, message), status);
  };
  if (reviewerFailures.remaining(ip) === 0) {
    return retry('reviewer-rate-limited', 'Too many wrong sign-ins from this network. Please wait 15 minutes, then try again.', 429);
  }
  if (!reviewerLoginMatches(form.get('username') ?? '', form.get('password') ?? '')) {
    reviewerFailures.take(ip, 1);
    return retry('reviewer-credentials', 'That username or password is not right.', 200);
  }
  return redirectTo(mintClientCode(state, { rt: '', rv: generation }));
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
    // No form yet, so no client either: the word is the whole row.
    connectFailed('token-bad-request');
    return oauthError('invalid_request', 'Send application/x-www-form-urlencoded');
  }
  const body = await cappedBody(request);
  if (body === null) {
    connectFailed('token-bad-request');
    return tooLarge();
  }
  const form = new URLSearchParams(body);
  const clientId = form.get('client_id') ?? '';
  const grant = form.get('grant_type');

  if (grant === 'authorization_code') {
    const code = unpackSealed<CodePayload>('code', form.get('code') ?? '');
    const from = { clientId, provider: code?.provider };
    // One sentence for every dead code, and one word each to the counter: the
    // client is told nothing about WHICH check it failed, on purpose.
    const dead = (reason: McpOAuthReason, detail?: McpOAuthDetail) => {
      connectFailed(reason, from, detail);
      return oauthError('invalid_grant', 'That code is not usable');
    };
    if (!code) return dead('token-dead-code', sealMiss(form.get('code')));
    if (code.clientId !== clientId) return dead('token-client');
    if (!redirectMatches(code.redirectUri, form.get('redirect_uri') ?? '')) return dead('token-redirect');
    if (!verifyPkce(form.get('code_verifier') ?? '', code.codeChallenge)) return dead('token-pkce');
    // Best-effort, per machine: OAuth 2.1 wants single-use codes and stateless
    // cannot promise it across Fly machines. Redemption still needs the
    // verifier, which never leaves the client (design §4).
    if (!claimCode(code.jti)) return dead('token-replayed');
    // A reviewer code never resolves to the token here: it is re-sealed with
    // its generation, and only if that generation is still the live one.
    if (!grantLive(code)) return dead('reviewer-generation');
    return Response.json(issueTokens(clientId, code.provider, code, Date.now()), { headers: NO_STORE });
  }

  if (grant === 'refresh_token') {
    const refresh = unpackSealed<RefreshPayload>('refresh', form.get('refresh_token') ?? '');
    const dead = (reason: McpOAuthReason, detail?: McpOAuthDetail) => {
      connectFailed(reason, { clientId, provider: refresh?.provider }, detail);
      return oauthError('invalid_grant', 'Please reconnect');
    };
    if (!refresh) return dead('token-dead-refresh', sealMiss(form.get('refresh_token')));
    if (refresh.clientId !== clientId) return dead('token-client');
    if (!grantLive(refresh)) return dead('reviewer-generation');
    // The original expiry travels through, so 90 days runs from consent.
    return Response.json(issueTokens(clientId, refresh.provider, refresh, Date.now(), refresh.exp), {
      headers: NO_STORE,
    });
  }

  connectFailed('token-grant-type', { clientId });
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
    if (allowRateLimitEvent(`register:${getClientIp(request, 'fly')}`)) void recordServerEvent('mcp_authorize_refused', { reason: 'register-redirect', detail: registrationRefused(body) });
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
