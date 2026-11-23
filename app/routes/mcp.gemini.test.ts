/**
 * US-32 AC59-AC66 (Brad 2026-11-23) · Gemini as an accepted connector client.
 *
 * Gemini's custom connector registers several per-user relay redirects on
 * Google's own host. The server answers that registration with one pinned
 * client, accepts at `/authorize` only a redirect of that one shape, and asks
 * `/token` for the very redirect `/authorize` saw.
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
import { GEMINI_CLIENT_ID, GEMINI_MAX_STATE_LENGTH, isGeminiRedirect, redirectShapes } from '../lib/mcp-gemini.server';
import { action, loader } from './mcp.$';

const ISSUER = 'https://mcp.example.test';
const RELAY = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-';
/** Made-up ids in the shape Gemini sends: 24 lowercase letters and digits, nothing after. */
const USER_A = `${RELAY}abcdefabcdef012345012345`;
const USER_B = `${RELAY}012345012345abcdefabcdef`;
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

describe('US-32 AC59: isGeminiRedirect accepts one shape, the one Gemini sends', () => {
  it('accepts the relay prefix and a 16 to 40 character lowercase id, nothing after', () => {
    expect(USER_A.length).toBe(93);
    expect(isGeminiRedirect(USER_A)).toBe(true);
    expect(isGeminiRedirect(`${RELAY}${'a1'.repeat(8)}`)).toBe(true);
    expect(isGeminiRedirect(`${RELAY}${'a1'.repeat(20)}`)).toBe(true);
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
    ['the old slug form naming this server', `${USER_A}-mcp_example_test`],
    ['the old slug form with a word id', `${RELAY}a_B9-mcp_example_test`],
    ['a 15-character id', `${RELAY}${'a'.repeat(15)}`],
    ['a 41-character id', `${RELAY}${'a'.repeat(41)}`],
    ['an uppercase id', `${RELAY}ABCDEFABCDEF012345012345`],
    ['one uppercase letter in the id', `${RELAY}Abcdefabcdef012345012345`],
    ['an underscore in the id', `${RELAY}abcdefabcdef_12345012345`],
    ['an extra path', `${USER_A}/extra/path`],
    ['a trailing segment', `${USER_A}/x`],
    ['a trailing slash', `${USER_A}/`],
    ['a query', `${USER_A}?x=1`],
    ['a fragment', `${USER_A}#x`],
    ['a trailing newline', `${USER_A}\n`],
    ['an encoded slash', `${RELAY}abcdefabcd%2F012345012345`],
    ['an encoded dot', `${RELAY}abcdefabcd%2E012345012345`],
    ['a dot segment', `${RELAY}../abcdefabcdef012345012345`],
    ['an empty id', RELAY],
    ['an @ in the id', `${RELAY}abcdefabcdef@12345012345`],
    ['a backslash in the id', `${RELAY}abcdefabcdef\\12345012345`],
    ['a tab in the id', `${RELAY}abcdefabcdef\t12345012345`],
    ['a newline in the id', `${RELAY}abcdefabcdef\n12345012345`],
    ['a non-ASCII digit in the id', `${RELAY}abcdefabcdef٣12345012345`],
    ['a hyphen in the id', `${RELAY}abcdefabcdef-12345012345`],
    ['a claude callback', 'https://claude.ai/api/mcp/auth_callback'],
    ['loopback', 'http://localhost/callback'],
  ])('refuses %s', (_, uri) => {
    expect(isGeminiRedirect(uri)).toBe(false);
  });
});

describe('US-32 AC60: registration answers Gemini with one pinned client', () => {
  it('six Gemini redirects register as the pinned Gemini client', async () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => `${RELAY}abcdefabcdef01234501234${n}`);
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

  it('the old slug form is refused, and its refusal still counts as gemini-like', async () => {
    expect((await register([`${USER_A}-mcp_example_test`])).status).toBe(400);
    expect(recordServerEvent).toHaveBeenCalledWith('mcp_authorize_refused', { reason: 'register-redirect', detail: 'gemini-like' });
  });

  it('authorize accepts the real shape and refuses the old slug form', async () => {
    expect((await authorize(USER_A, 'x')).status).toBe(200);
    expect((await authorize(`${USER_A}-mcp_example_test`, 'x')).status).toBe(400);
  });
});

describe('US-32 AC59/AC60: the list of six Gemini sends registers; authorize stays strict', () => {
  const ID = 'abcdefabcdef012345012345';
  const HOSTS = ['oauth-redirect-sandbox', 'oauth-redirect-test', 'oauth-redirect'];
  const at = (host: string, letter: string) => `https://${host}.googleusercontent.com/${letter}/user_bound_custom-mcp-${ID}`;
  /** The order the shape log recorded: the three hosts with /r/, then the three with the other letter. */
  const SIX = [...HOSTS.map((h) => at(h, 'r')), ...HOSTS.map((h) => at(h, 'a'))];
  const MAIN = at('oauth-redirect', 'r');
  const NON_AUTHORIZE = SIX.filter((u) => u !== MAIN);

  it('the six register as the pinned client, and the answer lists only the one authorize accepts', async () => {
    const res = await register(SIX);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBe(GEMINI_CLIENT_ID);
    expect(body.redirect_uris).toEqual([MAIN]);
  });

  it.each([
    ['one extra outside redirect', [...SIX, 'https://evil.test/cb']],
    ['a look-alike relay host', [...SIX.slice(1), at('oauth-redirect-prod', 'r')]],
    ['a relay host under another domain', [...SIX.slice(1), MAIN.replace('googleusercontent.com', 'googleusercontent.com.evil.test')]],
    ['a two-letter prefix segment', [...SIX.slice(0, 5), at('oauth-redirect', 'ab')]],
    ['an uppercase prefix segment', [...SIX.slice(0, 5), at('oauth-redirect', 'A')]],
    ['a digit prefix segment', [...SIX.slice(0, 5), at('oauth-redirect', '1')]],
    ['only sandbox and test hosts', [at('oauth-redirect-sandbox', 'r'), at('oauth-redirect-test', 'r')]],
    ['only non-/r/ entries', HOSTS.map((h) => at(h, 'a'))],
  ])('refuses %s', async (_, list) => {
    expect((await register(list)).status).toBe(400);
  });

  it.each(NON_AUTHORIZE)('authorize refuses %s', async (uri) => {
    expect((await authorize(uri, 'x')).status).toBe(400);
  });

  it('authorize accepts the main /r/ entry, and token still wants that exact string', async () => {
    expect((await authorize(MAIN, 'x')).status).toBe(200);
    const back = await codeFor(MAIN, 'x');
    const base = { grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: GEMINI_CLIENT_ID, code_verifier: VERIFIER };
    expect((await token({ ...base, redirect_uri: at('oauth-redirect', 'a') })).status).toBe(400);
    expect((await token({ ...base, redirect_uri: MAIN })).status).toBe(200);
  });

  it('switched off, the six are refused', async () => {
    process.env.MCP_GEMINI = 'off';
    expect((await register(SIX)).status).toBe(400);
  });

  it('an accepted six writes no shape line; a list with no /r/ main entry logs its own reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await register(SIX);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(redirectShapes({ redirect_uris: NON_AUTHORIZE }, true)).toContain('reason=no-authorize-shape count=5 ');
    expect(redirectShapes({ redirect_uris: [...SIX, 'https://evil.test/cb'] }, true)).toContain('reason=mixed count=7 ');
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
    const longest = `${RELAY}${'9'.repeat(40)}`;
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

describe('US-32 AC66: a refused Gemini-like registration logs allow-listed words and lengths only', () => {
  const PREFIX = '[mcp] gemini-like registration refused:';
  const shape = (uri: unknown) => redirectShapes({ redirect_uris: [uri] }, true).replace(/^.*? count=1 /, '');
  const shapeLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(PREFIX));

  it('a real-shaped redirect keeps its relay host and words, the id masked', () => {
    expect(shape(USER_A)).toBe('oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id:24>');
    expect(shape(`${RELAY}abcdefghijklmnopqrstuvwx`)).toBe('oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<w:24>');
    expect(shape(`${USER_A}-abc_defghijklm_xyz`)).toBe('oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id:24>-<w:3>_<w:10>_<w:3>');
    expect(shape(USER_A.replace('oauth-redirect.', 'oauth-redirect-sandbox.'))).toBe('oauth-redirect-sandbox.googleusercontent.com/r/user_bound_custom-mcp-<id:24>');
    expect(shape(USER_A.replace('oauth-redirect.', 'oauth-redirect-test.'))).toBe('oauth-redirect-test.googleusercontent.com/r/user_bound_custom-mcp-<id:24>');
  });

  it('a non-relay host logs no host text and no path, only its segment count and length', () => {
    const other = shape('https://example.test/ldl/3.2/weight/81/kg');
    expect(other).toBe('other-host[segments=5,len=21]');
    for (const leak of ['ldl', '3.2', '81', 'weight', 'kg', 'example']) expect(other).not.toContain(leak);
    const google = shape('https://jane-doe-hiv.googleusercontent.com/r/x');
    expect(google).toBe('other-google-host[segments=2,len=4]');
    for (const leak of ['jane', 'doe', 'hiv']) expect(google).not.toContain(leak);
  });

  it('a relay-host path keeps only allow-listed words, and other separators become "?"', () => {
    const line = shape('https://oauth-redirect.googleusercontent.com/r/jane.doe@gmail.com');
    expect(line).toBe('oauth-redirect.googleusercontent.com/r/<w:4>?<w:3>?<w:5>?<w:3>');
    for (const leak of ['jane', 'doe', 'gmail']) expect(line).not.toContain(leak);
    expect(shape(`${RELAY}a%20b~c+d:e`)).toBe('oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<w:1>?<id:3>?<w:1>?<w:1>?<w:1>');
  });

  it('port, userinfo, query and fragment are literals; a non-string and junk are named', () => {
    expect(shape('https://someone:pw@oauth-redirect.googleusercontent.com:8443/r/x?token=secretvalue#fragvalue'))
      .toBe('userinfo@oauth-redirect.googleusercontent.com:port/r/<w:1>?query#fragment');
    expect(shape('https://someone@evil.test:8443/cb?a=b')).toBe('userinfo@other-host:port[segments=1,len=3]?query');
    expect(shape(7)).toBe('non-string');
    expect(shape('not a url')).toBe('unparseable');
  });

  it('the port is read from the raw string, and a redirect the parser rewrites ends "~normalized"', () => {
    expect(shape(USER_A.replace('.com/', '.com:443/'))).toBe('oauth-redirect.googleusercontent.com:port/r/user_bound_custom-mcp-<id:24>~normalized');
    expect(shape(USER_A.replace('.com/', '.com:8443/'))).toBe('oauth-redirect.googleusercontent.com:port/r/user_bound_custom-mcp-<id:24>');
    expect(shape(USER_A.replace('oauth-redirect.', 'OAUTH-redirect.'))).toBe('oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id:24>~normalized');
    expect(shape(USER_A.replace('/r/', '/r/./'))).toBe('oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id:24>~normalized');
    expect(redirectShapes({ redirect_uris: [USER_A, USER_A.replace('.com/', '.com:443/')] }, true))
      .toBe(`${PREFIX} reason=mixed count=2 oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id:24> oauth-redirect.googleusercontent.com:port/r/user_bound_custom-mcp-<id:24>~normalized`);
  });

  it('the four reasons: no match, switch off, over the cap, mixed', () => {
    const otherGoogle = 'https://jane-doe-hiv.googleusercontent.com/r/x';
    expect(redirectShapes({ redirect_uris: [otherGoogle] }, true)).toBe(`${PREFIX} reason=no-match count=1 other-google-host[segments=2,len=4]`);
    expect(redirectShapes({ redirect_uris: [otherGoogle] }, false)).toBe(`${PREFIX} reason=no-match count=1 other-google-host[segments=2,len=4]`);
    expect(redirectShapes({ redirect_uris: [USER_A] }, false)).toBe(`${PREFIX} reason=switch-off count=1 oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id:24>`);
    expect(redirectShapes({ redirect_uris: Array.from({ length: 9 }, () => USER_A) }, true)).toContain(`${PREFIX} reason=over-cap count=9 `);
    expect(redirectShapes({ redirect_uris: [USER_A, 'https://evil.test/cb'] }, true)).toBe(`${PREFIX} reason=mixed count=2 oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id:24> other-host[segments=1,len=3]`);
    expect(redirectShapes({ redirect_uris: 'nope' }, true)).toBe(`${PREFIX} reason=no-match count=0`);
  });

  it('lists 8 redirects then "+N more", and cuts at a whole entry within 600 characters', () => {
    const many = redirectShapes({ redirect_uris: Array.from({ length: 11 }, () => 'https://evil.test/cb') }, true);
    expect(many).toBe(`${PREFIX} reason=no-match count=11 ${'other-host[segments=1,len=3] '.repeat(8)}+3 more`);
    const huge = redirectShapes({ redirect_uris: [`${RELAY}${'a/'.repeat(1000)}`, USER_A] }, true);
    expect(huge).toBe(`${PREFIX} reason=mixed count=2`);
  });

  it('property: over 200 seeded random lists, every 2+ letter-or-digit run is an allow-listed word or a number', () => {
    const ALLOWED = new Set(['oauth', 'redirect', 'sandbox', 'test', 'googleusercontent', 'com', 'other', 'google', 'host',
      'segments', 'len', 'non', 'string', 'unparseable', 'query', 'fragment', 'port', 'userinfo', 'id', 'more', 'mcp', 'gemini',
      'like', 'registration', 'refused', 'reason', 'count', 'switch', 'off', 'over', 'cap', 'mixed', 'no', 'match', 'user',
      'bound', 'custom', 'normalized', 'authorize', 'shape']);
    let seed = 20261123;
    const rand = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n; };
    const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-_.@%:~+?#=&;!$ ';
    const junk = (max: number) => Array.from({ length: rand(max) }, () => CHARS[rand(CHARS.length)]).join('');
    const word = () => Array.from({ length: 1 + rand(12) }, () => CHARS[rand(62)]).join('');
    const RELAYS = ['oauth-redirect', 'oauth-redirect-sandbox', 'oauth-redirect-test'];
    const entry = (): unknown => {
      const kind = rand(6);
      if (kind === 0) return junk(60);
      if (kind === 1) return rand(1000);
      const host = rand(2) ? `${RELAYS[rand(3)]}.googleusercontent.com` : `${word().toLowerCase()}${rand(2) ? '.googleusercontent.com' : '.test'}`;
      const user = rand(4) ? '' : `${word()}@`;
      const port = rand(4) ? '' : `:${1 + rand(9999)}`;
      const path = rand(2) ? `/r/user_bound_custom-mcp-${word()}${junk(20)}` : `/${junk(80)}`;
      return `${rand(2) ? 'https' : 'http'}://${user}${host}${port}${path}`;
    };
    const runs: string[] = [];
    for (let i = 0; i < 200; i++) {
      const line = redirectShapes({ redirect_uris: Array.from({ length: rand(12) }, entry) }, rand(2) === 1);
      expect(line.length).toBeLessThanOrEqual(600);
      runs.push(...(line.match(/[A-Za-z0-9]{2,}/g) ?? []));
    }
    expect(runs.filter((r) => !ALLOWED.has(r) && !/^\d+$/.test(r))).toEqual([]);
    expect(runs.length).toBeGreaterThan(1000);
  });

  it('the route writes one line per refusal allowance, only when gemini-like, never on success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 10; i++) await register([USER_A, 'https://evil.test/cb?id=secretvalue']);
      expect(shapeLines(warn)).toEqual([
        `${PREFIX} reason=mixed count=2 oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id:24> other-host[segments=1,len=3]?query`,
      ]);
      resetMcpMemory();
      warn.mockClear();
      await register(['https://evil.test/cb']);
      await register([USER_A]);
      expect(shapeLines(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
