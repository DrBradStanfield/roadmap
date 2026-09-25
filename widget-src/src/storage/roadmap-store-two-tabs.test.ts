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

  it('after a hide, the tab\'s next save runs clean and still takes the other tab in', async () => {
    const adapterA = new LocalStorageAdapter();
    const [a, b] = await twoTabs(adapterA);
    a.addMeasurement('hdl', 1.4, TODAY);
    a.flushSync(); // A is hidden; the page lives on
    b.addMeasurement('weight', 83, TODAY);
    await b.flush();
    const write = vi.spyOn(adapterA, 'write');
    const heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);

    a.addMeasurement('ldl', 3.1, TODAY);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(write).toHaveBeenCalledTimes(1); // no conflict retry
    expect(rows()).toEqual(['hdl 1.4 active', 'ldl 3.1 active', 'weight 82 active', 'weight 83 active']);
    expect(a.loadAllHistory().map((m) => m.value).sort((x, y) => x - y)).toEqual([1.4, 3.1, 82, 83]);
    expect(heard).toHaveBeenCalledTimes(1); // the page is told B's row arrived
    window.removeEventListener(REMOTE_CHANGED_EVENT, heard);
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
