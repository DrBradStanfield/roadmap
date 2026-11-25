/**
 * US-10 AC12 (lead S62b, root fix R6): a Google Drive record save reports
 * Drive's own refusal as a refusal, and only a real no-answer or an
 * ambiguous answer as "may have landed". The pre-upload version check sends
 * no upload, so its failure is the check's own; a 4xx answer to the create
 * POST itself stored nothing. A 5xx, a 408 or 429, a dropped socket, a
 * timeout, any failure of an update PATCH (US-10 AC4a) and any failure after
 * the upload may have landed.
 * The outcome is read as the caller reads it: SyncManager's save, then
 * `mayHaveLanded` / `isDefiniteRefusal` (what the erase path decides on), and
 * an erase end to end. Real DriveAdapter and SyncManager; synthetic HTTP only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageError } from './adapter';
import { DriveAdapter } from './drive-rest';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { ROADMAP_DOC } from './roadmap-doc';
import { createMeasurement } from './roadmap-file';
import { describeStorageFailure, SyncManager } from './sync-manager';
import { isDefiniteRefusal, mayHaveLanded } from './write-refusal';

/** How one scripted call fails: an HTTP answer, a dropped socket, or a timeout. */
type Failure = number | 'drop' | 'timeout';
/** Which call fails: the pre-upload version check, the create POST, the update PATCH, or the verify read after it. */
type Step = 'check' | 'create' | 'update' | 'verify';

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
  return new Response('{"error":{"message":"refused"}}', { status: failure });
}

/**
 * One record on Drive (or none, for a first create), and one scripted failure.
 * The pre-upload check is the second version read after a record search: the
 * first belongs to the snapshot, the second to driveUpdateIfVersion.
 */
function drive(step: Step, failure: Failure, opts: { armed?: () => boolean } = {}) {
  const exists = step !== 'create';
  let json = recordJson();
  let versionReads = 0;
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
  const rows: Array<[string, Step, Failure, 'refused' | 'may have landed']> = [
    ['a 403 on the pre-upload version check', 'check', 403, 'refused'],
    ['a 400 on the pre-upload version check', 'check', 400, 'refused'],
    ['a 401 on the pre-upload version check', 'check', 401, 'refused'],
    ['a 400 answer to the create POST', 'create', 400, 'refused'],
    ['a 403 answer to the create POST', 'create', 403, 'refused'],
    ['a 404 answer to the create POST (folder gone)', 'create', 404, 'refused'],
    // An update PATCH's own 4xx stays "may have landed", as US-10 AC4a pins (drive-first-save.test.ts).
    ['a 403 answer to the update PATCH', 'update', 403, 'may have landed'],
    ['a 400 answer to the update PATCH', 'update', 400, 'may have landed'],
    ['a 500 answer to the create POST', 'create', 500, 'may have landed'],
    ['a 503 answer to the update PATCH', 'update', 503, 'may have landed'],
    ['a 408 answer to the create POST', 'create', 408, 'may have landed'],
    ['a 429 answer to the update PATCH', 'update', 429, 'may have landed'],
    ['a socket dropped mid-upload (PATCH)', 'update', 'drop', 'may have landed'],
    ['a socket dropped mid-upload (POST)', 'create', 'drop', 'may have landed'],
    ['a timeout on the upload (PATCH)', 'update', 'timeout', 'may have landed'],
    ['a timeout on the upload (POST)', 'create', 'timeout', 'may have landed'],
    ['a 401 on the verify read after the upload', 'verify', 401, 'may have landed'],
    ['a 403 on the verify read after the upload', 'verify', 403, 'may have landed'],
  ];
  it.each(rows)('%s: %s', async (_name, step, failure, outcome) => {
    drive(step, failure);
    const error = await saveFailure();
    expect(error).toBeInstanceOf(StorageError);
    expect(mayHaveLanded(error)).toBe(outcome === 'may have landed');
    expect(isDefiniteRefusal(error)).toBe(outcome === 'refused');
    // A refusal never says the change may have landed; a may-have-landed failure always does.
    const { hint } = describeStorageFailure(error, 'The record in Google Drive');
    expect(/landed/i.test(hint)).toBe(outcome === 'may have landed');
  });
});

/** A device copy whose every write is refused (a full store), as in record-session.erase-mirror.test.ts. */
class RefusingDevice extends MemoryAdapter {
  async write(): Promise<never> {
    throw new StorageError('refused', undefined, Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
  }
}

describe('US-10 AC12 (S62b): an erase that Drive refuses before its upload is put back', () => {
  it('a 403 on the pre-upload version check, the device refusing too: the erase answers not erased and the record is as before', async () => {
    let erasing = false;
    drive('check', 403, { armed: () => erasing });
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
