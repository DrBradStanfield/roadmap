/**
 * US-32 AC38 · OpenAI's reviewer signs in on our own consent page.
 *
 * Twice the reviewer stopped at a third party's login (docs/reviews/
 * 2026-10-01-chatgpt-reviewer-signin-plan.md §1). This is the one password
 * login on the auth server, for one invented account, ChatGPT and Codex clients only, and
 * only while the three reviewer secrets are set. Each test pins one clause of
 * AC38: who sees the form, what a right and a wrong login do, that no blob
 * carries the reviewer's Dropbox token, and that unsetting or rotating either
 * secret ends every reviewer session on its next request of any kind.
 *
 * Same harness as `mcp.hosted.test.ts`: real Requests through the route's own
 * loader/action, Dropbox as an in-memory folder, and its token endpoint stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('node:dns/promises', () => ({ default: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] } }));
vi.mock('../lib/product-events.server', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/product-events.server')>();
  return { ...original, recordServerEvent: vi.fn(async () => {}) };
});
import { MemoryAdapter, MemoryCloud } from '../../packages/health-core/src/memory-adapter';
import { ROADMAP_FILE_NAME } from '../../packages/health-core/src/adapter';
import { createEmptyFile, createMeasurement, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { connectionKey, resetMcpMemory, type AccessPayload, type CodePayload, type RefreshPayload } from '../lib/mcp-grants.server';
import { hash, unpackSealed } from '../lib/mcp-seal.server';
import { mcpEndpoint, setAdapterFactory } from '../lib/mcp.server';
import { recordServerEvent } from '../lib/product-events.server';
import { setImportSeams } from '../lib/mcp-import.server';
import { action, loader } from './mcp.$';

const ISSUER = 'https://mcp.example.test';
const CHATGPT = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_REDIRECTS = [
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback',
];
const CHATGPT_REDIRECT = CHATGPT_REDIRECTS[0];
/** OpenAI tests "ChatGPT and Codex surfaces", so the pinned Codex client sees the box too (US-32 AC38). */
const CODEX = 'https://chatgpt.com/oauth/codex/client.json';
const CODEX_REDIRECT = 'http://127.0.0.1:4567/callback';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const NOW = '2026-09-02T10:00:00.000Z';
const LATER = new Date(Date.parse(NOW) + 11_000).toISOString();

/** A normal username: a plain lowercase word, not hex. */
const USERNAME = 'openaireview';
/** 26 characters from the unambiguous alphabet: no l, 1, o, 0. */
const PASSWORD = 'abcdefghijkmnpqrstuvwxyz23'; // gitleaks:allow, not a secret: test fixture
const sha256hex = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const REVIEWER_RT = 'reviewer-dropbox-refresh-token';
const REVIEWER_ACCESS = 'reviewer-dropbox-access-token';

let cloud: MemoryCloud;
let connections = 0;
/** Every refresh token Dropbox's token endpoint was asked to renew. */
let refreshed: string[];

function setReviewerSecrets(over: Partial<Record<'MCP_REVIEWER_USERNAME' | 'MCP_REVIEWER_PASSWORD_SHA256' | 'MCP_REVIEWER_DROPBOX_RT', string>> = {}): void {
  process.env.MCP_REVIEWER_USERNAME = USERNAME;
  process.env.MCP_REVIEWER_PASSWORD_SHA256 = sha256hex(PASSWORD);
  process.env.MCP_REVIEWER_DROPBOX_RT = REVIEWER_RT;
  Object.assign(process.env, over);
}

function clearReviewerSecrets(): void {
  delete process.env.MCP_REVIEWER_USERNAME;
  delete process.env.MCP_REVIEWER_PASSWORD_SHA256;
  delete process.env.MCP_REVIEWER_DROPBOX_RT;
}

/** Dropbox's token endpoint, plus whatever CIMD document a test serves. */
function stubFetch(documents: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url in documents) return Response.json(documents[url]);
    const body = new URLSearchParams(String(init.body ?? ''));
    if (body.get('grant_type') === 'refresh_token') {
      refreshed.push(body.get('refresh_token') ?? '');
      return Response.json({ access_token: body.get('refresh_token') === REVIEWER_RT ? REVIEWER_ACCESS : 'dropbox-access-token', expires_in: 14400 });
    }
    return Response.json({ refresh_token: `dropbox-refresh-token-${++connections}`, access_token: 'dropbox-access-token', expires_in: 14400 });
  }));
}

/** Which Dropbox access token each adapter was built with. */
let adapterTokens: string[];

beforeEach(() => {
  process.env.MCP_ISSUER = ISSUER;
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 3).toString('base64');
  process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 4).toString('base64');
  process.env.DROPBOX_APP_KEY = 'app-key';
  process.env.DROPBOX_APP_SECRET = 'app-secret';
  setReviewerSecrets();
  resetMcpMemory();
  refreshed = [];
  adapterTokens = [];
  cloud = new MemoryCloud();
  setAdapterFactory((_provider, token) => {
    adapterTokens.push(token);
    return new MemoryAdapter(cloud);
  });
  stubFetch();
  vi.mocked(recordServerEvent).mockClear();
});

afterEach(() => {
  setAdapterFactory(null);
  setImportSeams(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearReviewerSecrets();
  delete process.env.MCP_SEAL_KEYS;
  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_SECRET;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function authorizeQuery(clientId = CHATGPT, redirectUri = CHATGPT_REDIRECT): string {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'chatgpt-state',
    resource: `${ISSUER}/mcp`,
  }).toString();
}

async function consentHtml(clientId = CHATGPT, redirectUri = CHATGPT_REDIRECT): Promise<string> {
  const res = await get(`/mcp/authorize?${authorizeQuery(clientId, redirectUri)}`);
  expect(res.status).toBe(200);
  return res.text();
}

const REVIEWER_HEADING = 'OpenAI app reviewers: sign in here';
const REVIEWER_FORM = /<form method="post" class="reviewer">\s*<input type="hidden" name="state" value="([^"]+)">/;

function hasReviewerForm(html: string): boolean {
  return html.includes(REVIEWER_HEADING) || html.includes('name="password"');
}

/** The reviewer form's sealed state, off the consent page. */
function reviewerState(html: string): string {
  const match = REVIEWER_FORM.exec(html);
  expect(match, 'the consent page carries the reviewer form').not.toBeNull();
  return unescapeHtml(match![1]);
}

/** Every sealed state on the page, provider buttons included, in page order. */
function allStates(html: string): string[] {
  return [...html.matchAll(/name="state" value="([^"]+)"/g)].map((m) => unescapeHtml(m[1]));
}

function signIn(state: string, username: string, password: string, headers: Record<string, string> = {}): Promise<Response> {
  return post('/mcp/authorize', {
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ state, reviewer: '1', username, password }),
  });
}

/** The right login, typed the way a reviewer in a no-paste browser would. */
const TYPED_PASSWORD = 'ABCD EFGH-IJKM npqr STUV-wxyz 23';

async function reviewerCode(redirectUri = CHATGPT_REDIRECT): Promise<string> {
  const res = await signIn(reviewerState(await consentHtml(CHATGPT, redirectUri)), ` ${USERNAME.toUpperCase()} `, TYPED_PASSWORD);
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get('location')!);
  expect(to.origin + to.pathname).toBe(redirectUri);
  expect(to.searchParams.get('state')).toBe('chatgpt-state');
  expect(to.searchParams.get('iss')).toBe(ISSUER);
  return to.searchParams.get('code')!;
}

async function token(form: Record<string, string>): Promise<Response> {
  return post('/mcp/token', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
}

/** Redeem an authorization code at `/token` with the right PKCE verifier, as ChatGPT would. */
function redeem(code: string, redirectUri = CHATGPT_REDIRECT): Promise<Response> {
  return token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: VERIFIER, client_id: CHATGPT });
}

/** Press a provider button: POST its sealed state with no reviewer fields. */
function pressProvider(state: string): Promise<Response> {
  return post('/mcp/authorize', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state }),
  });
}

/** A sealed blob that carries the reviewer generation and no token, of any kind. */
function expectGenerationOnly(type: 'code' | 'access' | 'refresh', blob: string): string {
  const opened = unpackSealed<CodePayload | AccessPayload | RefreshPayload>(type, blob);
  expect(opened, type).not.toBeNull();
  expect(opened!.rt, type).toBe('');
  expect(opened!.rv, type).toMatch(/^[0-9a-f]{16}$/);
  expect(opened!.provider, type).toBe('dropbox');
  expect(JSON.stringify(opened), type).not.toContain(REVIEWER_RT);
  return opened!.rv!;
}

/** chatgpt.com echoes any query string into a CIMD document: this id resolves as a client named "ChatGPT". */
const LOOKALIKE = `${CHATGPT}?x=1`;
const serveLookalike = () => stubFetch({ [LOOKALIKE]: { client_id: LOOKALIKE, client_name: 'ChatGPT', redirect_uris: [CHATGPT_REDIRECT] } });

async function reviewerLogin(redirectUri = CHATGPT_REDIRECT): Promise<{ code: string; access: string; refresh: string }> {
  const code = await reviewerCode(redirectUri);
  const res = await redeem(code, redirectUri);
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as { access_token: string; refresh_token: string };
  return { code, access: tokens.access_token, refresh: tokens.refresh_token };
}

async function rpcStatus(access: string, method: string, params: unknown = {}, now = NOW): Promise<Response> {
  return mcpEndpoint(new Request(`${ISSUER}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), now);
}

async function callTool(access: string, name: string, args: unknown, now = NOW) {
  const res = await rpcStatus(access, 'tools/call', { name, arguments: args }, now);
  expect(res.status).toBe(200);
  const answer = (await res.json()) as { result: { content: Array<{ text: string }>; structuredContent?: unknown; isError?: boolean } };
  return { text: answer.result.content[0].text, structured: answer.result.structuredContent as Record<string, unknown>, isError: answer.result.isError === true };
}

const SEED_DAY = '2026-08-30';

/** The synthetic reviewer record: a profile and one recent measurement. */
function seedReviewerRecord(): void {
  const base = createEmptyFile({ deviceId: 'reviewer', now: '2026-01-01T00:00:00.000Z' });
  const file: RoadmapFile = {
    ...base,
    profile: { ...base.profile, sex: 'male', birthYear: 1979, heightCm: 178 },
    measurements: [createMeasurement({ id: 'ldl-row', metricType: 'ldl', value: 3.2, recordedAt: `${SEED_DAY}T00:00:00.000Z`, createdAt: `${SEED_DAY}T00:00:00.000Z` })],
  };
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
}

function storedRecord(): RoadmapFile {
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
}

function events(name: string): Array<Record<string, unknown>> {
  return vi.mocked(recordServerEvent).mock.calls
    .filter(([event]) => event === name)
    .map(([, meta]) => (meta ?? {}) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Who sees the form
// ---------------------------------------------------------------------------

describe('US-32 AC38 — the form is for the exact pinned ChatGPT and Codex clients, and only while the secrets are set', () => {
  it('shows an open reviewer form ABOVE the provider choice for the pinned ChatGPT client', async () => {
    const html = await consentHtml();
    expect(html).toContain(REVIEWER_HEADING);
    expect(html).toContain('For OpenAI’s app review only. This is not your Dropbox or Google password.');
    expect(html).toContain('Everyone else: choose where your record is kept');
    // Open, not behind a <details>, and first: above every provider button.
    expect(html).not.toContain('<details');
    expect(html.indexOf(REVIEWER_HEADING)).toBeLessThan(html.indexOf('Continue to Dropbox'));
    expect(html.indexOf(REVIEWER_HEADING)).toBeLessThan(html.indexOf('Everyone else'));
    // The username field refuses an email address, and nothing is remembered.
    expect(html).toMatch(/<input[^>]*name="username"[^>]*pattern="\[\^@\]\*"[^>]*autocomplete="off"/);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*name="password"/);
    expect(html).toContain('name="reviewer" value="1"');
    // The form posts the Dropbox state already on the page, never a URL parameter.
    const sealed = unpackSealed<{ provider: string; clientId: string }>('state', reviewerState(html));
    expect(sealed).toMatchObject({ provider: 'dropbox', clientId: CHATGPT });
  });

  it('shows it on both pinned ChatGPT callbacks', async () => {
    for (const redirect of CHATGPT_REDIRECTS) expect(hasReviewerForm(await consentHtml(CHATGPT, redirect))).toBe(true);
  });

  it('shows no form for a ChatGPT id with a query string, which chatgpt.com would echo as a CIMD document', async () => {
    serveLookalike();
    const html = await consentHtml(LOOKALIKE);
    expect(html).toContain('Continue to Dropbox');
    expect(hasReviewerForm(html)).toBe(false);
  });

  it('shows it to the exact pinned Codex client, and not to a Codex id with a query string', async () => {
    expect(hasReviewerForm(await consentHtml(CODEX, CODEX_REDIRECT))).toBe(true);
    const lookalike = `${CODEX}?x=1`;
    stubFetch({ [lookalike]: { client_id: lookalike, client_name: 'Codex', redirect_uris: [CODEX_REDIRECT] } });
    const html = await consentHtml(lookalike, CODEX_REDIRECT);
    expect(html).toContain('Continue to Dropbox');
    expect(hasReviewerForm(html)).toBe(false);
  });

  it('shows no form to Claude, Claude Code, another CIMD client or a DCR client', async () => {
    const other = 'https://assistant.example/client.json';
    stubFetch({ [other]: { client_id: other, client_name: 'ChatGPT', redirect_uris: [CHATGPT_REDIRECT] } });
    const register = await post('/mcp/register', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [CHATGPT_REDIRECT] }),
    });
    const dcr = (await register.json()).client_id as string;
    const cases: Array<[string, string]> = [
      ['https://claude.ai/oauth/mcp-oauth-client-metadata', 'https://claude.ai/api/mcp/auth_callback'],
      ['https://claude.ai/oauth/claude-code-client-metadata', 'http://localhost:4567/callback'],
      [other, CHATGPT_REDIRECT],
      [dcr, CHATGPT_REDIRECT],
    ];
    for (const [clientId, redirect] of cases) {
      const html = await consentHtml(clientId, redirect);
      expect(html, clientId).toContain('Continue to Dropbox');
      expect(hasReviewerForm(html), clientId).toBe(false);
    }
  });

  it('shows no form when any one secret is missing — the between-reviews state', async () => {
    for (const name of ['MCP_REVIEWER_USERNAME', 'MCP_REVIEWER_PASSWORD_SHA256', 'MCP_REVIEWER_DROPBOX_RT'] as const) {
      setReviewerSecrets();
      delete process.env[name];
      const html = await consentHtml();
      expect(hasReviewerForm(html), name).toBe(false);
      expect(html, name).not.toContain('Everyone else');
    }
  });

  it('names the reviewer credential on the page only while the secrets are set', async () => {
    setReviewerSecrets();
    expect(unescapeHtml(await consentHtml())).toContain('the Dropbox credential of one invented reviewer account');
    clearReviewerSecrets();
    // The visible text, not the stylesheet the page shell always carries.
    const text = unescapeHtml((await consentHtml()).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' '));
    expect(text).toContain('Nothing is stored on our server.');
    expect(text).not.toMatch(/reviewer/i);
  });

  it('names the reviewer credential whenever the token is held, even with the box off (partly set)', async () => {
    clearReviewerSecrets();
    process.env.MCP_REVIEWER_DROPBOX_RT = REVIEWER_RT;
    const html = await consentHtml();
    expect(hasReviewerForm(html)).toBe(false);
    expect(unescapeHtml(html)).toContain('the Dropbox credential of one invented reviewer account');
    // A malformed hash beside the token: the same, box off and clause on.
    setReviewerSecrets({ MCP_REVIEWER_PASSWORD_SHA256: 'not-a-hash' });
    const malformed = await consentHtml();
    expect(hasReviewerForm(malformed)).toBe(false);
    expect(unescapeHtml(malformed)).toContain('the Dropbox credential of one invented reviewer account');
  });

  it('shows no form when a secret is malformed, rather than throwing later', async () => {
    const malformed: Array<Record<string, string>> = [
      { MCP_REVIEWER_PASSWORD_SHA256: sha256hex(PASSWORD).toUpperCase() },
      { MCP_REVIEWER_PASSWORD_SHA256: sha256hex(PASSWORD).slice(1) },
      { MCP_REVIEWER_PASSWORD_SHA256: `${sha256hex(PASSWORD)}0` },
      { MCP_REVIEWER_PASSWORD_SHA256: 'z'.repeat(64) },
      { MCP_REVIEWER_USERNAME: 'reviewer@example.com' },
    ];
    for (const over of malformed) {
      setReviewerSecrets(over);
      expect(hasReviewerForm(await consentHtml()), JSON.stringify(Object.keys(over))).toBe(false);
    }
  });

  it('shows no form when Dropbox is not offered', async () => {
    delete process.env.DROPBOX_APP_KEY;
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'g-id';
    process.env.GOOGLE_DRIVE_SECRET = 'g-secret';
    const html = await consentHtml();
    expect(html).toContain('Continue to Google Drive');
    expect(hasReviewerForm(html)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A right login
// ---------------------------------------------------------------------------

describe('US-32 AC38 — the right login connects with no third-party sign-in, and no blob carries the token', () => {
  it('302s with a code, redeems it with PKCE, and reads the reviewer record through the secret token', async () => {
    seedReviewerRecord();
    const { code, access, refresh } = await reviewerLogin();

    // Never the token, in any of the three blobs: the generation instead.
    const generation = expectGenerationOnly('code', code);
    expect(expectGenerationOnly('access', access)).toBe(generation);
    expect(expectGenerationOnly('refresh', refresh)).toBe(generation);

    const read = await callTool(access, 'read_record', {});
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.text).profile).toMatchObject({ birthYear: 1979, heightCm: 178, sex: 'male' });
    // The server renewed the SECRET's token, and the adapter got its access token.
    expect(refreshed).toEqual([REVIEWER_RT]);
    expect(adapterTokens).toEqual([REVIEWER_ACCESS]);
  });

  it('works on both pinned ChatGPT callbacks', async () => {
    seedReviewerRecord();
    for (const redirect of CHATGPT_REDIRECTS) {
      const { access } = await reviewerLogin(redirect);
      expect((await callTool(access, 'read_record', {})).isError).toBe(false);
    }
  });

  it('renews on the refresh grant with the generation, never the token', async () => {
    seedReviewerRecord();
    const { refresh } = await reviewerLogin();
    const res = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CHATGPT });
    expect(res.status).toBe(200);
    const renewed = (await res.json()) as { access_token: string; refresh_token: string };
    expectGenerationOnly('access', renewed.access_token);
    expectGenerationOnly('refresh', renewed.refresh_token);
    expect((await callTool(renewed.access_token, 'read_record', {})).isError).toBe(false);
  });

  it('signs the pinned Codex client in the same way, back to its own loopback callback', async () => {
    seedReviewerRecord();
    const res = await signIn(reviewerState(await consentHtml(CODEX, CODEX_REDIRECT)), USERNAME, PASSWORD);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(CODEX_REDIRECT);
    const code = to.searchParams.get('code')!;
    expectGenerationOnly('code', code);
    const redeemed = await token({ grant_type: 'authorization_code', code, redirect_uri: CODEX_REDIRECT, code_verifier: VERIFIER, client_id: CODEX });
    expect(redeemed.status).toBe(200);
    const { access_token: access } = (await redeemed.json()) as { access_token: string };
    expect((await callTool(access, 'read_record', {})).isError).toBe(false);
    expect(events('mcp_connect')).toEqual([{ client: 'codex', provider: 'dropbox', via: 'reviewer' }]);
  });

  it('counts one mcp_connect with via reviewer, and no consent press', async () => {
    await reviewerCode();
    expect(events('mcp_connect')).toEqual([{ client: 'chatgpt', provider: 'dropbox', via: 'reviewer' }]);
    expect(events('mcp_consent_posted')).toEqual([]);
    expect(events('mcp_connect_failed')).toEqual([]);
  });

  it('still counts the consent press on the provider branch', async () => {
    const res = await pressProvider(allStates(await consentHtml()).at(-1)!);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).origin).toBe('https://www.dropbox.com');
    expect(events('mcp_consent_posted')).toEqual([{ client: 'chatgpt', provider: 'dropbox' }]);
  });
});

// ---------------------------------------------------------------------------
// A wrong login
// ---------------------------------------------------------------------------

describe('US-32 AC38 — a wrong login re-renders the page, counts, and echoes nothing', () => {
  const wrong: Array<[string, string, string]> = [
    ['wrong password', USERNAME, 'zzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['wrong username', 'someoneelse', PASSWORD],
    ['an @ in the username', `${USERNAME}@example.com`, PASSWORD],
    ['empty fields', '', ''],
  ];

  for (const [label, username, password] of wrong) {
    it(`refuses ${label}: 200, the inline message, no code, a counter row, input not echoed`, async () => {
      const state = reviewerState(await consentHtml());
      const compare = vi.spyOn(crypto, 'timingSafeEqual');
      const res = await signIn(state, username, password);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      const html = await res.text();
      expect(html).toContain('That username or password is not right.');
      // The page is the consent page again, with fresh sealed states to retry on.
      expect(html).toContain(REVIEWER_HEADING);
      expect(html).toContain('Continue to Dropbox');
      const retry = unpackSealed<{ clientId: string; redirectUri: string }>('state', reviewerState(html));
      expect(retry).toMatchObject({ clientId: CHATGPT, redirectUri: CHATGPT_REDIRECT });
      if (username) expect(html).not.toContain(username);
      if (password) expect(html).not.toContain(password);
      expect(html).not.toContain('value="openaireview');
      expect(events('mcp_connect_failed')).toEqual([{ client: 'chatgpt', provider: 'dropbox', reason: 'reviewer-credentials' }]);
      expect(events('mcp_connect')).toEqual([]);
      // Both comparisons ran, whichever half was wrong.
      expect(compare).toHaveBeenCalledTimes(2);
    });
  }

  it('lets the reviewer retry on the re-rendered page without restarting from ChatGPT', async () => {
    const wrongTry = await signIn(reviewerState(await consentHtml()), USERNAME, 'nope');
    const res = await signIn(reviewerState(await wrongTry.text()), USERNAME, PASSWORD);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });

  it('runs both comparisons on a right login too', async () => {
    const state = reviewerState(await consentHtml());
    const compare = vi.spyOn(crypto, 'timingSafeEqual');
    const res = await signIn(state, USERNAME, PASSWORD);
    expect(res.status).toBe(302);
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it('logs nothing: no username, no password, no token', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    seedReviewerRecord();
    await signIn(reviewerState(await consentHtml()), USERNAME, 'wrong-password');
    const { access } = await reviewerLogin();
    await callTool(access, 'read_record', {});
    const written = JSON.stringify(spies.map((spy) => spy.mock.calls));
    expect(written).not.toContain(USERNAME);
    expect(written).not.toContain('wrong-password');
    expect(written).not.toContain(PASSWORD);
    expect(written).not.toContain(REVIEWER_RT);
  });
});

// ---------------------------------------------------------------------------
// The failures-only limiter
// ---------------------------------------------------------------------------

describe('US-32 AC38 — 20 failures per IP per 15 minutes, and a success never counts', () => {
  const FROM_A = { 'fly-client-ip': '198.51.100.7' };
  const FROM_B = { 'fly-client-ip': '198.51.100.8' };

  async function failures(n: number, headers = FROM_A): Promise<void> {
    const html = await consentHtml();
    for (let i = 0; i < n; i++) expect((await signIn(reviewerState(html), USERNAME, 'wrong', headers)).status).toBe(200);
  }

  it('refuses the 21st attempt, even with the right password, and counts the refusal once', async () => {
    await failures(20);
    const html = await consentHtml();
    const res = await signIn(reviewerState(html), USERNAME, PASSWORD, FROM_A);
    expect(res.status).toBe(429);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).not.toContain(PASSWORD);
    await signIn(reviewerState(html), USERNAME, PASSWORD, FROM_A);
    expect(events('mcp_connect_failed').filter((row) => row.reason === 'reviewer-rate-limited')).toEqual([
      { client: 'chatgpt', provider: 'dropbox', reason: 'reviewer-rate-limited' },
    ]);
    // The credentials rows are braked too: one per IP per window, not twenty.
    expect(events('mcp_connect_failed').filter((row) => row.reason === 'reviewer-credentials')).toHaveLength(1);
  });

  it('never counts a success', async () => {
    const html = await consentHtml();
    for (let i = 0; i < 30; i++) expect((await signIn(reviewerState(html), USERNAME, PASSWORD, FROM_A)).status).toBe(302);
    await failures(19);
    expect((await signIn(reviewerState(html), USERNAME, PASSWORD, FROM_A)).status).toBe(302);
  });

  it('forgets the failures when the window expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-02T10:00:00Z'));
    await failures(20);
    expect((await signIn(reviewerState(await consentHtml()), USERNAME, PASSWORD, FROM_A)).status).toBe(429);
    vi.setSystemTime(new Date('2026-09-02T10:15:01Z'));
    expect((await signIn(reviewerState(await consentHtml()), USERNAME, PASSWORD, FROM_A)).status).toBe(302);
  });

  it('leaves a second IP unaffected', async () => {
    await failures(20);
    expect((await signIn(reviewerState(await consentHtml()), USERNAME, PASSWORD, FROM_B)).status).toBe(302);
  });
});

// ---------------------------------------------------------------------------
// Two-phase tools on a reviewer bearer
// ---------------------------------------------------------------------------

describe('US-32 AC38 — the two-phase tools work on a reviewer bearer (one shared connection key)', () => {
  it('correct_value proposes, then confirms', async () => {
    seedReviewerRecord();
    const { access } = await reviewerLogin();
    const row = storedRecord().measurements[0];
    const args = { id: row.id, newValue: 2.8, expectedValue: 3.2 };
    const proposed = await callTool(access, 'correct_value', args);
    expect(proposed.isError).toBe(false);
    const confirmed = await callTool(access, 'correct_value', { ...args, confirm: proposed.structured.confirm }, LATER);
    expect(confirmed.isError, confirmed.text).toBe(false);
    expect(storedRecord().measurements.find((m) => m.correctsId === row.id)?.value).toBe(2.8);
  });

  it('file_results proposes, then commits', async () => {
    seedReviewerRecord();
    const { access } = await reviewerLogin();
    const proposed = await callTool(access, 'file_results', {
      sourceFileName: 'Synthetic-reviewer-labs.pdf', classification: 'lab_report', collectedOn: '2026-08-31',
      values: [{ metric: 'ferritin', printedName: 'Ferritin', value: 120, unit: 'ug/L' }],
    });
    expect(proposed.isError, proposed.text).toBe(false);
    const receipt = proposed.structured.receipt as string;
    const committed = await callTool(access, 'file_results', { commit: { receipt, accept: ['c1'], replace: [] } });
    expect(committed.isError, committed.text).toBe(false);
    expect(storedRecord().labValues.some((row) => row.metricName === 'Ferritin')).toBe(true);
  });

  it('confirms a proposal from one reviewer session in another: every reviewer shares one stated bucket', async () => {
    seedReviewerRecord();
    const first = await reviewerLogin();
    const second = await reviewerLogin();
    const row = storedRecord().measurements[0];
    const args = { id: row.id, newValue: 2.9, expectedValue: 3.2 };
    const proposed = await callTool(first.access, 'correct_value', args);
    const confirmed = await callTool(second.access, 'correct_value', { ...args, confirm: proposed.structured.confirm }, LATER);
    expect(confirmed.isError, confirmed.text).toBe(false);
  });
});

describe('US-32 AC38 — the connection key', () => {
  it("is hash('reviewer:' + rv) for a reviewer grant, and stable across sessions", async () => {
    const one = unpackSealed<AccessPayload>('access', (await reviewerLogin()).access)!;
    const two = unpackSealed<AccessPayload>('access', (await reviewerLogin()).access)!;
    expect(one.rv).toBe(two.rv);
    expect(connectionKey(one)).toBe(hash(`reviewer:${one.rv}`));
    expect(connectionKey(two)).toBe(connectionKey(one));
    // A real connection still keys on its own token, so the two can never meet.
    expect(connectionKey({ rt: 'dropbox-refresh' })).toBe(hash('dropbox-refresh'));
    expect(connectionKey({ rt: '', rv: one.rv })).not.toBe(connectionKey({ rt: '' }));
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('US-32 AC38 — reviewer=1 is refused where it does not belong', () => {
  it('refuses a Google state', async () => {
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'g-id';
    process.env.GOOGLE_DRIVE_SECRET = 'g-secret';
    const html = await consentHtml();
    const google = allStates(html).find((state) => unpackSealed<{ provider: string }>('state', state)?.provider === 'google')!;
    const res = await signIn(google, USERNAME, PASSWORD);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(events('mcp_connect')).toEqual([]);
  });

  it('refuses a state sealed for any other client, the ChatGPT and Codex lookalikes included', async () => {
    const codexLookalike = `${CODEX}?x=1`;
    stubFetch({
      [LOOKALIKE]: { client_id: LOOKALIKE, client_name: 'ChatGPT', redirect_uris: [CHATGPT_REDIRECT] },
      [codexLookalike]: { client_id: codexLookalike, client_name: 'Codex', redirect_uris: [CODEX_REDIRECT] },
    });
    for (const [clientId, redirect] of [
      ['https://claude.ai/oauth/mcp-oauth-client-metadata', 'https://claude.ai/api/mcp/auth_callback'],
      [LOOKALIKE, CHATGPT_REDIRECT],
      [codexLookalike, CODEX_REDIRECT],
    ]) {
      const res = await signIn(allStates(await consentHtml(clientId, redirect))[0], USERNAME, PASSWORD);
      expect(res.status, clientId).toBe(400);
      expect(res.headers.get('location'), clientId).toBeNull();
    }
    expect(events('mcp_connect')).toEqual([]);
  });

  it('refuses when the secrets went between the page and the press', async () => {
    const state = reviewerState(await consentHtml());
    clearReviewerSecrets();
    const res = await signIn(state, USERNAME, PASSWORD);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('refuses a cross-origin POST with a 403 before anything else', async () => {
    const state = reviewerState(await consentHtml());
    const res = await signIn(state, USERNAME, PASSWORD, { Origin: 'https://evil.test' });
    expect(res.status).toBe(403);
    expect(events('mcp_connect')).toEqual([]);
    expect(events('mcp_connect_failed')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The kill switch
// ---------------------------------------------------------------------------

describe('US-32 AC38 — unsetting or rotating a secret ends every reviewer session on its next request', () => {
  const changes: Array<[string, () => void]> = [
    ['the token secret is unset', () => { delete process.env.MCP_REVIEWER_DROPBOX_RT; }],
    ['the token secret changes', () => { process.env.MCP_REVIEWER_DROPBOX_RT = 'a-new-reviewer-token'; }],
    ['the password hash changes', () => { process.env.MCP_REVIEWER_PASSWORD_SHA256 = sha256hex('another-password'); }],
    ['every secret is unset', clearReviewerSecrets],
  ];

  for (const [label, change] of changes) {
    it(`after ${label}: the refresh grant is invalid_grant, and every /mcp request is a 401`, async () => {
      seedReviewerRecord();
      const { access, refresh } = await reviewerLogin();
      expect((await rpcStatus(access, 'tools/list')).status).toBe(200);
      change();
      vi.mocked(recordServerEvent).mockClear();

      const renewed = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CHATGPT });
      expect(renewed.status).toBe(400);
      expect((await renewed.json()).error).toBe('invalid_grant');
      expect(events('mcp_connect_failed')).toEqual([{ client: 'chatgpt', provider: 'dropbox', reason: 'reviewer-generation' }]);

      refreshed.length = 0;
      expect((await rpcStatus(access, 'initialize', { protocolVersion: '2025-11-25' })).status).toBe(401);
      expect((await rpcStatus(access, 'tools/list')).status).toBe(401);
      expect((await rpcStatus(access, 'tools/call', { name: 'report_feedback', arguments: { kind: 'bug', title: 'x', detail: 'y' } })).status).toBe(401);
      expect((await rpcStatus(access, 'tools/call', { name: 'read_record', arguments: {} })).status).toBe(401);
      // Nothing reached Dropbox: the check is at the top, before dispatch.
      expect(refreshed).toEqual([]);
    });
  }

  it('refuses a live reviewer code once the generation has changed', async () => {
    const code = await reviewerCode();
    process.env.MCP_REVIEWER_DROPBOX_RT = 'a-new-reviewer-token';
    vi.mocked(recordServerEvent).mockClear();
    const res = await redeem(code);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    expect(events('mcp_connect_failed')).toEqual([{ client: 'chatgpt', provider: 'dropbox', reason: 'reviewer-generation' }]);
  });

  it('leaves real connections alone when the reviewer secrets go', async () => {
    seedReviewerRecord();
    const pressed = await pressProvider(allStates(await consentHtml()).at(-1)!);
    const nonce = new URL(pressed.headers.get('location')!).searchParams.get('state')!;
    const cookie = pressed.headers.get('set-cookie')!.split(';')[0];
    const back = await get(`/mcp/callback?code=dropbox-code&state=${encodeURIComponent(nonce)}`, { cookie });
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    expect(unpackSealed<CodePayload>('code', code)!.rv).toBeUndefined();
    const res = await redeem(code);
    expect(res.status).toBe(200);
    const { access_token: access } = (await res.json()) as { access_token: string };
    clearReviewerSecrets();
    expect((await rpcStatus(access, 'tools/list')).status).toBe(200);
    expect((await callTool(access, 'read_record', {})).isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A bare visit
// ---------------------------------------------------------------------------

describe('US-32 AC38 — a bare /mcp/authorize is a plain start-from-ChatGPT page', () => {
  it('answers 200 with the plain page and writes no refusal row', async () => {
    const res = await get('/mcp/authorize');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('This page opens when you connect Health by Dr Brad from ChatGPT. Go back to ChatGPT and press Connect.');
    expect(html).not.toContain('Continue to Dropbox');
    expect(hasReviewerForm(html)).toBe(false);
    expect(vi.mocked(recordServerEvent).mock.calls).toEqual([]);
  });

  it('still refuses an unknown client, which is not a bare visit', async () => {
    const res = await get(`/mcp/authorize?${authorizeQuery('https://evil.test/client.json')}`);
    expect(res.status).toBe(400);
    expect(events('mcp_authorize_refused')).toEqual([{ client: 'other', reason: 'unknown-client' }]);
  });
});
