/**
 * US-09 AC30 (lead A1 step e): a save refused for a revoked grant is never
 * retried; one that failed for any other reason (a dead network) is. Each
 * error here is the web adapter's own, made by its real code path against a
 * stubbed fetch, and reaches the record session as a save would meet it: the
 * session opens on a working store, then the adapter takes over its reads and
 * writes. `retry()` answers null when no retry is owed. Synthetic tokens; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RecordSession } from '@roadmap/health-core/record-session';
import type { RecordHost } from '@roadmap/health-core/record-host';
import { ROADMAP_FILE_NAME, StorageError, type StorageAdapter } from '@roadmap/health-core/adapter';
import { createMeasurement } from '@roadmap/health-core/roadmap-file';
import { DropboxAdapter, TOKEN_KEY as DROPBOX_TOKENS } from './dropbox';
import { CONFIG_KEY as DRIVE_CONFIG, GoogleDriveAdapter, TOKENS_KEY as DRIVE_TOKENS } from './drive';

let local: Map<string, string>;
function storage(s: Map<string, string>): Storage {
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  local = new Map();
  vi.stubGlobal('localStorage', storage(local));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A memory store until `real` is set; then the real adapter does every read and write. */
class Handover extends MemoryAdapter {
  real: StorageAdapter | null = null;
  async read(fileName: string) { return this.real ? this.real.read(fileName) : super.read(fileName); }
  async write(fileName: string, body: object, expected: string | null) {
    return this.real ? this.real.write(fileName, body, expected) : super.write(fileName, body, expected);
  }
}

/** A memory store whose reads go to `real` once a write has landed while it is set: the
 *  save's verify read after its write meets the real adapter's error (Codex R2). */
class VerifyHandover extends MemoryAdapter {
  real: StorageAdapter | null = null;
  wrote = false;
  async read(fileName: string) { return this.real && this.wrote ? this.real.read(fileName) : super.read(fileName); }
  async write(fileName: string, body: object, expected: string | null) {
    const result = await super.write(fileName, body, expected);
    if (this.real) this.wrote = true;
    return result;
  }
}

function host(store: StorageAdapter): RecordHost {
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

/** Open a session, edit, hand the store to `real`, and fail the save; answer what retry() gives. */
async function retryAfterFailedSave(real: StorageAdapter): Promise<Promise<boolean> | null> {
  const store = new Handover(new MemoryCloud());
  const session = await RecordSession.open(host(store));
  session.edit((file) => void file.measurements.push(createMeasurement({ id: 'a', metricType: 'weight', value: 80, recordedAt: '2026-11-01', createdAt: new Date().toISOString() })));
  store.real = real;
  await expect(session.flush()).rejects.toThrow();
  const run = session.retry();
  await run; // a retry that started runs out before the test ends
  return run;
}

/** As retryAfterFailedSave, but the write lands and the save's verify read fails (the save
 *  rewraps that error, US-09 AC13d). Answers retry() and whether Settings would promise an upload. */
async function retryAfterVerifyFails(real: StorageAdapter): Promise<{ run: Promise<boolean> | null; due: boolean }> {
  const store = new VerifyHandover(new MemoryCloud());
  const session = await RecordSession.open(host(store));
  session.edit((file) => void file.measurements.push(createMeasurement({ id: 'a', metricType: 'weight', value: 80, recordedAt: '2026-11-01', createdAt: new Date().toISOString() })));
  store.real = real;
  await expect(session.flush()).rejects.toThrow();
  expect(store.wrote).toBe(true);
  const due = session.retryDue;
  const run = session.retry();
  await run;
  return { run, due };
}

/** The error the adapter's own read throws: the first call a save makes. */
async function readError(adapter: StorageAdapter): Promise<StorageError> {
  const error = await adapter.read(ROADMAP_FILE_NAME).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(StorageError);
  return error as StorageError;
}

describe('Dropbox (US-09 AC30)', () => {
  const CONFIG = { clientId: 'test-app-key', redirectUri: 'https://example.com/' };
  const expired = { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: 0 };
  const fresh = () => ({ accessToken: 'at-live', refreshToken: 'rt-live', expiresAt: Date.now() + 3_600_000 });

  it('a revoked refresh token (the token endpoint answers 400 invalid_grant) is never retried', async () => {
    local.set(DROPBOX_TOKENS, JSON.stringify(expired));
    vi.stubGlobal('fetch', vi.fn(async () => reply(400, { error: 'invalid_grant', error_description: 'refresh token is invalid or revoked' })));
    // Status 400, not 401 or 403 (dropbox.ts refresh()): the reason says reconnect (owner D1).
    const error = await readError(new DropboxAdapter(CONFIG));
    expect(error.status).toBe(400);
    expect(error.reason).toBe('reconnect');
    expect(error.message).toBe('Dropbox token refresh failed (400) — please reconnect.');
    expect(await retryAfterFailedSave(new DropboxAdapter(CONFIG))).toBeNull();
  });

  it('a token endpoint that answers 400 for another reason, or 500, is retried', async () => {
    local.set(DROPBOX_TOKENS, JSON.stringify(expired));
    vi.stubGlobal('fetch', vi.fn(async () => reply(400, { error: 'invalid_request' })));
    expect((await readError(new DropboxAdapter(CONFIG))).reason).toBeUndefined();
    expect(await retryAfterFailedSave(new DropboxAdapter(CONFIG))).not.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => reply(500, { error: 'server_error' })));
    expect((await readError(new DropboxAdapter(CONFIG))).reason).toBeUndefined();
  });

  it('an access token Dropbox refuses (401 on the record call) is never retried', async () => {
    local.set(DROPBOX_TOKENS, JSON.stringify(fresh()));
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error_summary: 'invalid_access_token/' })));
    expect((await readError(new DropboxAdapter(CONFIG))).status).toBe(401);
    expect(await retryAfterFailedSave(new DropboxAdapter(CONFIG))).toBeNull();
  });

  it('a dead network is retried', async () => {
    local.set(DROPBOX_TOKENS, JSON.stringify(fresh()));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect((await readError(new DropboxAdapter(CONFIG))).status).toBeUndefined();
    expect(await retryAfterFailedSave(new DropboxAdapter(CONFIG))).not.toBeNull();
  });
});

describe('Google Drive (US-09 AC30)', () => {
  const CONFIG = {
    clientId: 'test-client-id',
    scope: 'openid email https://www.googleapis.com/auth/drive.file',
    redirectUri: 'https://example.com/',
    exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
  };
  const expired = { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: 0 };
  const fresh = () => ({ accessToken: 'at-live', refreshToken: 'rt-live', expiresAt: Date.now() + 3_600_000 });
  const signedIn = (tokens: object) => {
    local.set(DRIVE_TOKENS, JSON.stringify(tokens));
    local.set(DRIVE_CONFIG, JSON.stringify({ accountEmail: 'a@example.com' }));
  };

  it('a revoked refresh token (the exchange answers 401) is never retried', async () => {
    signedIn(expired);
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'invalid_grant' })));
    // No status (drive.ts getToken()); the reason tells it from the dead network below (owner D1).
    const error = await readError(new GoogleDriveAdapter(CONFIG));
    expect(error.status).toBeUndefined();
    expect(error.reason).toBe('reconnect');
    expect(error.message).toBe('Google Drive needs to be reconnected.');
    signedIn(expired); // the refusal cleared the tokens
    expect(await retryAfterFailedSave(new GoogleDriveAdapter(CONFIG))).toBeNull();
  });

  it('an expired access token whose refresh cannot reach the exchange (offline) is retried', async () => {
    signedIn(expired);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const error = await readError(new GoogleDriveAdapter(CONFIG));
    expect(error.status).toBeUndefined();
    expect(error.message).toBe('Google Drive needs to be reconnected.'); // the revoked grant's words, but no reason
    expect(error.reason).toBeUndefined();
    expect(await retryAfterFailedSave(new GoogleDriveAdapter(CONFIG))).not.toBeNull();
  });

  it('an access token Drive refuses (401 on the record lookup) is never retried', async () => {
    signedIn(fresh());
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: { code: 401, message: 'Invalid Credentials' } })));
    expect((await readError(new GoogleDriveAdapter(CONFIG))).status).toBe(401);
    expect(await retryAfterFailedSave(new GoogleDriveAdapter(CONFIG))).toBeNull();
  });

  it('a dead network with a live access token is retried', async () => {
    signedIn(fresh());
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect((await readError(new GoogleDriveAdapter(CONFIG))).status).toBeUndefined();
    expect(await retryAfterFailedSave(new GoogleDriveAdapter(CONFIG))).not.toBeNull();
  });
});

// Codex R2 (F3): a revoked grant met by the verify read after a landed write keeps its
// reason through the save's rewrap, so it is still a refused sign-in: no retry, no promise.
describe('a revoked grant after the write landed (US-09 AC30)', () => {
  const DROPBOX = { clientId: 'test-app-key', redirectUri: 'https://example.com/' };
  const DRIVE = {
    clientId: 'test-client-id',
    scope: 'openid email https://www.googleapis.com/auth/drive.file',
    redirectUri: 'https://example.com/',
    exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
  };
  const expired = { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: 0 };

  it('Dropbox, 400 invalid_grant on the verify read: never retried, and Settings promises nothing', async () => {
    local.set(DROPBOX_TOKENS, JSON.stringify(expired));
    vi.stubGlobal('fetch', vi.fn(async () => reply(400, { error: 'invalid_grant' })));
    expect(await retryAfterVerifyFails(new DropboxAdapter(DROPBOX))).toEqual({ run: null, due: false });
  });

  it('Google Drive, a refresh with no grant on the verify read: never retried, and Settings promises nothing', async () => {
    local.set(DRIVE_TOKENS, JSON.stringify(expired));
    local.set(DRIVE_CONFIG, JSON.stringify({ accountEmail: 'a@example.com' }));
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'invalid_grant' })));
    expect(await retryAfterVerifyFails(new GoogleDriveAdapter(DRIVE))).toEqual({ run: null, due: false });
  });
});
