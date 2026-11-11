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
import { ERASE_UNREACHABLE, RecordSession, PERSIST_DEBOUNCE_MS, saveRecordInto } from './record-session';
import type { RecordHost } from './record-host';
import type { SaveEvent, SaveState } from './save-state';
import { ConflictError, ROADMAP_FILE_NAME, StorageError, type ReadResult, type WriteResult } from './adapter';
import { createMeasurement, type FileDocument, type RoadmapFile } from './roadmap-file';
import { stampProfile } from './state-edits';
import { buildErasedFile } from './erase';

// The real build, which one test makes throw once (US-16 AC2a).
vi.mock('./erase', async (original) => {
  const real = await original<typeof import('./erase')>();
  return { ...real, buildErasedFile: vi.fn(real.buildErasedFile) };
});

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
  removeSync(fileName: string, expected: string | null): void {
    if (this.revision(fileName) !== expected) throw new ConflictError('moved');
    this.cloud.files.delete(fileName);
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

/** A cloud whose save never answers: the page goes before the request ends. */
class StalledStore extends TestStore {
  async write(): Promise<WriteResult> {
    this.writes += 1;
    return new Promise<WriteResult>(() => {});
  }
}

/** The fake cloud host, its device copy given the synchronous face localStorage has on the web.
 *  `chosen`: this browser still uses this cloud (no other tab has switched it elsewhere); null: the host cannot tell. */
function withDeviceSync(fake: Fake, stopped = false, chosen: boolean | null = true): { host: RecordHost; device: TestStore } {
  const device = new TestStore(fake.mirrorCloud);
  if (fake.host.tier !== 'cloud') throw new Error('cloud host expected');
  const stillChosen = chosen == null ? {} : { stillChosen: () => chosen };
  return { host: { ...fake.host, mirror: { ...fake.host.mirror, sync: device, writesStopped: () => stopped, ...stillChosen } }, device };
}

/** Another device erases the cloud record; this device's session then takes the erase in. */
async function eraseElsewhere(cloud: MemoryCloud, session: RecordSession): Promise<void> {
  const other = await RecordSession.open(fakeHost(new TestStore(cloud)).host);
  clock += 60_000;
  expect((await other.erase()).success).toBe(true);
  clock += 60_000;
  expect(await session.refreshFromRemote()).toBe(true);
}

describe('RecordSession: a cloud page goes away before its save lands (US-06 AC13, US-10 AC5)', () => {
  it('writes the unsaved change to the device copy at once, marked for sync, and the next session lifts it up', async () => {
    const store = new StalledStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    add(session, 'late');
    session.flushSync();
    // Synchronously, with the cloud save still in the air.
    expect(ids(stored(fake.mirrorCloud))).toEqual(['late']);
    expect(fake.pending.value).toBe(true);
    expect(store.cloud.files.has(ROADMAP_FILE_NAME)).toBe(false);

    const next = await RecordSession.open({ ...host, store: new TestStore(store.cloud) });
    expect(ids(next.file)).toEqual(['late']);
    await next.flush();
    expect(ids(stored(store.cloud))).toEqual(['late']);
    expect(fake.pending.value).toBe(false);
  });

  it('merges into the device copy: a row only it holds stays, and a row this copy erased does not come back', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    add(session, 'erased');
    await session.flush();
    expect((await session.erase()).success).toBe(true);
    // A device copy from before the erase, which also holds a row of its own.
    const before = structuredClone(session.file);
    before.meta.eraseEpoch = 0;
    before.meta.erasedAt = undefined;
    before.erasedRows = undefined;
    before.measurements = [weight('erased', 80, '2026-10-01'), weight('device-only', 70, '2026-09-01')];
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(before), version: 1 });
    add(session, 'late', 82, '2026-10-03');
    store.write = () => new Promise<WriteResult>(() => {}); // the save now hangs
    session.flushSync();
    const device = stored(fake.mirrorCloud);
    expect(ids(device)).toEqual(['device-only', 'late']);
    expect(device.meta.eraseEpoch).toBe(1);
    expect(fake.pending.value).toBe(true);
  });

  it('writes and marks nothing on the device after log-off (US-09 AC2c)', async () => {
    const store = new StalledStore();
    const fake = fakeHost(store);
    const { host, device } = withDeviceSync(fake, true);
    const session = await RecordSession.open(host);
    add(session, 'late');
    const writes = device.writes;
    session.flushSync();
    expect(device.writes).toBe(writes);
    expect(fake.mirrorCloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
    expect(fake.pending.value).toBe(false);
  });

  it('does nothing when nothing is unsaved', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    add(session, 'a');
    await session.flush();
    session.flushSync();
    expect(fake.mirrorCloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
    expect(fake.pending.value).toBe(false);
  });
});

/** A cloud whose save waits until the test lets it land. */
class HeldStore extends TestStore {
  private held: Array<() => void> = [];
  private open = false;
  async write(fileName: string, body: object, expected: string | null): Promise<WriteResult> {
    if (!this.open) await new Promise<void>((go) => this.held.push(go));
    return super.write(fileName, body, expected);
  }
  release(): void {
    this.open = true;
    for (const go of this.held.splice(0)) go();
  }
}

describe('RecordSession: the device copy a cloud page leaves behind (US-06 AC13, US-09 AC4)', () => {
  it("another tab's save that did not include it keeps the copy and its marker, and the next load lifts it up", async () => {
    // Two tabs on one device: one device copy and one marker, one cloud.
    const cloud = new MemoryCloud();
    const fake = fakeHost(new StalledStore(cloud));
    const { host: closing } = withDeviceSync(fake);
    const working: RecordHost = { ...closing, store: new TestStore(cloud) };
    const tabA = await RecordSession.open(closing);
    const tabB = await RecordSession.open(working);
    add(tabA, 'dose');
    tabA.flushSync(); // tab A closes: the copy is written, its cloud save never lands
    expect(fake.pending.value).toBe(true);
    add(tabB, 'other', 81, '2026-10-02');
    await tabB.flush(); // an unrelated save, without tab A's change
    expect(fake.pending.value).toBe(true);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['dose']);
    const next = await RecordSession.open(working);
    expect(ids(next.file)).toEqual(['dose', 'other']);
    await next.flush();
    expect(ids(stored(cloud))).toEqual(['dose', 'other']);
    expect(fake.pending.value).toBe(false);
  });

  it('a cloud save that holds all of it clears the marker and leaves the copy, for a load that cannot reach the cloud (US-09 AC13)', async () => {
    const store = new HeldStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    add(session, 'late');
    session.flushSync(); // hidden: the copy is written, the save is in the air
    expect(ids(stored(fake.mirrorCloud))).toEqual(['late']);
    store.release();
    await session.flush();
    expect(ids(stored(store.cloud))).toEqual(['late']);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['late']);
    expect(fake.pending.value).toBe(false);
  });

  it('an erase taken in from another device removes the copy this page wrote as it was hidden, once its save landed', async () => {
    const store = new HeldStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    add(session, 'late');
    session.flushSync();
    store.release();
    await session.flush();
    await eraseElsewhere(store.cloud, session);
    expect(fake.mirrorCloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
    expect(fake.pending.value).toBe(false);
  });

  it('an erase taken in from another device removes a copy it covers that was there when this page opened', async () => {
    const store = new TestStore();
    const seed = await RecordSession.open(fakeHost(store).host);
    add(seed, 'a');
    await seed.flush();
    const fake = fakeHost(store);
    // A full copy left on the device, no marker: what an earlier departure left once its save landed.
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(seed.file), version: 1 });
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    fake.pending.value = true; // a marker beside it goes too
    await eraseElsewhere(store.cloud, session);
    expect(fake.mirrorCloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
    expect(fake.pending.value).toBe(false);
  });

  it('an erase taken in keeps the copy and its marker when the removal is refused (the copy moved)', async () => {
    const store = new TestStore();
    const seed = await RecordSession.open(fakeHost(store).host);
    add(seed, 'a');
    await seed.flush();
    const fake = fakeHost(store);
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(seed.file), version: 1 });
    const { host, device } = withDeviceSync(fake);
    device.removeSync = () => { throw new ConflictError('moved'); };
    const session = await RecordSession.open(host);
    fake.pending.value = true;
    await eraseElsewhere(store.cloud, session);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a']);
    expect(fake.pending.value).toBe(true);
  });

  it('an erase taken in removes nothing on a host that cannot tell whether this browser still uses this cloud', async () => {
    const store = new TestStore();
    const seed = await RecordSession.open(fakeHost(store).host);
    add(seed, 'a');
    await seed.flush();
    const fake = fakeHost(store);
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(seed.file), version: 1 });
    const { host } = withDeviceSync(fake, false, null);
    const session = await RecordSession.open(host);
    await eraseElsewhere(store.cloud, session);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a']);
  });

  it('an erase taken in removes the copy a failed save wrote, once a later save holds it', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    store.failWrites = true;
    add(session, 'a');
    await expect(session.flush()).rejects.toThrow('Cloud sync failed'); // mirrored, marked
    store.failWrites = false;
    add(session, 'b', 81, '2026-10-02');
    await session.flush();
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a']);
    expect(fake.pending.value).toBe(false);
    await eraseElsewhere(store.cloud, session);
    expect(fake.mirrorCloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
  });

  it('an erase taken in keeps a copy written since this page last read or wrote it, and its marker', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    add(session, 'a');
    await session.flush();
    // Another page wrote the device copy after this one opened: this page cannot tell what it is for.
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(session.file), version: 1 });
    fake.pending.value = true;
    await eraseElsewhere(store.cloud, session);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a']);
    expect(fake.pending.value).toBe(true);
  });

  it('an erase taken in keeps the copy once another tab has moved this browser off this cloud (US-09 AC2)', async () => {
    const store = new TestStore();
    const seed = await RecordSession.open(fakeHost(store).host);
    add(seed, 'a');
    await seed.flush();
    const fake = fakeHost(store);
    // The record the other tab now runs on, on the device ("This device" or another cloud's copy).
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(seed.file), version: 1 });
    const { host } = withDeviceSync(fake, false, false);
    const session = await RecordSession.open(host);
    await eraseElsewhere(store.cloud, session);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a']);
  });

  it('an erase taken in leaves a copy that holds a row the erase did not list', async () => {
    const store = new TestStore();
    const seed = await RecordSession.open(fakeHost(store).host);
    add(seed, 'a');
    await seed.flush();
    const fake = fakeHost(store);
    // The copy also holds a change that never reached the cloud, so no erase listed it.
    const copy = structuredClone(seed.file);
    copy.measurements.push(weight('unsynced', 70, '2026-09-01'));
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(copy), version: 1 });
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host); // no marker: the change is not lifted up
    await eraseElsewhere(store.cloud, session);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a', 'unsynced']);
  });

  it('a save leaves a copy no marker names, as before', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    // A copy from before this device connected the cloud: nothing marks it.
    const copy = structuredClone(session.file);
    copy.measurements.push(weight('guest', 70, '2026-09-01'));
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(copy), version: 1 });
    session.edit((file) => void file.measurements.push(weight('guest', 70, '2026-09-01')));
    await session.flush();
    expect(ids(stored(fake.mirrorCloud))).toEqual(['guest']);
  });

  it('a save reads no device copy and clears nothing when no marker is set', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const { host, device } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    const readSync = vi.spyOn(device, 'readSync'); // the save's reads, not the load's (US-06 AC13)
    add(session, 'a');
    await session.flush();
    expect(readSync).not.toHaveBeenCalled();
    expect(fake.calls).not.toContain('pending.clear');
  });

  it('a marker with no copy beside it is cleared by a save', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    fake.pending.value = true;
    add(session, 'a');
    await session.flush();
    expect(fake.pending.value).toBe(false);
  });

  it('a copy that cannot be read keeps its marker after a save, for the next load to decide', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: '{not json', version: 1 });
    fake.pending.value = true;
    add(session, 'a');
    await session.flush();
    expect(fake.pending.value).toBe(true);
    expect(fake.mirrorCloud.files.get(ROADMAP_FILE_NAME)?.json).toBe('{not json');
  });

  it('an erase taken in while this tab holds a change the cloud has not got keeps the copy and its marker', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake);
    const session = await RecordSession.open(host);
    add(session, 'a');
    await session.flush();
    store.failWrites = true;
    add(session, 'unsaved', 81, '2026-10-02');
    await expect(session.flush()).rejects.toThrow('Cloud sync failed'); // mirrored, marked
    store.failWrites = false;
    const other = await RecordSession.open(fakeHost(new TestStore(store.cloud)).host);
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;
    expect(await session.refreshFromRemote()).toBe(true);
    expect(ids(session.file)).toEqual(['unsaved']);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a', 'unsaved']);
    expect(fake.pending.value).toBe(true);
  });

  it('a host whose device copy has no synchronous remove keeps its marker when an erase is taken in', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    fake.pending.value = true;
    const other = await RecordSession.open(fakeHost(new TestStore(store.cloud)).host);
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;
    expect(await session.refreshFromRemote()).toBe(true);
    expect(fake.pending.value).toBe(true);
  });
});

/** Another device erases the cloud record while this browser has no page open on it. */
async function eraseWhileClosed(cloud: MemoryCloud): Promise<void> {
  const other = await RecordSession.open(fakeHost(new TestStore(cloud)).host);
  clock += 60_000;
  expect((await other.erase()).success).toBe(true);
  clock += 60_000;
}

/** A cloud record holding 'a', and a device copy of it that no marker names: what a departure leaves once its save lands. */
async function copyLeftBehind(chosen: boolean | null = true): Promise<{ store: TestStore; fake: Fake; host: RecordHost; device: TestStore }> {
  const store = new TestStore();
  const seed = await RecordSession.open(fakeHost(store).host);
  add(seed, 'a');
  await seed.flush();
  const fake = fakeHost(store);
  fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(seed.file), version: 1 });
  return { store, fake, ...withDeviceSync(fake, false, chosen) };
}

describe('RecordSession: an erase taken in at a load (US-06 AC13)', () => {
  it('removes a pre-erase copy it covers, and its marker, so an offline start does not show the erased record', async () => {
    const { store, fake, host } = await copyLeftBehind();
    await eraseWhileClosed(store.cloud);
    const session = await RecordSession.open(host);
    expect(ids(session.file)).toEqual([]);
    expect(fake.mirrorCloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
    expect(fake.pending.value).toBe(false);
  });

  it('removes a marked pre-erase copy it covers before lifting it up: nothing comes back', async () => {
    const { store, fake, host } = await copyLeftBehind();
    fake.pending.value = true;
    await eraseWhileClosed(store.cloud);
    const session = await RecordSession.open(host);
    expect(fake.mirrorCloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
    expect(fake.pending.value).toBe(false);
    await session.flush();
    expect(ids(stored(store.cloud))).toEqual([]);
  });

  it('keeps a copy written after that erase, for a load that cannot reach the cloud', async () => {
    const { store, fake, host } = await copyLeftBehind();
    await eraseWhileClosed(store.cloud);
    const first = await RecordSession.open(host);
    add(first, 'late', 81, '2026-10-02');
    first.flushSync(); // hidden: the copy now holds the erased record and the change
    await first.flush();
    await RecordSession.open(host);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['late']);
  });

  it('keeps a copy holding a row the erase did not list, and lifts that row up', async () => {
    const { store, fake, host } = await copyLeftBehind();
    const copy = stored(fake.mirrorCloud);
    copy.measurements.push(weight('unsynced', 70, '2026-09-01'));
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(copy), version: 1 });
    fake.pending.value = true;
    await eraseWhileClosed(store.cloud);
    const session = await RecordSession.open(host);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a', 'unsynced']);
    expect(ids(session.file)).toEqual(['unsynced']);
  });

  it('keeps the copy once another tab has moved this browser off this cloud (US-09 AC2)', async () => {
    const { store, fake, host } = await copyLeftBehind(false);
    await eraseWhileClosed(store.cloud);
    await RecordSession.open(host);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a']);
  });

  it('keeps the copy on a host that cannot tell whether this browser still uses this cloud', async () => {
    const { store, fake, host } = await copyLeftBehind(null);
    await eraseWhileClosed(store.cloud);
    await RecordSession.open(host);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a']);
  });

  it('keeps the copy and its marker when the removal is refused (the copy moved)', async () => {
    const { store, fake, host, device } = await copyLeftBehind();
    device.removeSync = () => { throw new ConflictError('moved'); };
    fake.pending.value = true;
    await eraseWhileClosed(store.cloud);
    await RecordSession.open(host);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a']);
    expect(fake.pending.value).toBe(true);
  });

  it('keeps the copy when nothing was erased since it was written', async () => {
    const { fake, host } = await copyLeftBehind();
    await RecordSession.open(host);
    expect(ids(stored(fake.mirrorCloud))).toEqual(['a']);
  });
});

describe('RecordSession: a cloud tab left open after another tab moved this browser off its cloud (US-09 AC2)', () => {
  it('writes and marks nothing on the device as it goes away: the device file is the other tab\'s record now', async () => {
    const store = new StalledStore();
    const fake = fakeHost(store);
    const { host, device } = withDeviceSync(fake, false, false);
    const session = await RecordSession.open(host);
    add(session, 'late');
    const writes = device.writes;
    session.flushSync();
    expect(device.writes).toBe(writes);
    expect(fake.mirrorCloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
    expect(fake.pending.value).toBe(false);
  });

  it('still writes on a host that cannot tell which backend this browser uses, as before', async () => {
    const store = new StalledStore();
    const fake = fakeHost(store);
    const { host } = withDeviceSync(fake, false, null);
    const session = await RecordSession.open(host);
    add(session, 'late');
    session.flushSync();
    expect(ids(stored(fake.mirrorCloud))).toEqual(['late']);
    expect(fake.pending.value).toBe(true);
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
    // The second shape fails the row check before the version check (Codex R1).
    for (const newer of [JSON.stringify({ schemaVersion: 9999 }), JSON.stringify({ schemaVersion: 9999, measurements: {} })]) {
      const store = new TestStore();
      const fake = fakeHost(store, 'device');
      const session = await RecordSession.open(fake.host);
      add(session, 'a');
      await session.flush();
      store.cloud.files.set(ROADMAP_FILE_NAME, { json: newer, version: 7 });
      const beforeErase = vi.fn(async () => {});
      const result = await session.erase(beforeErase);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Update the app/);
      expect(beforeErase).not.toHaveBeenCalled();
      expect(store.cloud.files.get(ROADMAP_FILE_NAME)!.json).toBe(newer);
    }
  });

  it("keeps a legacy erase's gap when the device copy holds it, so a stale copy cannot bring back what it removed (US-11 AC9, US-09 AC23)", async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    expect((await session.erase()).success).toBe(true); // epoch 1, its list from 1
    // The device copy: an older app's erase at epoch 5 that listed nothing.
    const legacy = structuredClone(session.file);
    legacy.meta.eraseEpoch = 5;
    delete legacy.erasedRows;
    fake.mirrorCloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(legacy), version: 1 });
    // A copy from before that erase, holding a row it removed.
    const stale = structuredClone(legacy);
    stale.meta.eraseEpoch = 4;
    stale.measurements = [weight('pre', 79, '2026-09-01')];
    clock += 60_000;
    store.failWrites = true;
    expect((await session.erase()).success).toBe(false); // mirrored onto the device
    const mirror = fake.host.tier === 'cloud' ? fake.host.mirror.adapter : null;
    expect(stored(fake.mirrorCloud).meta.eraseEpoch).toBe(6);
    expect(stored(fake.mirrorCloud).erasedRows?.fromEpoch).toBe(6);
    await saveRecordInto(mirror!, stale, { deviceId: 'old-tab', now: new Date(clock).toISOString() });
    expect(ids(stored(fake.mirrorCloud))).toEqual([]);
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

/**
 * Today's save mode, pinned as a caller sees it, before it becomes one union
 * (lead A1, step a). The mode is spread over the debounce timer, the save in
 * flight, the dirty-during-save flag, the change counts and `erasing`.
 */
describe('RecordSession: the save mode as a caller sees it today (lead A1)', () => {
  /** Holds the store's next `method` call until released; `reached` resolves
   *  once the call has started. Later calls run as normal. */
  function holdNext(store: TestStore, method: 'read' | 'write') {
    const own = store as unknown as Record<string, unknown>;
    const original = (store[method] as (...args: unknown[]) => Promise<unknown>).bind(store);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { started = resolve; });
    own[method] = async (...args: unknown[]) => {
      delete own[method];
      started();
      await gate;
      return original(...args);
    };
    return { reached, release };
  }
  /** The fake host on the real timer functions, so vi's fake timers drive the debounce. */
  const onTimers = (host: RecordHost): RecordHost => ({
    ...host,
    timers: {
      set: (run: () => void, ms: number) => setTimeout(run, ms),
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  });
  /** An edit whose background save rejects: one write, the marker set. */
  async function failedBackgroundSave() {
    vi.useFakeTimers();
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(onTimers(fake.host));
    store.failWrites = true;
    add(session, 'a');
    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS);
    expect(store.writes).toBe(1);
    expect(fake.pending.value).toBe(true);
    store.failWrites = false;
    return { store, fake, session };
  }

  it('a background cloud save that rejects sets the pending marker (US-09 AC4), and no save is tried again until an edit', async () => {
    try {
      const { store, fake, session } = await failedBackgroundSave();
      await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS * 50);
      expect(store.writes).toBe(1); // no retry of its own
      expect(vi.getTimerCount()).toBe(0);
      expect(fake.pending.value).toBe(true);

      add(session, 'b', 81, '2026-10-02');
      await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS - 1);
      expect(store.writes).toBe(1); // the edit waits on the debounce
      expect(fake.pending.value).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.writes).toBe(2);
      expect(ids(stored(store.cloud))).toEqual(['a', 'b']);
      expect(fake.pending.value).toBe(false); // the cloud save that lands clears it
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['flush', 'flushSync'] as const)('after that failure, a %s tries the save again (US-10 AC5a)', async (trigger) => {
    try {
      const { store, session } = await failedBackgroundSave();
      if (trigger === 'flush') await session.flush();
      else session.flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.writes).toBe(2);
      expect(ids(stored(store.cloud))).toEqual(['a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('after that failure, refreshFromRemote still reads and merges: an unsaved change does not hold it back', async () => {
    try {
      const { store, session } = await failedBackgroundSave();
      const other = await RecordSession.open(fakeHost(new TestStore(store.cloud)).host);
      add(other, 'theirs', 81, '2026-10-02');
      await other.flush();
      clock += 60_000;
      const reads = vi.spyOn(store, 'read');
      expect(await session.refreshFromRemote()).toBe(true);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(ids(session.file)).toEqual(['a', 'theirs']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('today (step d of lead A1 changes this, US-09 AC30): no pending marker while an edit waits on the debounce, nor while its save is in flight', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    expect(fake.timers).toHaveLength(1);
    expect(fake.pending.value).toBe(false);
    const held = holdNext(store, 'write');
    fake.timers[0].run();
    await held.reached;
    expect(fake.pending.value).toBe(false);
    held.release();
    await session.flush();
    expect(store.writes).toBe(1);
    expect(fake.pending.value).toBe(false);
  });

  it('an edit made during a save pass runs a second pass; with none, one pass and one write (US-10 AC5a)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    expect(store.writes).toBe(1); // no edit during the pass: one write

    store.onWrite = () => { store.onWrite = undefined; add(session, 'b', 81, '2026-10-02'); };
    add(session, 'c', 82, '2026-10-03');
    await session.flush();
    expect(store.writes).toBe(3); // the edit in the pass ran a second one
    expect(ids(stored(store.cloud))).toEqual(['a', 'b', 'c']);
    // Whatever timers remain find nothing left to save.
    for (const t of [...fake.timers]) t.run();
    await session.flush();
    expect(store.writes).toBe(3);
    expect(ids(stored(store.cloud))).toEqual(['a', 'b', 'c']);
  });

  it('a page-hide flushSync during a pass that took an edit makes one more pass', async () => {
    const store = new TestStore();
    const fake = fakeHost(store, 'device');
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    const held = holdNext(store, 'write');
    fake.timers[0].run(); // the pass starts from 'a'
    await held.reached;
    add(session, 'b', 81, '2026-10-02'); // an edit the pass did not take
    session.flushSync(); // the synchronous write lands both
    expect(store.writes).toBe(1);
    expect(ids(stored(store.cloud))).toEqual(['a', 'b']);
    held.release();
    await session.flush();
    // The held pass meets the sync write's revision and retries (2 writes),
    // then one more pass for 'b', though the sync write already landed it.
    expect(store.writes).toBe(4);
    expect(ids(stored(store.cloud))).toEqual(['a', 'b']);
    await session.flush();
    expect(store.writes).toBe(4);
  });

  it('a flush during a save joins it and resolves when it lands, with no write of its own (US-10 AC5a, US-11 AC7)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    const held = holdNext(store, 'write');
    fake.timers[0].run(); // the background save starts
    await held.reached;
    let landed = false;
    const flushing = session.flush();
    void flushing.then(() => { landed = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(landed).toBe(false); // still waiting on the held write
    held.release();
    await expect(flushing).resolves.toBeUndefined();
    expect(store.writes).toBe(1);
    expect(ids(stored(store.cloud))).toEqual(['a']);
  });

  it('a flush that joins a save whose later pass fails rejects with the save-failed text (US-11 AC7)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    // The first pass lands with an edit made during it; the second pass fails.
    store.onWrite = () => {
      store.onWrite = () => { store.failWrites = true; };
      add(session, 'b', 81, '2026-10-02');
    };
    fake.timers[0].run();
    await expect(session.flush()).rejects.toThrow('Cloud sync failed — your latest changes are still on this device.');
    expect(store.writes).toBe(2);
    expect(ids(stored(store.cloud))).toEqual(['a']);
  });

  it('refreshFromRemote answers false and reads nothing while an edit waits or its save is in flight (US-34 AC2)', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    const reads = vi.spyOn(store, 'read');
    add(session, 'a');
    expect(await session.refreshFromRemote()).toBe(false); // on the debounce
    expect(reads).not.toHaveBeenCalled();

    const held = holdNext(store, 'write');
    const atStart = reads.mock.calls.length;
    fake.timers[0].run();
    await held.reached;
    expect(reads).toHaveBeenCalledTimes(atStart + 1); // the save's own read
    expect(await session.refreshFromRemote()).toBe(false); // in flight
    expect(reads).toHaveBeenCalledTimes(atStart + 1);
    held.release();
    await session.flush();

    // Nothing pending: it reads, once (the save's verify read came before).
    const saved = reads.mock.calls.length;
    expect(await session.refreshFromRemote()).toBe(false);
    expect(reads).toHaveBeenCalledTimes(saved + 1);
  });

  it('refuses() is true from the erase swap to the end of its write, and false once the erase is done (US-16 AC2a)', async () => {
    const store = new TestStore();
    const session = await RecordSession.open(fakeHost(store).host);
    add(session, 'a');
    await session.flush();
    expect(session.refuses()).toBe(false);
    const held = holdNext(store, 'write');
    const erasing = session.erase();
    await held.reached;
    expect(session.refuses()).toBe(true);
    expect(add(session, 'late')).toBe(false);
    held.release();
    expect((await erasing).success).toBe(true);
    expect(session.refuses()).toBe(false);
    expect(add(session, 'after')).toBe(true);
  });

  it('after an erase whose write rejects, refuses() is false and an edit is accepted (US-16 AC2a)', async () => {
    const store = new TestStore();
    const session = await RecordSession.open(fakeHost(store).host);
    add(session, 'a');
    await session.flush();
    store.failWrites = true;
    expect((await session.erase()).success).toBe(false);
    expect(session.refuses()).toBe(false);
    expect(add(session, 'after')).toBe(true);
  });

  it('after an erase whose build throws, refuses() is false and an edit is accepted (US-16 AC2a)', async () => {
    const store = new TestStore();
    const session = await RecordSession.open(fakeHost(store).host);
    add(session, 'a');
    await session.flush();
    vi.mocked(buildErasedFile).mockImplementationOnce(() => { throw new Error('build failed'); });
    expect(await session.erase()).toEqual({ success: false, error: 'build failed' });
    expect(session.refuses()).toBe(false);
    expect(add(session, 'after')).toBe(true);
  });

  it("today, refuses() is still false before the erase's stored read answers (lead A6; a later PR may change it)", async () => {
    const store = new TestStore();
    const session = await RecordSession.open(fakeHost(store).host);
    add(session, 'a');
    await session.flush();
    const held = holdNext(store, 'read');
    const erasing = session.erase();
    await held.reached;
    // Lead A6 may flip this in a later PR.
    expect(session.refuses()).toBe(false);
    expect(add(session, 'during-read')).toBe(true); // an edit is let in
    held.release();
    expect((await erasing).success).toBe(true);
    expect(session.refuses()).toBe(false);
  });
});

describe("RecordSession: two erases on one session (US-16 AC2a)", () => {
  function hold(store: TestStore, method: "read" | "write") {
    const own = store as unknown as Record<string, unknown>;
    const original = (store[method] as (...args: unknown[]) => Promise<unknown>).bind(store);
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { started = r; });
    own[method] = async (...args: unknown[]) => { delete own[method]; started(); await gate; return original(...args); };
    return { reached, release };
  }
  it("a second erase refused at its read leaves the first erase refusing edits", async () => {
    const store = new TestStore();
    const session = await RecordSession.open(fakeHost(store).host);
    add(session, "a");
    await session.flush();
    const held = hold(store, "write");
    const first = session.erase();
    await held.reached;
    expect(session.refuses()).toBe(true);
    store.failReads = true;
    const second = await session.erase();
    expect(second.success).toBe(false);
    store.failReads = false;
    expect(session.refuses()).toBe(true);
    held.release();
    await first;
  });
});

describe('RecordSession: a save asked for while a landed save still adopts (US-11 AC7)', () => {
  it('starts no pass beside that save, so a later flush joins the one pass that carries the change', async () => {
    const store = new TestStore();
    const fake = fakeHost(store);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    // Another device erases: this session's next save merges the erase in, and
    // its adopt() clears the off-file data after the pass and its claim ended.
    const other = await RecordSession.open(fakeHost(new TestStore(store.cloud)).host);
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let inner: Promise<void> | null = null;
    fake.host.clearOffFileData = () => {
      fake.host.clearOffFileData = () => {};
      add(session, 'c', 82, '2026-10-03'); // one more change, inside that save's adopt()
      const write = store.write.bind(store);
      store.write = async (...args: Parameters<TestStore['write']>) => { store.write = write; await gate; return write(...args); };
      inner = session.flush();
    };
    add(session, 'b', 81, '2026-10-02');
    await session.flush();
    expect(inner).not.toBeNull();
    // The flush made inside adopt() started the pass that carries 'c', after
    // the landed pass's claim ended. The old save never clears that newer
    // claim, so this flush joins it: it answers only once that write lands,
    // and adds no write of its own (adversary R2).
    let answered = false;
    const late = session.flush().then(() => { answered = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(answered).toBe(false);
    const writes = store.writes;
    release();
    await Promise.all([inner, late]);
    expect(answered).toBe(true);
    expect(store.writes - writes).toBe(1);
    expect(ids(stored(store.cloud))).toContain('c');
  });
});

describe("RecordSession: an edit made while another device's erase is taken in (US-11 AC7)", () => {
  /** A saved row 'a', then another device erases it: the next save or re-read takes the erase in. */
  async function erasedElsewhere(tier: 'device' | 'cloud' = 'cloud') {
    const store = new TestStore();
    const fake = fakeHost(store, tier);
    const session = await RecordSession.open(fake.host);
    add(session, 'a');
    await session.flush();
    const before = stored(store.cloud).meta.eraseEpoch ?? 0;
    const other = await RecordSession.open(fakeHost(new TestStore(store.cloud), tier).host);
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;
    return { store, fake, session, before, erased: other.eraseIdentity };
  }

  /** The save that takes the erase in makes an edit and a flush from its off-file clear. */
  async function editInsideTheClear() {
    const run = await erasedElsewhere();
    let inner: Promise<void> | null = null;
    let storedWhenAnswered: string[] = [];
    run.fake.host.clearOffFileData = () => {
      run.fake.host.clearOffFileData = () => {};
      expect(add(run.session, 'c', 82, '2026-10-03')).toBe(true);
      inner = run.session.flush().then(() => { storedWhenAnswered = ids(stored(run.store.cloud)); });
    };
    add(run.session, 'b', 81, '2026-10-02');
    await run.session.flush();
    expect(inner).not.toBeNull();
    await inner;
    return { ...run, storedWhenAnswered };
  }

  it('keeps the edit, and the flush made with it answers only once a write carries it', async () => {
    const { store, session, storedWhenAnswered } = await editInsideTheClear();
    expect(ids(session.file)).toContain('c');
    expect(storedWhenAnswered).toContain('c');
    expect(ids(stored(store.cloud))).toContain('c');
  });

  it('lands the edit on the erased copy: no pre-erase row comes back, and the epoch only moves on', async () => {
    const { store, session, before, erased } = await editInsideTheClear();
    await session.flush();
    const record = stored(store.cloud);
    expect(session.eraseIdentity).toBe(erased);
    expect(record.meta.eraseEpoch ?? 0).toBeGreaterThan(before);
    expect(JSON.stringify([record.meta.eraseEpoch ?? 0, record.meta.erasedAt ?? null])).toBe(erased);
    expect(ids(record)).not.toContain('a');
    expect(ids(session.file)).not.toContain('a');
    expect(ids(record)).toContain('c');
  });

  describe('a clear that throws keeps the erased copy, and surfaces as before', () => {
    const boom = () => { throw new Error('clear refused'); };

    it('through a save: the flush fails and the failure is reported', async () => {
      const { fake, session, erased } = await erasedElsewhere();
      fake.host.clearOffFileData = boom;
      add(session, 'b', 81, '2026-10-02');
      await expect(session.flush()).rejects.toThrow(/Cloud sync failed/);
      expect(fake.reports).toEqual([{ cause: undefined, repeat: false }]);
      expect(session.eraseIdentity).toBe(erased);
      expect(ids(session.file)).not.toContain('a');
    });

    it('through a re-read: the re-read rejects with the error', async () => {
      const { fake, session, erased } = await erasedElsewhere();
      fake.host.clearOffFileData = boom;
      await expect(session.refreshFromRemote()).rejects.toThrow('clear refused');
      expect(session.eraseIdentity).toBe(erased);
      expect(ids(session.file)).not.toContain('a');
    });

    it('through a page hide: nothing throws to the page, and no save is left to run', async () => {
      const { fake, session, erased } = await erasedElsewhere('device');
      fake.host.clearOffFileData = boom;
      add(session, 'b', 81, '2026-10-02');
      expect(() => session.flushSync()).not.toThrow();
      expect(session.saveStatus).toBe('saved');
      expect(session.eraseIdentity).toBe(erased);
      expect(ids(session.file)).not.toContain('a');
    });
  });
});

describe('RecordSession: a pass and its claim end together (lead A1)', () => {
  type Inside = { mode: SaveState; running: Promise<boolean> | null; dispatch(event: SaveEvent): number | null };
  const passRuns = (s: SaveState) => s.mode === 'saving' || (s.mode === 'erasing' && s.under.mode === 'saving');
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** Holds the store's next write until released. */
  function holdWrite(store: TestStore) {
    let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { reached = r; });
    const write = store.write.bind(store);
    store.write = async (...args: Parameters<TestStore['write']>) => { store.write = write; reached(); await gate; return write(...args); };
    return { started, release };
  }

  it('a pass runs exactly while the mode is saving (or erasing over saving), at every event', async () => {
    const store = new TestStore();
    const fake = fakeHost(store, 'device');
    const session = await RecordSession.open(fake.host);
    const inside = session as unknown as Inside;
    const broken: string[] = [];
    const seen = new Set<string>();
    const check = (at: string) => {
      if (passRuns(inside.mode) !== (inside.running !== null)) broken.push(`${at}: ${JSON.stringify(inside.mode)}, running ${inside.running !== null}`);
    };
    // Checked as each event arrives, and once the turn that dispatched it ends
    // (a pass's claim is set just after the save that starts it, in that turn).
    const dispatch = inside.dispatch.bind(session);
    inside.dispatch = (event) => {
      check(`before ${event.type}`);
      seen.add(`${event.type}${passRuns(inside.mode) ? ' mid-pass' : ''}`);
      const pass = dispatch(event);
      queueMicrotask(() => check(`after ${event.type}`));
      return pass;
    };
    const fireDebounce = () => fake.timers.splice(0).forEach((t) => t.run());
    const midPass = async (during: () => void | Promise<void>) => {
      const held = holdWrite(store);
      add(session, `m${store.writes}`);
      const save = session.flush();
      await held.started;
      await during();
      held.release();
      await save;
    };

    const steps: Array<[string, () => Promise<void>]> = [
      ['a pass lands', async () => { add(session, 'a'); await session.flush(); }],
      ['an edit, then the debounce firing, mid-pass', () => midPass(() => { add(session, 'b'); fireDebounce(); })],
      ['a pass fails', async () => {
        store.failWrites = true;
        add(session, 'c');
        await expect(session.flush()).rejects.toThrow();
        store.failWrites = false;
      }],
      ['flushSync mid-pass', () => midPass(() => { add(session, 'd'); session.flushSync(); })],
      ['an erase mid-pass', async () => {
        let erase: Promise<unknown> | null = null;
        await midPass(async () => {
          erase = session.erase();
          for (let i = 0; i < 50 && inside.mode.mode !== 'erasing'; i += 1) await tick();
          expect(inside.mode.mode).toBe('erasing');
        });
        expect(await erase).toEqual({ success: true });
      }],
      ["a save asked for from adopt(), after another device's erase", async () => {
        const other = await RecordSession.open(fakeHost(new TestStore(store.cloud), 'device').host);
        clock += 60_000;
        expect((await other.erase()).success).toBe(true);
        clock += 60_000;
        let inner: Promise<void> | null = null;
        fake.host.clearOffFileData = () => {
          fake.host.clearOffFileData = () => {};
          add(session, 'e');
          inner = session.flush();
        };
        add(session, 'f');
        await session.flush();
        await inner;
      }],
    ];
    for (const [name, step] of steps) {
      await step();
      await tick();
      check(`after step: ${name}`);
    }

    expect(broken).toEqual([]);
    expect([...seen]).toEqual(expect.arrayContaining([
      'passLanded mid-pass', 'passFailed mid-pass', 'edited mid-pass', 'save mid-pass', 'synced mid-pass', 'eraseStarted mid-pass',
    ]));
    expect(inside.running).toBeNull();
    expect(session.saveStatus).toBe('saved');
  });
});
