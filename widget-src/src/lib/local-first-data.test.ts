import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { initRoadmapStore, flushRoadmapStore } from './roadmap-data';
import * as data from './roadmap-data';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

// US-03/04/09: the module used by UI callers must work without Vite rewriting
// its identity. The actual store and sync engine persist into a fake cloud.
describe('explicit local-first data path', () => {
  let cloud: MemoryCloud;
  beforeEach(async () => {
    vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Health CRUD must not use HTTP')));
    cloud = new MemoryCloud();
    await initRoadmapStore(new MemoryAdapter(cloud));
  });
  afterEach(async () => {
    await flushRoadmapStore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('saves and corrects a dated measurement through the imported API', async () => {
    const added = await data.addMeasurement('ldl', 4.2, '2026-08-01');
    expect(added.status).toBe('inserted');
    if (added.status !== 'inserted') throw new Error('measurement was not saved');
    expect(await data.correctMeasurement(added.row.id, 3.1)).toMatchObject({ status: 'ok' });
    await flushRoadmapStore();
    const persisted = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
    expect(persisted.measurements).toHaveLength(2);
    expect(persisted.measurements.find((row: { id: string }) => row.id === added.row.id).status).toBe('entered-in-error');
    expect((await data.loadLatestMeasurements())?.previousMeasurements).toMatchObject([{ value: 3.1 }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists profile and screening changes without a retired server endpoint', async () => {
    await data.saveChangedMeasurements({ sex: 'female', heightCm: 170 }, {});
    await data.saveScreening('breast_last_date', '2026-07-01');
    await flushRoadmapStore();
    const persisted = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
    expect(persisted.profile).toMatchObject({ sex: 'female', heightCm: 170 });
    expect(persisted.screenings.breastLastDate).toBe('2026-07-01');
    expect(fetch).not.toHaveBeenCalled();
  });
});
