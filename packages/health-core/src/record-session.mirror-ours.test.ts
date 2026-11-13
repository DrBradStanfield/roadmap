/**
 * US-09 AC2c: a cloud page takes in this device's copy only while it is still
 * that page's mirror and the page may write: `writesStopped()` false and
 * `stillChosen()` not false, read live. Checked at open, before the device copy
 * is read, and again once the read returns. When the second check fails, the
 * page holds its cloud copy only: the body read is dropped unmerged, nothing is
 * marked edited, no save is scheduled, and the marker stays. A marker is cleared
 * at open only while the copy is this page's. The iPhone's host (writes never
 * stopped, no `stillChosen`) lifts as before. The web host is pinned in
 * widget-src/src/storage/web-record-host.cloud-open.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME, type ReadResult } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import type { RecordHost } from './record-host';
import { RecordSession } from './record-session';
import { createMeasurement, type RoadmapFile } from './roadmap-file';
import { ROADMAP_DOC } from './roadmap-doc';

let clock = Date.parse('2026-11-13T10:00:00.000Z');

/** The device copy. `duringRead` runs while its read is awaited; `unreadable` makes the read throw. */
class DeviceCopy extends MemoryAdapter {
  reads = 0;
  duringRead?: () => void;
  unreadable = false;
  override async read(name: string): Promise<ReadResult> {
    this.reads += 1;
    const result = await super.read(name);
    this.duringRead?.();
    if (this.unreadable) throw new Error('unparseable');
    return result;
  }
}

class CountingCloud extends MemoryAdapter {
  writes = 0;
  override async write(...args: Parameters<MemoryAdapter['write']>) {
    this.writes += 1;
    return super.write(...args);
  }
}

interface Page {
  host: RecordHost;
  cloud: CountingCloud;
  device: DeviceCopy;
  /** What the mirror answers, read live. `chosen` undefined: the host has no `stillChosen` (the iPhone). */
  state: { stopped: boolean; chosen: boolean | undefined; pending: boolean };
  timers: Array<() => void>;
  statuses: string[];
}

const weight = (id: string) =>
  createMeasurement({ id, metricType: 'weight', value: 80, recordedAt: '2026-11-12', createdAt: new Date(clock).toISOString() });
const ids = (file: RoadmapFile) => file.measurements.map((m) => m.id).sort();
const fileWith = (id: string): RoadmapFile => {
  const file = ROADMAP_DOC.migrate(null, { deviceId: 'other', now: new Date(clock).toISOString() });
  file.measurements.push(weight(id));
  return file;
};

/** A cloud page whose cloud holds `cloud-row` and whose device copy holds `device-row`, its marker set. */
function cloudPage(state: Partial<Page['state']> = {}): Page {
  const cloudStore = new MemoryCloud();
  cloudStore.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(fileWith('cloud-row')), version: 1 });
  const deviceStore = new MemoryCloud();
  deviceStore.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(fileWith('device-row')), version: 1 });
  const page: Page = {
    host: undefined as unknown as RecordHost,
    cloud: new CountingCloud(cloudStore),
    device: new DeviceCopy(deviceStore),
    state: { stopped: false, chosen: true, pending: true, ...state },
    timers: [],
    statuses: [],
  };
  const s = page.state;
  page.host = {
    tier: 'cloud', store: page.cloud,
    clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {},
    deviceId: () => 'laptop', clock: { now: () => (clock += 1000) },
    timers: { set: (run: () => void) => { page.timers.push(run); return page.timers.length; }, clear: () => {} },
    remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
    saveStatusChanged: (status) => void page.statuses.push(status),
    mirror: {
      adapter: page.device,
      pending: { get: () => s.pending, set: () => { s.pending = true; }, clear: () => { s.pending = false; } },
      writesStopped: () => s.stopped,
      ...(s.chosen === undefined ? {} : { stillChosen: () => s.chosen !== false }),
      wipe: async () => {},
      opened: () => {},
    },
  } as RecordHost;
  return page;
}

/** The page holds its cloud copy only, nothing is marked edited or scheduled, and a flush writes nothing. */
async function holdsCloudCopyOnly(page: Page, session: RecordSession) {
  expect(ids(session.file)).toEqual(['cloud-row']);
  expect(page.timers).toEqual([]); // no save scheduled
  expect(page.statuses).toEqual([]); // no 'edited': the save status never moved
  await session.flush();
  expect(page.cloud.writes).toBe(0);
  expect(page.state.pending).toBe(true); // the marker is left
}

describe('US-09 AC2c: a cloud page takes in the device copy only while it is its mirror', () => {
  it('a page whose copy is its own merges it, schedules a save, and the marker clears once the cloud has it', async () => {
    const page = cloudPage();
    const session = await RecordSession.open(page.host);
    expect(ids(session.file)).toEqual(['cloud-row', 'device-row']);
    expect(page.timers).toHaveLength(1);
    await session.flush();
    expect(ids(JSON.parse(page.cloud.cloud.files.get(ROADMAP_FILE_NAME)!.json))).toEqual(['cloud-row', 'device-row']);
    expect(page.state.pending).toBe(false);
  });

  it('a page whose writes are stopped at open reads no device copy and takes nothing in', async () => {
    const page = cloudPage({ stopped: true });
    const session = await RecordSession.open(page.host);
    expect(page.device.reads).toBe(0);
    await holdsCloudCopyOnly(page, session);
  });

  it('a page this browser no longer names at open reads no device copy and takes nothing in', async () => {
    const page = cloudPage({ chosen: false });
    const session = await RecordSession.open(page.host);
    expect(page.device.reads).toBe(0);
    await holdsCloudCopyOnly(page, session);
  });

  it('a page whose writes stop while the device copy is read holds its cloud copy only', async () => {
    const page = cloudPage();
    page.device.duringRead = () => { page.state.stopped = true; };
    const session = await RecordSession.open(page.host);
    expect(page.device.reads).toBe(1);
    await holdsCloudCopyOnly(page, session);
  });

  it('a page this browser stops naming while the device copy is read holds its cloud copy only', async () => {
    const page = cloudPage();
    page.device.duringRead = () => { page.state.chosen = false; };
    const session = await RecordSession.open(page.host);
    await holdsCloudCopyOnly(page, session);
  });

  it('an empty device copy clears the marker only while the copy is this page\'s', async () => {
    const ours = cloudPage();
    ours.device.cloud.files.clear();
    await RecordSession.open(ours.host);
    expect(ours.state.pending).toBe(false);

    const stopping = cloudPage();
    stopping.device.cloud.files.clear();
    stopping.device.duringRead = () => { stopping.state.stopped = true; };
    await RecordSession.open(stopping.host);
    expect(stopping.state.pending).toBe(true);
  });

  it('an unreadable device copy clears the marker only while the copy is this page\'s', async () => {
    const ours = cloudPage();
    ours.device.unreadable = true;
    const kept = await RecordSession.open(ours.host);
    expect(ids(kept.file)).toEqual(['cloud-row']);
    expect(ours.state.pending).toBe(false);

    const stopping = cloudPage();
    stopping.device.unreadable = true;
    stopping.device.duringRead = () => { stopping.state.stopped = true; };
    await RecordSession.open(stopping.host);
    expect(stopping.state.pending).toBe(true);
  });

  it("the iPhone's host (writes never stopped, no stillChosen) lifts the device copy as before", async () => {
    const page = cloudPage({ chosen: undefined });
    const session = await RecordSession.open(page.host);
    expect(ids(session.file)).toEqual(['cloud-row', 'device-row']);
    await session.flush();
    expect(page.state.pending).toBe(false);
  });
});
