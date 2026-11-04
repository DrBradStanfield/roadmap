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
import { ConflictError, ROADMAP_FILE_NAME, StorageError, type ReadResult, type WriteResult } from './adapter';
import { createMeasurement, type FileDocument, type RoadmapFile } from './roadmap-file';
import { stampProfile } from './state-edits';

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
    const readSync = vi.spyOn(device, 'readSync');
    const session = await RecordSession.open(host);
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
