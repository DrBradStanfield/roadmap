/**
 * @vitest-environment jsdom
 *
 * US-10 AC5 — two tabs of one browser share one on-device record.
 *
 * A guest's tabs all read and write `health_roadmap_file_v2`, and each holds
 * its own copy in memory. The tab-close write (`flushSync`, which app.tsx runs
 * on `beforeunload` and on `visibilitychange: hidden`) wrote that copy with no
 * version check and no merge. So a tab that had not seen the other's save
 * erased it, on every tab switch, even with nothing of its own to save. Real
 * WebKit, 2026-09-25: weights [83, 82] at rev 2 became [82] at rev 3.
 *
 * Two stores over jsdom's one localStorage stand in for the two tabs. Fake
 * timers hold the 800 ms persist debounce, so an unsaved edit stays unsaved
 * until a test saves it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConflictError, createEmptyFile, createMeasurement, MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from './roadmap-store';
import { LocalStorageAdapter } from './local-storage-adapter';
import { BT_TIMELINE_DRAFT_KEY, DRAFTS_CLEARED_EVENT, VITALS_DRAFT_KEY } from '../lib/storage';
import { Sentry } from '../lib/sentry';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const FILE_KEY = 'health_roadmap_file_v2';
const REV_KEY = 'health_roadmap_file_v2_rev';
const TODAY = '2026-09-25T00:00:00.000Z';

function stored(): RoadmapFile {
  return JSON.parse(localStorage.getItem(FILE_KEY)!) as RoadmapFile;
}
function rev(): number {
  return Number(localStorage.getItem(REV_KEY));
}
/** Every stored row as "metric value status", sorted. */
function rows(): string[] {
  return stored().measurements.map((m) => `${m.metricType} ${m.value} ${m.status}`).sort();
}

/** The record both tabs open on: one weight, saved a week ago. */
async function seed(): Promise<void> {
  const week = '2026-09-18T00:00:00.000Z';
  const file = createEmptyFile({ deviceId: 'dev_seed', now: week });
  file.measurements.push(createMeasurement({ id: 'w1', metricType: 'weight', value: 82, recordedAt: week, createdAt: week }));
  await new LocalStorageAdapter().write(ROADMAP_FILE_NAME, file, null);
}

/** Tab A and tab B, both opened on the seeded record before either saves. */
async function twoTabs(adapterA = new LocalStorageAdapter()): Promise<[RoadmapStore, RoadmapStore]> {
  await seed();
  return [await RoadmapStore.create(adapterA), await RoadmapStore.create(new LocalStorageAdapter())];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-25T10:00:00.000Z'));
  localStorage.clear();
  vi.mocked(Sentry.captureException).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('US-10 AC5 — a tab-close write never drops another tab\'s save', () => {
  it('a tab with nothing unsaved writes nothing', async () => {
    const [a, b] = await twoTabs();
    b.addMeasurement('weight', 83, TODAY);
    await b.flush();
    const before = rev();

    a.flushSync(); // A hides or closes; it never saved

    expect(rows()).toEqual(['weight 82 active', 'weight 83 active']);
    expect(rev()).toBe(before);
  });

  it('a tab with an unsaved edit writes the merge: both tabs\' rows kept, and the version moves on', async () => {
    const [a, b] = await twoTabs();
    a.addMeasurement('hdl', 1.4, TODAY); // still on the debounce
    b.addMeasurement('weight', 83, TODAY);
    await b.flush();
    const before = rev();

    a.flushSync();

    expect(rows()).toEqual(['hdl 1.4 active', 'weight 82 active', 'weight 83 active']);
    expect(rev()).toBe(before + 1);
  });

  it('two tabs that fill the same slot keep both rows, and one stays active', async () => {
    const [a, b] = await twoTabs();
    b.addMeasurement('weight', 83, TODAY);
    await b.flush();
    vi.setSystemTime(new Date('2026-09-25T10:00:01.000Z')); // A types a second later
    a.addMeasurement('weight', 84, TODAY);

    a.flushSync();

    // The merge's slot rule: the newer row holds the day, the other is kept.
    expect(rows()).toEqual(['weight 82 active', 'weight 83 entered-in-error', 'weight 84 active']);
  });

  it('an erase made in the other tab stands when a tab with nothing unsaved closes', async () => {
    const [a, b] = await twoTabs();
    expect((await b.deleteUserData()).success).toBe(true);

    a.flushSync();

    expect(stored().meta.eraseEpoch).toBe(1);
    expect(stored().measurements).toEqual([]);
  });

  it('an erase made in the other tab stands when a tab with an unsaved edit closes, and the edit goes with it', async () => {
    const [a, b] = await twoTabs();
    expect((await b.deleteUserData()).success).toBe(true);
    a.addMeasurement('hdl', 1.4, TODAY); // typed in A, which has not heard of the erase

    a.flushSync();

    // mergeFiles' epoch gate: the higher eraseEpoch wins WHOLESALE. A's copy,
    // its old weight and its unsaved row alike, goes, just as A's next
    // debounced save would have sent it.
    expect(stored().meta.eraseEpoch).toBe(1);
    expect(stored().measurements).toEqual([]);
  });

  it('never writes over a record a newer app saved, and the refusal is reported', async () => {
    const [a] = await twoTabs();
    a.addMeasurement('hdl', 1.4, TODAY);
    // Another tab, reloaded onto a newer bundle, saved a newer schema.
    const newer = JSON.stringify({ ...stored(), schemaVersion: 9999 });
    localStorage.setItem(FILE_KEY, newer);
    localStorage.setItem(REV_KEY, String(rev() + 1));

    a.flushSync();
    expect(localStorage.getItem(FILE_KEY)).toBe(newer);

    // The refused write fell back to the async save, which refuses too, and says so.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(localStorage.getItem(FILE_KEY)).toBe(newer);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('a save that failed stays unsaved: once there is room, the close writes it', async () => {
    const [a] = await twoTabs();
    let full = true; // the disk is full, say with another tab's documents
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (full && key === FILE_KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    a.addMeasurement('hdl', 1.4, TODAY);
    await vi.advanceTimersByTimeAsync(1_000); // the debounced save fails
    expect(rows()).toEqual(['weight 82 active']);

    full = false; // the other tab frees space
    a.flushSync(); // this tab closes

    expect(rows()).toEqual(['hdl 1.4 active', 'weight 82 active']);
  });

  it('a hide that merges the other tab\'s erase takes it in: the drafts go, the page is told, a later edit survives', async () => {
    const [a, b] = await twoTabs();
    a.addMeasurement('hdl', 1.4, TODAY); // unsaved when B erases
    expect((await b.deleteUserData()).success).toBe(true);
    // A's matrix, still open on the old record, typed on after B's erase.
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, '{"draft":{"date":"2026-09-25","values":{"ldl":"3.2"}}}');
    localStorage.setItem(VITALS_DRAFT_KEY, '{"draft":{"date":"2026-09-25","values":{"weight":"84"}}}');
    const cleared = vi.fn();
    const changed = vi.fn();
    window.addEventListener(DRAFTS_CLEARED_EVENT, cleared);
    window.addEventListener(REMOTE_CHANGED_EVENT, changed);

    a.flushSync(); // A hides

    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(a.loadAllHistory()).toEqual([]);
    // A now works at the erase's epoch, so its next edit is kept.
    a.addMeasurement('ldl', 3.1, TODAY);
    await a.flush();
    expect(rows()).toEqual(['ldl 3.1 active']);
    window.removeEventListener(DRAFTS_CLEARED_EVENT, cleared);
    window.removeEventListener(REMOTE_CHANGED_EVENT, changed);
  });

  it('after that hide, an erase in this tab removes what the other tab saved since', async () => {
    const [a, b] = await twoTabs();
    a.addMeasurement('hdl', 1.4, TODAY);
    expect((await b.deleteUserData()).success).toBe(true);
    a.flushSync(); // A hides, and takes B's erase in
    b.addMeasurement('weight', 83, TODAY); // B starts again
    await b.flush();

    expect((await a.deleteUserData()).success).toBe(true);

    expect(stored().meta.eraseEpoch).toBe(2);
    expect(stored().measurements).toEqual([]);
  });

  it('after a hide the tab shows what the other tab saved, and its next save runs clean and takes in what came after', async () => {
    const adapterA = new LocalStorageAdapter();
    const [a, b] = await twoTabs(adapterA);
    b.addMeasurement('weight', 83, TODAY);
    await b.flush();
    const heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);
    a.addMeasurement('hdl', 1.4, TODAY);

    a.flushSync(); // A is hidden; the page lives on

    // The hide took B's row in, and told the page.
    expect(a.loadAllHistory().map((m) => m.value).sort((x, y) => x - y)).toEqual([1.4, 82, 83]);
    expect(heard).toHaveBeenCalledTimes(1);

    // jsdom has one window for both tabs: B's own save announces A's row there.
    window.removeEventListener(REMOTE_CHANGED_EVENT, heard);
    b.addMeasurement('ldl', 3.1, TODAY); // B saves again after A's hide
    await b.flush();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);
    const write = vi.spyOn(adapterA, 'write');
    a.addMeasurement('waist', 90, TODAY);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(write).toHaveBeenCalledTimes(1); // no conflict retry
    expect(rows()).toEqual(['hdl 1.4 active', 'ldl 3.1 active', 'waist 90 active', 'weight 82 active', 'weight 83 active']);
    expect(a.loadAllHistory().map((m) => m.value).sort((x, y) => x - y)).toEqual([1.4, 3.1, 82, 83, 90]);
    expect(heard).toHaveBeenCalledTimes(2);
    window.removeEventListener(REMOTE_CHANGED_EVENT, heard);
  });

  it('a second hide with nothing new writes nothing', async () => {
    const [a] = await twoTabs();
    a.addMeasurement('hdl', 1.4, TODAY);
    a.flushSync();
    const after = rev();

    a.flushSync();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(rev()).toBe(after);
  });

  it('a device that refuses every write reports each kind of refusal once per page load, not on every hide', async () => {
    const [a] = await twoTabs();
    a.addMeasurement('hdl', 1.4, TODAY);
    let full = true;
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (full && key === FILE_KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      setItem.call(this, key, value);
    });

    a.flushSync();
    await vi.advanceTimersByTimeAsync(0);
    a.flushSync();
    await vi.advanceTimersByTimeAsync(0);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual(['weight 82 active']);

    // A new kind of refusal is still reported: another tab's newer app wrote.
    full = false;
    localStorage.setItem(FILE_KEY, JSON.stringify({ ...stored(), schemaVersion: 9999 }));
    a.flushSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });

  it('a conflict with another tab is retried on every hide, though an earlier one was too', async () => {
    const adapterA = new LocalStorageAdapter();
    const [a] = await twoTabs(adapterA);
    // Another tab saves between this tab's read and its write, once per hide
    // (read() runs through readSync too, so the retry's own read is spared).
    const readSync = adapterA.readSync.bind(adapterA);
    let theirs = 0;
    let armed = false;
    vi.spyOn(adapterA, 'readSync').mockImplementation((fileName) => {
      const read = readSync(fileName);
      if (!armed) return read;
      armed = false;
      theirs += 1;
      const file = structuredClone(read.body) as RoadmapFile;
      file.measurements.push(createMeasurement({ id: `theirs-${theirs}`, metricType: 'weight', value: 90 + theirs, recordedAt: `2026-09-0${theirs}T00:00:00.000Z`, createdAt: '2026-09-18T00:00:00.000Z' }));
      new LocalStorageAdapter().writeSync(fileName, file, read.version);
      return read;
    });

    a.addMeasurement('hdl', 1.4, TODAY);
    armed = true;
    a.flushSync(); // refused: the version moved; the async save retries and lands
    await vi.advanceTimersByTimeAsync(0);
    a.addMeasurement('ldl', 3.1, TODAY);
    armed = true;
    a.flushSync(); // refused again
    await vi.advanceTimersByTimeAsync(0);

    expect(rows()).toEqual(['hdl 1.4 active', 'ldl 3.1 active', 'weight 82 active', 'weight 91 active', 'weight 92 active']);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});


/** A provider whose every read takes 300 ms, so a save and an erase overlap. */
class SlowAdapter extends MemoryAdapter {
  async read(...args: Parameters<MemoryAdapter['read']>) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return super.read(...args);
  }
}

/** A slow cloud holding one weight, and a page open on it with 83 kg typed. */
async function slowCloudWithEdit(): Promise<{ cloud: MemoryCloud; adapter: SlowAdapter; store: RoadmapStore }> {
  const cloud = new MemoryCloud();
  const seeded = await RoadmapStore.create(new MemoryAdapter(cloud));
  seeded.addMeasurement('weight', 82, '2026-09-18T00:00:00.000Z');
  await seeded.flush();
  const adapter = new SlowAdapter(cloud);
  const opening = RoadmapStore.create(adapter);
  await vi.advanceTimersByTimeAsync(400);
  const store = await opening;
  store.addMeasurement('weight', 83, TODAY); // on the 800 ms debounce
  return { cloud, adapter, store };
}

/** Erase, and note what the cloud holds at the moment success is reported. */
async function eraseAndLook(cloud: MemoryCloud, store: RoadmapStore): Promise<RoadmapFile | null> {
  let atSuccess: RoadmapFile | null = null;
  const erase = store.deleteUserData().then((result) => {
    if (result.success) atSuccess = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await erase;
  return atSuccess;
}

describe('US-11 AC7 — an erase beats what it has not seen, and says so only once written', () => {
  it('a tab that never hid still erases over the other tab\'s erase and fresh start', async () => {
    const [a, b] = await twoTabs();
    expect((await b.deleteUserData()).success).toBe(true);
    b.addMeasurement('weight', 83, TODAY); // B starts again
    await b.flush();

    // A still holds the record from before B's erase, at the old epoch.
    expect((await a.deleteUserData()).success).toBe(true);

    expect(stored().meta.eraseEpoch).toBe(2);
    expect(stored().measurements).toEqual([]);
  });

  it('so does a device that never heard of the other device\'s erase and fresh start', async () => {
    const cloud = new MemoryCloud();
    const phone = await RoadmapStore.create(new MemoryAdapter(cloud));
    phone.addMeasurement('weight', 82, '2026-09-18T00:00:00.000Z');
    await phone.flush();
    const laptop = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect((await phone.deleteUserData()).success).toBe(true);
    phone.addMeasurement('weight', 83, TODAY); // the phone starts again
    await phone.flush();

    expect((await laptop.deleteUserData()).success).toBe(true);

    const file = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
    expect(file.meta.eraseEpoch).toBe(2);
    expect(file.measurements).toEqual([]);
  });

  it('reports success only once the erase is written, though a save was running when it began', async () => {
    const { cloud, store } = await slowCloudWithEdit();
    await vi.advanceTimersByTimeAsync(900); // the debounced save has started, and is still reading

    const atSuccess = await eraseAndLook(cloud, store);

    expect(atSuccess?.meta.eraseEpoch).toBe(1);
    expect(atSuccess?.measurements).toEqual([]);
  });

  it('never saves the change it is about to throw away', async () => {
    const { cloud, adapter, store } = await slowCloudWithEdit();
    const write = vi.spyOn(adapter, 'write');
    await vi.advanceTimersByTimeAsync(700); // the erase begins 100 ms before the debounce fires

    const atSuccess = await eraseAndLook(cloud, store);

    expect(atSuccess?.meta.eraseEpoch).toBe(1);
    expect(atSuccess?.measurements).toEqual([]);
    const written = write.mock.calls.map(([, body]) => body as RoadmapFile);
    expect(written.some((file) => file.measurements.some((m) => m.value === 83))).toBe(false);
  });

  it('a flush made by a listener to a save that just ended starts a new save', async () => {
    const [a, b] = await twoTabs();
    b.addMeasurement('weight', 83, TODAY);
    await b.flush();
    let flushed: Promise<void> | null = null;
    const listener = () => {
      window.removeEventListener(REMOTE_CHANGED_EVENT, listener);
      a.addMeasurement('ldl', 3.1, TODAY);
      flushed = a.flush();
    };
    window.addEventListener(REMOTE_CHANGED_EVENT, listener);
    a.addMeasurement('hdl', 1.4, TODAY);

    await a.flush(); // folds B's row in, and announces it
    await flushed;

    expect(rows()).toContain('ldl 3.1 active');
  });

  it('an erase that failed to save is written by the next hide', async () => {
    const [a] = await twoTabs();
    let full = true;
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (full && key === FILE_KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    expect((await a.deleteUserData()).success).toBe(false);
    expect(rows()).toEqual(['weight 82 active']);

    full = false;
    a.flushSync(); // the tab hides

    expect(stored().meta.eraseEpoch).toBe(1);
    expect(stored().measurements).toEqual([]);
  });
});

/**
 * What the browser does in every OTHER tab of this origin when one tab
 * changes a key. jsdom has one window for both stores, and fires no storage
 * event at the window that made the change, so the test fires it for tab A.
 * `key` null is a clear().
 */
function storageEvent(key: string | null = FILE_KEY, newValue: string | null = localStorage.getItem(FILE_KEY)): void {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
}

/** Each listening tab's stop, run after its test, passed or failed. */
let stops: Array<() => void> = [];

/** Tab A on screen and listening, as `initRoadmapStore` starts it. */
async function listeningTabs(): Promise<{ a: RoadmapStore; b: RoadmapStore; adapterA: LocalStorageAdapter }> {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const adapterA = new LocalStorageAdapter();
  const [a, b] = await twoTabs(adapterA);
  stops.push(a.startLiveRefresh());
  return { a, b, adapterA };
}

const values = (store: RoadmapStore) => store.loadAllHistory().map((m) => m.value).sort((x, y) => x - y);

/** The tab hidden, or shown again, as the browser reports it. */
function setVisibility(state: 'hidden' | 'visible'): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Another tab saves a row, and the browser tells tab A. */
async function otherTabSaves(b: RoadmapStore, metric: string, value: number): Promise<void> {
  b.addMeasurement(metric, value, TODAY);
  await b.flush();
  storageEvent();
}

describe('US-34 AC6 — another tab\'s save reaches this tab as it lands', () => {
  let heard: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);
  });
  afterEach(() => {
    window.removeEventListener(REMOTE_CHANGED_EVENT, heard);
    for (const stop of stops) stop();
    stops = [];
  });

  it('takes in a row the other tab saved: the page hears it once, and this tab saves nothing', async () => {
    const { a, b, adapterA } = await listeningTabs();
    const write = vi.spyOn(adapterA, 'write');
    const writeSync = vi.spyOn(adapterA, 'writeSync');

    await otherTabSaves(b, 'weight', 83);
    await vi.advanceTimersByTimeAsync(0);

    expect(values(a)).toEqual([82, 83]);
    expect(a.loadLatestMeasurements().previousMeasurements.map((m) => m.value)).toEqual([83]);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(writeSync).not.toHaveBeenCalled();
    // Nothing is left unsaved by the take-in: a hide writes nothing.
    const before = rev();
    a.flushSync();
    expect(rev()).toBe(before);
  });

  it('hears only this record\'s key: its version key, another file and a draft cost no read', async () => {
    const { adapterA } = await listeningTabs();
    const read = vi.spyOn(adapterA, 'read');

    storageEvent(REV_KEY);
    storageEvent('health_roadmap_file_v2:chat-history.json');
    storageEvent(BT_TIMELINE_DRAFT_KEY);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(read).not.toHaveBeenCalled();
  });

  it('a storm of saves in the other tab costs two re-reads, not one each, and loses none of them', async () => {
    const { a, b, adapterA } = await listeningTabs();
    const read = vi.spyOn(adapterA, 'read');

    // A lab import, say: ten saves, one every 100 ms.
    for (let day = 1; day <= 10; day++) {
      b.addMeasurement('ldl', 3 + day / 10, `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`);
      await b.flush();
      storageEvent();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(read).toHaveBeenCalledTimes(1); // the first, at once
    await vi.advanceTimersByTimeAsync(5_000);

    expect(read).toHaveBeenCalledTimes(2); // the rest, once the window is out
    expect(a.loadAllHistory().filter((m) => m.metricType === 'ldl')).toHaveLength(10);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('a hidden tab reads nothing, takes the other tab\'s save in when shown, and hears the next', async () => {
    const { a, b, adapterA } = await listeningTabs();
    const read = vi.spyOn(adapterA, 'read');
    setVisibility('hidden');

    await otherTabSaves(b, 'weight', 83);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).not.toHaveBeenCalled();
    expect(values(a)).toEqual([82]);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(values(a)).toEqual([82, 83]);

    await vi.advanceTimersByTimeAsync(6_000);
    await otherTabSaves(b, 'hdl', 1.4);
    await vi.advanceTimersByTimeAsync(0);
    expect(values(a)).toEqual([1.4, 82, 83]);
  });

  // Codex review of this AC, round 2: a re-read the throttle had queued ran
  // after the tab hid. That read moved the throttle on, so the re-read on
  // return was dropped, and a save made while hidden stayed unseen.
  it('a re-read queued before the tab hid never runs hidden, and the return still catches up', async () => {
    const { a, b, adapterA } = await listeningTabs();
    const read = vi.spyOn(adapterA, 'read');
    await otherTabSaves(b, 'weight', 83); // read at once
    await vi.advanceTimersByTimeAsync(1_000);
    await otherTabSaves(b, 'hdl', 1.4); // queued for the end of the window
    await vi.advanceTimersByTimeAsync(1_000);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(read).toHaveBeenCalledTimes(1);
    await otherTabSaves(b, 'ldl', 3.1); // unheard: the tab is hidden
    await vi.advanceTimersByTimeAsync(1_000);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(values(a)).toEqual([1.4, 3.1, 82, 83]);
  });

  it('a tab shown again inside the throttle\'s window catches up when the window runs out', async () => {
    const { a, b } = await listeningTabs();
    await otherTabSaves(b, 'weight', 83); // read at once
    await vi.advanceTimersByTimeAsync(1_000);
    setVisibility('hidden');
    await otherTabSaves(b, 'hdl', 1.4); // unheard
    await vi.advanceTimersByTimeAsync(1_000);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(values(a)).toEqual([82, 83]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(values(a)).toEqual([1.4, 82, 83]);
  });

  it('a return reads once, though visibilitychange and focus both fire, in either order', async () => {
    const { b, adapterA } = await listeningTabs();
    const read = vi.spyOn(adapterA, 'read');
    setVisibility('hidden');
    await otherTabSaves(b, 'weight', 83);
    await vi.advanceTimersByTimeAsync(10_000);
    setVisibility('visible');
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await otherTabSaves(b, 'hdl', 1.4);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('an edit waiting to be saved here is never merged over: its save takes the row in, and says so once', async () => {
    const { a, b, adapterA } = await listeningTabs();
    a.addMeasurement('hdl', 1.4, TODAY); // on the 800 ms debounce
    const read = vi.spyOn(adapterA, 'read');

    await otherTabSaves(b, 'weight', 83);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000); // the debounced save
    expect(values(a)).toEqual([1.4, 82, 83]);
    expect(rows()).toEqual(['hdl 1.4 active', 'weight 82 active', 'weight 83 active']);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('the other tab\'s profile edit shows here before this tab saves, and this tab\'s next edit keeps it (US-10 AC5\'s commonest loss)', async () => {
    const { a, b } = await listeningTabs();
    b.saveChangedMeasurements({ sex: 'male', heightCm: 180 }, {});
    await b.flush();
    storageEvent();
    await vi.advanceTimersByTimeAsync(0);

    // Taken in by the re-read alone: the page is told, and shows B's height,
    // with no save in A to have merged it.
    expect(heard).toHaveBeenCalledTimes(1);
    expect(a.getPrefillInputs()).toMatchObject({ sex: 'male', heightCm: 180 });

    // A second later, the user sets a birth year in tab A.
    vi.setSystemTime(new Date('2026-09-25T10:00:01.000Z'));
    a.saveChangedMeasurements({ birthYear: 1970 }, {});
    await a.flush();

    expect(stored().profile).toMatchObject({ sex: 'male', heightCm: 180, birthYear: 1970 });
  });

  it('a lone tab re-reads nothing when shown or focused, however often', async () => {
    const { adapterA } = await listeningTabs();
    const read = vi.spyOn(adapterA, 'read');
    for (let round = 0; round < 3; round++) {
      window.dispatchEvent(new Event('focus'));
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(10_000);
      setVisibility('visible');
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(read).not.toHaveBeenCalled();
  });

  // Adversarial review, 2026-09-25: the return re-read only if a `storage`
  // event was heard while hidden. A page restored from the back-forward cache,
  // or an iOS tab the system suspended, can miss the event and showed a stale
  // record until its next write. The return now compares the stored revision
  // with the last one this tab read or wrote: one getItem.
  it('a re-read held back at hide runs on the return, with nothing heard while hidden', async () => {
    const { a, b, adapterA } = await listeningTabs();
    await otherTabSaves(b, 'weight', 83); // read at once
    await vi.advanceTimersByTimeAsync(1_000);
    await otherTabSaves(b, 'hdl', 1.4); // held for the end of the window
    await vi.advanceTimersByTimeAsync(1_000);
    const read = vi.spyOn(adapterA, 'read');

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).not.toHaveBeenCalled();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(values(a)).toEqual([1.4, 82, 83]);
  });

  it('a save the tab never heard of (a page back from the back-forward cache) is read on the return', async () => {
    const { a, b } = await listeningTabs();
    setVisibility('hidden');
    b.addMeasurement('weight', 83, TODAY);
    await b.flush(); // no storage event reaches tab A
    await vi.advanceTimersByTimeAsync(10_000);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(values(a)).toEqual([82, 83]);
  });

  it('a return with the revision where this tab left it reads nothing, this tab\'s own save and a heard one included', async () => {
    const { a, b, adapterA } = await listeningTabs();
    await otherTabSaves(b, 'weight', 83); // heard and read
    a.addMeasurement('hdl', 1.4, TODAY);
    await a.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    const read = vi.spyOn(adapterA, 'read');

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    setVisibility('visible');
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).not.toHaveBeenCalled();
    expect(values(a)).toEqual([1.4, 82, 83]);
  });

  it('a tab opened hidden still hears a save made before it is first shown', async () => {
    await seed();
    const a = await RoadmapStore.create(new LocalStorageAdapter());
    const b = await RoadmapStore.create(new LocalStorageAdapter());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    stops.push(a.startLiveRefresh());
    await otherTabSaves(b, 'weight', 83);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(values(a)).toEqual([82]);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(values(a)).toEqual([82, 83]);
  });

  it('takes the other tab\'s erase in: the drafts go, the page hears it once, and a later edit is kept', async () => {
    const { a, b, adapterA } = await listeningTabs();
    expect((await b.deleteUserData()).success).toBe(true);
    // A's matrices still hold drafts typed on the old record. One localStorage
    // and one window serve both tabs here, so B's erase already cleared them:
    // they are put back, and the listeners attached, after it.
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, '{"draft":{"date":"2026-09-25","values":{"ldl":"3.2"}}}');
    localStorage.setItem(VITALS_DRAFT_KEY, '{"draft":{"date":"2026-09-25","values":{"weight":"84"}}}');
    const cleared = vi.fn();
    window.addEventListener(DRAFTS_CLEARED_EVENT, cleared);
    heard.mockClear();
    const write = vi.spyOn(adapterA, 'write');

    storageEvent();
    await vi.advanceTimersByTimeAsync(0);

    expect(a.loadAllHistory()).toEqual([]);
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    // A now works at the erase's epoch, so its next edit is kept.
    a.addMeasurement('ldl', 3.1, TODAY);
    await a.flush();
    expect(stored().meta.eraseEpoch).toBe(1);
    expect(rows()).toEqual(['ldl 3.1 active']);
    window.removeEventListener(DRAFTS_CLEARED_EVENT, cleared);
  });

  it('another tab removing the record (a log-off) brings nothing in, writes nothing back, and leaves this tab as it was', async () => {
    const { a, adapterA } = await listeningTabs();
    const read = vi.spyOn(adapterA, 'read');
    const write = vi.spyOn(adapterA, 'write');

    await new LocalStorageAdapter().disconnect(); // the other tab logs this device off
    storageEvent(FILE_KEY, null);
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toHaveBeenCalledTimes(1);
    expect(values(a)).toEqual([82]);
    expect(localStorage.getItem(FILE_KEY)).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();

    // A clear() names no key, and is heard the same way.
    await vi.advanceTimersByTimeAsync(6_000);
    localStorage.clear();
    storageEvent(null, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(values(a)).toEqual([82]);
    expect(localStorage.getItem(FILE_KEY)).toBeNull();
  });

  // Codex review of this AC, R1: the empty record migrate makes for a missing
  // file stamps its profile and screenings now, and last write wins on
  // lamport, then time. Merged in, it beat a profile whose lamport is 0 or
  // absent, and emptied it here.
  it('a removal keeps a profile and screenings that carry no clock: a missing record is never merged in as an empty one', async () => {
    // Written by a direct file edit or an older app: data, no lamport, a week old.
    const week = '2026-09-18T00:00:00.000Z';
    const file = createEmptyFile({ deviceId: 'dev_seed', now: week });
    file.profile = { sex: 'male', heightCm: 178, updatedAt: week };
    file.screenings = { colorectalMethod: 'colonoscopy_10yr', updatedAt: week, lamport: 0 };
    await new LocalStorageAdapter().write(ROADMAP_FILE_NAME, file, null);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const a = await RoadmapStore.create(new LocalStorageAdapter());
    stops.push(a.startLiveRefresh());

    await new LocalStorageAdapter().disconnect(); // the other tab logs off
    storageEvent(FILE_KEY, null);
    await vi.advanceTimersByTimeAsync(0);

    expect(a.getPrefillInputs()).toMatchObject({ sex: 'male', heightCm: 178 });
    expect(a.loadLatestMeasurements().screenings.map((s) => s.value)).toEqual(['colonoscopy_10yr']);
    expect(heard).not.toHaveBeenCalled();
  });

  it('an edit this tab could not save survives the removal, and the next hide writes it', async () => {
    const { a } = await listeningTabs();
    let full = true;
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (full && key === FILE_KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    a.addMeasurement('hdl', 1.4, TODAY);
    await vi.advanceTimersByTimeAsync(1_000); // the debounced save fails
    full = false;

    await new LocalStorageAdapter().disconnect(); // the other tab logs off
    storageEvent(FILE_KEY, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(values(a)).toEqual([1.4, 82]);
    expect(localStorage.getItem(FILE_KEY)).toBeNull();

    // The hide writes this tab's copy, the edit with it: the device file is
    // made again (the residual US-10 AC5 names), and nothing is lost.
    a.flushSync();
    expect(rows()).toEqual(['hdl 1.4 active', 'weight 82 active']);
  });
});

describe('LocalStorageAdapter — the synchronous write keeps write()\'s version check (US-10 AC4, AC5)', () => {
  it('refuses a version another tab moved, and leaves that tab\'s bytes alone', () => {
    const adapter = new LocalStorageAdapter();
    adapter.writeSync(ROADMAP_FILE_NAME, { schemaVersion: 1 }, null);
    const { version } = adapter.readSync(ROADMAP_FILE_NAME);
    new LocalStorageAdapter().writeSync(ROADMAP_FILE_NAME, { schemaVersion: 1, tab: 'B' }, version);

    expect(() => adapter.writeSync(ROADMAP_FILE_NAME, { schemaVersion: 1, tab: 'A' }, version)).toThrow(ConflictError);
    expect(adapter.readSync(ROADMAP_FILE_NAME).body).toEqual({ schemaVersion: 1, tab: 'B' });
  });
});

describe('LocalStorageAdapter.watch — another tab\'s write, heard through the storage event (US-34 AC6)', () => {
  it('calls for this file\'s key and for a clear(), for nothing else, and stops on abort', () => {
    const changed = vi.fn();
    const watching = new AbortController();
    new LocalStorageAdapter().watch(ROADMAP_FILE_NAME, changed, watching.signal);

    storageEvent(FILE_KEY);
    storageEvent(null);
    storageEvent(REV_KEY);
    storageEvent('health_roadmap_file_v2:chat-history.json');
    storageEvent(VITALS_DRAFT_KEY);
    expect(changed).toHaveBeenCalledTimes(2);

    watching.abort();
    storageEvent(FILE_KEY);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
