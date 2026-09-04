/**
 * US-32 phase 2 · the Google leg of the hosted MCP server.
 *
 * Three things are proved here and nowhere else: the consent screen offers
 * exactly the providers whose secrets exist (the feature gate that keeps Drive
 * inert until Brad finishes the Google console steps); a Google connection
 * survives the whole OAuth chain; and the provider is a SEALED property of the
 * token, so a Dropbox connection can never be steered into a Drive adapter or
 * the other way round.
 *
 * The Dropbox chain is `mcp.hosted.test.ts` and stays untouched — the two files
 * share the flow deliberately, because a divergence between them would be a
 * divergence in the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('node:dns/promises', () => ({ default: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] } }));
import { MemoryAdapter, MemoryCloud } from '../../packages/health-core/src/memory-adapter';
import { ROADMAP_FILE_NAME } from '../../packages/health-core/src/adapter';
import { DRIVE_FOLDER_NAME } from '../../packages/health-core/src/drive-rest';
import { ToolContractError } from '../../packages/health-core/src/mcp-tools';
import { DropboxAdapter } from '../../packages/health-core/src/dropbox-rest';
import { createEmptyFile, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { type AccessPayload, resetMcpMemory } from '../lib/mcp-grants.server';
import { type McpProvider } from '../lib/mcp-providers.server';
import { packSealed, unpackSealed } from '../lib/mcp-seal.server';
import { mcpEndpoint, setAdapterFactory } from '../lib/mcp.server';
import { action, loader } from './mcp.$';

const ISSUER = 'https://mcp.example.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const NOW = '2026-09-02T10:00:00.000Z';
const TODAY = NOW.slice(0, 10);

let cloud: MemoryCloud;
/** Which provider the factory was asked for, per call. */
let builtFor: McpProvider[] = [];

beforeEach(() => {
  process.env.MCP_ISSUER = ISSUER;
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 5).toString('base64');
  process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 6).toString('base64');
  process.env.DROPBOX_APP_KEY = 'app-key';
  process.env.DROPBOX_APP_SECRET = 'app-secret';
  process.env.GOOGLE_DRIVE_CLIENT_ID = 'google-client-id';
  process.env.GOOGLE_DRIVE_SECRET = 'google-secret';
  resetMcpMemory();
  cloud = new MemoryCloud();
  builtFor = [];
  setAdapterFactory((provider) => {
    builtFor.push(provider);
    return new MemoryAdapter(cloud);
  });
  stubTokenEndpoints();
});

afterEach(() => {
  setAdapterFactory(null);
  vi.unstubAllGlobals();
  delete process.env.MCP_SEAL_KEYS;
  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_SECRET;
});

/** Both providers' token endpoints, answering like the real ones. */
function stubTokenEndpoints(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com')) {
        return Response.json({ refresh_token: 'google-refresh', access_token: 'google-access', expires_in: 3600 });
      }
      if (url.includes('dropboxapi.com')) {
        return Response.json({ refresh_token: 'dropbox-refresh', access_token: 'dropbox-access', expires_in: 14400 });
      }
      return new Response('unexpected', { status: 500 });
    }),
  );
}

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

async function registerClientOverHttp(): Promise<string> {
  const res = await post('/mcp/register', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).client_id as string;
}

async function consentHtml(clientId: string): Promise<string> {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${ISSUER}/mcp`,
  });
  const consent = await get(`/mcp/authorize?${query}`);
  expect(consent.status).toBe(200);
  return consent.text();
}

/** The sealed state behind the button whose label names this provider. */
function stateForButton(html: string, label: string): string {
  const forms = html.split('<form method="post">').slice(1);
  const form = forms.find((f) => f.includes(`Continue to ${label}`));
  expect(form, `no "Continue to ${label}" button`).toBeTruthy();
  return unescapeHtml(/name="state" value="([^"]+)"/.exec(form!)![1]);
}

/** Register, consent to one provider, come back, and redeem the code. */
async function connect(label: string): Promise<{ clientId: string; access: string; refresh: string; to: URL }> {
  const clientId = await registerClientOverHttp();
  const sealed = stateForButton(await consentHtml(clientId), label);

  const pressed = await post('/mcp/authorize', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: sealed }),
  });
  expect(pressed.status).toBe(302);
  const to = new URL(pressed.headers.get('location')!);
  const cookie = pressed.headers.get('set-cookie')!.split(';')[0];
  const nonce = to.searchParams.get('state')!;

  const back = await get(`/mcp/callback?code=provider-code&state=${encodeURIComponent(nonce)}`, { cookie });
  expect(back.status).toBe(302);
  const returned = new URL(back.headers.get('location')!);
  expect(returned.origin + returned.pathname).toBe(REDIRECT);

  const res = await post('/mcp/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: returned.searchParams.get('code')!,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: clientId,
    }),
  });
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as { access_token: string; refresh_token: string };
  return { clientId, access: tokens.access_token, refresh: tokens.refresh_token, to };
}

async function callTool(access: string, name: string, args: unknown) {
  const res = await mcpEndpoint(
    new Request(`${ISSUER}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    NOW,
  );
  expect(res.status).toBe(200);
  const answer = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: answer.result.content[0].text, isError: answer.result.isError === true };
}

function seedRecord(): void {
  const file = createEmptyFile({ deviceId: 'phone', now: '2026-01-01T00:00:00.000Z' });
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
}

function storedRecord(): RoadmapFile {
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
}

// ---------------------------------------------------------------------------
// The feature gate
// ---------------------------------------------------------------------------

describe('the consent screen offers only configured providers (US-32 phase 2)', () => {
  it('shows both when both are configured', async () => {
    const html = await consentHtml(await registerClientOverHttp());
    expect(html).toContain('Continue to Dropbox');
    expect(html).toContain('Continue to Google Drive');
    expect(html).toContain('myaccount.google.com/connections');
  });

  it('shows Dropbox alone until the Google secrets exist — merging is inert', async () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_SECRET;
    const html = await consentHtml(await registerClientOverHttp());
    expect(html).toContain('Continue to Dropbox');
    expect(html).not.toContain('Google');
  });

  it('is unavailable, not broken, when no provider is configured', async () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_SECRET;
    delete process.env.DROPBOX_APP_KEY;
    delete process.env.DROPBOX_APP_SECRET;
    const clientId = 'c.x.y';
    const res = await get(`/mcp/authorize?client_id=${clientId}`);
    expect(res.status).toBe(503);
    process.env.DROPBOX_APP_KEY = 'app-key';
    process.env.DROPBOX_APP_SECRET = 'app-secret';
  });
});

// ---------------------------------------------------------------------------
// The Google chain
// ---------------------------------------------------------------------------

describe('a Google connection, end to end (US-32 phase 2)', () => {
  it('sends the user to Google with drive.file, offline, and nothing wider', async () => {
    const { to } = await connect('Google Drive');
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(to.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(to.searchParams.get('access_type')).toBe('offline');
    // Without it a returning widget user gets no refresh token and a stateless
    // server has nowhere to keep one, so the connection could not be made.
    expect(to.searchParams.get('prompt')).toBe('consent');
    // Would widen the token to scopes granted elsewhere. `drive.file` is the point.
    expect(to.searchParams.get('include_granted_scopes')).toBeNull();
    expect(to.searchParams.get('redirect_uri')).toBe(`${ISSUER}/mcp/callback`);
    expect(to.searchParams.get('client_id')).toBe('google-client-id');
    // The provider gets an opaque nonce, never the sealed state.
    expect(to.searchParams.get('state')!.length).toBeLessThan(64);
  });

  it('reads and writes the record, and says which cloud it saved to', async () => {
    seedRecord();
    const { access, refresh, clientId } = await connect('Google Drive');
    expect(unpackSealed<AccessPayload>('access', access)!.provider).toBe('google');

    const read = await callTool(access, 'read_record', {});
    expect(read.isError).toBe(false);

    const added = await callTool(access, 'add_measurement', { metricType: 'ldl', value: 3.2, recordedAt: TODAY });
    expect(added.isError).toBe(false);
    expect(added.text).toContain('Saved to the user’s Google Drive');
    expect(storedRecord().measurements.find((m) => m.status === 'active')!.value).toBe(3.2);
    expect(builtFor).toEqual(['google', 'google']);

    // The refresh grant carries the provider through, so a renewed token still
    // opens Drive rather than falling back to the first provider in the table.
    const renewed = await post('/mcp/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
    });
    const next = (await renewed.json()) as { access_token: string };
    expect(unpackSealed<AccessPayload>('access', next.access_token)!.provider).toBe('google');
  });

  it('names Google when Google will not renew the connection', async () => {
    seedRecord();
    const { access } = await connect('Google Drive');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 400 })));
    const answer = await callTool(access, 'read_record', {});
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('Google Drive would not renew');
  });
});

// ---------------------------------------------------------------------------
// Provider isolation
// ---------------------------------------------------------------------------

describe('the provider is sealed, not asserted (US-32 phase 2)', () => {
  it('a Dropbox token reaches Dropbox and never Google', async () => {
    const { access } = await connect('Dropbox');
    setAdapterFactory(null); // the real factory, chosen by the sealed provider

    const hosts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      hosts.push(url.host);
      if (url.host === 'api.dropboxapi.com') return Response.json({ access_token: 'dropbox-access' });
      return new Response('{}', { status: 200, headers: { 'dropbox-api-result': '{"rev":"1"}' } });
    }));

    await callTool(access, 'read_record', {});
    expect(hosts).toContain('content.dropboxapi.com');
    expect(hosts.some((h) => h.endsWith('googleapis.com'))).toBe(false);
  });

  it('refuses a token whose sealed provider was edited', async () => {
    const { access } = await connect('Dropbox');
    const payload = unpackSealed<AccessPayload>('access', access)!;
    expect(payload.provider).toBe('dropbox');

    // Flip one byte of the ciphertext. AES-GCM authenticates the payload, so
    // the provider inside it cannot be swapped without the tag failing — the
    // whole token dies rather than quietly becoming a Google connection.
    const [clientPart, sealed] = access.split('~');
    const [header, body] = sealed.split('.');
    const raw = Buffer.from(body, 'base64url');
    raw[20] ^= 0xff;
    const tampered = `${clientPart}~${header}.${raw.toString('base64url')}`;
    expect(unpackSealed<AccessPayload>('access', tampered)).toBeNull();

    const res = await mcpEndpoint(
      new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tampered}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('will not finish a consent for a provider whose secrets have gone', async () => {
    const sealed = stateForButton(await consentHtml(await registerClientOverHttp()), 'Google Drive');
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_SECRET;
    const pressed = await post('/mcp/authorize', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state: sealed }),
    });
    expect(pressed.status).toBe(400);
    expect(await pressed.text()).toContain('not available');
  });
});

// ---------------------------------------------------------------------------
// The real Drive adapter, wired through the endpoint
// ---------------------------------------------------------------------------

describe('the real adapter finds the file the widget made (US-32 phase 2)', () => {
  it('reads the record out of the app folder over a Google connection', async () => {
    const { access } = await connect('Google Drive');
    setAdapterFactory(null);

    const file = createEmptyFile({ deviceId: 'phone', now: '2026-01-01T00:00:00.000Z' });
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      asked.push(url.pathname + url.search);
      if (url.href.includes('oauth2.googleapis.com')) {
        return Response.json({ access_token: 'google-access', expires_in: 3600 });
      }
      if (url.pathname === '/drive/v3/files') {
        const q = decodeURIComponent(url.searchParams.get('q') ?? '');
        return Response.json({ files: q.includes(ROADMAP_FILE_NAME) ? [{ id: 'file-1' }] : [] });
      }
      if (url.pathname === '/drive/v3/files/file-1') {
        if (url.searchParams.get('alt') === 'media') return new Response(JSON.stringify(file));
        return Response.json({ version: '7' });
      }
      return new Response('unexpected', { status: 500 });
    }));

    const read = await callTool(access, 'read_record', {});
    expect(read.isError).toBe(false);
    // Found by the record's name, exactly as `widget-src/src/storage/drive.ts`
    // finds it — and never by a folder id the server invented.
    expect(asked.some((a) => decodeURIComponent(a).includes(`name='${ROADMAP_FILE_NAME}'`))).toBe(true);
    expect(DRIVE_FOLDER_NAME).toBe('Health Plan by Dr Brad');
  });
});

// ---------------------------------------------------------------------------
// The blobs phase 1 already handed out
// ---------------------------------------------------------------------------

describe('a phase-1 blob, minted before `provider` existed (US-32 phase 2)', () => {
  it('still opens, as Dropbox, and still works', async () => {
    seedRecord();
    const now = Math.floor(Date.now() / 1000);
    // Exactly the phase-1 AccessPayload shape: no provider field at all. These
    // are live in vendor token stores and we cannot update one, so reading
    // `undefined` as a provider would have 500ed every call after this deploy.
    const access = packSealed('access', 'client', { clientId: 'client', rt: 'dropbox-refresh', exp: now + 3600 });
    expect(unpackSealed<AccessPayload>('access', access)!.provider).toBe('dropbox');

    const answer = await callTool(access, 'read_record', {});
    expect(answer.isError).toBe(false);
    expect(builtFor).toEqual(['dropbox']);
  });

  it('a phase-1 refresh blob mints an access blob that names Dropbox', async () => {
    const now = Math.floor(Date.now() / 1000);
    const refresh = packSealed('refresh', 'client', {
      clientId: 'client',
      rt: 'dropbox-refresh',
      exp: now + 30 * 86_400,
    });
    const res = await post('/mcp/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: 'client' }),
    });
    expect(res.status).toBe(200);
    const minted = (await res.json()) as { access_token: string };
    expect(unpackSealed<AccessPayload>('access', minted.access_token)!.provider).toBe('dropbox');
  });
});

describe('an internal failure is an error with an id, never a 500 (US-32 phase 2)', () => {
  it('answers -32603 on the failed request rather than throwing out of the endpoint', async () => {
    const { access } = await connect('Dropbox');
    // A `ToolContractError` is the one failure the tool layer deliberately
    // does NOT dress up as a storage problem — it means we broke our own
    // contract. It used to escape the endpoint entirely and become a 500 the
    // vendor could not match to any request.
    setAdapterFactory(() => {
      throw new ToolContractError('a bug in us');
    });
    const res = await mcpEndpoint(
      new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'abc', method: 'tools/call', params: { name: 'read_record', arguments: {} } }),
      }),
      NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; error: { code: number; message: string } };
    expect(body.id).toBe('abc');
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toContain('Nothing was written');
  });

  it('reports a TypeError from inside the tool run as -32603, not as a storage refusal (US-32 AC17)', async () => {
    const { access } = await connect('Dropbox');
    seedRecord();
    // A bug of ours, thrown where the record is written. It used to fall into
    // the catch-all and come back worded as "the record in Dropbox did not
    // answer" — sending the user to check a cloud folder that was fine.
    setAdapterFactory(() => {
      const adapter = new MemoryAdapter(cloud);
      adapter.write = () => {
        throw new TypeError('boom');
      };
      return adapter;
    });
    const res = await mcpEndpoint(
      new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'zed',
          method: 'tools/call',
          params: { name: 'add_measurement', arguments: { metricType: 'weight', value: 80, recordedAt: TODAY } },
        }),
      }),
      NOW,
    );
    const body = (await res.json()) as { id: string; result?: unknown; error: { code: number; message: string } };
    expect(body.result).toBeUndefined();
    expect(body.id).toBe('zed');
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).not.toContain('did not answer');
  });

  it('still words a real network outage as a refusal the user can act on (US-32 AC17)', async () => {
    const { access } = await connect('Dropbox');
    // The nuance the rethrow must not swallow: `fetch` rejects with a bare
    // TypeError when the network is down, so the ADAPTER owns it and raises a
    // StorageError. Real DropboxAdapter here, not the memory one.
    setAdapterFactory(() => new DropboxAdapter('dropbox-access'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        if (String(input).includes('content.dropboxapi.com')) throw new TypeError('fetch failed');
        return Response.json({ access_token: 'dropbox-access', expires_in: 14400 });
      }),
    );
    const answer = await callTool(access, 'read_record', {});
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('did not answer');
  });
});

// ---------------------------------------------------------------------------
// US-35 AC3 — the folder route on a Drive connection is refused, honestly
// ---------------------------------------------------------------------------
import { resetImportMemory } from '../lib/mcp-import.server';

describe('US-35 AC3 — import_documents on Google Drive', () => {
  afterEach(() => resetImportMemory());

  it('refuses the folder route in words before any Drive call, naming the website (and the drag, for ChatGPT)', async () => {
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(createEmptyFile({ deviceId: 'd', now: NOW })), version: 1 });
    const { access } = await connect('Google Drive');
    const calls = () => (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([url]) => String(url).includes('googleapis.com/drive'));
    const before = calls().length;
    const answer = await callTool(access, 'import_documents', {});
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('Google Drive');
    expect(answer.text).toContain('website');
    expect(answer.text).not.toContain('Drag'); // a Claude-registered client is not told to drag
    expect(calls().length).toBe(before);
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(1);
  });
});
