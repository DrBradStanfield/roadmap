// @vitest-environment jsdom
/**
 * US-16 AC2a: "did the record change since you asked" is an equality test on
 * the whole erase identity, not on the epoch. A merge can move the identity
 * within one epoch (merge.test.ts: at one epoch, the erasedAt moves), so a
 * same-epoch erase from another device must also count as a change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from '@roadmap/health-core/roadmap-file';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { migrateFile } from '@roadmap/health-core/migrate';
import { rowRootIds } from '@roadmap/health-core/merge';
import { RoadmapStore } from '../storage/roadmap-store';
import { addMeasurement, askedUnder, flushRoadmapStore, getEraseIdentity, initRoadmapStore, markEraseShown, stillShown } from './roadmap-data';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

/** Another device erases the record in the shared cloud, as its own
 *  deleteUserData writes it (US-09 AC23); `sameEpoch` keeps the epoch. */
async function otherDeviceErases(cloud: MemoryCloud, at: string, sameEpoch = false) {
  const adapter = new MemoryAdapter(cloud);
  const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
  const ctx = { deviceId: 'other-device', now: at };
  const prior = migrateFile(body, ctx);
  const erased = migrateFile(null, ctx);
  const epoch = (prior.meta.eraseEpoch ?? 0) + (sameEpoch ? 0 : 1);
  erased.schemaVersion = CURRENT_SCHEMA_VERSION;
  const ids = new Set([...rowRootIds(prior), ...(prior.erasedRows?.ids ?? [])]);
  erased.erasedRows = { fromEpoch: prior.erasedRows?.fromEpoch ?? epoch, ids: [...ids].sort() };
  erased.meta.eraseEpoch = epoch;
  erased.meta.erasedAt = at;
  await adapter.write(ROADMAP_FILE_NAME, erased, version);
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(async () => {
  await flushRoadmapStore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('US-16 AC2a: askedUnder and stillShown compare the whole erase identity', () => {
  it('a same-epoch identity move is a change: stillShown is false', async () => {
    const cloud = new MemoryCloud();
    vi.spyOn(RoadmapStore, 'create');
    await initRoadmapStore(new MemoryAdapter(cloud));
    await addMeasurement('weight', 82, '2026-09-01');
    await flushRoadmapStore();
    const store: RoadmapStore = await vi.mocked(RoadmapStore.create).mock.results.at(-1)!.value;

    await otherDeviceErases(cloud, new Date(Date.now() + 1000).toISOString());
    await store.refreshFromRemote();
    markEraseShown(getEraseIdentity());
    const asked = askedUnder();
    expect(stillShown(asked)).toBe(true);

    // Erased again at the same epoch: only the erasedAt moves.
    await vi.advanceTimersByTimeAsync(6000); // past the re-read throttle
    await otherDeviceErases(cloud, new Date(Date.now() + 2000).toISOString(), true);
    await store.refreshFromRemote();
    expect(JSON.parse(getEraseIdentity())[0]).toBe(1);
    expect(getEraseIdentity()).not.toBe(asked);
    // The store moved; the screen has not shown it yet.
    expect(stillShown(asked)).toBe(false);
    // And once the screen shows it.
    markEraseShown(getEraseIdentity());
    expect(stillShown(asked)).toBe(false);
  });

  it('nothing moved: stillShown is true', async () => {
    await initRoadmapStore(new MemoryAdapter(new MemoryCloud()));
    markEraseShown(getEraseIdentity());
    expect(stillShown(askedUnder())).toBe(true);
  });
});
