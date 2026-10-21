/**
 * The record session in the engine's own runtime, over MemoryAdapter and a
 * fake host (ios/architecture.md D4). The widget's store tests pin the same
 * rules through the web host; these pin them where the iPhone app reaches
 * them: serialized saves (US-11 AC7), the failure mirror (US-09 AC4), the
 * erase and its guard (US-09 AC23, US-11, US-16 AC2a) and a remote erase
 * (US-11 AC6, orchestrator O5).
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ERASE_UNREACHABLE, RecordSession, PERSIST_DEBOUNCE_MS } from './record-session';
import type { RecordHost } from './record-host';
import { ConflictError, ROADMAP_FILE_NAME, StorageError, type ReadResult, type WriteResult } from './adapter';
import { createMeasurement, type FileDocument, type RoadmapFile } from './roadmap-file';
import { copyCloudDown } from './record-transfer';

/** A store whose writes can be made to fail, and whose reads can be held. */
class TestStore extends MemoryAdapter {
  failWrites = false;
  failReads = false;
  writes = 0;
  onWrite?: () => void;
  async read(fileName: string) {
    if (this.failReads) throw new StorageError('unreachable');
    return super.read(fileName);
  }
  async write(fileName: string, body: object, expected: string | null) {
    this.writes += 1;
    this.onWrite?.();
    if (this.failWrites) throw new StorageError('refused', undefined, Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
    return super.write(fileName, body, expected);
  }
  // The synchronous face a device tier needs, as localStorage has on the web.
  readSync(fileName: string): ReadResult {
    const entry = this.cloud.files.get(fileName);
    return entry ? { body: JSON.parse(entry.json), version: String(entry.version) } : { body: null, version: null };
  }
  writeSync(fileName: string, body: object, expected: string | null): WriteResult {
    this.writes += 1;
    if (this.failWrites) throw new StorageError('refused', undefined, Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
    const entry = this.cloud.files.get(fileName);
    if ((entry ? String(entry.version) : null) !== expected) throw new ConflictError('moved');
    const version = (entry?.version ?? 0) + 1;
    this.cloud.files.set(fileName, { json: JSON.stringify(body), version });
    return { version: String(version) };
  }
  revision(fileName: string): string | null {
    const entry = this.cloud.files.get(fileName);
    return entry ? String(entry.version) : null;
  }
}

interface Fake {
  host: RecordHost;
  timers: Array<{ run: () => void; ms: number }>;
  calls: string[];
  reports: Array<{ op?: string; cause?: string; repeat: boolean }>;
  mirrorCloud: MemoryCloud;
  pending: { value: boolean };
  /** The originals each off-file clear was told to keep. */
  kept: string[][];
}

let clock = Date.parse('2026-10-21T10:00:00.000Z');

function fakeHost(store: TestStore, tier: 'device' | 'cloud' = 'cloud'): Fake {
  const timers: Fake['timers'] = [];
  const calls: string[] = [];
  const reports: Fake['reports'] = [];
  const mirrorCloud = new MemoryCloud();
  const pending = { value: false };
  const kept: string[][] = [];
  const base = {
    store,
    clearOffFileData: (keep: ReadonlySet<string>) => { calls.push('clearOffFileData'); kept.push([...keep].sort()); },
    deviceId: () => 'phone',
    clock: { now: () => clock },
    timers: {
      set: (run: () => void, ms: number) => { const t = { run, ms }; timers.push(t); return t; },
      clear: (handle: unknown) => { const i = timers.indexOf(handle as Fake['timers'][number]); if (i >= 0) timers.splice(i, 1); },
    },
    remoteChanged: () => calls.push('remoteChanged'),
    failureCause: () => 'QuotaExceededError',
    report: (_error: unknown, at: { op: string; cause?: string; repeat: boolean }) =>
      void reports.push(at.op === 'persist' ? { cause: at.cause, repeat: at.repeat } : { op: at.op, repeat: at.repeat }),
    clearNamedFiles: () => calls.push('clearNamedFiles'),
  };
  const host: RecordHost = tier === 'device'
    ? { ...base, tier: 'device', sync: store, eraseFence: () => null }
    : {
        ...base,
        tier: 'cloud',
        mirror: {
          adapter: new MemoryAdapter(mirrorCloud),
          pending: {
            get: () => pending.value,
            set: () => { pending.value = true; calls.push('pending.set'); },
            clear: () => { pending.value = false; calls.push('pending.clear'); },
          },
          writesStopped: () => false,
          opened: () => calls.push('opened'),
        },
      };
  return { host, timers, calls, reports, mirrorCloud, pending, kept };
}

const weight = (id: string, value: number, day: string) =>
  createMeasurement({ id, metricType: 'weight', value, recordedAt: day, createdAt: new Date(clock).toISOString() });
const add = (session: RecordSession, id: string, value = 80, day = '2026-10-01', erase?: string) =>
  session.edit((file) => void file.measurements.push(weight(id, value, day)), erase);
const stored = (cloud: MemoryCloud): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
const doc = (id: string, fileRef: string): FileDocument => ({
  id, title: id, type: 'pathology_report', date: '2026-10-20', fileRef, contentHash: 'sha256-x', mimeType: 'application/pdf',
  extractedText: '', addedAt: new Date(clock).toISOString(), metadata: {}, sourceFileName: `${id}.pdf`,
});
const ids = (file: RoadmapFile) => file.measurements.map((m) => m.id).sort();

describe('RecordSession: saves', () => {
  it('schedules a debounced save through the host timers, and the timer saves', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    expect(fake.calls).toEqual(['opened']);
    add(session, 'a');
    add(session, 'b');
    expect(fake.timers.map((t) => t.ms)).toEqual([PERSIST_DEBOUNCE_MS]); // the burst is one save
    fake.timers[0].run();
    await session.flush();
    expect(ids(stored(store.cloud))).toEqual(['a', 'b']);
  });

  it('joins a save in flight, and answers only when the joined pass has landed (US-11 AC7)', async () => {
    const store = new TestStore();
    const session = await RecordSession.open(fakeHost(store).host);
    add(session, 'a');
    const first = session.flush();
    add(session, 'b', 81, '2026-10-02'); // lands while the first save is in the air
    const second = session.flush();
    await Promise.all([first, second]);
    expect(store.writes).toBe(2); // one save, two passes
    expect(ids(stored(store.cloud))).toEqual(['a', 'b']);
  });

  it("folds another device's write back in and announces it once (US-34 AC1)", async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    const other = await RecordSession.open(fakeHost(new TestStore(store.cloud)).host);
    add(other, 'theirs', 70, '2026-09-01');
    await other.flush();
    add(session, 'mine');
    await session.flush();
    expect(ids(session.file)).toEqual(['mine', 'theirs']);
    expect(fake.calls.filter((c) => c === 'remoteChanged')).toHaveLength(1);
  });
});

describe('RecordSession: a failed save (US-09 AC4, US-10 AC5)', () => {
  it('mirrors the working copy on the device, marks it pending, and reports it', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    store.failWrites = true;
    add(session, 'offline');
    await expect(session.flush()).rejects.toThrow('Cloud sync failed');
    expect(fake.pending.value).toBe(true);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['offline']);
    expect(fake.reports).toEqual([{ cause: undefined, repeat: false }]);

    // The next session lifts the mirror up, and the marker clears once the cloud has it.
    store.failWrites = false;
    const next = await RecordSession.open(fake.host);
    expect(ids(next.file)).toEqual(['offline']);
    await next.flush();
    expect(ids(stored(store.cloud))).toEqual(['offline']);
    expect(fake.pending.value).toBe(false);
  });

  it('keeps the marker when the mirror is from a newer app (mirrorSkipped)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    fake.pending.value = true;
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify({ schemaVersion: 999 }), version: 1 });
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    expect(fake.pending.value).toBe(true);
  });

  it('names a device refusal, and reports each kind once a session', async () => {
    const store = new TestStore();
    const fake = fakeHost(store, 'device');
    const session = await RecordSession.open(fake.host);
    store.failWrites = true;
    add(session, 'a');
    await expect(session.flush()).rejects.toThrow();
    session.flushSync(); // a hide retries it, and meets the same refusal
    await vi.waitFor(() => expect(fake.reports).toHaveLength(2));
    expect(fake.reports).toEqual([{ cause: 'QuotaExceededError', repeat: false }, { cause: 'QuotaExceededError', repeat: true }]);
  });
});

describe('RecordSession: erase (US-09 AC23, US-11)', () => {
  it('refuses on a session that runs on-device because the cloud could not be read, before anything moves', async () => {
    const store = new TestStore();
    const session = await RecordSession.open(fakeHost(store).host, { cloudUnreachable: true });
    const beforeErase = vi.fn(async () => {});
    expect(await session.erase(beforeErase)).toEqual({ success: false, error: ERASE_UNREACHABLE });
    expect(beforeErase).not.toHaveBeenCalled();
  });

  it('refuses on a cloud it cannot read, runs no step, and puts the debounced change back', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    store.failReads = true;
    const beforeErase = vi.fn(async () => {});
    expect(await session.erase(beforeErase)).toEqual({ success: false, error: ERASE_UNREACHABLE });
    expect(beforeErase).not.toHaveBeenCalled();
    expect(ids(session.file)).toEqual(['a']);
    expect(fake.timers).toHaveLength(1);
  });

  it('reads the stored record, then runs the caller step, then writes the erase and cleans the device', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    const order: string[] = [];
    const read = store.read.bind(store);
    store.read = async (name: string) => { order.push('read'); return read(name); };
    const result = await session.erase(async () => { order.push('beforeErase'); });
    expect(result).toEqual({ success: true });
    expect(order.slice(0, 2)).toEqual(['read', 'beforeErase']);
    const erased = stored(store.cloud);
    expect(erased.meta.eraseEpoch).toBe(1);
    expect(erased.erasedRows?.ids).toEqual(['a']);
    expect(erased.measurements).toEqual([]);
    expect(fake.calls).toEqual(expect.arrayContaining(['pending.clear', 'clearOffFileData', 'clearNamedFiles']));
  });

  it('on a cloud writes the erased record onto the device, so a stale cloud copy cannot put old rows back there (US-11 AC9)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    if (fake.host.tier !== 'cloud') throw new Error('expected the cloud tier');
    const mirror = fake.host.mirror;
    // On the web the device record is the mirror's own file.
    fake.host.deviceRecord = () => {
      const entry = fake.mirrorCloud.files.get(ROADMAP_FILE_NAME);
      return entry ? JSON.parse(entry.json) : null;
    };
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    session.edit((file) => void file.documents.push(doc('listed', 'Lab results/listed.pdf')));
    await session.flush();
    // The cloud as it stood before the erase, and a device copy that names it.
    const stale = { ...store.cloud.files.get(ROADMAP_FILE_NAME)! };
    await mirror.adapter.write(ROADMAP_FILE_NAME, session.file, null);

    expect((await session.erase()).success).toBe(true);
    const device = stored(fake.mirrorCloud);
    expect(device.meta.eraseEpoch).toBe(1);
    expect(device.measurements).toEqual([]);
    expect(device.documents).toEqual([]);
    expect(fake.pending.value).toBe(false);
    // The listed original goes, though the device copy named it before the erase.
    expect(fake.kept.at(-1)).toEqual([]);

    // A stale cloud read, copied down (log-off, a switch): the device stays erased.
    store.cloud.files.set(ROADMAP_FILE_NAME, stale);
    await copyCloudDown(fake.host);
    const after = stored(fake.mirrorCloud);
    expect(after.meta.eraseEpoch).toBe(1);
    expect(after.measurements).toEqual([]);
    expect(after.documents).toEqual([]);
  });

  it("keeps a row, and its original, that this browser's guest tab saved after the erase read the device copy (US-11 AC9, AC6)", async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    fake.host.deviceRecord = () => stored(fake.mirrorCloud);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    // The guest tab's save lands while the erase writes the cloud.
    store.onWrite = () => {
      const late = structuredClone(session.file);
      late.measurements = [weight('late', 81, '2026-10-02')];
      late.documents = [doc('late', 'Lab results/late.pdf')];
      fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(late), version: 1 });
      store.onWrite = undefined;
    };
    expect((await session.erase()).success).toBe(true);
    const device = stored(fake.mirrorCloud);
    expect(device.meta.eraseEpoch).toBe(1);
    expect(ids(device)).toEqual(['late']);
    expect(fake.kept.at(-1)).toEqual(['Lab results/late.pdf']);
  });

  it('still clears the off-file data and named files when the device copy cannot take the erased record, and warns (US-11 AC9)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    if (fake.host.tier !== 'cloud') throw new Error('expected the cloud tier');
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    fake.host.mirror.adapter.write = async () => { throw new StorageError('device refused'); };
    expect(await session.erase()).toEqual({ success: true, warning: 'device refused' });
    expect(fake.calls).toEqual(expect.arrayContaining(['pending.clear', 'clearOffFileData', 'clearNamedFiles']));
    expect(stored(store.cloud).meta.eraseEpoch).toBe(1);
  });

  it('on the device tier clears the named files, with no mirror to write', async () => {
    const store = new TestStore();
    const fake = fakeHost(store, 'device');
    const session = await RecordSession.open(fake.host);
    expect((await session.erase()).success).toBe(true);
    expect(fake.calls).toEqual(['clearOffFileData', 'clearNamedFiles']);
  });

  it('refuses every edit while its own erase writes, and one stamped for an erase the copy is no longer at (US-16 AC2a)', async () => {
    const store = new TestStore();
    const session = await RecordSession.open(fakeHost(store).host);
    const before = session.eraseIdentity;
    session.showErase(before);
    const during: boolean[] = [];
    store.onWrite = () => { during.push(add(session, 'late')); };
    expect((await session.erase()).success).toBe(true);
    store.onWrite = undefined;
    expect(during).toEqual([false]);
    expect(session.file.measurements).toEqual([]);
    // The page still shows the old erase: a write made for it is refused...
    expect(add(session, 'stale')).toBe(false);
    expect(add(session, 'stale', 80, '2026-10-01', before)).toBe(false);
    // ...and one made for the erase the copy is at is taken.
    expect(add(session, 'fresh', 80, '2026-10-01', session.eraseIdentity)).toBe(true);
    session.showErase(session.eraseIdentity);
    expect(add(session, 'next', 81, '2026-10-02')).toBe(true);
  });
});

describe('RecordSession: an erase made elsewhere (US-11 AC6, O5)', () => {
  it('clears the off-file data once, and announces the erase, on a re-read', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    const other = await RecordSession.open(fakeHost(new TestStore(store.cloud)).host);
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    fake.calls.length = 0;
    expect(await session.refreshFromRemote()).toBe(true);
    expect(fake.calls).toEqual(['clearOffFileData', 'remoteChanged']);
    expect(session.file.measurements).toEqual([]);
    // Nothing new: no second clear.
    clock += 60_000;
    expect(await session.refreshFromRemote()).toBe(false);
    expect(fake.calls).toEqual(['clearOffFileData', 'remoteChanged']);
  });

  it('keeps the originals of documents the erase did not remove (US-11 AC6, US-09 AC20)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    session.edit((file) => void file.documents.push(doc('before', 'Lab results/before.pdf')));
    await session.flush();
    const other = await RecordSession.open(fakeHost(new TestStore(store.cloud)).host);
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;
    // Added after the erase, so its row survives every merge.
    other.edit((file) => void file.documents.push(doc('after', 'Lab results/after.pdf')), other.eraseIdentity);
    await other.flush();
    clock += 60_000;
    expect(await session.refreshFromRemote()).toBe(true);
    expect(session.file.documents.map((d) => d.id)).toEqual(['after']);
    expect(fake.kept).toEqual([['Lab results/after.pdf']]);
  });
});

describe("RecordSession: the device's own record copy (US-11 AC6, US-09 AC23)", () => {
  async function erasedWithDeviceCopy(deviceRecord: () => unknown) {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    session.edit((file) => void file.documents.push(doc('listed', 'Lab results/listed.pdf')));
    await session.flush();
    // The device copy: the listed document, and one no erase saw.
    const device = structuredClone(session.file);
    device.documents.push(doc('unseen', 'Lab results/unseen.pdf'));
    const other = await RecordSession.open(fakeHost(new TestStore(store.cloud)).host);
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    fake.host.deviceRecord = () => deviceRecord.call(null) ?? device;
    clock += 60_000;
    expect(await session.refreshFromRemote()).toBe(true);
    return fake.kept;
  }

  it('keeps the originals its unseen documents name, never the ones the erase listed', async () => {
    expect(await erasedWithDeviceCopy(() => undefined)).toEqual([['Lab results/unseen.pdf']]);
  });

  it('names nothing when that copy cannot be read', async () => {
    expect(await erasedWithDeviceCopy(() => { throw new Error('corrupt'); })).toEqual([[]]);
  });
});

describe('RecordSession: host timer ids', () => {
  it('cancels a debounce whose timer id is 0 (iOS timer ids may start there)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const live = new Map<number, () => void>();
    let next = 0;
    fake.host.timers = {
      set: (run) => { live.set(next, run); return next++; },
      clear: (handle) => void live.delete(handle as number),
    };
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    expect([...live.keys()]).toEqual([0]);
    await session.flush(); // saves now, so the debounced save must be gone
    expect(live.size).toBe(0);
  });
});

describe('RecordSession.deleteAllData: the erase order (US-09 AC23, US-11 AC2; O6)', () => {
  it('reads the record, then the teardown, then the chat tombstones, then writes the erase', async () => {
    const store = new TestStore();
    const session = await RecordSession.open(fakeHost(store).host);
    add(session, 'a');
    await session.flush();
    const order: string[] = [];
    const read = store.read.bind(store);
    store.read = async (name: string) => { order.push('read'); return read(name); };
    store.onWrite = () => order.push('write');
    const result = await session.deleteAllData({
      teardown: async () => { order.push('teardown'); },
      chat: async () => ({ eraseAll: async () => { order.push('chat'); } }),
    });
    expect(result).toEqual({ success: true, chatErased: true });
    expect(order.slice(0, 3)).toEqual(['read', 'teardown', 'chat']);
    expect(order.indexOf('write')).toBeGreaterThan(2); // the record's own write comes last
  });

  it('reports a failed step and erases anyway; a failed chat step says so', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    const result = await session.deleteAllData({
      teardown: async () => { throw new Error('server down'); },
      chat: async () => ({ eraseAll: async () => { throw new Error('chat cloud down'); } }),
    });
    expect(result).toEqual({ success: true, chatErased: false });
    expect(fake.reports).toEqual([{ op: 'pre-erase', repeat: false }, { op: 'chat-erase', repeat: false }]);
    expect(stored(store.cloud).meta.eraseEpoch).toBe(1);
  });

  it('runs neither step when the erase is refused', async () => {
    const store = new TestStore();
    const session = await RecordSession.open(fakeHost(store).host);
    store.failReads = true;
    const teardown = vi.fn(async () => {});
    const chat = vi.fn(async () => null);
    expect(await session.deleteAllData({ teardown, chat })).toEqual({ success: false, error: ERASE_UNREACHABLE, chatErased: false });
    expect(teardown).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });
});
