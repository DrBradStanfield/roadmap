/**
 * US-64 (lead S-11) · The hosted MCP's HTML views, byte for byte.
 *
 * Written on main before the views left the route file: every page the connect
 * flow renders, with its status and headers, through the route's own
 * loader/action. Only the sealed states change from run to run, so they are
 * replaced with a placeholder; every other byte is compared with the snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

import { serveClientMetadata } from '../lib/mcp-cimd.test-helpers';
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
import { resetMcpMemory } from '../lib/mcp-grants.server';
import { action, loader } from './mcp.$';

const ISSUER = 'https://mcp.example.test';
const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK_REDIRECT = 'http://127.0.0.1:4567/callback';
const CIMD = 'https://assistant.example.test/client.json';
const CHALLENGE = crypto.createHash('sha256').update('v'.repeat(64), 'ascii').digest('base64url');
const USERNAME = 'reviewer';
const PASSWORD = 'test-password-good';
const sha256hex = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const ENV_KEYS = [
  'MCP_ISSUER', 'MCP_SEAL_KEYS', 'MCP_CLIENT_HMAC_KEY', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET',
  'GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_SECRET', 'MCP_REVIEWER_USERNAME', 'MCP_REVIEWER_PASSWORD_SHA256',
  'MCP_REVIEWER_DROPBOX_RT', 'MCP_REVIEWER_VENDORS',
];

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

function authorizeQuery(clientId: string, redirectUri: string): string {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${ISSUER}/mcp`,
  }).toString();
}

async function registerDcr(clientName: string, redirectUri: string): Promise<string> {
  const res = await post('/mcp/register', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri] }),
  });
  return (await res.json()).client_id as string;
}

const STATE_VALUE = /(name="state" value=")[^"]+(")/g;

/** What the user's browser gets: status, the headers we set, and the page with its sealed states blanked. */
async function rendered(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].filter(([name]) => name !== 'set-cookie').map(([k, v]) => `${k}: ${v}`).sort();
  const body = (await res.text()).replace(STATE_VALUE, '$1<sealed>$2');
  return [`status: ${res.status}`, ...headers, '', body].join('\n');
}

function firstState(html: string): string {
  const match = /name="state" value="([^"]+)"/.exec(html);
  return match![1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
}

beforeEach(() => {
  resetClaimsState(claims.state!);
  process.env.MCP_ISSUER = ISSUER;
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 3).toString('base64');
  process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 4).toString('base64');
  process.env.DROPBOX_APP_KEY = 'app-key';
  process.env.DROPBOX_APP_SECRET = 'app-secret';
  resetMcpMemory();
  serveClientMetadata({
    [CIMD]: { client_id: CIMD, client_name: 'Assistant <b>"Pro"</b> & Co', redirect_uris: [CLAUDE_REDIRECT] },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
});

function reviewerOn(): void {
  process.env.MCP_REVIEWER_USERNAME = USERNAME;
  process.env.MCP_REVIEWER_PASSWORD_SHA256 = sha256hex(PASSWORD);
  process.env.MCP_REVIEWER_DROPBOX_RT = 'test-token-good';
  process.env.MCP_REVIEWER_VENDORS = 'anthropic';
}

describe('US-64 S-11: every hosted-MCP HTML view renders byte for byte as main rendered it', () => {
  it('a bare visit to the consent address', async () => {
    expect(await rendered(await get('/mcp/authorize'))).toMatchSnapshot();
  });

  it('an unknown client', async () => {
    expect(await rendered(await get(`/mcp/authorize?${authorizeQuery('not-a-client', CLAUDE_REDIRECT)}`))).toMatchSnapshot();
  });

  it('a malformed request from a known client', async () => {
    expect(await rendered(await get(`/mcp/authorize?client_id=${encodeURIComponent(CLAUDE)}&redirect_uri=${encodeURIComponent('https://elsewhere.example.test/cb')}`))).toMatchSnapshot();
  });

  it('the consent page for a known client, Dropbox alone', async () => {
    expect(await rendered(await get(`/mcp/authorize?${authorizeQuery(CLAUDE, CLAUDE_REDIRECT)}`))).toMatchSnapshot();
  });

  it('the consent page with Dropbox and Google Drive', async () => {
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_DRIVE_SECRET = 'google-secret';
    expect(await rendered(await get(`/mcp/authorize?${authorizeQuery(CLAUDE, CLAUDE_REDIRECT)}`))).toMatchSnapshot();
  });

  it('the consent page for a self-registered client, by host and by loopback', async () => {
    const byHost = await registerDcr('My <script>App</script>', CLAUDE_REDIRECT);
    expect(await rendered(await get(`/mcp/authorize?${authorizeQuery(byHost, CLAUDE_REDIRECT)}`))).toMatchSnapshot();
    const byLoopback = await registerDcr("Local 'tool'", LOOPBACK_REDIRECT);
    expect(await rendered(await get(`/mcp/authorize?${authorizeQuery(byLoopback, LOOPBACK_REDIRECT)}`))).toMatchSnapshot();
  });

  it('the consent page for a client published at its own address', async () => {
    expect(await rendered(await get(`/mcp/authorize?${authorizeQuery(CIMD, CLAUDE_REDIRECT)}`))).toMatchSnapshot();
  });

  it('the consent page with the reviewer box, then a wrong reviewer sign-in', async () => {
    reviewerOn();
    const page = await get(`/mcp/authorize?${authorizeQuery(CLAUDE, CLAUDE_REDIRECT)}`);
    const html = await page.clone().text();
    expect(await rendered(page)).toMatchSnapshot();
    const wrong = await post('/mcp/authorize', {
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ISSUER },
      body: new URLSearchParams({ state: firstState(html), reviewer: '1', username: USERNAME, password: 'not-it' }).toString(),
    });
    expect(await rendered(wrong)).toMatchSnapshot();
  });

  it('the error pages of the consent POST and the provider callback', async () => {
    const expired = await post('/mcp/authorize', {
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ISSUER },
      body: new URLSearchParams({ state: 'not-a-seal' }).toString(),
    });
    expect(await rendered(expired)).toMatchSnapshot();
    expect(await rendered(await get('/mcp/callback?state=x&code=y'))).toMatchSnapshot();
  });
});
