/**
 * Lead S57 (US-11 AC3b, AC7; US-16 AC2a; US-09 AC4): an erase whose cloud
 * write fails keeps the erased copy only when the failure mirror holds it on
 * the device. When the device write fails too, the erase lives nowhere but in
 * memory: the session puts its copy back, and the erase answers that it did
 * not happen. A failed erase no longer leaves the record half-erased.
 */
import { describe, expect, it } from 'vitest';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { ROADMAP_FILE_NAME, StorageError } from './adapter';
import { createMeasurement, type RoadmapFile } from './roadmap-file';
import { ROADMAP_DOC } from './roadmap-doc';
import { transition, writtenNowhere, type SaveState } from './save-state';
import { mayHaveLanded, SyncManager } from './sync-manager';

/** A memory store whose writes can be made to fail, or land and then fail the re-read after them. */
class FailingStore extends MemoryAdapter {
  failWrites = false;
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
  async write(fileName: string, body: object, expected: string | null) {
    if (this.failWrites) throw new StorageError('refused', undefined, Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
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
