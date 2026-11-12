/**
 * @vitest-environment jsdom
 *
 * US-09 AC2c: a cloud page writes nothing to this device after a log-off on
 * this device. The web host notes the log-off id once, when it is built (the
 * adapter's own sign-in id, else the device's id then), and its device copy
 * is the page's mirror only while that id is still current AND this browser
 * still names the page's provider. No storage event is needed: these pages
 * hear none (jsdom raises none for the same document).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, type WriteResult } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RecordSession } from '@roadmap/health-core/record-session';
import { createMeasurement, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import type { RecordHost } from '@roadmap/health-core/record-host';

const BACKEND_KEY = 'health_roadmap_backend';
const PENDING_MIRROR_KEY = 'health_roadmap_pending_cloud_sync';
let LocalStorageAdapter: typeof import('./local-storage-adapter').LocalStorageAdapter;
let webRecordHost: typeof import('./web-record-host').webRecordHost;
let isSyncPending: typeof import('./web-record-host').isSyncPending;
/** A fresh page: a fresh module graph, loaded with the device's log-off id as it is now. */
async function loadPage(): Promise<void> {
  vi.resetModules();
  ({ LocalStorageAdapter } = await import('./local-storage-adapter'));
  ({ webRecordHost, isSyncPending } = await import('./web-record-host'));
}

const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
const LIFTED_KEY = 'health_roadmap_lifted_revision';

afterEach(() => localStorage.clear());
// A cloud page runs with its backend remembered; MemoryAdapter's id is 'memory'.
beforeEach(async () => {
  localStorage.setItem(BACKEND_KEY, 'memory');
  localStorage.setItem(LOG_OFF_ID_KEY, 'id-before');
  await loadPage();
});

/** Another tab logs off (a new id) and the device signs in again to the same
 *  provider. This page hears nothing of it. */
function logOffElsewhere(): void {
  localStorage.setItem(LOG_OFF_ID_KEY, 'id-after');
  localStorage.removeItem(BACKEND_KEY);
  localStorage.setItem(BACKEND_KEY, 'memory');
}

class StalledCloud extends MemoryAdapter {
  async write(): Promise<WriteResult> {
    return new Promise<WriteResult>(() => {});
  }
}
class FailingCloud extends MemoryAdapter {
  failing = false;
  async write(...args: Parameters<MemoryAdapter['write']>): Promise<WriteResult> {
    if (this.failing) throw new Error('network down');
    return super.write(...args);
  }
}
/** A cloud adapter that carries the id its sign-in began under, as the four real ones do. */
class SignedInCloud extends MemoryAdapter {
  constructor(cloud: MemoryCloud, readonly gen: string | null) { super(cloud); }
}

const add = (session: RecordSession, id: string, value: number) =>
  session.edit((file) => void file.measurements.push(createMeasurement({
    id, metricType: 'weight', value, recordedAt: '2026-10-01', createdAt: '2026-10-01T10:00:00.000Z',
  })));
const ids = (file: RoadmapFile | null | undefined) => (file?.measurements ?? []).map((m) => m.id).sort();
const deviceCopy = () => new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body as RoadmapFile | null;

/** Another device's cloud page: its erase touches nothing in this browser. */
function phoneHost(cloud: MemoryCloud): RecordHost {
  const host = webRecordHost(new MemoryAdapter(cloud));
  if (host.tier !== 'cloud') throw new Error('cloud host expected');
  return {
    ...host,
    clearOffFileData: () => {},
    ownsOffFileData: () => true, // a phone keeps no browser off-file data and is the owner on its own device
    deviceRecord: undefined,
    mirror: {
      ...host.mirror, adapter: new MemoryAdapter(new MemoryCloud()), sync: undefined,
      pending: { get: () => false, set: () => {}, clear: () => {} }, wipe: async () => {},
    },
  };
}

describe('US-09 AC2c: a host built before a log-off writes nothing to this device after it', () => {
  it('a departure writes no device copy and no marker (mirrorNow)', async () => {
    const tab = await RecordSession.open(webRecordHost(new StalledCloud(new MemoryCloud())));
    logOffElsewhere();
    add(tab, 'late', 81);
    tab.flushSync();
    expect(deviceCopy()).toBeNull();
    expect(isSyncPending()).toBe(false);
  });

  it('a failed save writes no device copy and no marker', async () => {
    const adapter = new FailingCloud(new MemoryCloud());
    const tab = await RecordSession.open(webRecordHost(adapter));
    logOffElsewhere();
    adapter.failing = true;
    add(tab, 'late', 81);
    await expect(tab.flush()).rejects.toThrow();
    expect(deviceCopy()).toBeNull();
    expect(isSyncPending()).toBe(false);
  });

  it('the same provider named again after the log-off does not reopen it', async () => {
    const adapter = new FailingCloud(new MemoryCloud());
    const tab = await RecordSession.open(webRecordHost(adapter));
    logOffElsewhere();
    expect(localStorage.getItem(BACKEND_KEY)).toBe('memory');
    adapter.failing = true;
    add(tab, 'late', 81);
    tab.flushSync();
    await expect(tab.flush()).rejects.toThrow();
    expect(deviceCopy()).toBeNull();
    expect(isSyncPending()).toBe(false);
  });

  it("a marker set after the log-off survives this page's successful save (releaseMarker)", async () => {
    const tab = await RecordSession.open(webRecordHost(new MemoryAdapter(new MemoryCloud())));
    logOffElsewhere();
    localStorage.setItem(PENDING_MIRROR_KEY, '9999-12-31T23:59:59.999Z'); // the new session's
    add(tab, 'late', 81);
    await tab.flush();
    expect(isSyncPending()).toBe(true);
  });

  it('a device copy survives an erase this page takes in after the log-off (releaseErasedCopy)', async () => {
    const cloud = new MemoryCloud();
    const tab = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    add(tab, 'late', 81);
    tab.flushSync(); // this page last wrote the device copy
    await tab.flush();
    logOffElsewhere();
    expect((await (await RecordSession.open(phoneHost(cloud))).erase()).success).toBe(true);
    expect(await tab.refreshFromRemote()).toBe(true);
    expect(ids(deviceCopy())).toEqual(['late']);
  });

  it("opening it after the log-off leaves a connect's lift record alone (liftMissed)", async () => {
    const host = webRecordHost(new MemoryAdapter(new MemoryCloud()));
    logOffElsewhere();
    localStorage.setItem(LIFTED_KEY, 'r-other'); // the new sign-in's lift
    await RecordSession.open(host);
    expect(localStorage.getItem(LIFTED_KEY)).toBe('r-other');
    expect(isSyncPending()).toBe(false);
  });

  it("an adapter whose sign-in began before the log-off is refused, though its host is built after", async () => {
    localStorage.setItem(LOG_OFF_ID_KEY, 'id-after');
    await loadPage();
    const adapter = new FailingCloud(new MemoryCloud());
    const signedIn = Object.assign(adapter, { gen: 'id-before' });
    const tab = await RecordSession.open(webRecordHost(signedIn));
    adapter.failing = true;
    add(tab, 'late', 81);
    await expect(tab.flush()).rejects.toThrow();
    expect(deviceCopy()).toBeNull();
  });
});

describe('US-09 AC2c: both halves of the check stand', () => {
  it('a new log-off id alone stops the mirror, and so does another provider alone', async () => {
    const sameProvider = new FailingCloud(new MemoryCloud());
    const tabA = await RecordSession.open(webRecordHost(sameProvider));
    localStorage.setItem(LOG_OFF_ID_KEY, 'id-after'); // the provider stays 'memory'
    sameProvider.failing = true;
    add(tabA, 'a', 81);
    await expect(tabA.flush()).rejects.toThrow();
    expect(deviceCopy(), 'the id half').toBeNull();

    localStorage.setItem(LOG_OFF_ID_KEY, 'id-before');
    const sameId = new FailingCloud(new MemoryCloud());
    const tabB = await RecordSession.open(webRecordHost(sameId));
    localStorage.setItem(BACKEND_KEY, 'dropbox'); // the id stays
    sameId.failing = true;
    add(tabB, 'b', 82);
    await expect(tabB.flush()).rejects.toThrow();
    expect(deviceCopy(), 'the provider half').toBeNull();
  });
});

describe('US-09 AC2c controls: no log-off, a device page, a host built after the log-off', () => {
  it('with the id unchanged, a failed save mirrors and marks as before', async () => {
    const adapter = new FailingCloud(new MemoryCloud());
    const tab = await RecordSession.open(webRecordHost(adapter));
    adapter.failing = true;
    add(tab, 'late', 81);
    await expect(tab.flush()).rejects.toThrow();
    expect(ids(deviceCopy())).toEqual(['late']);
    expect(isSyncPending()).toBe(true);
  });

  it('a device-tier page keeps saving after the id changes', async () => {
    localStorage.removeItem(BACKEND_KEY);
    const tab = await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    localStorage.setItem(LOG_OFF_ID_KEY, 'id-after');
    add(tab, 'kept', 81);
    await tab.flush();
    expect(ids(deviceCopy())).toEqual(['kept']);
  });

  it('a page opened before the first log-off mirrors while there is still none', async () => {
    localStorage.removeItem(LOG_OFF_ID_KEY);
    await loadPage();
    const adapter = new FailingCloud(new MemoryCloud());
    const tab = await RecordSession.open(webRecordHost(adapter));
    adapter.failing = true;
    add(tab, 'late', 81);
    await expect(tab.flush()).rejects.toThrow();
    expect(ids(deviceCopy())).toEqual(['late']);
  });

  it('a host built after the log-off, on a page loaded after it, works normally', async () => {
    logOffElsewhere();
    await loadPage();
    const adapter = new FailingCloud(new MemoryCloud());
    const tab = await RecordSession.open(webRecordHost(adapter));
    adapter.failing = true;
    add(tab, 'late', 81);
    tab.flushSync();
    await expect(tab.flush()).rejects.toThrow();
    expect(ids(deviceCopy())).toEqual(['late']);
    expect(isSyncPending()).toBe(true);
  });

  it('an adapter that signed in under the current id mirrors', async () => {
    const adapter = new SignedInCloud(new MemoryCloud(), 'id-before');
    const tab = await RecordSession.open(webRecordHost(adapter));
    tab.flushSync(); // nothing unsaved: no write
    add(tab, 'late', 81);
    tab.flushSync();
    expect(ids(deviceCopy())).toEqual(['late']);
  });
});
