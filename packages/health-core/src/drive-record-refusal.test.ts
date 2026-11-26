/**
 * US-10 AC12 (lead S62b, root fix R6): a Google Drive record save reports
 * Drive's own refusal as a refusal, and only a real no-answer or an
 * ambiguous answer as "may have landed". The pre-upload version check sends
 * no upload, so its failure is the check's own; a 4xx answer to the create
 * POST itself stored nothing. A 5xx, a 408 or 429, a dropped socket, a
 * timeout to an upload, any failure of an update PATCH but its 400, 403 and
 * 404 (US-10 AC4a, AC16) and any failure after the upload may have landed.
 * The check's own 5xx, 408, 429 or timeout got no answer: nothing was written
 * (US-10 AC16, owner 2026-11-25). A 403 that names a rate limit is
 * `rate-limited`, never an access refusal.
 * The outcome is read as the caller reads it: SyncManager's save, then the
 * error's typed `outcome` and `mayHaveLanded` (what the erase path decides on),
 * and an erase end to end. Real DriveAdapter and SyncManager; synthetic HTTP only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageError, type StorageFailureReason, type StorageOutcome } from './adapter';
import { DriveAdapter } from './drive-rest';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { ROADMAP_DOC } from './roadmap-doc';
import { createMeasurement } from './roadmap-file';
import { saveFailureCause } from './save-state';
import { describeStorageFailure, SyncManager } from './sync-manager';
import { mayHaveLanded } from './write-refusal';

/** How one scripted call fails: an HTTP answer, a 403 naming a Drive limit, a dropped socket, or a timeout. */
type Failure = number | 'drop' | 'timeout' | 'rateLimitExceeded' | 'userRateLimitExceeded' | 'storageQuotaExceeded';
/** Which call fails: the write's record lookup (its search), the pre-upload version check, the create POST, the update PATCH, or the verify read after it. */
type Step = 'lookup' | 'check' | 'create' | 'update' | 'verify';

const NOW = '2026-11-25T10:00:00.000Z';
const ctx = { deviceId: 'phone', now: NOW };

function recordJson(): string {
  const file = ROADMAP_DOC.migrate(null, ctx);
  file.measurements.push(createMeasurement({ id: 'w1', metricType: 'weight', value: 80, recordedAt: '2026-11-01', createdAt: NOW }));
  return JSON.stringify(file);
}

function failWith(failure: Failure): Response {
  if (failure === 'drop') throw new TypeError('terminated');
  if (failure === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
  if (typeof failure === 'string') return Response.json({ error: { code: 403, errors: [{ domain: 'usageLimits', reason: failure }] } }, { status: 403 });
  return new Response('{"error":{"message":"refused"}}', { status: failure });
}

/**
 * One record on Drive (or none, for a first create), and one scripted failure.
 * The pre-upload check is the second version read after a record search: the
 * first belongs to the snapshot, the second to driveUpdateIfVersion.
 */
function drive(step: Step, failure: Failure, opts: { armed?: () => boolean; lookup?: number } = {}) {
  const exists = step !== 'create';
  let json = recordJson();
  let versionReads = 0;
  let searches = 0;
  let uploaded = false;
  const armed = opts.armed ?? (() => true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    if (url.includes('/upload/')) {
      if (method === 'POST' && step === 'create' && armed()) return failWith(failure);
      if (method === 'PATCH' && step === 'update' && armed()) return failWith(failure);
      json = String(init.body);
      uploaded = true;
      return Response.json({ id: 'r1', version: '4' });
    }
    if (url.includes('mimeType')) return Response.json({ files: [{ id: 'folder1', name: 'Health Roadmap' }] });
    if (url.includes('/files?q=')) {
      versionReads = 0;
      // The save's read searches first; the write's own lookup is the next armed search (`lookup`, default 2).
      if (step === 'lookup' && armed() && ++searches === (opts.lookup ?? 2)) return failWith(failure);
      return Response.json({ files: exists ? [{ id: 'r1', createdTime: '2026-01-01T00:00:00.000Z' }] : [] });
    }
    if (url.includes('fields=version')) {
      if (++versionReads === 2 && step === 'check' && armed()) return failWith(failure);
      return Response.json({ version: uploaded ? '4' : '3' });
    }
    if (url.includes('alt=media')) {
      if (uploaded && step === 'verify' && armed()) return failWith(failure);
      return new Response(json);
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }));
}

async function saveFailure(): Promise<unknown> {
  const sync = new SyncManager(new DriveAdapter('test-token-good'), 'phone', ROADMAP_DOC, { now: () => NOW });
  return sync.save(ROADMAP_DOC.migrate(JSON.parse(recordJson()), ctx)).then(() => null, (error: unknown) => error);
}

afterEach(() => vi.unstubAllGlobals());

describe('US-10 AC12 (S62b): what a failed Drive record save tells its caller', () => {
  const rows: Array<[string, Step, Failure, StorageOutcome, StorageFailureReason?]> = [
    // The write's record lookup sends no write: its failure got no answer, or was refused (US-10 AC16).
    ['a 500 on the write\'s record lookup', 'lookup', 500, 'no-answer'],
    ['a rate limit (403) on the write\'s record lookup', 'lookup', 'rateLimitExceeded', 'refused', 'rate-limited'],
    ['a 403 on the write\'s record lookup', 'lookup', 403, 'refused', 'forbidden'],
    ['a 403 on the pre-upload version check', 'check', 403, 'refused', 'forbidden'],
    ['a 400 on the pre-upload version check', 'check', 400, 'refused'],
    ['a 401 on the pre-upload version check', 'check', 401, 'refused', 'auth'],
    // The check sent no write: its own failure got no answer, and nothing was written (owner, 2026-11-25).
    ['a 500 on the pre-upload version check', 'check', 500, 'no-answer'],
    ['a 503 on the pre-upload version check', 'check', 503, 'no-answer'],
    ['a 408 on the pre-upload version check', 'check', 408, 'no-answer'],
    ['a 429 on the pre-upload version check', 'check', 429, 'no-answer'],
    ['a socket dropped on the pre-upload version check', 'check', 'drop', 'no-answer'],
    ['a timeout on the pre-upload version check', 'check', 'timeout', 'no-answer'],
    ['a rate limit (403) on the pre-upload version check', 'check', 'rateLimitExceeded', 'refused', 'rate-limited'],
    ['a 400 answer to the create POST', 'create', 400, 'refused'],
    ['a 403 answer to the create POST', 'create', 403, 'refused', 'forbidden'],
    ['a 404 answer to the create POST (folder gone)', 'create', 404, 'refused'],
    ['a user rate limit (403) on the create POST', 'create', 'userRateLimitExceeded', 'refused', 'rate-limited'],
    // A full Drive stored nothing, and is not an access refusal.
    ['a full Drive (403) on the create POST', 'create', 'storageQuotaExceeded', 'refused', 'storage-full'],
    ['a full Drive (403) on the update PATCH', 'update', 'storageQuotaExceeded', 'refused', 'storage-full'],
    // An update PATCH's 400, 403 and 404 stored nothing; its 401 and every other failure may have landed (owner, 2026-11-25).
    ['a 403 answer to the update PATCH', 'update', 403, 'refused', 'forbidden'],
    ['a 400 answer to the update PATCH', 'update', 400, 'refused'],
    ['a 404 answer to the update PATCH', 'update', 404, 'refused'],
    ['a 401 answer to the update PATCH', 'update', 401, 'may-have-landed', 'auth'],
    ['a rate limit (403) on the update PATCH', 'update', 'rateLimitExceeded', 'may-have-landed', 'rate-limited'],
    ['a 500 answer to the create POST', 'create', 500, 'may-have-landed'],
    ['a 503 answer to the update PATCH', 'update', 503, 'may-have-landed'],
    ['a 408 answer to the create POST', 'create', 408, 'may-have-landed'],
    ['a 429 answer to the update PATCH', 'update', 429, 'may-have-landed'],
    ['a socket dropped mid-upload (PATCH)', 'update', 'drop', 'may-have-landed'],
    ['a socket dropped mid-upload (POST)', 'create', 'drop', 'may-have-landed'],
    ['a timeout on the upload (PATCH)', 'update', 'timeout', 'may-have-landed'],
    ['a timeout on the upload (POST)', 'create', 'timeout', 'may-have-landed'],
    ['a 401 on the verify read after the upload', 'verify', 401, 'may-have-landed', 'auth'],
    ['a 403 on the verify read after the upload', 'verify', 403, 'may-have-landed', 'forbidden'],
  ];
  it.each(rows)('%s: %s', async (_name, step, failure, outcome, reason) => {
    drive(step, failure);
    const error = await saveFailure();
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).outcome).toBe(outcome);
    expect((error as StorageError).reason).toBe(reason);
    expect(mayHaveLanded(error)).toBe(outcome === 'may-have-landed');
    // A refusal never says the change may have landed; a may-have-landed failure always does.
    const told = describeStorageFailure(error, 'The record in Google Drive');
    expect(/landed/i.test(told.hint)).toBe(outcome === 'may-have-landed');
    // A rate limit passes: it is never worded as an access refusal, and the save is retried.
    expect(/refused this connection/.test(told.message)).toBe(reason === 'auth' || reason === 'forbidden');
    if (reason === 'rate-limited') expect(saveFailureCause(error)).toBe('other');
  });
});

/** A device copy whose every write is refused (a full store), as in record-session.erase-mirror.test.ts. */
class RefusingDevice extends MemoryAdapter {
  async write(): Promise<never> {
    throw new StorageError('refused', undefined, Object.assign(new Error('full'), { name: 'QuotaExceededError' }), undefined, undefined, 'refused');
  }
}

describe('US-10 AC12 (S62b): an erase that Drive refuses before its upload is put back', () => {
  // 500: the check, or the write's record lookup, got no answer, so nothing was written (US-10 AC16, owner 2026-11-25).
  it.each([['check', 403], ['check', 500], ['lookup', 500]] as Array<[Step, number]>)('a %s %s before the upload, the device refusing too: the erase answers not erased and the record is as before', async (step, status) => {
    let erasing = false;
    // An erase reads the record, then saves (a read, then the write's lookup): its lookup is the third search.
    drive(step, status, { armed: () => erasing, lookup: 3 });
    const device = new RefusingDevice(new MemoryCloud());
    const host: RecordHost = {
      tier: 'cloud',
      store: new DriveAdapter('test-token-good'),
      clearOffFileData: () => {},
      clearedErase: () => null,
      noteCleared: () => {},
      deviceId: () => 'phone',
      clock: { now: () => Date.parse(NOW) },
      timers: { set: () => ({}), clear: () => {} },
      remoteChanged: () => {},
      failureCause: () => 'QuotaExceededError',
      report: () => {},
      mirror: {
        adapter: device,
        pending: { get: () => false, set: () => {}, clear: () => {} },
        writesStopped: () => false,
        wipe: async () => {},
        opened: () => {},
      },
    };
    const session = await RecordSession.open(host);
    expect(session.file.measurements.map((m) => m.id)).toEqual(['w1']);
    const before = session.eraseIdentity;
    erasing = true;
    const result = await session.erase();
    expect(result).toEqual({ success: false });
    expect(session.eraseIdentity).toBe(before);
    expect(session.file.measurements.map((m) => m.id)).toEqual(['w1']);
  });
});
