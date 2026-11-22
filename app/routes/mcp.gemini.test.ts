/**
 * US-32 AC59-AC62 (Brad 2026-11-23) · Gemini as an accepted connector client.
 *
 * Gemini's custom connector registers several per-user relay redirects on
 * Google's own host. The server answers that registration with one pinned
 * client, accepts at `/authorize` only a redirect of that one shape naming
 * THIS server, and asks `/token` for the very redirect `/authorize` saw.
 *
 * Same harness as `mcp.hosted.test.ts`: real Requests through the route's own
 * loader/action, Dropbox's token endpoint stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const claims = vi.hoisted(() => ({ state: null as null | import('../lib/single-use-claims.test-helpers').ClaimsState }));
vi.mock('../lib/supabase-client.server', async (actual) => {
  const helpers = await import('../lib/single-use-claims.test-helpers');
  claims.state ??= helpers.newClaimsState();
  return { ...(await actual<object>()), supabaseAdmin: helpers.claimsAdmin(claims.state) };
});
import { resetClaimsState } from '../lib/single-use-claims.test-helpers';
vi.mock('../lib/product-events.server', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/product-events.server')>();
  return { ...original, recordServerEvent: vi.fn(async () => {}) };
});
import { recordServerEvent } from '../lib/product-events.server';
import { resetMcpMemory } from '../lib/mcp-grants.server';
import { KNOWN_CLIENTS } from '../lib/mcp-clients.server';
import { GEMINI_CLIENT_ID, GEMINI_MAX_STATE_LENGTH, isGeminiRedirect } from '../lib/mcp-gemini.server';
import { action, loader } from './mcp.$';

/** The test issuer's host, mcp.example.test, gives the slug mcp_example_test. */
const ISSUER = 'https://mcp.example.test';
const RELAY = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-';
const USER_A = `${RELAY}104857600012345678901-mcp_example_test`;
const USER_B = `${RELAY}209715200098765432109-mcp_example_test`;
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');

beforeEach(() => {
  resetClaimsState(claims.state!);
  process.env.MCP_ISSUER = ISSUER;
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 3).toString('base64');
  process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 4).toString('base64');
  process.env.DROPBOX_APP_KEY = 'app-key';
  process.env.DROPBOX_APP_SECRET = 'app-secret';
  process.env.MCP_GEMINI = 'on';
  resetMcpMemory();
  vi.mocked(recordServerEvent).mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    refresh_token: `dropbox-refresh-token-${crypto.randomUUID()}`,
    access_token: 'dropbox-access-token',
    expires_in: 14400,
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MCP_SEAL_KEYS;
  delete process.env.MCP_GEMINI;
});

function unescapeHtml(text: string): string {
  return text.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
}

function get(path: string, headers: HeadersInit = {}): Promise<Response> {
  const url = new URL(path, ISSUER);
  const splat = url.pathname.replace(/^\/mcp\/?/, '');
  return Promise.resolve(loader({ request: new Request(url, { headers }), params: { '*': splat }, context: {} } as never)) as Promise<Response>;
}

function post(path: string, init: RequestInit): Promise<Response> {
  const url = new URL(path, ISSUER);
  const splat = url.pathname.replace(/^\/mcp\/?/, '');
  return Promise.resolve(action({ request: new Request(url, { method: 'POST', ...init }), params: { '*': splat }, context: {} } as never)) as Promise<Response>;
}

function register(redirectUris: string[]): Promise<Response> {
  return post('/mcp/register', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Gemini', redirect_uris: redirectUris }),
  });
}

function authorize(redirect: string, state: string): Promise<Response> {
  return get(`/mcp/authorize?${new URLSearchParams({
    client_id: GEMINI_CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state,
    resource: `${ISSUER}/mcp`,
  })}`);
}

/** Authorize, consent, come back from Dropbox: the code and where it went. */
async function codeFor(redirect: string, state: string): Promise<URL> {
  const consent = await authorize(redirect, state);
  expect(consent.status).toBe(200);
  const sealed = unescapeHtml(/name="state" value="([^"]+)"/.exec(await consent.text())![1]);
  const pressed = await post('/mcp/authorize', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: sealed }),
  });
  expect(pressed.status).toBe(302);
  const cookie = pressed.headers.get('set-cookie')!.split(';')[0];
  const nonce = new URL(pressed.headers.get('location')!).searchParams.get('state')!;
  const back = await get(`/mcp/callback?code=dropbox-code&state=${encodeURIComponent(nonce)}`, { cookie });
  expect(back.status).toBe(302);
  return new URL(back.headers.get('location')!);
}

function token(form: Record<string, string>): Promise<Response> {
  return post('/mcp/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
}

describe('US-32 AC59: isGeminiRedirect accepts one shape, naming this server', () => {
  it('accepts the field-observed relay shape for this server', () => {
    expect(isGeminiRedirect(USER_A)).toBe(true);
    expect(isGeminiRedirect(`${RELAY}a_B9-mcp_example_test`)).toBe(true);
  });

  it.each([
    ['http', USER_A.replace('https:', 'http:')],
    ['another host', USER_A.replace('oauth-redirect.', 'evil.')],
    ['a subdomain trick', USER_A.replace('googleusercontent.com', 'googleusercontent.com.evil.test')],
    ['a host suffix trick', USER_A.replace('oauth-redirect.', 'xoauth-redirect.')],
    ['the sandbox relay', USER_A.replace('oauth-redirect.', 'oauth-redirect-sandbox.')],
    ['the test relay', USER_A.replace('oauth-redirect.', 'oauth-redirect-test.')],
    ['an uppercase host', USER_A.replace('oauth-redirect.googleusercontent.com', 'OAUTH-REDIRECT.googleusercontent.com')],
    ['an IDN host', USER_A.replace('oauth-redirect.', 'oauth-redіrect.')],
    ['an explicit port', USER_A.replace('.com/', '.com:443/')],
    ['userinfo', USER_A.replace('https://', 'https://u@')],
    ['an /a/ path', USER_A.replace('/r/', '/a/')],
    ['another path prefix', USER_A.replace('user_bound_custom-mcp-', 'user_bound_other-')],
    ['another server slug', USER_A.replace('mcp_example_test', 'mcp_evil_test')],
    ['a trailing segment', `${USER_A}/x`],
    ['a trailing slash', `${USER_A}/`],
    ['a query', `${USER_A}?x=1`],
    ['a fragment', `${USER_A}#x`],
    ['an encoded slash', `${RELAY}1%2F2-mcp_example_test`],
    ['an encoded dot', `${RELAY}1%2E2-mcp_example_test`],
    ['a dot segment', `${RELAY}../1-mcp_example_test`],
    ['an empty id', `${RELAY}-mcp_example_test`],
    ['an over-long id', `${RELAY}${'1'.repeat(65)}-mcp_example_test`],
    ['an @ in the id', `${RELAY}1@2-mcp_example_test`],
    ['a backslash in the id', `${RELAY}1\\2-mcp_example_test`],
    ['a tab in the id', `${RELAY}1\t2-mcp_example_test`],
    ['a newline in the id', `${RELAY}1\n2-mcp_example_test`],
    ['a non-ASCII digit in the id', `${RELAY}1٣2-mcp_example_test`],
    ['a hyphen in the id', `${RELAY}1-2-mcp_example_test`],
    ['%2F in the id', `${RELAY}1%2F2-mcp_example_test`],
    ['a claude callback', 'https://claude.ai/api/mcp/auth_callback'],
    ['loopback', 'http://localhost/callback'],
  ])('refuses %s', (_, uri) => {
    expect(isGeminiRedirect(uri)).toBe(false);
  });
});

describe('US-32 AC60: registration answers Gemini with one pinned client', () => {
  it('six Gemini redirects register as the pinned Gemini client', async () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => `${RELAY}${n}0000000000-mcp_example_test`);
    const res = await register(six);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBe(GEMINI_CLIENT_ID);
    expect(body.client_id.length).toBeLessThan(16);
    expect(body.redirect_uris).toEqual(six);
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('a mixed list is refused, and the refusal counts only its closed category', async () => {
    const res = await register([USER_A, 'https://evil.test/cb']);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
    expect(recordServerEvent).toHaveBeenCalledWith('mcp_authorize_refused', { reason: 'register-redirect', detail: 'gemini-like' });
  });

  it('an unrelated refusal is "other", and the row holds no URI or host', async () => {
    await register(['https://evil.test/cb']);
    const calls = vi.mocked(recordServerEvent).mock.calls;
    expect(calls).toEqual([['mcp_authorize_refused', { reason: 'register-redirect', detail: 'other' }]]);
    expect(JSON.stringify(calls)).not.toContain('evil');
  });

  it('a Gemini redirect for another server is refused', async () => {
    expect((await register([USER_A.replace('mcp_example_test', 'mcp_evil_test')])).status).toBe(400);
  });
});

describe('US-32 AC61: authorize and token for the pinned Gemini client', () => {
  it('a ~1,400-character state completes to a code, and token needs the same redirect and PKCE', async () => {
    const state = 's'.repeat(1400);
    const back = await codeFor(USER_A, state);
    expect(back.origin + back.pathname).toBe(USER_A.split('?')[0]);
    expect(back.searchParams.get('state')).toBe(state);
    const code = back.searchParams.get('code')!;
    const base = { grant_type: 'authorization_code', code, client_id: GEMINI_CLIENT_ID };

    // Another user's Gemini redirect is a valid shape, and still not this code's.
    expect((await token({ ...base, redirect_uri: USER_B, code_verifier: VERIFIER })).status).toBe(400);
    expect((await token({ ...base, redirect_uri: USER_A, code_verifier: 'w'.repeat(64) })).status).toBe(400);
    const ok = await token({ ...base, redirect_uri: USER_A, code_verifier: VERIFIER });
    expect(ok.status).toBe(200);
    expect((await ok.json()).access_token).toBeTruthy();
    // Single use.
    expect((await token({ ...base, redirect_uri: USER_A, code_verifier: VERIFIER })).status).toBe(400);
  });

  it('the consent screen names Gemini with the known-client sentence', async () => {
    const html = unescapeHtml(await (await authorize(USER_A, 'x')).text());
    expect(html).toContain('<span class="who">Gemini</span> wants to connect to your health record.');
    expect(html).toContain('What we can tell you about it: it is a known client.');
    expect(recordServerEvent).toHaveBeenCalledWith('mcp_authorize_shown', expect.objectContaining({ client: 'gemini' }));
  });

  it(`the state cap: ${GEMINI_MAX_STATE_LENGTH} fits with the longest id, one more is refused`, async () => {
    const longest = `${RELAY}${'9'.repeat(64)}-mcp_example_test`;
    expect((await authorize(longest, 's'.repeat(GEMINI_MAX_STATE_LENGTH))).status).toBe(200);
    const over = await authorize(longest, 's'.repeat(GEMINI_MAX_STATE_LENGTH + 1));
    expect(over.status).toBe(302);
    expect(new URL(over.headers.get('location')!).searchParams.get('error_description')).toBe('state is too long');
  });

  it('a look-alike redirect is refused without a redirect, and the Gemini pin opens nothing for others', async () => {
    const res = await authorize(USER_A.replace('oauth-redirect.', 'oauth-redirect-sandbox.'), 'x');
    expect(res.status).toBe(400);
    expect((await get(`/mcp/authorize?${new URLSearchParams({
      client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
      redirect_uri: USER_A, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'x',
    })}`)).status).toBe(400);
  });
});

describe('US-32 AC63: the MCP_GEMINI switch, off unless exactly "on"', () => {
  it.each([undefined, '', 'ON', 'true', '1', ' on'])('MCP_GEMINI=%j: no pin, main\'s refusal, no gemini client anywhere', async (value) => {
    if (value === undefined) delete process.env.MCP_GEMINI;
    else process.env.MCP_GEMINI = value;
    const refused = await register([USER_A]);
    const legacy = await register(['https://evil.test/cb']);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(await legacy.text());
    const res = await authorize(USER_A, 'x');
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('Gemini');
  });

  it('switching off ends a code minted while on', async () => {
    const back = await codeFor(USER_A, 'x');
    process.env.MCP_GEMINI = 'off';
    const res = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: GEMINI_CLIENT_ID, redirect_uri: USER_A, code_verifier: VERIFIER });
    expect(res.status).toBe(400);
  });
});

describe('US-32 AC64: a refused registration counts at most the per-IP allowance', () => {
  it('ten refusals from one IP write one row, in either switch state', async () => {
    for (const state of ['on', 'off']) {
      resetMcpMemory();
      vi.mocked(recordServerEvent).mockClear();
      process.env.MCP_GEMINI = state;
      for (let i = 0; i < 10; i++) expect((await register([USER_A, 'https://evil.test/cb'])).status).toBe(400);
      expect(vi.mocked(recordServerEvent).mock.calls.filter(([name]) => name === 'mcp_authorize_refused')).toHaveLength(1);
    }
  });
});

describe('US-32 AC65: any Gemini redirect beside any other is refused before truncation', () => {
  const five = Array.from({ length: 5 }, () => 'https://claude.ai/api/mcp/auth_callback');
  it.each(['on', 'off'])('MCP_GEMINI=%s: Gemini in position 6, and in position 1', async (state) => {
    process.env.MCP_GEMINI = state;
    expect((await register([...five, USER_A])).status).toBe(400);
    expect((await register([USER_A, ...five])).status).toBe(400);
  });

  it('nine Gemini redirects, an empty list, or a non-string entry are refused', async () => {
    expect((await register(Array.from({ length: 9 }, () => USER_A))).status).toBe(400);
    expect((await register([])).status).toBe(400);
    expect((await post('/mcp/register', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [USER_A, 7] }),
    })).status).toBe(400);
  });

  it('the pin keeps no redirect list, and authorize judges gemini by shape alone', async () => {
    expect(KNOWN_CLIENTS.get(GEMINI_CLIENT_ID)!.redirectUris).toEqual([]);
    expect((await authorize('https://claude.ai/api/mcp/auth_callback', 'x')).status).toBe(400);
  });
});
