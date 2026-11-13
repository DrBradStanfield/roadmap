/**
 * Lead S57 (US-11 AC3b, AC7; US-16 AC2a; US-09 AC4): an erase whose cloud
 * write fails keeps the erased copy only when the failure mirror holds it on
 * the device. When the cloud definitely refused the write and the device
 * write fails too, the erase lives nowhere but in memory: the session puts
 * its copy back, and the erase answers that it did not happen. A write that
 * may have landed (no answer, a 5xx, a failed verify) keeps the erased copy,
 * as before. A failed erase no longer leaves the record half-erased.
 */
import { describe, expect, it } from 'vitest';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { ConflictError, LostUpdateError, ROADMAP_FILE_NAME, StorageError } from './adapter';
import { createMeasurement, type RoadmapFile } from './roadmap-file';
import { ROADMAP_DOC } from './roadmap-doc';
import { transition, writtenNowhere, type SaveState } from './save-state';
import { SyncManager } from './sync-manager';
import { isDefiniteRefusal, mayHaveLanded, uncertainWrite } from './write-refusal';

/** A memory store whose writes can be made to fail, or land and then fail the re-read after them. */
class FailingStore extends MemoryAdapter {
  failWrites = false;
  /** What a failing write throws: by default a definite refusal (a full store). */
  failure: () => Error = () => new StorageError('refused', undefined, Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
  private failReadAfterWrite = false;
  private wrote = false;
  /** From now on: reads work until a write lands, then fail. */
  failReadsAfterNextWrite() {
    this.failReadAfterWrite = true;
    this.wrote = false;
  }
  async read(fileName: string) {
    if (this.failReadAfterWrite && this.wrote) throw new StorageError('unreachable');
    return super.read(fileName);
  }
  /** A failing write stores its body first, then throws (localStorage's record landed, its revision did not). */
  landBeforeFailing = false;
  async write(fileName: string, body: object, expected: string | null) {
    if (this.failWrites && this.landBeforeFailing) await super.write(fileName, body, expected);
    if (this.failWrites) throw this.failure();
    const written = await super.write(fileName, body, expected);
    this.wrote = true;
    return written;
  }
}

let clock = Date.parse('2026-11-13T10:00:00.000Z');

function setup() {
  const cloud = new FailingStore();
  const device = new FailingStore(new MemoryCloud());
  const pending = { value: false };
  const calls: string[] = [];
  const host: RecordHost = {
    tier: 'cloud',
    store: cloud,
    clearOffFileData: () => { calls.push('clearOffFileData'); },
    clearedErase: () => null,
    noteCleared: () => {},
    deviceId: () => 'phone',
    clock: { now: () => clock },
    timers: { set: () => ({}), clear: () => {} },
    remoteChanged: () => {},
    failureCause: () => 'QuotaExceededError',
    report: () => {},
    mirror: {
      adapter: device,
      pending: {
        get: () => pending.value,
        set: () => { pending.value = true; },
        clear: () => { pending.value = false; },
      },
      writesStopped: () => false,
      wipe: async () => { device.cloud.files.clear(); calls.push('wipe'); },
      opened: () => {},
    },
  };
  return { host, cloud, device, pending, calls };
}

const weight = (id: string) =>
  createMeasurement({ id, metricType: 'weight', value: 80, recordedAt: '2026-11-01', createdAt: new Date(clock).toISOString() });
const add = (session: RecordSession, id: string) => session.edit((file) => void file.measurements.push(weight(id)));
const stored = (store: MemoryAdapter): RoadmapFile => JSON.parse(store.cloud.files.get(ROADMAP_FILE_NAME)!.json);
const ids = (file: RoadmapFile) => file.measurements.map((m) => m.id).sort();

describe('RecordSession.erase when neither the cloud nor the device takes it (lead S57)', () => {
  it('puts the copy back, answers not erased, and the next good save leaves both copies as before the erase plus the unsynced edit', async () => {
    const { host, cloud, device, pending, calls } = setup();
    const session = await RecordSession.open(host);
    add(session, 'synced');
    await session.flush();
    // An edit the cloud has not taken: its failed save mirrored it on the device.
    cloud.failWrites = true;
    add(session, 'unsynced');
    await expect(session.flush()).rejects.toThrow();
    expect(ids(stored(device))).toEqual(['synced', 'unsynced']);
    expect(pending.value).toBe(true);

    const before = session.eraseIdentity;
    const file = structuredClone(session.file);
    device.failWrites = true;
    const result = await session.erase();
    expect(result).toEqual({ success: false });
    // Nothing moved in memory: the same record, at the same erase, and edits under it are taken.
    expect(session.eraseIdentity).toBe(before);
    expect(session.file).toEqual(file);
    expect(session.refuses(before)).toBe(false);
    // Nothing moved on either copy, and no clean-up ran.
    expect(ids(stored(cloud))).toEqual(['synced']);
    expect(stored(cloud).meta.eraseEpoch ?? 0).toBe(0);
    expect(ids(stored(device))).toEqual(['synced', 'unsynced']);
    expect(stored(device).meta.eraseEpoch ?? 0).toBe(0);
    expect(calls).toEqual([]);
    // The marker stays set (owner ruling a): it lifts only the pre-erase copy.
    expect(pending.value).toBe(true);

    // The next good save: both copies hold the pre-erase record plus the unsynced edit, nothing erased.
    cloud.failWrites = false;
    device.failWrites = false;
    clock += 60_000;
    await session.flush();
    for (const copy of [stored(cloud), stored(device)]) {
      expect(ids(copy)).toEqual(['synced', 'unsynced']);
      expect(copy.meta.eraseEpoch ?? 0).toBe(0);
      expect(copy.erasedRows).toBeUndefined();
    }
    expect(pending.value).toBe(false);
  });

  it('S69 R2: keeps the erased copy when the cloud refused and the device write stored it before it failed (its revision moved)', async () => {
    const { host, cloud, pending } = setup();
    // A device copy with a revision to compare, as localStorage has on the web; the iPhone's has none.
    const device = new DeviceStore(new MemoryCloud());
    if (host.tier === 'cloud') Object.assign(host.mirror, { adapter: device, sync: device });
    const session = await RecordSession.open(host);
    add(session, 'a');
    await session.flush();
    const before = session.eraseIdentity;
    cloud.failWrites = true; // a definite refusal (a full store)
    device.failWrites = true;
    device.landBeforeFailing = true;
    device.failure = () => uncertainWrite(new StorageError('Could not save on this device (local storage may be full).', 'This change may have been stored.'));
    const result = await session.erase();
    // The device holds the erased copy and its marker: the next session lifts it into the cloud. Putting the copy back here
    // would skip the caller's commit (the reminders cancel) for an erase that then lands.
    expect(stored(device).meta.eraseEpoch).toBe(1);
    expect(pending.value).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(session.eraseIdentity).not.toBe(before);
    expect(session.file.measurements).toEqual([]);
  });

  it('keeps the erased copy when the cloud write landed and only the re-read after it failed, the device refusing too', async () => {
    const { host, cloud, device } = setup();
    const session = await RecordSession.open(host);
    add(session, 'a');
    await session.flush();
    const before = session.eraseIdentity;
    device.failWrites = true;
    cloud.failReadsAfterNextWrite();
    const result = await session.erase();
    // The cloud holds the erase: putting the copy back would accept edits its higher epoch then drops.
    expect(stored(cloud).meta.eraseEpoch).toBe(1);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(session.eraseIdentity).not.toBe(before);
    expect(session.file.measurements).toEqual([]);
  });

  it('keeps the erased copy, only in memory, when the cloud gave no answer and the device refused: the stated residual (owner ruling A)', async () => {
    const { host, cloud, device } = setup();
    const session = await RecordSession.open(host);
    add(session, 'a');
    await session.flush();
    const before = session.eraseIdentity;
    cloud.failWrites = true;
    cloud.failure = () => new StorageError('Dropbox did not answer', 'The change may have landed.');
    device.failWrites = true;
    const result = await session.erase();
    // The upload may have landed, so the copy is not put back; a relaunch before a retry lands brings the record back (S57).
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(session.eraseIdentity).not.toBe(before);
    expect(ids(stored(cloud))).toEqual(['a']);
    expect(device.cloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
  });

  it('control: when the failure mirror lands, the erased copy stays in memory and on the device, as before (US-16 AC2a)', async () => {
    const { host, cloud, device, pending } = setup();
    const session = await RecordSession.open(host);
    add(session, 'a');
    await session.flush();
    const before = session.eraseIdentity;
    cloud.failWrites = true;
    const result = await session.erase();
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(session.eraseIdentity).not.toBe(before);
    expect(session.file.measurements).toEqual([]);
    expect(stored(device).meta.eraseEpoch).toBe(1);
    expect(ids(stored(device))).toEqual([]);
    expect(pending.value).toBe(true);
    expect(ids(stored(cloud))).toEqual(['a']);
  });
});

describe('what says a failed pass wrote nowhere (lead S57)', () => {
  const saving: SaveState = { mode: 'saving', changes: 2, saved: 1, from: 2, armed: false };

  it('N1: a landed failure of a pass that started before the swap says nothing of the erase', () => {
    // The erase swapped in change 3 while a pass from change 2 ran; that pass wrote the pre-erase copy, then failed its check.
    const erasing: SaveState = { mode: 'erasing', phase: 'writing', under: { mode: 'saving', changes: 3, saved: 1, from: 2, armed: false } };
    const early = transition(erasing, { type: 'passFailed', cause: 'other', landed: true }).state;
    expect(early.mode === 'erasing' && writtenNowhere(early.under)).toBe(true);
    // A pass that carried the erase (from the swap's count) keeps its landed mark.
    const carried: SaveState = { mode: 'erasing', phase: 'writing', under: { mode: 'saving', changes: 3, saved: 1, from: 3, armed: false } };
    const late = transition(carried, { type: 'passFailed', cause: 'other', landed: true }).state;
    expect(late.mode === 'erasing' && late.under).toMatchObject({ mode: 'failed', landed: true });
    expect(late.mode === 'erasing' && writtenNowhere(late.under)).toBe(false);
  });

  it('a pass that failed before writing and reached no device copy wrote nowhere; one that may have landed, or was mirrored, did not', () => {
    const plain = transition(saving, { type: 'passFailed', cause: 'other' }).state;
    expect(writtenNowhere(plain)).toBe(true);
    expect(writtenNowhere(transition(plain, { type: 'mirrored', changes: 2 }).state)).toBe(false);
    const landed = transition(saving, { type: 'passFailed', cause: 'other', landed: true }).state;
    expect(landed).toMatchObject({ mode: 'failed', landed: true });
    expect(writtenNowhere(landed)).toBe(false);
    expect(writtenNowhere(saving)).toBe(false);
  });

  it('SyncManager marks a failure after a landed write, never one before it', async () => {
    const ctx = { deviceId: 'phone', now: new Date(clock).toISOString() };
    const store = new FailingStore();
    const sync = new SyncManager(store, 'phone', ROADMAP_DOC, { now: () => ctx.now });
    const file = ROADMAP_DOC.migrate(null, ctx);
    store.failWrites = true;
    const refused = await sync.save(file).catch((e: unknown) => e);
    expect(mayHaveLanded(refused)).toBe(false);
    store.failWrites = false;
    store.failReadsAfterNextWrite();
    const unverified = await sync.save(file).catch((e: unknown) => e);
    expect(unverified).toBeInstanceOf(StorageError);
    expect(mayHaveLanded(unverified)).toBe(true);
  });
});

describe('isDefiniteRefusal: only a failure that certainly stored nothing (owner ruling A)', () => {
  const status = (n: number) => new StorageError(`write failed (${n})`, undefined, undefined, n);
  const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
  const stopped = Object.assign(new StorageError('stopped'), { name: 'WritesStoppedError' });
  const rows: Array<[string, unknown, boolean]> = [
    ['a refused precondition (ConflictError)', new ConflictError(), true],
    ['a write that landed then vanished (LostUpdateError)', new LostUpdateError('lost'), false],
    ['a full provider (reason storage-full)', new StorageError('Dropbox is full', 'Nothing was written.', undefined, 409, 'storage-full'), true],
    ['a full device store (QuotaExceededError)', quota, true],
    ['a storage error caused by a full store', new StorageError('refused', undefined, quota), true],
    ['a page whose device writes stopped (WritesStoppedError)', stopped, true],
    ...[400, 401, 403, 404, 409, 412, 413, 422].map((n): [string, unknown, boolean] => [`HTTP ${n}`, status(n), true]),
    ...[408, 429, 500, 502, 503, 504, 507].map((n): [string, unknown, boolean] => [`HTTP ${n}`, status(n), false]),
    ['no answer (fetchOrFail: no status)', new StorageError('Dropbox did not answer', 'The change may have landed.'), false],
    ['an abort', new DOMException('aborted', 'AbortError'), false],
    ['a plain error', new Error('network'), false],
    ['not an error at all', 'oops', false],
    ['a 403 an adapter marked as after its upload (Drive verify)', uncertainWrite(status(403)), false],
  ];
  it.each(rows)('%s', (_name, error, refused) => {
    expect(isDefiniteRefusal(error)).toBe(refused);
  });

  it('a thrown value that is not an object cannot carry the mark, so it counts as may have landed', () => {
    for (const thrown of ['oops', undefined, null, 42]) expect(mayHaveLanded(thrown)).toBe(true);
    expect(mayHaveLanded(new Error('plain, unmarked'))).toBe(false);
  });

  it('SyncManager marks a write that threw unless it was a definite refusal, and keeps its words', async () => {
    const ctx = { deviceId: 'phone', now: new Date(clock).toISOString() };
    const store = new FailingStore();
    const sync = new SyncManager(store, 'phone', ROADMAP_DOC, { now: () => ctx.now });
    const file = ROADMAP_DOC.migrate(null, ctx);
    store.failWrites = true;
    const gateway = new StorageError('Dropbox write failed (502)', undefined, undefined, 502);
    store.failure = () => gateway;
    const thrown = await sync.save(file).catch((e: unknown) => e);
    expect(thrown).toBe(gateway); // never rewrapped: the words the page shows are the adapter's
    expect(mayHaveLanded(thrown)).toBe(true);
    store.failure = () => status(403);
    expect(mayHaveLanded(await sync.save(file).catch((e: unknown) => e))).toBe(false);
  });
});

/** A synchronous device store, as localStorage is on the web, whose writes can be made to fail. */
class DeviceStore extends FailingStore {
  readSync(name: string) {
    const entry = this.cloud.files.get(name);
    return entry ? { body: JSON.parse(entry.json), version: String(entry.version) } : { body: null, version: null };
  }
  writeSync(name: string, body: object, expected: string | null) {
    if (this.failWrites) throw this.failure();
    const entry = this.cloud.files.get(name);
    if ((entry ? String(entry.version) : null) !== expected) throw new ConflictError('moved');
    const version = (entry?.version ?? 0) + 1;
    this.cloud.files.set(name, { json: JSON.stringify(body), version });
    return { version: String(version) };
  }
  revision(name: string) { return this.cloud.files.has(name) ? String(this.cloud.files.get(name)!.version) : null; }
}

function deviceSetup() {
  const store = new DeviceStore(new MemoryCloud());
  const calls: string[] = [];
  const host: RecordHost = {
    tier: 'device', store, sync: store,
    clearNamedFiles: () => { calls.push('clearNamedFiles'); }, eraseFence: () => null,
    clearOffFileData: () => { calls.push('clearOffFileData'); },
    clearedErase: () => null,
    noteCleared: () => {},
    deviceId: () => 'laptop',
    clock: { now: () => clock },
    timers: { set: () => ({}), clear: () => {} },
    remoteChanged: () => {},
    failureCause: () => 'QuotaExceededError',
    report: () => {},
  };
  return { host, store, calls };
}

/** What LocalStorageAdapter.writeSync throws (widget-src local-storage-adapter.ts). */
const quota = () => Object.assign(new Error('full'), { name: 'QuotaExceededError' });
const FULL = 'Could not save on this device (local storage may be full).';
const deviceFailures: Array<[string, () => Error]> = [
  ['the record write is full (nothing stored)', () => new StorageError(FULL, undefined, quota())],
  ['writes stopped by a log-off (WritesStoppedError)', () => Object.assign(new Error('stopped'), { name: 'WritesStoppedError' })],
];

describe('S69, US-11 AC4c: an erase the device tier refused outright is put back', () => {
  it.each(deviceFailures)('%s: the copy is put back and the erase answers not erased', async (_name, failure) => {
    const { host, store, calls } = deviceSetup();
    const session = await RecordSession.open(host);
    add(session, 'a');
    await session.flush();
    const before = session.eraseIdentity;
    const file = structuredClone(session.file);
    store.failWrites = true;
    store.failure = failure;
    const result = await session.erase();
    expect(result).toEqual({ success: false });
    expect(session.eraseIdentity).toBe(before);
    expect(session.file).toEqual(file);
    expect(session.refuses(before)).toBe(false);
    expect(ids(stored(store))).toEqual(['a']);
    expect(stored(store).meta.eraseEpoch ?? 0).toBe(0);
    expect(calls).toEqual([]);
  });

  it('control: a revision write that failed after the record may have stored (uncertainWrite) keeps the erased copy', async () => {
    const { host, store } = deviceSetup();
    const session = await RecordSession.open(host);
    add(session, 'a');
    await session.flush();
    const before = session.eraseIdentity;
    store.failWrites = true;
    store.failure = () => uncertainWrite(new StorageError(FULL, 'This change may have been stored. Read the record again before trying it a second time.', quota()));
    const result = await session.erase();
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(session.eraseIdentity).not.toBe(before);
    expect(session.file.measurements).toEqual([]);
  });

  // An unreadable stored record is written over directly (replaceUnreadable, US-11 AC9), not through
  // SyncManager, so nothing marks a write that may have stored but the adapter itself.
  const unreadable = async () => {
    const { host, store } = deviceSetup();
    const session = await RecordSession.open(host);
    add(session, 'a');
    await session.flush();
    store.cloud.files.set(ROADMAP_FILE_NAME, { json: '{not json', version: 9 });
    return { session, store, before: session.eraseIdentity };
  };

  it.each(deviceFailures)('over an unreadable record, %s: put back too', async (_name, failure) => {
    const { session, store, before } = await unreadable();
    store.failWrites = true;
    store.failure = failure;
    expect(await session.erase()).toEqual({ success: false });
    expect(session.eraseIdentity).toBe(before);
    expect(ids(session.file)).toEqual(['a']);
  });

  it('control: over an unreadable record, a write that may have stored keeps the erased copy', async () => {
    const { session, store, before } = await unreadable();
    store.failWrites = true;
    store.failure = () => uncertainWrite(new StorageError(FULL, 'This change may have been stored.', quota()));
    const result = await session.erase();
    expect(result.success).toBe(false);
    expect(result.error).toBe(FULL);
    expect(session.eraseIdentity).not.toBe(before);
    expect(session.file.measurements).toEqual([]);
  });

  it('control: over an unreadable record, a failure that is not a known refusal keeps the erased copy', async () => {
    const { session, store, before } = await unreadable();
    store.failWrites = true;
    store.failure = () => new Error('something unknown');
    const result = await session.erase();
    expect(result.success).toBe(false);
    expect(session.eraseIdentity).not.toBe(before);
  });
});
