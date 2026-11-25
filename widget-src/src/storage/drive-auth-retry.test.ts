/**
 * US-10 AC19 (S57c): a web Google Drive save whose access token is refused on the verify read
 * after its upload (a 401 that may have landed) owes a retry, and the retry asks for a fresh
 * token before any Drive call. The retries end: a grant the exchange refuses, or a fresh token
 * Drive refuses before any upload, comes back as a refused sign-in and no retry is owed.
 * The real web adapter under RecordSession, over a synthetic Drive and token exchange.
 * Synthetic tokens; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RecordSession } from '@roadmap/health-core/record-session';
import type { RecordHost } from '@roadmap/health-core/record-host';
import { ROADMAP_DOC } from '@roadmap/health-core/roadmap-doc';
import { createMeasurement } from '@roadmap/health-core/roadmap-file';
import { CONFIG_KEY as DRIVE_CONFIG, GoogleDriveAdapter, TOKENS_KEY as DRIVE_TOKENS } from './drive';

const CONFIG = {
  clientId: 'test-client-id',
  scope: 'openid email https://www.googleapis.com/auth/drive.file',
  redirectUri: 'https://example.com/',
  exchangeUrl: 'https://synthetic.invalid/api/google-token',
};
const NOW = '2026-11-25T10:00:00.000Z';

let local: Map<string, string>;
beforeEach(() => {
  local = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
    clear: () => local.clear(),
    key: (i: number) => [...local.keys()][i] ?? null,
    get length() { return local.size; },
  });
  local.set(DRIVE_TOKENS, JSON.stringify({ accessToken: 'at-first', refreshToken: 'rt-one', expiresAt: Date.now() + 3_600_000 }));
  local.set(DRIVE_CONFIG, JSON.stringify({ accountEmail: 'a@example.com', folderId: 'folder1' }));
});
afterEach(() => vi.unstubAllGlobals());

/** What the token exchange answers on the retry: a refused grant, or a fresh token. */
type Exchange = 'invalid_grant' | 'fresh';
/** What Drive does with the fresh token: refuses it at the record lookup, or takes the save. */
type Fresh = 'refused' | 'accepted';

/**
 * One record on Drive. The first access token's save uploads, then every call after its upload
 * answers 401 (the verify read). `calls` logs each request, in order, by kind.
 */
function drive(exchange: Exchange, fresh: Fresh, calls: string[]) {
  let json = JSON.stringify(ROADMAP_DOC.migrate(null, { deviceId: 'web-1', now: NOW }));
  let uploaded = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    if (url === CONFIG.exchangeUrl) {
      calls.push('exchange');
      return exchange === 'fresh'
        ? Response.json({ accessToken: 'at-fresh', expiresIn: 3600 })
        : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    const token = new Headers(init.headers).get('Authorization');
    calls.push(`${method} ${token}`);
    const refused = (token === 'Bearer at-first' && uploaded) || (token === 'Bearer at-fresh' && fresh === 'refused');
    if (refused) return new Response('{"error":{"code":401,"message":"Invalid Credentials"}}', { status: 401 });
    if (url.includes('/upload/')) {
      json = String(init.body);
      uploaded = true;
      return Response.json({ id: 'r1', version: '4' });
    }
    if (url.includes('/files?q=')) return Response.json({ files: [{ id: 'r1', createdTime: '2026-01-01T00:00:00.000Z' }] });
    if (url.includes('fields=version')) return Response.json({ version: uploaded ? '4' : '3' });
    if (url.includes('alt=media')) return new Response(json);
    throw new Error(`unexpected request ${method} ${url}`);
  }));
}

function host(store: GoogleDriveAdapter): RecordHost {
  return {
    tier: 'cloud', store,
    mirror: {
      adapter: new MemoryAdapter(new MemoryCloud()),
      pending: { get: () => false, set: () => {}, clear: () => {} },
      writesStopped: () => false, wipe: async () => {}, opened: () => {},
    },
    clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {},
    deviceId: () => 'web-1', clock: { now: () => Date.now() },
    timers: { set: () => ({}), clear: () => {} },
    remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
  };
}

/** Open, edit, and fail the save on the verify read's 401. Answers the session and the calls so far. */
async function failedOnVerify(exchange: Exchange, fresh: Fresh) {
  const calls: string[] = [];
  drive(exchange, fresh, calls);
  const session = await RecordSession.open(host(new GoogleDriveAdapter(CONFIG)));
  session.edit((file) => void file.measurements.push(createMeasurement({ id: 'w1', metricType: 'weight', value: 80, recordedAt: '2026-11-01', createdAt: NOW })), session.shownErase);
  await expect(session.flush()).rejects.toThrow();
  expect(calls.filter((c) => c.startsWith('PATCH'))).toEqual(['PATCH Bearer at-first']); // the upload went out
  expect(calls.at(-1)).toBe('GET Bearer at-first'); // the read after it was refused
  return { session, calls };
}

describe('US-10 AC19 (S57c): a 401 after a Drive upload that may have landed', () => {
  it('owes a retry, and the retry asks for a fresh token before any Drive call', async () => {
    const { session, calls } = await failedOnVerify('fresh', 'accepted');
    expect(session.retryDue).toBe(true);
    const before = calls.length;
    expect(await session.retry()).toBe(true);
    const retry = calls.slice(before);
    expect(retry[0]).toBe('exchange');
    expect(retry.slice(1).every((c) => c.endsWith('Bearer at-fresh'))).toBe(true);
    expect(session.retryDue).toBe(false);
    expect(session.saveStatus).toBe('saved');
  });

  it('ends against a dead grant: the exchange refuses it, nothing goes to Drive, and no retry is owed', async () => {
    const { session, calls } = await failedOnVerify('invalid_grant', 'accepted');
    expect(session.retryDue).toBe(true);
    const before = calls.length;
    expect(await session.retry()).toBe(false);
    expect(calls.slice(before)).toEqual(['exchange']);
    expect(session.retryDue).toBe(false);
    expect(session.retry()).toBeNull(); // the next trigger starts nothing
    expect(calls.length).toBe(before + 1);
  });

  it('ends when Drive refuses the fresh token before any upload: no retry is owed', async () => {
    const { session, calls } = await failedOnVerify('fresh', 'refused');
    const before = calls.length;
    expect(await session.retry()).toBe(false);
    const retry = calls.slice(before);
    expect(retry).toEqual(['exchange', 'GET Bearer at-fresh']); // the save's first read, refused
    expect(retry.some((c) => c.startsWith('PATCH'))).toBe(false);
    expect(session.retryDue).toBe(false);
    expect(session.retry()).toBeNull();
  });
});
