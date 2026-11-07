/**
 * @vitest-environment jsdom
 *
 * The device copy a cloud page writes as it goes away (US-06 AC13), with two
 * tabs' sessions on one localStorage, through the web host itself: another
 * tab's save never clears the marker for a change it did not carry, a save
 * that carries all of it clears the marker and leaves the copy (US-09 AC4,
 * AC13), and a cloud tab left open after another tab moved this browser to
 * "This device" never removes the record that tab now runs on (US-09 AC2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError, MemoryAdapter, MemoryCloud, RecordSession, ROADMAP_FILE_NAME, copyCloudDown, createMeasurement,
  type RecordHost, type RoadmapFile, type WriteResult,
} from '@roadmap/health-core';
import { LocalStorageAdapter } from './local-storage-adapter';
import { BACKEND_KEY, isSyncPending, webRecordHost } from './web-record-host';

afterEach(() => localStorage.clear());
// A cloud page runs with its backend remembered (connect.ts); MemoryAdapter's id is 'memory'.
beforeEach(() => localStorage.setItem(BACKEND_KEY, 'memory'));

/** A cloud whose save never answers: the tab closes before it lands. */
class StalledCloud extends MemoryAdapter {
  async write(): Promise<WriteResult> {
    return new Promise<WriteResult>(() => {});
  }
}

const add = (session: RecordSession, id: string, value: number) =>
  session.edit((file) => void file.measurements.push(createMeasurement({
    id, metricType: 'weight', value, recordedAt: '2026-10-01', createdAt: '2026-10-01T10:00:00.000Z',
  })));
const ids = (file: RoadmapFile | null | undefined) => (file?.measurements ?? []).map((m) => m.id).sort();
const deviceCopy = () => new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body as RoadmapFile | null;

describe('two cloud tabs on one localStorage (US-06 AC13)', () => {
  it("tab B's save without tab A's departure keeps the copy and its marker; the next load lifts it up and clears the marker", async () => {
    const cloud = new MemoryCloud();
    const tabA = await RecordSession.open(webRecordHost(new StalledCloud(cloud)));
    const tabB = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    add(tabA, 'dose', 1.7);
    tabA.flushSync(); // tab A closes
    expect(ids(deviceCopy())).toEqual(['dose']);
    expect(isSyncPending()).toBe(true);

    add(tabB, 'other', 80);
    await tabB.flush();
    expect(isSyncPending()).toBe(true);
    expect(ids(deviceCopy())).toEqual(['dose']);

    const next = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    expect(ids(next.file)).toEqual(['dose', 'other']);
    await next.flush();
    expect(isSyncPending()).toBe(false);
    // The copy stays for a load that cannot reach the cloud (US-09 AC13).
    expect(ids(deviceCopy())).toEqual(['dose']);
  });
});

describe('a save that holds the device copy (US-09 AC13)', () => {
  it('keeps the copy, so a load that cannot reach the cloud starts from it', async () => {
    const cloud = new MemoryCloud();
    const tab = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    add(tab, 'late', 81);
    tab.flushSync(); // hidden
    await tab.flush(); // its cloud save lands
    expect(isSyncPending()).toBe(false);
    const offline = await RecordSession.open(webRecordHost(new LocalStorageAdapter()), { cloudUnreachable: true });
    expect(ids(offline.file)).toEqual(['late']);
  });
});

/** Another device's cloud page: its erase touches nothing in this browser. */
function phoneHost(cloud: MemoryCloud): RecordHost {
  const host = webRecordHost(new MemoryAdapter(cloud));
  if (host.tier !== 'cloud') throw new Error('cloud host expected');
  return {
    ...host,
    clearOffFileData: () => {},
    deviceRecord: undefined,
    mirror: {
      ...host.mirror, adapter: new MemoryAdapter(new MemoryCloud()), sync: undefined,
      pending: { get: () => false, set: () => {}, clear: () => {} }, wipe: async () => {},
    },
  };
}

/** Tab B on the cloud saves 'base'; tab A then picks "This device": the cloud
 *  is copied down, forgotten, and tab A reloads on the device. */
async function switchedAway(): Promise<{ cloud: MemoryCloud; tabB: RecordSession }> {
  const cloud = new MemoryCloud();
  localStorage.setItem(BACKEND_KEY, 'memory');
  const tabB = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
  add(tabB, 'base', 80);
  await tabB.flush();
  const leaving = webRecordHost(new MemoryAdapter(cloud));
  if (leaving.tier !== 'cloud') throw new Error('cloud host expected');
  await copyCloudDown(leaving);
  localStorage.removeItem(BACKEND_KEY);
  const tabA = await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
  expect(ids(tabA.file)).toEqual(['base']);
  return { cloud, tabB };
}

describe('a cloud tab left open after another tab moved this browser to "This device" (US-09 AC2)', () => {
  it('its hide and save leave the record that tab now runs on', async () => {
    const { tabB } = await switchedAway();
    add(tabB, 'late', 81);
    tabB.flushSync(); // hidden
    await tabB.flush(); // its cloud save lands
    const tabA = await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    expect(ids(tabA.file)).toContain('base');
  });

  it('so does an erase it takes in from another device', async () => {
    const { cloud, tabB } = await switchedAway();
    expect((await (await RecordSession.open(phoneHost(cloud))).erase()).success).toBe(true);
    expect(await tabB.refreshFromRemote()).toBe(true);
    const tabA = await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    expect(ids(tabA.file)).toEqual(['base']);
  });

  it('and an edit and a departure after it took in an erase from another device (Brad R1)', async () => {
    const { cloud, tabB } = await switchedAway();
    expect((await (await RecordSession.open(phoneHost(cloud))).erase()).success).toBe(true);
    expect(await tabB.refreshFromRemote()).toBe(true);
    add(tabB, 'late', 81);
    tabB.flushSync(); // tab B closes
    const tabA = await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    expect(ids(tabA.file)).toEqual(['base']);
    expect(isSyncPending()).toBe(false);
  });

  it('and an erase it takes in after it last wrote that record itself', async () => {
    const { cloud, tabB } = await switchedAway();
    add(tabB, 'late', 81);
    tabB.flushSync(); // hidden: it last wrote the device copy itself
    await tabB.flush();
    expect((await (await RecordSession.open(phoneHost(cloud))).erase()).success).toBe(true);
    expect(await tabB.refreshFromRemote()).toBe(true);
    const tabA = await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    expect(ids(tabA.file)).toContain('base');
  });
});

describe('an erase taken in from another device, on the cloud this browser still uses (US-06 AC13)', () => {
  it('removes the copy this tab wrote as it was hidden, and its marker', async () => {
    // The key browsers already hold the remembered backend under (connect.ts re-exports it).
    expect(BACKEND_KEY).toBe('health_roadmap_backend');
    const cloud = new MemoryCloud();
    localStorage.setItem(BACKEND_KEY, 'memory');
    const tab = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    add(tab, 'dose', 1.7);
    tab.flushSync(); // hidden
    await tab.flush();
    expect(ids(deviceCopy())).toEqual(['dose']);
    expect((await (await RecordSession.open(phoneHost(cloud))).erase()).success).toBe(true);
    expect(await tab.refreshFromRemote()).toBe(true);
    expect(deviceCopy()).toBeNull();
    expect(isSyncPending()).toBe(false);
  });
});

describe('an erase taken in at a load, on the cloud this browser still uses (US-06 AC13, Brad R2)', () => {
  it('removes the copy a hidden tab left once its save landed, so an offline start does not show the erased record', async () => {
    const cloud = new MemoryCloud();
    const laptop = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    add(laptop, 'dose', 1.7);
    laptop.flushSync(); // hidden inside the debounce
    await laptop.flush(); // its save lands; the laptop then closes
    expect(ids(deviceCopy())).toEqual(['dose']);
    expect((await (await RecordSession.open(phoneHost(cloud))).erase()).success).toBe(true);
    const later = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    expect(ids(later.file)).toEqual([]);
    expect(deviceCopy()).toBeNull();
    expect(isSyncPending()).toBe(false);
    const offline = await RecordSession.open(webRecordHost(new LocalStorageAdapter()), { cloudUnreachable: true });
    expect(ids(offline.file)).toEqual([]);
  });

  it('keeps the copy once another tab moved this browser to "This device" (US-09 AC2)', async () => {
    const { cloud } = await switchedAway();
    expect((await (await RecordSession.open(phoneHost(cloud))).erase()).success).toBe(true);
    await RecordSession.open(webRecordHost(new MemoryAdapter(cloud))); // a stale cloud page loads
    const tabA = await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    expect(ids(tabA.file)).toEqual(['base']);
  });
});

describe('LocalStorageAdapter.removeSync', () => {
  it('removes the record and its revision only at the revision it was read at', () => {
    localStorage.removeItem(BACKEND_KEY); // only the record's own keys here
    const device = new LocalStorageAdapter();
    const first = device.writeSync(ROADMAP_FILE_NAME, { schemaVersion: 1 }, null).version;
    const second = device.writeSync(ROADMAP_FILE_NAME, { schemaVersion: 1, other: true }, first).version;
    // Another tab wrote since `first` was read: its write stays.
    expect(() => device.removeSync(ROADMAP_FILE_NAME, first)).toThrow(ConflictError);
    expect(device.revision(ROADMAP_FILE_NAME)).toBe(second);
    device.removeSync(ROADMAP_FILE_NAME, second);
    expect(device.readSync(ROADMAP_FILE_NAME).body).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
