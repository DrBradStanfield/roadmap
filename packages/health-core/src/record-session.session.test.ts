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
import { liftDeviceCopy } from './record-transfer';
import { setReminderOptIn, setScreening, stampProfile } from './state-edits';

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
  /** This tab's unconfirmed erase (sessionStorage on the web). */
  mark: { value: string | null };
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
  const mark = { value: null as string | null };
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
  };
  const host: RecordHost = tier === 'device'
    ? { ...base, tier: 'device', sync: store, clearNamedFiles: () => calls.push('clearNamedFiles'), eraseFence: () => null }
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
          wipe: async () => { mirrorCloud.files.clear(); calls.push('wipe'); },
          opened: () => calls.push('opened'),
          unconfirmedErase: { get: () => mark.value, set: (v: string) => { mark.value = v; }, clear: () => { mark.value = null; } },
        },
      };
  return { host, timers, calls, reports, mirrorCloud, pending, kept, mark };
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
    expect(fake.calls).toEqual(expect.arrayContaining(['clearOffFileData', 'pending.clear', 'wipe']));
  });

  it('bumps past the device copy\'s epoch too, so a higher-epoch device copy cannot keep its profile (US-11 AC9)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    // The device copy: a later erase and a profile, from a session that never reached this cloud.
    const device = stampProfile(structuredClone(session.file), { sex: 'female' }, new Date(clock).toISOString());
    device.meta.eraseEpoch = 5;
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(device), version: 1 });
    store.failWrites = true;
    expect((await session.erase()).success).toBe(false);
    expect(session.file.meta.eraseEpoch).toBe(6);
    // The failed save mirrored the erase: it wins over the device copy.
    const mirrored = stored(fake.mirrorCloud);
    expect(mirrored.meta.eraseEpoch).toBe(6);
    expect(mirrored.profile.sex).toBeUndefined();
  });

  it('on the device tier replaces a record no one can read with the erased record, and succeeds (US-11 AC9)', async () => {
    for (const bytes of ['{not valid json', JSON.stringify({ schemaVersion: 1, measurements: 'not a list' })]) {
      const store = new TestStore();
      const fake = fakeHost(store, 'device');
      const session = await RecordSession.open(fake.host);
      add(session, 'a');
      await session.flush();
      store.cloud.files.set(ROADMAP_FILE_NAME, { json: bytes, version: 7 });
      expect(await session.erase()).toEqual({ success: true });
      const erased = stored(store.cloud);
      expect(erased.meta.eraseEpoch).toBe(1);
      expect(erased.erasedRows?.ids).toEqual(['a']);
      expect(erased.measurements).toEqual([]);
      expect(fake.calls).toEqual(['clearOffFileData', 'clearNamedFiles']);
    }
  });

  it('on the device tier never overwrites bytes another tab replaced after the erase found them unreadable (US-11 AC9)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store, 'device');
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    store.cloud.files.set(ROADMAP_FILE_NAME, { json: '{not valid json', version: 7 });
    // Another tab repairs the file and saves a row while the erase runs.
    const result = await session.erase(async () => {
      const repaired = structuredClone(session.file);
      repaired.measurements = [weight('other-tab', 81, '2026-10-02')];
      store.cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(repaired), version: 8 });
    });
    expect(result.success).toBe(true);
    expect(ids(stored(store.cloud))).toEqual(['other-tab']);
  });

  it('on the device tier refuses to erase a record a newer app wrote, and leaves it (US-11 AC9)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store, 'device');
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    const newer = JSON.stringify({ schemaVersion: 9999 });
    store.cloud.files.set(ROADMAP_FILE_NAME, { json: newer, version: 7 });
    const beforeErase = vi.fn(async () => {});
    const result = await session.erase(beforeErase);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Update the app/);
    expect(beforeErase).not.toHaveBeenCalled();
    expect(store.cloud.files.get(ROADMAP_FILE_NAME)!.json).toBe(newer);
  });

  it('on the device tier clears the named files instead of wiping a mirror', async () => {
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

describe('RecordSession: an erase this tab has not yet seen the cloud hold (US-11 AC9)', () => {
  /** A cloud record with rows, erased; answers the copy from before the erase. */
  async function erased() {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    const stale = { ...store.cloud.files.get(ROADMAP_FILE_NAME)! };
    expect((await session.erase()).success).toBe(true);
    return { store, fake, stale };
  }

  it('a reload while the provider still serves the pre-erase file shows no old rows, and pushes the erase again', async () => {
    const { store, fake, stale } = await erased();
    store.cloud.files.set(ROADMAP_FILE_NAME, stale);
    fake.timers.length = 0;
    const reloaded = await RecordSession.open(fake.host);
    expect(reloaded.file.meta.eraseEpoch).toBe(1);
    expect(reloaded.file.measurements).toEqual([]);
    expect(fake.timers).toHaveLength(1); // the push is queued
    await reloaded.flush();
    expect(stored(store.cloud).meta.eraseEpoch).toBe(1);
    expect(stored(store.cloud).measurements).toEqual([]);
  });

  it('once a read shows the erase, a version restored from history loads as it is', async () => {
    const { store, fake, stale } = await erased();
    expect(fake.mark.value).not.toBeNull();
    // Another device saves a row after the erase; this tab's read of that
    // file shows the erase, a row it never listed beside it: confirmed.
    const other = await RecordSession.open(fakeHost(store).host);
    add(other, 'after', 81, '2026-10-02', other.eraseIdentity);
    await other.flush();
    await RecordSession.open(fake.host);
    expect(fake.mark.value).toBeNull();
    store.cloud.files.set(ROADMAP_FILE_NAME, stale); // the user restores an old version
    const restored = await RecordSession.open(fake.host);
    expect(ids(restored.file)).toEqual(['a']);
  });

  it("an erase of account A never reaches account B's file: profile, screenings, opt-in and ids survive", async () => {
    const { fake } = await erased();
    const a = stored((fake.host.store as TestStore).cloud);
    // Account B, connected in the same tab: its own record.
    const storeB = new TestStore();
    const ownerB = await RecordSession.open(fakeHost(storeB).host);
    ownerB.edit((file) => stampProfile(file, { sex: 'female' }, new Date(clock).toISOString()));
    ownerB.edit((file) => setScreening(file, 'colorectal_method', 'fit', new Date(clock).toISOString()));
    ownerB.edit((file) => setReminderOptIn(file, { status: 'active', token: 't', email: 'b@example.com', provider: 'dropbox' }, new Date(clock).toISOString()));
    add(ownerB, 'b');
    await ownerB.flush();
    const hostB = { ...fake.host, store: storeB } as Extract<RecordHost, { tier: 'cloud' }>;
    await liftDeviceCopy(hostB);
    const sessionB = await RecordSession.open(hostB);
    await sessionB.flush();
    for (const file of [sessionB.file, stored(storeB.cloud)]) {
      expect(file.profile.sex).toBe('female');
      expect(file.screenings.colorectalMethod).toBe('fit');
      expect(file.reminderOptIn?.status).toBe('active');
      expect(ids(file)).toEqual(['b']);
      expect(file.meta.eraseEpoch ?? 0).toBe(0);
      expect(file.erasedRows?.ids ?? []).not.toEqual(expect.arrayContaining(a.erasedRows!.ids));
    }
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
