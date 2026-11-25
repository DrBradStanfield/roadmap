// @vitest-environment jsdom
/**
 * US-10 AC13 (root fix R6, PR 2): what every caller concludes today from a
 * failed record save, per adapter and failure shape. Pins only: no
 * production change. Each row runs the real adapter under SyncManager.save
 * (and an erase under RecordSession) against synthetic HTTP, and reads the
 * outcome through public behaviour, never through hint words:
 * - landed: `mayHaveLanded` (the save state's landed mark, record-session.ts),
 * - refused: a conflict, or a failure raised with outcome `refused` (US-10 AC16),
 * - cause: whether a session's save failing so owes a retry (`retryDue`; 'auth' stops it),
 * - told: which `describeStorageFailure` sentence the user is shown (sync-manager.ts),
 * - erase: an erase whose cloud write fails this way, the device copy refused
 *   too, is put back or kept in memory (record-session-erase.ts).
 * Rows marked S62b are PR 1's (US-10 AC12); this file sits on that branch.
 * R6 PR 3 (US-10 AC16) moved these readers to the typed outcome field; rows
 * marked AC16 changed on purpose, for the owner's rulings of 2026-11-25. The
 * field itself, per adapter: storage-outcome-field.test.ts. Rows marked AC17
 * (R6 PR 3b): a sync conflict storm is now raised `refused`, every attempt's
 * write refused as a conflict. Failures before the upload: pre-write-outcome-pins.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, LostUpdateError, StorageError, type StorageAdapter } from '@roadmap/health-core/adapter';
import { DriveAdapter } from '@roadmap/health-core/drive-rest';
import { DropboxAdapter } from '@roadmap/health-core/dropbox-rest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RecordSession } from '@roadmap/health-core/record-session';
import type { RecordHost } from '@roadmap/health-core/record-host';
import { ROADMAP_DOC } from '@roadmap/health-core/roadmap-doc';
import { createMeasurement } from '@roadmap/health-core/roadmap-file';
import { describeStorageFailure, SyncManager } from '@roadmap/health-core/sync-manager';
import { mayHaveLanded } from '@roadmap/health-core/write-refusal';
import { GitHubAdapter } from './github';
import { LocalStorageAdapter } from './local-storage-adapter';
import { WebDavAdapter } from './webdav';
import { saveCauseOf } from '../testing/save-cause';

const NOW = '2026-11-25T10:00:00.000Z';
const ctx = { deviceId: 'phone', now: NOW };

/** How the scripted call fails: an HTTP answer (with an optional body), a dropped socket, or a timeout. */
type Failure = number | 'drop' | 'timeout' | { status: number; body: string };
type Kind = 'dropbox' | 'drive-create' | 'drive-update' | 'drive-check' | 'github' | 'webdav';

function failWith(failure: Failure): Response {
  if (failure === 'drop') throw new TypeError('terminated');
  if (failure === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
  if (typeof failure === 'number') return new Response('{"error":"synthetic"}', { status: failure });
  return new Response(failure.body, { status: failure.status });
}

function recordJson(): string {
  const file = ROADMAP_DOC.migrate(null, ctx);
  file.measurements.push(createMeasurement({ id: 'w1', metricType: 'weight', value: 80, recordedAt: '2026-11-01', createdAt: NOW }));
  return JSON.stringify(file);
}

/**
 * Each provider holds one record (none for a Drive create) and answers reads;
 * the one scripted call fails: the upload, or for drive-check the version
 * read just before it (the second version read after a record search).
 * `armed` holds the failure back while a session opens.
 */
function stub(kind: Kind, failure: Failure, armed: () => boolean): void {
  const json = recordJson();
  let versionReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    if (kind === 'dropbox') {
      if (url.endsWith('/files/upload')) return armed() ? failWith(failure) : Response.json({ rev: 'r2' });
      if (url.endsWith('/files/download')) return new Response(json, { headers: { 'dropbox-api-result': JSON.stringify({ rev: 'r1' }) } });
    }
    if (kind === 'github') {
      if (url.endsWith('/repos/synthetic/synthetic-private')) return Response.json({ private: true });
      if (method === 'PUT') return armed() ? failWith(failure) : Response.json({ content: { sha: 's2' } });
      if (url.includes('/contents/')) return Response.json({ sha: 's1', content: btoa(json), encoding: 'base64', size: json.length });
    }
    if (kind === 'webdav') {
      if (method === 'PUT') return armed() ? failWith(failure) : new Response(null, { status: 201, headers: { etag: '"2"' } });
      if (method === 'GET') return new Response(json, { headers: { etag: '"1"' } });
    }
    if (kind.startsWith('drive')) {
      if (url.includes('/upload/')) {
        const failing = (method === 'POST' && kind === 'drive-create') || (method === 'PATCH' && kind === 'drive-update');
        return failing && armed() ? failWith(failure) : Response.json({ id: 'r1', version: '4' });
      }
      if (url.includes('mimeType')) return Response.json({ files: [{ id: 'folder1', name: 'Health Roadmap' }] });
      if (url.includes('/files?q=')) {
        versionReads = 0;
        return Response.json({ files: kind === 'drive-create' ? [] : [{ id: 'r1', createdTime: '2026-01-01T00:00:00.000Z' }] });
      }
      if (url.includes('fields=version')) {
        if (++versionReads === 2 && kind === 'drive-check' && armed()) return failWith(failure);
        return Response.json({ version: '3' });
      }
      if (url.includes('alt=media')) return new Response(json);
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }));
}

function adapterOf(kind: Kind): StorageAdapter {
  if (kind === 'dropbox') return new DropboxAdapter('test-token-good');
  if (kind === 'github') return new GitHubAdapter({ token: 'test-token-good', owner: 'synthetic', repo: 'synthetic-private' });
  if (kind === 'webdav') return new WebDavAdapter({ url: 'https://synthetic.invalid/dav', username: 'synthetic', password: 'synthetic' });
  return new DriveAdapter('test-token-good');
}

/** Which describeStorageFailure sentence the user is shown. */
function toldOf(error: unknown): string {
  const told = describeStorageFailure(error, 'The record');
  if (error instanceof ConflictError) return 'conflict';
  if (told.message.endsWith('after a change was sent')) return MAYBE;
  if (told.message.endsWith('Nothing was read and nothing was written')) return NOTHING;
  if (error instanceof StorageError && error.hint) return told.hint === error.hint ? OWN : 'other';
  if (told.message === 'The record did not answer' && /may have landed/.test(told.hint)) return LANDED;
  return told.message === 'The record did not answer. Nothing was written' ? SILENT : 'other';
}

/** A conflict the provider refused, or a failure raised `refused`: nothing stored. */
function refusedOf(error: unknown): boolean {
  if (error instanceof ConflictError) return !(error instanceof LostUpdateError);
  return error instanceof StorageError && error.outcome === 'refused';
}

interface Outcome { landed: boolean; refused: boolean; cause: string; told: string; erase: 'put back' | 'kept' }

/** A device copy whose every write is refused (a full store). */
class RefusingDevice extends MemoryAdapter {
  async write(): Promise<never> {
    throw new StorageError('refused', undefined, Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
  }
}

async function eraseOutcome(kind: Kind, failure: Failure): Promise<'put back' | 'kept'> {
  let armed = false;
  stub(kind, failure, () => armed);
  const host: RecordHost = {
    tier: 'cloud', store: adapterOf(kind),
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
  const result = await session.erase();
  expect(result.success).toBe(false);
  return session.eraseIdentity === before ? 'put back' : 'kept';
}

async function outcomeOf(kind: Kind, failure: Failure): Promise<Outcome> {
  stub(kind, failure, () => true);
  const sync = new SyncManager(adapterOf(kind), 'phone', ROADMAP_DOC, { now: () => NOW });
  const error = await sync.save(ROADMAP_DOC.migrate(JSON.parse(recordJson()), ctx)).then(() => null, (e: unknown) => e);
  expect(error).not.toBeNull();
  const outcome = { landed: mayHaveLanded(error), refused: refusedOf(error), cause: await saveCauseOf(error), told: toldOf(error) };
  vi.unstubAllGlobals();
  return { ...outcome, erase: await eraseOutcome(kind, failure) };
}

afterEach(() => vi.unstubAllGlobals());

const SHAPES: Record<string, Failure> = {
  400: 400, 401: 401, 403: 403, 404: 404, 409: 409, 412: 412, 422: 422,
  408: 408, 429: 429, 500: 500, 503: 503, drop: 'drop', timeout: 'timeout',
};
const NOTHING = 'access, nothing written';
const MAYBE = 'access, may have landed';
const OWN = 'its own hint';
const SILENT = 'did not answer, nothing written';
/** "did not answer", and the change may have landed (US-10 AC16). */
const LANDED = 'did not answer, may have landed';

/** [adapter, shape, landed, refused, cause, told]. The erase column follows `landed`: kept when it may have landed, else put back. */
type Row = [Kind, string, boolean, boolean, 'auth' | 'other', string];
const ROWS: Row[] = [
  // Dropbox (dropbox-rest.ts dropboxWrite; the web adapter writes through it too). A 409 with no
  // error summary is a ConflictError, so every attempt conflicts: a storm that wrote nothing.
  ['dropbox', '400', false, true, 'other', SILENT],
  ['dropbox', '401', false, true, 'auth', NOTHING],
  ['dropbox', '403', false, true, 'other', NOTHING],
  ['dropbox', '404', false, true, 'other', SILENT],
  ['dropbox', '409', false, true, 'other', OWN], // AC17: was not refused (a storm named no outcome)
  ['dropbox', '412', false, true, 'other', SILENT],
  ['dropbox', '422', false, true, 'other', SILENT],
  ['dropbox', '408', true, false, 'other', LANDED], // AC16: was SILENT
  ['dropbox', '429', true, false, 'other', LANDED], // AC16: was SILENT
  ['dropbox', '500', true, false, 'other', LANDED], // AC16: was SILENT
  ['dropbox', '503', true, false, 'other', LANDED], // AC16: was SILENT
  ['dropbox', 'drop', true, false, 'other', OWN],
  ['dropbox', 'timeout', true, false, 'other', OWN],
  // Google Drive, first create (POST). The 4xx rows but 408 and 429 are PR 1's (S62b, US-10 AC12).
  ['drive-create', '400', false, true, 'other', OWN],
  ['drive-create', '401', false, true, 'auth', NOTHING],
  ['drive-create', '403', false, true, 'other', NOTHING],
  ['drive-create', '404', false, true, 'other', OWN],
  ['drive-create', '409', false, true, 'other', OWN],
  ['drive-create', '412', false, true, 'other', OWN],
  ['drive-create', '422', false, true, 'other', OWN],
  ['drive-create', '408', true, false, 'other', OWN],
  ['drive-create', '429', true, false, 'other', OWN],
  ['drive-create', '500', true, false, 'other', OWN],
  ['drive-create', '503', true, false, 'other', OWN],
  ['drive-create', 'drop', true, false, 'other', OWN],
  ['drive-create', 'timeout', true, false, 'other', OWN],
  // Google Drive, update (PATCH): every failure may have landed (US-10 AC4a) but its 400, 403 and 404 (AC16).
  ['drive-update', '400', false, true, 'other', OWN], // AC16: was landed
  ['drive-update', '401', true, false, 'auth', MAYBE],
  ['drive-update', '403', false, true, 'other', NOTHING], // AC16: was landed, MAYBE
  ['drive-update', '404', false, true, 'other', OWN], // AC16: was landed
  ['drive-update', '409', true, false, 'other', OWN],
  ['drive-update', '412', true, false, 'other', OWN],
  ['drive-update', '422', true, false, 'other', OWN],
  ['drive-update', '408', true, false, 'other', OWN],
  ['drive-update', '429', true, false, 'other', OWN],
  ['drive-update', '500', true, false, 'other', OWN],
  ['drive-update', '503', true, false, 'other', OWN],
  ['drive-update', 'drop', true, false, 'other', OWN],
  ['drive-update', 'timeout', true, false, 'other', OWN],
  // Google Drive, the version check before the PATCH. Every row but 404, drop and timeout is PR 1's
  // (S62b): the 4xx ones now refuse, and the 408/429/5xx ones lost the create-path hint. A 404 reads
  // as a vanished file, a conflict each attempt: a storm. The check sent no write, so the rest got no answer (AC16).
  ['drive-check', '400', false, true, 'other', SILENT],
  ['drive-check', '401', false, true, 'auth', NOTHING],
  ['drive-check', '403', false, true, 'other', NOTHING],
  ['drive-check', '404', false, true, 'other', OWN], // AC17: was not refused
  ['drive-check', '409', false, true, 'other', SILENT],
  ['drive-check', '412', false, true, 'other', SILENT],
  ['drive-check', '422', false, true, 'other', SILENT],
  ['drive-check', '408', false, false, 'other', SILENT], // AC16: was landed
  ['drive-check', '429', false, false, 'other', SILENT], // AC16: was landed
  ['drive-check', '500', false, false, 'other', SILENT], // AC16: was landed
  ['drive-check', '503', false, false, 'other', SILENT], // AC16: was landed
  ['drive-check', 'drop', false, false, 'other', OWN], // AC16: was landed
  ['drive-check', 'timeout', false, false, 'other', OWN], // AC16: was landed
  // GitHub: 409 and 422 are ConflictErrors, so a storm.
  ['github', '400', false, true, 'other', SILENT],
  ['github', '401', false, true, 'auth', NOTHING],
  ['github', '403', false, true, 'other', NOTHING],
  ['github', '404', false, true, 'other', SILENT],
  ['github', '409', false, true, 'other', OWN], // AC17: was not refused
  ['github', '412', false, true, 'other', SILENT],
  ['github', '422', false, true, 'other', OWN], // AC17: was not refused
  ['github', '408', true, false, 'other', LANDED], // AC16: was SILENT
  ['github', '429', true, false, 'other', LANDED], // AC16: was SILENT
  ['github', '500', true, false, 'other', LANDED], // AC16: was SILENT
  ['github', '503', true, false, 'other', LANDED], // AC16: was SILENT
  ['github', 'drop', true, false, 'other', OWN],
  ['github', 'timeout', true, false, 'other', OWN],
  // WebDAV: 412 is a ConflictError, so a storm.
  ['webdav', '400', false, true, 'other', SILENT],
  ['webdav', '401', false, true, 'auth', NOTHING],
  ['webdav', '403', false, true, 'other', NOTHING],
  ['webdav', '404', false, true, 'other', SILENT],
  ['webdav', '409', false, true, 'other', SILENT],
  ['webdav', '412', false, true, 'other', OWN], // AC17: was not refused
  ['webdav', '422', false, true, 'other', SILENT],
  ['webdav', '408', true, false, 'other', LANDED], // AC16: was SILENT
  ['webdav', '429', true, false, 'other', LANDED], // AC16: was SILENT
  ['webdav', '500', true, false, 'other', LANDED], // AC16: was SILENT
  ['webdav', '503', true, false, 'other', LANDED], // AC16: was SILENT
  ['webdav', 'drop', true, false, 'other', OWN],
  ['webdav', 'timeout', true, false, 'other', OWN],
];

describe('US-10 AC13: a failed record save, per adapter and failure shape', () => {
  it.each(ROWS)('%s, %s: landed %s, refused %s, cause %s, told %s', async (kind, shape, landed, refused, cause, told) => {
    expect(await outcomeOf(kind, SHAPES[shape])).toEqual({ landed, refused, cause, told, erase: landed ? 'kept' : 'put back' });
  });

  it('a Dropbox 409 that names a full store is a refusal with its own words (reason storage-full)', async () => {
    const full = { status: 409, body: '{"error_summary":"path/insufficient_space/.."}' };
    expect(await outcomeOf('dropbox', full)).toEqual({ landed: false, refused: true, cause: 'other', told: OWN, erase: 'put back' });
  });
});

describe('US-10 AC13: the device tier (LocalStorageAdapter) when the browser store is full', () => {
  afterEach(() => vi.restoreAllMocks());
  /** The save's outcome when setItem refuses the keys `refuses` picks. */
  async function localOutcome(refuses: (key: string) => boolean) {
    const sync = new SyncManager(new LocalStorageAdapter(), 'phone', ROADMAP_DOC, { now: () => NOW });
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (refuses(key)) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    const error = await sync.save(ROADMAP_DOC.migrate(JSON.parse(recordJson()), ctx)).then(() => null, (e: unknown) => e);
    localStorage.clear();
    return { landed: mayHaveLanded(error), refused: refusedOf(error), cause: await saveCauseOf(error), told: toldOf(error) };
  }
  it('the record write refused: nothing stored', async () => {
    expect(await localOutcome((key) => key === 'health_roadmap_file_v2')).toEqual({ landed: false, refused: true, cause: 'other', told: SILENT });
  });
  it('the revision write refused and the old record put back: nothing stored', async () => {
    expect(await localOutcome((key) => key === 'health_roadmap_file_v2_rev')).toEqual({ landed: false, refused: true, cause: 'other', told: SILENT });
  });
});
