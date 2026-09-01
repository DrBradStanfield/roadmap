/**
 * US-32 · the hosted MCP server, end to end and in process.
 *
 * One test drives the whole chain a real connection takes — register,
 * authorize, consent, Dropbox callback, token, then MCP calls, refresh, and
 * the budget running out — because the parts are individually plausible and
 * only the chain proves they fit. The rest of the file is the refusals: the
 * 401 that starts OAuth, the 405s, the foreign `Origin`, the feature flag off,
 * and the four mandatory corrections mitigations of design §3.
 *
 * Dropbox is a fake folder in memory with the same rev-conditional semantics
 * (`MemoryAdapter`), so the `SyncManager` loop under test is the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

// A client id that is a URL means a CIMD fetch; DNS must not leave the machine.
vi.mock('node:dns/promises', () => ({ default: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] } }));
import { MemoryAdapter, MemoryCloud } from '../../packages/health-core/src/memory-adapter';
import { ROADMAP_FILE_NAME } from '../../packages/health-core/src/adapter';
import { createEmptyFile, createMeasurement, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { CONNECTION_WRITES, PER_ACCESS_WRITES, resetMcpMemory, unpackSealed, WRITE_COST, type AccessPayload } from '../lib/mcp-auth.server';
import { MAX_CORRECTION_AGE_DAYS, mcpEndpoint, setAdapterFactory } from '../lib/mcp.server';
import { action, loader } from './mcp.$';

const ISSUER = 'https://mcp.example.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const NOW = '2026-09-02T10:00:00.000Z';

let cloud: MemoryCloud;

beforeEach(() => {
  process.env.MCP_ISSUER = ISSUER;
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 3).toString('base64');
  process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 4).toString('base64');
  process.env.DROPBOX_APP_KEY = 'app-key';
  process.env.DROPBOX_APP_SECRET = 'app-secret';
  resetMcpMemory();
  cloud = new MemoryCloud();
  setAdapterFactory(() => new MemoryAdapter(cloud));
  // Dropbox's token endpoint is the only network call the server makes here.
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    refresh_token: 'dropbox-refresh-token',
    access_token: 'dropbox-access-token',
    expires_in: 14400,
  })));
});

afterEach(() => {
  setAdapterFactory(null);
  vi.unstubAllGlobals();
  delete process.env.MCP_SEAL_KEYS;
});

// ---------------------------------------------------------------------------
// Helpers — the route's own loader/action, driven with real Requests
// ---------------------------------------------------------------------------

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

/** Register, authorize, consent, come back from Dropbox, and redeem the code. */
async function connect(): Promise<{ clientId: string; access: string; refresh: string }> {
  const clientId = await registerClientOverHttp();

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
  const html = await consent.text();
  const sealedState = /name="state" value="([^"]+)"/.exec(html)![1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));

  const toDropbox = await post('/mcp/authorize', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: sealedState }),
  });
  expect(toDropbox.status).toBe(302);
  expect(toDropbox.headers.get('location')).toContain('https://www.dropbox.com/oauth2/authorize');

  const back = await get(`/mcp/callback?code=dropbox-code&state=${encodeURIComponent(sealedState)}`);
  expect(back.status).toBe(302);
  const returned = new URL(back.headers.get('location')!);
  expect(returned.origin + returned.pathname).toBe(REDIRECT);
  expect(returned.searchParams.get('state')).toBe('client-state');
  expect(returned.searchParams.get('iss')).toBe(ISSUER); // RFC 9207

  const tokens = await redeem({
    grant_type: 'authorization_code',
    code: returned.searchParams.get('code')!,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    client_id: clientId,
  });
  return { clientId, access: tokens.access_token, refresh: tokens.refresh_token };
}

async function redeem(form: Record<string, string>) {
  const res = await post('/mcp/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
}

async function rpc(access: string, method: string, params: unknown = {}, now = NOW) {
  const res = await mcpEndpoint(
    new Request(`${ISSUER}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    now,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: unknown[] } };
}

async function callTool(access: string, name: string, args: unknown, now = NOW) {
  const answer = await rpc(access, 'tools/call', { name, arguments: args }, now);
  return { text: answer.result!.content![0].text, isError: answer.result!.isError === true };
}

function seedRecord(build: (file: RoadmapFile) => RoadmapFile = (f) => f): void {
  const file = build(createEmptyFile({ deviceId: 'phone', now: '2026-01-01T00:00:00.000Z' }));
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
}

function storedRecord(): RoadmapFile {
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
}

// ---------------------------------------------------------------------------

describe('the whole connection, end to end (US-32)', () => {
  it('registers, authorizes, reads, adds, corrects, refreshes', async () => {
    seedRecord();
    const { clientId, access, refresh } = await connect();

    const initialized = await rpc(access, 'initialize', { protocolVersion: '2025-11-25' });
    expect((initialized.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');

    const listed = await rpc(access, 'tools/list');
    expect(listed.result!.tools!.map((t) => (t as { name: string }).name)).toEqual([
      'read_record', 'get_plan', 'add_measurement', 'add_lab_values', 'correct_value',
    ]);

    const read = await callTool(access, 'read_record', {});
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.text).measurements).toEqual([]);

    const added = await callTool(access, 'add_measurement', { metricType: 'ldl', value: 3.2 });
    expect(added.isError).toBe(false);
    expect(added.text).toContain('Saved to the user’s Dropbox');
    const row = storedRecord().measurements.find((m) => m.status === 'active')!;
    expect(row.value).toBe(3.2);

    // A correction appends and flips; it never mutates and never deletes.
    const corrected = await callTool(access, 'correct_value', { id: row.id, newValue: 2.8, expectedValue: 3.2 });
    expect(corrected.isError).toBe(false);
    const after = storedRecord().measurements;
    expect(after).toHaveLength(2);
    expect(after.find((m) => m.id === row.id)!.status).toBe('entered-in-error');
    expect(after.find((m) => m.correctsId === row.id)!.value).toBe(2.8);
    expect(after.find((m) => m.correctsId === row.id)!.recordedAt).toBe(row.recordedAt);

    // Refresh: a new pair, and the connection pool is one access-grant lighter.
    const renewed = await redeem({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    const renewedAccess = await callTool(renewed.access_token, 'read_record', {});
    expect(renewedAccess.isError).toBe(false);
  });

  it('never writes a health value into a log line', async () => {
    seedRecord();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { access } = await connect();
    await callTool(access, 'add_measurement', { metricType: 'ldl', value: 3.2 });
    expect(spy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the doors that must stay shut (US-32, design §6)', () => {
  it('401s with the resource-metadata pointer when there is no token', async () => {
    const res = await mcpEndpoint(new Request(`${ISSUER}/mcp`, { method: 'POST', body: '{}' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('401s on a forged or foreign bearer token', async () => {
    const forged = `${Buffer.from('https://evil.test', 'utf8').toString('base64url')}~aaa.bbb`;
    expect((await mcpEndpoint(new Request(`${ISSUER}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${forged}` }, body: '{}' }))).status).toBe(401);
  });

  it('405s on GET and DELETE — no event stream, no session', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await mcpEndpoint(new Request(`${ISSUER}/mcp`, { method }));
      expect(res.status).toBe(405);
    }
  });

  it('never mints an Mcp-Session-Id, and ignores one sent to it', async () => {
    seedRecord();
    const { access } = await connect();
    const res = await mcpEndpoint(new Request(`${ISSUER}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Mcp-Session-Id': 'abc', 'Last-Event-ID': '7' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Mcp-Session-Id')).toBeNull();
  });

  it('emits no CORS header, and 403s a foreign Origin', async () => {
    const res = await mcpEndpoint(new Request(`${ISSUER}/mcp`, { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' }));
    expect(res.status).toBe(403);
    const clean = await mcpEndpoint(new Request(`${ISSUER}/mcp`, { method: 'POST', body: '{}' }));
    expect(clean.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('404s everything while MCP_SEAL_KEYS is unset', async () => {
    delete process.env.MCP_SEAL_KEYS;
    expect((await mcpEndpoint(new Request(`${ISSUER}/mcp`, { method: 'POST', body: '{}' }))).status).toBe(404);
    expect((await get('/mcp/authorize')).status).toBe(404);
    expect((await post('/mcp/token', { body: '' })).status).toBe(404);
  });

  it('serves a client that skips initialize (the next revision expects it)', async () => {
    seedRecord();
    const { access } = await connect();
    const listed = await rpc(access, 'tools/list');
    expect(listed.result!.tools).toHaveLength(5);
  });
});

describe('the authorization server refuses what it must (US-32, design §4)', () => {
  it('rejects an unknown client rather than redirecting anywhere', async () => {
    const res = await get(`/mcp/authorize?client_id=https%3A%2F%2Fevil.test%2Fc&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256`);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('rejects an unregistered redirect_uri without redirecting to it', async () => {
    const clientId = await registerClientOverHttp();
    const res = await get(`/mcp/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=https%3A%2F%2Fevil.test%2Fcb&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256`);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('demands PKCE S256, and the right audience', async () => {
    const clientId = await registerClientOverHttp();
    const base = `client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`;
    const plain = await get(`/mcp/authorize?${base}&code_challenge=${CHALLENGE}&code_challenge_method=plain`);
    expect(plain.status).toBe(302);
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');

    const wrongAudience = await get(`/mcp/authorize?${base}&code_challenge=${CHALLENGE}&code_challenge_method=S256&resource=https%3A%2F%2Fother.test%2Fmcp`);
    expect(new URL(wrongAudience.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('answers invalid_grant — never a custom code — on every dead grant', async () => {
    seedRecord();
    const { clientId, refresh } = await connect();

    const wrongVerifier = await post('/mcp/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'nonsense', redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId }),
    });
    expect(wrongVerifier.status).toBe(400);
    expect((await wrongVerifier.json()).error).toBe('invalid_grant');

    const otherClient = await post('/mcp/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: 'c.someone.else' }),
    });
    expect((await otherClient.json()).error).toBe('invalid_grant');
  });

  it('spends an authorization code once per machine', async () => {
    seedRecord();
    const clientId = await registerClientOverHttp();
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256' });
    const html = await (await get(`/mcp/authorize?${query}`)).text();
    const sealedState = /name="state" value="([^"]+)"/.exec(html)![1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
    const back = await get(`/mcp/callback?code=dropbox-code&state=${encodeURIComponent(sealedState)}`);
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    const form = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId };

    await redeem(form);
    const replay = await post('/mcp/token', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    expect((await replay.json()).error).toBe('invalid_grant');
  });

  it('takes form-encoding at /token and JSON at /register, not the other way round', async () => {
    const wrongType = await post('/mcp/token', { headers: { 'content-type': 'application/json' }, body: '{}' });
    expect((await wrongType.json()).error).toBe('invalid_request');
    const alsoWrong = await post('/mcp/register', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
    expect((await alsoWrong.json()).error).toBe('invalid_client_metadata');
  });
});

describe('the four mandatory corrections mitigations (US-32, design §3)', () => {
  const LDL_ID = 'row-ldl';

  function seedWithLdl(recordedAt: string): void {
    seedRecord((file) => ({
      ...file,
      measurements: [createMeasurement({ id: LDL_ID, metricType: 'ldl', value: 3.2, recordedAt, createdAt: recordedAt })],
    }));
  }

  it('1 — refuses a correction that does not state expectedValue', async () => {
    seedWithLdl('2026-08-30');
    const { access } = await connect();
    const answer = await callTool(access, 'correct_value', { id: LDL_ID, newValue: 2.8 });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('expectedValue');
    expect(storedRecord().measurements).toHaveLength(1);
  });

  it('1 — refuses a correction whose expectedValue is stale or invented', async () => {
    seedWithLdl('2026-08-30');
    const { access } = await connect();
    const answer = await callTool(access, 'correct_value', { id: LDL_ID, newValue: 2.8, expectedValue: 9.9 });
    expect(answer.isError).toBe(true);
    expect(storedRecord().measurements.find((m) => m.id === LDL_ID)!.status).toBe('active');
  });

  it('2 — refuses a correction on a row older than 90 days, and allows one inside', async () => {
    seedWithLdl('2026-01-01');
    const { access } = await connect();
    const old = await callTool(access, 'correct_value', { id: LDL_ID, newValue: 2.8, expectedValue: 3.2 });
    expect(old.isError).toBe(true);
    expect(old.text).toContain(String(MAX_CORRECTION_AGE_DAYS));
    expect(storedRecord().measurements).toHaveLength(1);

    seedWithLdl('2026-08-30');
    const recent = await callTool(access, 'correct_value', { id: LDL_ID, newValue: 2.8, expectedValue: 3.2 });
    expect(recent.isError).toBe(false);
  });

  it('3 — caps the rows one lab call may write', async () => {
    seedRecord();
    const { access } = await connect();
    const values = Array.from({ length: 51 }, (_, i) => ({ metricName: `test-${i}`, value: 1, unit: 'mg/L' }));
    const answer = await callTool(access, 'add_lab_values', { values });
    expect(answer.isError).toBe(true);
    expect(storedRecord().labValues).toEqual([]);
  });

  it('4 — a correction costs five adds, so the budget bounds falsification first', async () => {
    seedRecord();
    const { access } = await connect();
    const token = unpackSealed<AccessPayload>('access', access)!;
    expect(token.writes).toBe(PER_ACCESS_WRITES);

    // Corrections exhaust the hour's allowance five times faster than adds.
    expect(PER_ACCESS_WRITES / WRITE_COST.correct).toBeLessThan(PER_ACCESS_WRITES / WRITE_COST.add);

    let refused = '';
    for (let day = 1; day <= PER_ACCESS_WRITES + 1; day++) {
      const answer = await callTool(access, 'add_measurement', {
        metricType: 'ldl',
        value: 3,
        recordedAt: `2026-0${day < 10 ? 1 : 2}-${String(day % 28 || 1).padStart(2, '0')}`,
      });
      if (answer.isError && answer.text.includes('write budget')) {
        refused = answer.text;
        break;
      }
    }
    expect(refused).toContain('Reading still works');
    // Reads are untouched by an exhausted write budget.
    expect((await callTool(access, 'read_record', {})).isError).toBe(false);
  });

  it('the connection pool is finite, not just the hour', () => {
    expect(CONNECTION_WRITES / PER_ACCESS_WRITES).toBeGreaterThan(1);
  });

  it('a taken slot is refused and named, pointing at correct_value', async () => {
    seedWithLdl('2026-08-30');
    const { access } = await connect();
    const answer = await callTool(access, 'add_measurement', { metricType: 'ldl', value: 4, recordedAt: '2026-08-30' });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(LDL_ID);
    expect(answer.text).toContain('correct_value');
    expect(storedRecord().measurements).toHaveLength(1);
  });
});

describe('a record from a newer app version is read-only (US-32, design §7)', () => {
  it('refuses the write and says why', async () => {
    cloud.files.set(ROADMAP_FILE_NAME, {
      json: JSON.stringify({ ...createEmptyFile({ deviceId: 'phone', now: NOW }), schemaVersion: 99 }),
      version: 1,
    });
    const { access } = await connect();
    const answer = await callTool(access, 'add_measurement', { metricType: 'ldl', value: 3.2 });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('READ-ONLY');
    expect(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json).schemaVersion).toBe(99);
  });
});

describe('discovery documents (US-32, design §6)', () => {
  it('names this resource exactly, and lists our issuer first', async () => {
    const { loader: wellKnown } = await import('./[.]well-known.$');
    const doc = await (await wellKnown({ params: { '*': 'oauth-protected-resource/mcp' } } as never) as Response).json();
    expect(doc.resource).toBe(`${ISSUER}/mcp`);
    expect(doc.authorization_servers[0]).toBe(ISSUER);
  });

  it('advertises CIMD and "none", which Claude needs both of', async () => {
    const { loader: wellKnown } = await import('./[.]well-known.$');
    const doc = await (await wellKnown({ params: { '*': 'oauth-authorization-server' } } as never) as Response).json();
    expect(doc.client_id_metadata_document_supported).toBe(true);
    expect(doc.token_endpoint_auth_methods_supported).toContain('none');
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
    expect(doc.authorization_response_iss_parameter_supported).toBe(true);
  });
});
