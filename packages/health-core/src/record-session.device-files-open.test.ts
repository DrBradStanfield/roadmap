/**
 * US-09 AC2c: a device page that may not write this device's health files
 * reads none of them either, the record included. The device host says so
 * through `deviceFilesOpen`, read at each use; a host that leaves it out (the
 * iPhone's) is open. A cloud page's own cloud is not a device file: a stopped
 * cloud page still re-reads it. The real web host is pinned in
 * widget-src/src/storage/web-record-host.device-files-open.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, type ReadResult, type WriteResult } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { clearOffFile, type RecordHost, type SyncStorage } from './record-host';
import { RecordSession } from './record-session';
import { ROADMAP_DOC } from './roadmap-doc';
import { createMeasurement, type RoadmapFile } from './roadmap-file';

let clock = Date.parse('2026-11-13T10:00:00.000Z');

/** A synchronous device store over one MemoryCloud, as localStorage is on the web. */
class DeviceStore extends MemoryAdapter implements SyncStorage {
  readSync = vi.fn((name: string): ReadResult => {
    const entry = this.cloud.files.get(name);
    return entry ? { body: JSON.parse(entry.json), version: String(entry.version) } : { body: null, version: null };
  });
  writeSync = vi.fn((name: string, body: object, expected: string | null): WriteResult => {
    const entry = this.cloud.files.get(name);
    if ((entry ? String(entry.version) : null) !== expected) throw new Error('moved');
    const version = (entry?.version ?? 0) + 1;
    this.cloud.files.set(name, { json: JSON.stringify(body), version });
    return { version: String(version) };
  });
  revision(name: string) { return this.cloud.files.has(name) ? String(this.cloud.files.get(name)!.version) : null; }
  override async read(name: string) { return this.readSync(name); } // through readSync, so one spy sees both
}

interface Page {
  host: RecordHost;
  /** What this page may do: `open` false closes it. The kept erase is the host's own, written only while open. */
  state: { open: boolean; kept: string | null };
  timers: Array<() => void>;
  reports: string[];
  statuses: string[];
  clears: number;
}

/** A device page whose ownership follows `open`, as the web host's does (one rule: no log-off since load). */
function devicePage(store: DeviceStore, open: boolean, omitGate = false): Page {
  const page: Page = { host: undefined as unknown as RecordHost, state: { open, kept: null }, timers: [], reports: [], statuses: [], clears: 0 };
  const owns = () => page.state.open;
  page.host = {
    tier: 'device', store, sync: store, clearNamedFiles: () => {}, eraseFence: () => null,
    clearOffFileData: () => { page.clears += 1; },
    clearedErase: () => (owns() ? page.state.kept : null),
    noteCleared: (identity: string) => { if (owns()) page.state.kept = identity; },
    ...(omitGate ? {} : { ownsOffFileData: owns, deviceFilesOpen: owns }),
    deviceId: () => 'laptop', clock: { now: () => (clock += 1000) },
    timers: { set: (run: () => void) => { page.timers.push(run); return page.timers.length; }, clear: () => {} },
    remoteChanged: () => {}, failureCause: () => 'other',
    saveStatusChanged: (status) => void page.statuses.push(status),
    report: (_error, at) => void page.reports.push(at.op),
  } as RecordHost;
  return page;
}

const weight = (id: string) =>
  createMeasurement({ id, metricType: 'weight', value: 80, recordedAt: '2026-11-12', createdAt: new Date(clock).toISOString() });
const add = (session: RecordSession, id: string) => session.edit((f) => { f.measurements.push(weight(id)); });
const ids = (file: RoadmapFile) => file.measurements.map((m) => m.id).sort();
const stored = (store: DeviceStore) => ids(JSON.parse(store.cloud.files.get(ROADMAP_FILE_NAME)!.json));

/** Another page, open, saves `id` to the device record. */
async function otherPageSaves(store: DeviceStore, id: string) {
  const other = await RecordSession.open(devicePage(new DeviceStore(store.cloud), true).host);
  add(other, id);
  await other.flush();
}

describe('US-09 AC2c: a device page that may not write this device\'s record reads none of it', () => {
  it('a page closed after it opened neither re-reads, flushes nor saves through the device record', async () => {
    const store = new DeviceStore();
    const page = devicePage(store, true);
    const session = await RecordSession.open(page.host);
    page.state.open = false;
    await otherPageSaves(store, 'guest');
    store.readSync.mockClear();

    expect(await session.refreshFromRemote()).toBe(false);
    add(session, 'mine');
    session.flushSync();
    await expect(session.flush()).rejects.toThrow();

    expect(store.readSync).not.toHaveBeenCalled();
    expect(ids(session.file)).toEqual(['mine']); // nothing of the other page's
    expect(stored(store)).toEqual(['guest']); // and nothing of its own written
    expect(session.saveStatus).toBe('not-saved');
    expect(page.statuses.at(-1)).toBe('not-saved');
    expect(page.reports).toEqual([]);
  });

  it('a page closed at open reads nothing, opens on an empty record, and keeps and clears nothing', async () => {
    const store = new DeviceStore();
    await otherPageSaves(store, 'guest');
    store.readSync.mockClear();
    const page = devicePage(store, false);
    const session = await RecordSession.open(page.host);

    expect(store.readSync).not.toHaveBeenCalled();
    expect(ids(session.file)).toEqual([]);
    expect(session.file.meta.eraseEpoch ?? 0).toBe(0);
    expect(page.state.kept).toBeNull(); // no erase adopted as cleared up to
    expect(page.clears).toBe(0); // nothing cleared

    add(session, 'mine');
    page.timers.splice(0).forEach((run) => run()); // the debounce fires its save
    await vi.waitFor(() => expect(session.saveStatus).toBe('not-saved')); // failed, never a lasting 'saving'
    expect(store.readSync).not.toHaveBeenCalled();
    expect(stored(store)).toEqual(['guest']);
    expect(page.reports).toEqual([]);
  });

  it.each([
    { name: 'leaves the gate out', omitGate: true },
    { name: 'stays open', omitGate: false },
  ])('a page whose host $name opens, re-reads and saves through the device record', async ({ omitGate }) => {
    const store = new DeviceStore();
    await otherPageSaves(store, 'guest');
    const session = await RecordSession.open(devicePage(store, true, omitGate).host);
    expect(ids(session.file)).toEqual(['guest']);
    await otherPageSaves(store, 'later');
    expect(await session.refreshFromRemote()).toBe(true);
    add(session, 'mine');
    await session.flush();
    expect(stored(store)).toEqual(['guest', 'later', 'mine']);
    expect(session.saveStatus).toBe('saved');
  });
});

describe('US-09 AC2c: a stopped cloud page still reads its own cloud', () => {
  it('a cloud page whose device writes stopped re-reads and takes in its cloud', async () => {
    const cloud = new MemoryCloud();
    const host = {
      tier: 'cloud', store: new MemoryAdapter(cloud),
      clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {}, ownsOffFileData: () => false,
      deviceId: () => 'laptop', clock: { now: () => (clock += 10_000) }, timers: { set: () => 0, clear: () => {} },
      remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
      mirror: {
        adapter: new MemoryAdapter(), pending: { get: () => false, set: () => {}, clear: () => {} },
        writesStopped: () => true, wipe: async () => {}, opened: () => {},
      },
    } as unknown as RecordHost;
    const session = await RecordSession.open(host);
    const other = await RecordSession.open({ ...host, store: new MemoryAdapter(cloud), deviceId: () => 'phone' } as RecordHost);
    add(other, 'phone-row');
    await other.flush();
    expect(await session.refreshFromRemote()).toBe(true);
    expect(ids(session.file)).toEqual(['phone-row']);
  });
});

describe('US-09 AC2c, US-11 AC6: clearOffFile reads the device record only for an owner', () => {
  const ctx = { deviceId: 'laptop', now: '2026-11-13T10:00:00.000Z' };
  const after = ROADMAP_DOC.migrate(null, ctx);
  it.each([
    { name: 'a page that does not own the off-file data', owns: false, reads: false },
    { name: 'a page that owns it', owns: true, reads: true },
    { name: 'a host that leaves ownsOffFileData out', owns: undefined, reads: true },
  ])('$name reads the device record: $reads', ({ owns, reads }) => {
    const deviceRecord = vi.fn(() => null);
    const host = { clearOffFileData: () => {}, deviceRecord, ...(owns === undefined ? {} : { ownsOffFileData: () => owns }) } as unknown as RecordHost;
    clearOffFile(host, after, ctx);
    expect(deviceRecord.mock.calls.length > 0).toBe(reads);
  });
});
