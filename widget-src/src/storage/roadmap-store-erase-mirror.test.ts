// @vitest-environment jsdom
/**
 * Lead S57 on the web (US-11 AC3b, AC7; US-16 AC2a): "Delete all my data" on a
 * cloud page whose cloud refuses the write AND whose device copy cannot be written
 * (private browsing, a full or blocked localStorage). The erase lived only in
 * memory, so a reload brought every value back while the page showed an empty
 * record. Now the store puts its copy back and answers `{ success: false }`
 * with no reason, so useErase says ERASE_FAILED and keeps the record on screen
 * (useErase.test.tsx F2). A failed erase no longer leaves the record half-erased.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { BT_TIMELINE_DRAFT_KEY } from '../lib/storage';
import {
  addMeasurement, currentSaveStatus, deleteUserData, flushRoadmapStore, getEraseIdentity, getReminderOptIn, initRoadmapStore, setPreEraseHook, setReminderOptIn,
} from '../lib/roadmap-data';
import { cancelRemindersForErase } from '../../standalone/reminders';
import { LocalStorageAdapter } from './local-storage-adapter';
import { RoadmapStore } from './roadmap-store';
import { BACKEND_KEY, PENDING_MIRROR_KEY } from './web-record-host';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));

/** A cloud whose writes can be made to fail, refused. */
class FailingCloud extends MemoryAdapter {
  failWrites = false;
  async write(...args: Parameters<MemoryAdapter['write']>) {
    // A definite refusal (a revoked grant): nothing was stored (write-refusal.ts).
    if (this.failWrites) throw new StorageError('Dropbox write failed (403)', undefined, undefined, 403);
    return super.write(...args);
  }
}

const DEVICE_KEY = 'health_roadmap_file_v2';
const cloudFile = (cloud: MemoryAdapter) => JSON.parse(cloud.cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
const deviceFile = () => JSON.parse(localStorage.getItem(DEVICE_KEY)!) as RoadmapFile;
const fileOf = (store: RoadmapStore) => (store as unknown as { file: RoadmapFile }).file;
const days = (file: RoadmapFile) => file.measurements.map((m) => m.recordedAt.slice(0, 10)).sort();

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(BACKEND_KEY, 'memory');
});
afterEach(() => vi.restoreAllMocks());

describe('Delete all my data when neither the cloud nor this browser takes it (lead S57)', () => {
  it('keeps the record as it was in memory, in the cloud and in this browser, and the next good save erases nothing', async () => {
    const cloud = new FailingCloud();
    const store = await RoadmapStore.create(cloud);
    store.addMeasurement('weight', 82, '2026-09-01');
    store.setReminderOptIn({ status: 'active', token: 'test-token-good', email: 'a@example.com', provider: 'dropbox' });
    await store.flush();
    // An edit the cloud has not taken: its failed save is held in this browser.
    cloud.failWrites = true;
    store.addMeasurement('weight', 81, '2026-09-02');
    await expect(store.flush()).rejects.toThrow();
    expect(days(deviceFile())).toEqual(['2026-09-01', '2026-09-02']);
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, '{"draft":"typed"}');

    const before = store.eraseIdentity;
    const deviceBefore = localStorage.getItem(DEVICE_KEY);
    const teardown = vi.fn(async () => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const result = await store.deleteAllData({ teardown });
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(result).toEqual({ success: false, chatErased: true });
    expect(teardown).toHaveBeenCalledTimes(1); // the irreversible step ran before the write; see the PR's list
    // In memory: the same record at the same erase, its opt-in still active.
    expect(store.eraseIdentity).toBe(before);
    expect(days(fileOf(store))).toEqual(['2026-09-01', '2026-09-02']);
    expect(store.getReminderOptIn()?.status).toBe('active');
    // In this browser: the record, the marker and the draft untouched; in the cloud: as before.
    expect(localStorage.getItem(DEVICE_KEY)).toBe(deviceBefore);
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBe('{"draft":"typed"}');
    expect(days(cloudFile(cloud))).toEqual(['2026-09-01']);

    // The next good save: both copies hold the record as before plus the unsynced edit, nothing erased.
    cloud.failWrites = false;
    await store.flush();
    for (const copy of [cloudFile(cloud), deviceFile()]) {
      expect(days(copy)).toEqual(['2026-09-01', '2026-09-02']);
      expect(copy.meta.eraseEpoch ?? 0).toBe(0);
    }
  });
});

describe('S69, US-11 AC4c: on "This device", an erase the browser refused cancels no reminders', () => {
  /** The device record's revision key, beside DEVICE_KEY (local-storage-adapter.ts). */
  const REV_KEY = DEVICE_KEY + '_rev';

  async function deviceWithOptIn() {
    localStorage.removeItem(BACKEND_KEY);
    await initRoadmapStore(new LocalStorageAdapter());
    setPreEraseHook(cancelRemindersForErase); // as standalone/app.tsx registers it
    expect(setReminderOptIn({ status: 'active', token: 'test-token-good', email: 'synthetic-person@example.com', provider: 'dropbox' })).toBe(true);
    await flushRoadmapStore();
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(String(JSON.parse(String(init?.body)).op));
      return new Response('{}', { status: 200 });
    }));
    return posts;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('the record write is full: the copy is put back, reminders stay on, and no cancel is sent', async () => {
    const posts = await deviceWithOptIn();
    const before = getEraseIdentity();
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === DEVICE_KEY) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    const result = await deleteUserData();
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(result.success).toBe(false);
    expect(getEraseIdentity()).toBe(before);
    expect(getReminderOptIn()?.status).toBe('active');
    expect(posts).not.toContain('cancel');
  });

  it('control: the revision write is full and the old record cannot go back, so the erase may have stored: the cancel is sent', async () => {
    const posts = await deviceWithOptIn();
    const before = getEraseIdentity();
    const setItem = Storage.prototype.setItem;
    let recordWrites = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === REV_KEY) throw new DOMException('full', 'QuotaExceededError');
      if (key === DEVICE_KEY && ++recordWrites > 1) throw new DOMException('full', 'QuotaExceededError'); // the put-back of the old record
      setItem.call(this, key, value);
    });
    const result = await deleteUserData();
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(result.success).toBe(false);
    expect(getEraseIdentity()).not.toBe(before);
    expect(posts).toContain('cancel');
  });
});

describe('S69 R2, US-11 AC4c: a cloud erase is kept, and the cancel sent, only when the device copy carries it', () => {
  const REV_KEY = DEVICE_KEY + '_rev';

  async function cloudWithOptIn() {
    const cloud = new FailingCloud();
    await initRoadmapStore(cloud);
    setPreEraseHook(cancelRemindersForErase); // as standalone/app.tsx registers it
    expect(setReminderOptIn({ status: 'active', token: 'test-token-good', email: 'synthetic-person@example.com', provider: 'dropbox' })).toBe(true);
    await flushRoadmapStore();
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(String(JSON.parse(String(init?.body)).op));
      return new Response('{}', { status: 200 });
    }));
    cloud.failWrites = true; // the cloud refuses outright (403)
    // A failed save first, so the device copy exists: its old record is the one a put-back restores.
    await addMeasurement('weight', 81, '2026-09-02');
    await expect(flushRoadmapStore()).rejects.toThrow();
    expect(deviceFile().meta.eraseEpoch ?? 0).toBe(0);
    return posts;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('the mirror stored the erased record, its revision did not fit and the old record could not go back: not put back, cancel sent', async () => {
    const posts = await cloudWithOptIn();
    const before = getEraseIdentity();
    const setItem = Storage.prototype.setItem;
    let recordWrites = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === REV_KEY) throw new DOMException('full', 'QuotaExceededError');
      if (key === DEVICE_KEY && ++recordWrites % 2 === 0) throw new DOMException('full', 'QuotaExceededError'); // each put-back of the old record
      setItem.call(this, key, value);
    });
    const result = await deleteUserData();
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(deviceFile().meta.eraseEpoch).toBe(1); // the erased copy is on the device, to be lifted next session
    expect(result.success).toBe(false);
    expect(getEraseIdentity()).not.toBe(before);
    expect(posts).toContain('cancel');
  });

  it('the same, when an earlier failed write had already left the device copy with no revision: still not put back, cancel sent', async () => {
    const posts = await cloudWithOptIn();
    localStorage.removeItem(REV_KEY); // what an earlier write that could not put its old record back leaves (US-34 AC6a)
    const before = getEraseIdentity();
    const setItem = Storage.prototype.setItem;
    let recordWrites = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === REV_KEY) throw new DOMException('full', 'QuotaExceededError');
      if (key === DEVICE_KEY && ++recordWrites % 2 === 0) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    const result = await deleteUserData();
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(deviceFile().meta.eraseEpoch).toBe(1);
    expect(localStorage.getItem(REV_KEY)).toBeNull(); // the revision reads as before, '0'
    expect(result.success).toBe(false);
    expect(getEraseIdentity()).not.toBe(before);
    expect(posts).toContain('cancel');
  });

  it('the first mirror attempt stored the erased record and the retry stored nothing: held, cancel sent', async () => {
    const posts = await cloudWithOptIn();
    const before = getEraseIdentity();
    const setItem = Storage.prototype.setItem;
    let recordWrites = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === REV_KEY) throw new DOMException('full', 'QuotaExceededError');
      // The first attempt's record lands; its put-back of the old record, and every write of the retry, do not fit.
      if (key === DEVICE_KEY && ++recordWrites > 1) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    const result = await deleteUserData();
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(recordWrites).toBeGreaterThan(2); // the retry ran
    expect(deviceFile().meta.eraseEpoch).toBe(1);
    expect(result.success).toBe(false);
    expect(getEraseIdentity()).not.toBe(before);
    expect(posts).toContain('cancel');
  });

  it('a device copy whose erase epoch is not a number reads as a load reads it, so a write that stored nothing is put back', async () => {
    const posts = await cloudWithOptIn();
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...deviceFile(), meta: { ...deviceFile().meta, eraseEpoch: '5' } }));
    const before = getEraseIdentity();
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === DEVICE_KEY) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    const result = await deleteUserData();
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(result.success).toBe(false);
    expect(getEraseIdentity()).toBe(before);
    expect(posts).not.toContain('cancel');
  });

  it('US-09 AC30: outside an erase, another tab moving the revision while this save stored nothing never says the changes are on this device', async () => {
    await cloudWithOptIn();
    await addMeasurement('weight', 80, '2026-09-03');
    const setItem = Storage.prototype.setItem;
    let otherTabWrote = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === DEVICE_KEY) {
        if (!otherTabWrote) { otherTabWrote = true; setItem.call(this, REV_KEY, '98-othertab'); }
        throw new DOMException('full', 'QuotaExceededError');
      }
      setItem.call(this, key, value);
    });
    await expect(flushRoadmapStore()).rejects.toThrow();
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(days(deviceFile())).not.toContain('2026-09-03');
    expect(currentSaveStatus()).toBe('not-saved');
  });

  it('another tab wrote the device copy meanwhile (not an erase) and this write stored nothing: put back, no cancel', async () => {
    const posts = await cloudWithOptIn();
    const before = getEraseIdentity();
    const setItem = Storage.prototype.setItem;
    let otherTabWrote = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === DEVICE_KEY) {
        // Another tab's save lands first (a new revision); then this tab's record write does not fit.
        if (!otherTabWrote) { otherTabWrote = true; setItem.call(this, REV_KEY, '99-othertab'); }
        throw new DOMException('full', 'QuotaExceededError');
      }
      setItem.call(this, key, value);
    });
    const result = await deleteUserData();
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(deviceFile().meta.eraseEpoch ?? 0).toBe(0); // nothing of this erase stored
    expect(result.success).toBe(false);
    // The device copy does not carry the erase, so the erase did not happen: the record and the reminders stay.
    expect(getEraseIdentity()).toBe(before);
    expect(getReminderOptIn()?.status).toBe('active');
    expect(posts).not.toContain('cancel');
  });

  it('the device copy already had no revision and the full record write stored nothing: put back, no cancel', async () => {
    const posts = await cloudWithOptIn();
    localStorage.removeItem(REV_KEY); // the revision reads '0' before the write as after it
    const before = getEraseIdentity();
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === DEVICE_KEY) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    const result = await deleteUserData();
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(deviceFile().meta.eraseEpoch ?? 0).toBe(0);
    expect(result.success).toBe(false);
    expect(getEraseIdentity()).toBe(before);
    expect(getReminderOptIn()?.status).toBe('active');
    expect(posts).not.toContain('cancel');
  });

  it('another tab wrote a later erase to the device copy and this write stored nothing: held, cancel sent', async () => {
    const posts = await cloudWithOptIn();
    const before = getEraseIdentity();
    const later = { ...deviceFile(), measurements: [], meta: { ...deviceFile().meta, eraseEpoch: 2 } };
    const setItem = Storage.prototype.setItem;
    let otherTabWrote = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === DEVICE_KEY) {
        if (!otherTabWrote) { otherTabWrote = true; setItem.call(this, DEVICE_KEY, JSON.stringify(later)); setItem.call(this, REV_KEY, '99-othertab'); }
        throw new DOMException('full', 'QuotaExceededError');
      }
      setItem.call(this, key, value);
    });
    const result = await deleteUserData();
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(deviceFile().meta.eraseEpoch).toBe(2); // an erase this one's covers sits on the device
    expect(result.success).toBe(false);
    expect(getEraseIdentity()).not.toBe(before);
    expect(posts).toContain('cancel');
  });
});
