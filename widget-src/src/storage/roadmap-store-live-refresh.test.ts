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
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
// The tool the connector actually calls — deep-imported, as the servers do.
import { updateProfile } from '../../../packages/health-core/src/mcp-tools';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from './roadmap-store';

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

  it('a local-only record has no second writer, so it never re-reads', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    expect(await store.refreshFromRemote()).toBe(false);
  });
});
