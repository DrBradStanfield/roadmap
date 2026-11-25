// @vitest-environment jsdom
/**
 * US-10 AC17 (root fix R6, PR 3b): failures raised inside a record save but
 * before its upload went out now name `no-answer` or `refused` where they are
 * raised. Before, they named no outcome, so SyncManager marked them may have
 * landed (write-refusal.ts afterWrite): the save state kept the landed mark,
 * an erase that failed so was kept in memory, and the user read "may have
 * landed". Each row runs the real adapter under SyncManager.save, and an erase
 * under RecordSession with a device copy that refuses too, against synthetic
 * HTTP; read through public behaviour, never hint words. Every row here
 * changed on purpose: each was landed, kept, and told LANDED before.
 * After an upload, nothing here is `refused` unless it is that upload's own
 * refusal: these rows fail before any upload is sent (the stubs count them).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageError, type StorageAdapter } from '@roadmap/health-core/adapter';
import { DriveAdapter } from '@roadmap/health-core/drive-rest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RecordSession } from '@roadmap/health-core/record-session';
import type { RecordHost } from '@roadmap/health-core/record-host';
import { ROADMAP_DOC } from '@roadmap/health-core/roadmap-doc';
import { createMeasurement } from '@roadmap/health-core/roadmap-file';
import { describeStorageFailure, SyncManager } from '@roadmap/health-core/sync-manager';
import { mayHaveLanded } from '@roadmap/health-core/write-refusal';
import { DropboxAdapter as WebDropboxAdapter } from './dropbox';
import { GitHubAdapter } from './github';
import { LocalStorageAdapter } from './local-storage-adapter';

const NOW = '2026-11-25T10:00:00.000Z';
const ctx = { deviceId: 'phone', now: NOW };
const json = (() => {
  const file = ROADMAP_DOC.migrate(null, ctx);
  file.measurements.push(createMeasurement({ id: 'w1', metricType: 'weight', value: 80, recordedAt: '2026-11-01', createdAt: NOW }));
  return JSON.stringify(file);
})();

type Case =
  | 'github repo check 500' | 'github repo check 503' | 'github repo check 408' | 'github repo check 429' | 'github public repo'
  | 'drive lookup incomplete' | 'drive lookup invalid metadata' | 'drive lookup repeated page token'
  | 'drive folder create 500' | 'drive folder create no id'
  | 'dropbox token refresh 500';

let uploads = 0;

/** Synthetic HTTP for `c`. `armed` holds the failure back while a session opens. */
function stub(c: Case, armed: () => boolean): void {
  let lookupsArmed = 0;
  let refreshesArmed = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    if (c.startsWith('github')) {
      if (url.endsWith('/repos/synthetic/synthetic-private')) {
        if (!armed()) return Response.json({ private: true });
        if (c === 'github public repo') return Response.json({ private: false });
        return new Response('{"message":"synthetic"}', { status: Number(c.slice(-3)) });
      }
      if (method === 'PUT') { uploads++; return Response.json({ content: { sha: 's2' } }); }
      if (url.includes('/contents/')) return Response.json({ sha: 's1', content: btoa(json), encoding: 'base64', size: json.length });
    }
    if (c.startsWith('drive')) {
      const creating = c.startsWith('drive folder');
      if (url.includes('/upload/')) { uploads++; return Response.json({ id: 'r1', version: '4' }); }
      if (url.includes('mimeType')) return Response.json({ files: creating ? [] : [{ id: 'folder1', name: 'Health Roadmap' }] });
      if (method === 'POST' && url.endsWith('/files?fields=id')) {
        if (!armed()) return Response.json({ id: 'folder1' });
        return c === 'drive folder create 500' ? new Response('{}', { status: 500 }) : Response.json({});
      }
      if (url.includes('/files?q=')) {
        // The save's read takes the first lookup after arming; the check before its upload, the rest.
        if (armed() && ++lookupsArmed >= 2) {
          if (c === 'drive lookup incomplete') return Response.json({ files: [], incompleteSearch: true });
          if (c === 'drive lookup invalid metadata') return Response.json({ files: [{ id: 5 }] });
          if (c === 'drive lookup repeated page token') return Response.json({ files: [], nextPageToken: 'p1' });
        }
        return Response.json({ files: creating ? [] : [{ id: 'r1', createdTime: '2026-01-01T00:00:00.000Z' }] });
      }
      if (url.includes('fields=version')) return Response.json({ version: '3' });
      if (url.includes('alt=media')) return new Response(json);
    }
    if (c.startsWith('dropbox')) {
      if (url.endsWith('/oauth2/token')) {
        // Each refresh grants a token that is already due again, so every call refreshes;
        // the second one after arming (the save's upload) gets a 500.
        if (armed() && ++refreshesArmed === 2) return new Response('{}', { status: 500 });
        return Response.json({ access_token: 'test-token-good', expires_in: 1 });
      }
      if (url.endsWith('/files/upload')) { uploads++; return Response.json({ rev: 'r2' }); }
      if (url.endsWith('/files/download')) return new Response(json, { headers: { 'dropbox-api-result': JSON.stringify({ rev: 'r1' }) } });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }));
}

function adapterOf(c: Case): StorageAdapter {
  if (c.startsWith('github')) return new GitHubAdapter({ token: 'test-token-good', owner: 'synthetic', repo: 'synthetic-private' });
  if (c.startsWith('dropbox')) {
    localStorage.setItem('health_roadmap_dropbox_tokens', JSON.stringify({ accessToken: 'test-token-good', refreshToken: 'test-token-good', expiresAt: 0 }));
    return new WebDropboxAdapter({ clientId: 'test-app-key', redirectUri: 'https://example.com/' });
  }
  return new DriveAdapter('test-token-good');
}

const SILENT = 'did not answer, nothing written';
function toldOf(error: unknown): string {
  const told = describeStorageFailure(error, 'The record');
  if (error instanceof StorageError && error.hint) return 'its own hint';
  if (told.message === 'The record did not answer' && /may have landed/.test(told.hint)) return 'did not answer, may have landed';
  return told.message === 'The record did not answer. Nothing was written' ? SILENT : 'other';
}

/** A device copy whose every write is refused (a full store). */
class RefusingDevice extends MemoryAdapter {
  async write(): Promise<never> {
    throw new StorageError('refused', undefined, Object.assign(new Error('full'), { name: 'QuotaExceededError' }), undefined, undefined, 'refused');
  }
}

async function eraseOutcome(c: Case): Promise<'put back' | 'kept'> {
  let armed = false;
  stub(c, () => armed);
  const host: RecordHost = {
    tier: 'cloud', store: adapterOf(c),
    clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {},
    deviceId: () => 'phone', clock: { now: () => Date.parse(NOW) },
    timers: { set: () => ({}), clear: () => {} }, remoteChanged: () => {},
    failureCause: () => 'QuotaExceededError', report: () => {},
    mirror: {
      adapter: new RefusingDevice(new MemoryCloud()),
      pending: { get: () => false, set: () => {}, clear: () => {} },
      writesStopped: () => false, wipe: async () => {}, opened: () => {},
    },
  };
  const session = await RecordSession.open(host);
  const before = session.eraseIdentity;
  armed = true;
  uploads = 0;
  expect((await session.erase()).success).toBe(false);
  expect(uploads).toBe(0);
  return session.eraseIdentity === before ? 'put back' : 'kept';
}

async function outcomeOf(c: Case) {
  stub(c, () => true);
  uploads = 0;
  const sync = new SyncManager(adapterOf(c), 'phone', ROADMAP_DOC, { now: () => NOW });
  const error = await sync.save(ROADMAP_DOC.migrate(JSON.parse(json), ctx)).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(StorageError);
  expect(uploads).toBe(0);
  const outcome = { landed: mayHaveLanded(error), outcome: (error as StorageError).outcome, told: toldOf(error) };
  vi.unstubAllGlobals();
  localStorage.clear();
  return { ...outcome, erase: await eraseOutcome(c) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** [case, outcome]. Every row: not landed, told SILENT, the erase put back. Was: landed, LANDED, kept. */
const ROWS: Array<[Case, 'no-answer' | 'refused']> = [
  // GitHub's private-repository check before the first write (github.ts assertPrivate).
  ['github repo check 500', 'no-answer'],
  ['github repo check 503', 'no-answer'],
  ['github repo check 408', 'no-answer'],
  ['github repo check 429', 'no-answer'],
  ['github public repo', 'refused'],
  // Google Drive's record lookup before the upload (drive-rest-record.ts discoverRecord).
  ['drive lookup incomplete', 'no-answer'],
  ['drive lookup invalid metadata', 'no-answer'],
  ['drive lookup repeated page token', 'no-answer'],
  // Google Drive's app-folder create before the record's first create (drive-rest-files.ts driveCreateFolder).
  ['drive folder create 500', 'no-answer'],
  ['drive folder create no id', 'no-answer'],
  // The web Dropbox adapter's token refresh before the upload (dropbox.ts refresh).
  ['dropbox token refresh 500', 'no-answer'],
];

describe('US-10 AC17: a record save that fails before its upload stored nothing', () => {
  it.each(ROWS)('%s: %s, not landed, told nothing written, the erase put back', async (c, outcome) => {
    expect(await outcomeOf(c)).toEqual({ landed: false, outcome, told: SILENT, erase: 'put back' });
  });
});

describe('US-10 AC17: the device tier (LocalStorageAdapter) when setItem fails for another reason than a full store', () => {
  it('a SecurityError on the record write: refused, not landed (was landed)', async () => {
    const sync = new SyncManager(new LocalStorageAdapter(), 'phone', ROADMAP_DOC, { now: () => NOW });
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'health_roadmap_file_v2') throw new DOMException('denied', 'SecurityError');
      setItem.call(this, key, value);
    });
    const error = await sync.save(ROADMAP_DOC.migrate(JSON.parse(json), ctx)).then(() => null, (e: unknown) => e);
    expect({ landed: mayHaveLanded(error), outcome: (error as StorageError).outcome, told: toldOf(error) }).toEqual({ landed: false, outcome: 'refused', told: SILENT });
  });
});
