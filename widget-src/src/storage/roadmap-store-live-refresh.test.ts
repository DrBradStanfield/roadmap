/**
 * @vitest-environment jsdom
 *
 * US-34 — the record on screen keeps up.
 *
 * An AI connector (or another device) writes to the same file the open page is
 * showing. These pin what the STORE promises: it re-reads at the moments a
 * user comes back to the tab, it never re-reads over a local edit that has not
 * gone up yet, and it says "changed" only when something actually did.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME, type RoadmapFile, type StorageAdapter } from '@roadmap/health-core';
// The tool the connector actually calls — deep-imported, as the servers do.
import { updateProfile } from '../../../packages/health-core/src/mcp-tools';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from './roadmap-store';
import { LocalStorageAdapter } from './local-storage-adapter';

/** The connector's write clock. Deliberately in the past: a tied lamport
 *  falls through to wall-clock time, and the local edit below is later. */
const NOW = '2026-09-01T00:00:00Z';

function cloudFile(cloud: MemoryCloud): RoadmapFile {
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
}

/** What an MCP connector does to the file while the page sits open. */
function writeProfileToCloud(cloud: MemoryCloud, heightCm: number): void {
  const outcome = updateProfile(cloudFile(cloud), { heightCm }, NOW);
  if (outcome.status !== 'ok' || !outcome.file) throw new Error(outcome.text);
  const stored = cloud.files.get(ROADMAP_FILE_NAME)!;
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(outcome.file), version: stored.version + 1 });
}

/** A store over a cloud that already holds a record, with the throttle clear. */
async function connected(cloud: MemoryCloud): Promise<RoadmapStore> {
  const store = await RoadmapStore.create(new MemoryAdapter(cloud));
  store.saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
  await store.flush();
  vi.setSystemTime(Date.now() + 10_000);
  return store;
}

describe('US-34 AC1 — a remote change reaches the open page', () => {
  // Real time never passes here: the 800 ms persist debounce must stay
  // pending in the test that says a pending edit wins.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('applies a connector’s profile write on visibilitychange, and announces it once', async () => {
    const cloud = new MemoryCloud();
    const store = await connected(cloud);
    const stop = store.startLiveRefresh();
    const heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);

    writeProfileToCloud(cloud, 165);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));

    expect(store.loadLatestMeasurements().inputs.heightCm).toBe(165);
    stop();
  });

  it('says nothing when the bytes did not change', async () => {
    const cloud = new MemoryCloud();
    const store = await connected(cloud);
    const heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);

    // A merge always bumps the file's own clock, so an unchanged record must
    // be recognised by its CONTENT — Drive hands back no version to compare.
    expect(await store.refreshFromRemote()).toBe(false);
    expect(heard).not.toHaveBeenCalled();
  });

  it('re-reads at most once every five seconds, however often the tab is switched', async () => {
    const cloud = new MemoryCloud();
    const store = await connected(cloud);

    writeProfileToCloud(cloud, 165);
    expect(await store.refreshFromRemote()).toBe(true);
    writeProfileToCloud(cloud, 170);
    expect(await store.refreshFromRemote()).toBe(false);

    vi.setSystemTime(Date.now() + 6_000);
    expect(await store.refreshFromRemote()).toBe(true);
    expect(store.loadLatestMeasurements().inputs.heightCm).toBe(170);
  });

  it('never re-reads over an edit the user has just made', async () => {
    const cloud = new MemoryCloud();
    const store = await connected(cloud);

    // A local edit schedules a debounced save: the working copy is AHEAD of
    // the cloud, and merging a read taken before it would fight that write.
    store.saveChangedMeasurements({ heightCm: 181 }, { heightCm: 178 });
    writeProfileToCloud(cloud, 165);

    expect(await store.refreshFromRemote()).toBe(false);
    expect(store.loadLatestMeasurements().inputs.heightCm).toBe(181);

    // Once it has gone up, the connector's write is merged in the ordinary way.
    await store.flush();
    expect(cloudFile(cloud).profile.heightCm).toBe(181);
  });

  it('polls only while the tab is visible', async () => {
    const cloud = new MemoryCloud();
    const store = await connected(cloud);
    const refresh = vi.spyOn(store, 'refreshFromRemote');
    const stop = store.startLiveRefresh();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).not.toHaveBeenCalled();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalled();
    stop();
  });

  it('US-34 AC2 — drops a merge whose base was replaced while the read was in the air', async () => {
    const cloud = new MemoryCloud();
    // A read the test can hold open, so an edit can land AND finish saving
    // inside the window — the case a `writePending` check taken afterwards
    // cannot see, because by then nothing is pending.
    let gate: Promise<void> | null = null;
    class SlowAdapter extends MemoryAdapter {
      async read(fileName: string) {
        // Only the re-read waits: the save that happens inside the window has
        // a read of its own, and holding that would deadlock the test.
        const held = gate;
        gate = null;
        if (held) await held;
        return super.read(fileName);
      }
    }
    const store = await RoadmapStore.create(new SlowAdapter(cloud) as StorageAdapter);
    store.saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
    await store.flush();
    vi.setSystemTime(Date.now() + 10_000);

    writeProfileToCloud(cloud, 165);
    let open: () => void = () => {};
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const refreshing = store.refreshFromRemote();
    store.saveChangedMeasurements({ heightCm: 181 }, { heightCm: 178 });
    await store.flush();
    open();

    expect(await refreshing).toBe(false);
    expect(store.loadLatestMeasurements().inputs.heightCm).toBe(181);
  });

  it('US-34 AC6 — the local tier re-reads too: another tab\'s write is taken in', async () => {
    localStorage.clear();
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    const otherTab = await RoadmapStore.create(new LocalStorageAdapter());
    otherTab.addMeasurement('weight', 83, '2026-09-25T00:00:00.000Z');
    await otherTab.flush();

    expect(await store.refreshFromRemote()).toBe(true);
    expect(store.loadAllHistory().map((m) => m.value)).toEqual([83]);
  });
});

/** A MemoryAdapter that also carries a change signal, as Dropbox and Drive do.
 *  `push()` is the provider saying the file moved. */
class WatchedAdapter extends MemoryAdapter {
  push: () => void = () => {};
  watching = 0;
  watch(_fileName: string, onChange: () => void, signal: AbortSignal): void {
    this.watching += 1;
    this.push = onChange;
    signal.addEventListener('abort', () => {
      this.watching -= 1;
    });
  }
}

describe('US-34 AC1 — the provider’s own change signal replaces the timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });

  async function watched(cloud: MemoryCloud): Promise<[RoadmapStore, WatchedAdapter]> {
    const adapter = new WatchedAdapter(cloud);
    const store = await RoadmapStore.create(adapter as StorageAdapter);
    store.saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
    await store.flush();
    vi.setSystemTime(Date.now() + 10_000);
    return [store, adapter];
  }

  it('applies a pushed change with no timer running at all', async () => {
    const cloud = new MemoryCloud();
    const [store, adapter] = await watched(cloud);
    const stop = store.startLiveRefresh();
    expect(adapter.watching).toBe(1);

    writeProfileToCloud(cloud, 165);
    adapter.push();
    await vi.waitFor(() => expect(store.loadLatestMeasurements().inputs.heightCm).toBe(165));

    // The minute poll is gone for a watched backend: a whole quiet minute
    // costs no read.
    const refresh = vi.spyOn(store, 'refreshFromRemote');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it('US-34 AC6 — the local tier runs no timer: the storage event is its change signal', async () => {
    localStorage.clear();
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    const interval = vi.spyOn(globalThis, 'setInterval');
    const refresh = vi.spyOn(store, 'refreshFromRemote');
    const stop = store.startLiveRefresh();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(interval).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    stop();
    interval.mockRestore();
  });

  it('still polls every minute for a backend with no change signal', async () => {
    const store = await connected(new MemoryCloud());
    const refresh = vi.spyOn(store, 'refreshFromRemote');
    const stop = store.startLiveRefresh();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalled();
    stop();
  });

  it('holds a push the throttle swallowed until the window is out', async () => {
    const cloud = new MemoryCloud();
    const [store, adapter] = await watched(cloud);
    const stop = store.startLiveRefresh();

    writeProfileToCloud(cloud, 165);
    adapter.push();
    await vi.waitFor(() => expect(store.loadLatestMeasurements().inputs.heightCm).toBe(165));

    // A second push inside the 5-second window: the watch will not fire again
    // for this change, so dropping it would lose it until the user came back.
    writeProfileToCloud(cloud, 170);
    adapter.push();
    expect(store.loadLatestMeasurements().inputs.heightCm).toBe(165);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(store.loadLatestMeasurements().inputs.heightCm).toBe(170);
    stop();
  });

  it('drops the watch when the tab is hidden and takes it up again on return', async () => {
    const [store, adapter] = await watched(new MemoryCloud());
    const stop = store.startLiveRefresh();
    expect(adapter.watching).toBe(1);

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(adapter.watching).toBe(0);

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(adapter.watching).toBe(1);

    stop();
    expect(adapter.watching).toBe(0);
  });
});

describe('US-34 AC1 — a change the save itself folded in is still announced', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  // refreshFromRemote() stands aside while a save is pending, and the save's
  // own post-write merge then folds the remote change into the working copy.
  // Nothing was left to find on the next re-read, so without this the screen
  // stayed stale until a reload.
  it('announces a remote change the in-flight save merged in', async () => {
    const cloud = new MemoryCloud();
    const store = await connected(cloud);
    const heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);

    writeProfileToCloud(cloud, 165);
    store.saveChangedMeasurements({ weightKg: 80 }, {});
    await store.flush();

    expect(heard).toHaveBeenCalledTimes(1);
    expect(store.loadLatestMeasurements().inputs.heightCm).toBe(165);
  });

  it('says nothing when the save had no remote change to fold in', async () => {
    const cloud = new MemoryCloud();
    const store = await connected(cloud);
    const heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);

    store.saveChangedMeasurements({ weightKg: 80 }, {});
    await store.flush();

    expect(heard).not.toHaveBeenCalled();
  });
});

/**
 * The 2026-09-22 guest's typed weight vanished because the store announced a
 * remote change that never happened: on an empty backend the first save merges
 * against a record the migration stamps NOW, so the singleton clocks differ,
 * and a merge re-sorts rows by id, so any new row whose id sorts first reads as
 * a change too. HealthTool re-ran its load path on the false alarm and took the
 * typed value with it. The alarm now compares what a person would see: rows as
 * a set, and no per-record clocks.
 */
describe('US-34 AC3 — only a change someone made is announced', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  it('an empty browser: neither the first save nor a row whose id sorts first announces anything', async () => {
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    const heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);

    store.saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
    await store.flush();
    const ids = ['ffffffff-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'] as const;
    const uuid = vi.spyOn(crypto, 'randomUUID');
    uuid.mockReturnValueOnce(ids[0]).mockReturnValueOnce(ids[1]);
    store.addMeasurement('weight', 82, '2026-09-20');
    await store.flush();
    store.addMeasurement('ldl', 3.2, '2026-09-20'); // its id sorts before the weight's
    await store.flush();
    uuid.mockRestore();

    expect(store.loadAllHistory().map((m) => m.id).sort()).toEqual([ids[1], ids[0]]);
    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener(REMOTE_CHANGED_EVENT, heard);
  });

  it('an empty cloud: the first save announces nothing either', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    const heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);
    // A person takes a few seconds to type: the save's own reading of the
    // empty cloud is stamped later than the page's.
    vi.setSystemTime(Date.now() + 5_000);

    store.saveChangedMeasurements({ sex: 'female', heightCm: 165 }, {});
    await store.flush();

    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener(REMOTE_CHANGED_EVENT, heard);
  });

  it('a real change from another writer is announced exactly once', async () => {
    const cloud = new MemoryCloud();
    const store = await connected(cloud);
    const heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);

    const other = await RoadmapStore.create(new MemoryAdapter(cloud));
    other.addMeasurement('ldl', 2.9, '2026-09-10');
    await other.flush();
    store.addMeasurement('weight', 80, '2026-09-11');
    await store.flush();
    store.addMeasurement('waist', 90, '2026-09-11');
    await store.flush();

    expect(heard).toHaveBeenCalledTimes(1);
    expect(store.loadAllHistory().map((m) => m.metricType).sort()).toEqual(['ldl', 'waist', 'weight']);
    window.removeEventListener(REMOTE_CHANGED_EVENT, heard);
  });

  /** Another device re-saved the same profile: its clock moved, nothing else. */
  function bumpProfileClock(cloud: MemoryCloud): void {
    const file = cloudFile(cloud);
    file.profile.lamport = (file.profile.lamport ?? 0) + 5;
    const stored = cloud.files.get(ROADMAP_FILE_NAME)!;
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: stored.version + 1 });
  }

  it('a re-read that brings only a clock takes it in without announcing it', async () => {
    const cloud = new MemoryCloud();
    const store = await connected(cloud);
    const heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);

    bumpProfileClock(cloud);
    await store.refreshFromRemote();

    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener(REMOTE_CHANGED_EVENT, heard);
  });

  // The reason the ADOPTION test stays clock-sensitive: a re-read that
  // skipped a clock-only change would leave this device's profile lamport
  // behind the cloud's, and the next profile edit would lose the merge.
  it('after a clock-only re-read, the next profile edit still wins', async () => {
    const cloud = new MemoryCloud();
    const store = await connected(cloud);

    bumpProfileClock(cloud);
    await store.refreshFromRemote();
    store.saveChangedMeasurements({ heightCm: 180 }, { heightCm: 178 });
    await store.flush();

    expect(cloudFile(cloud).profile.heightCm).toBe(180);
  });
});
