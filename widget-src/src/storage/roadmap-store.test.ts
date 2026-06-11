import { describe, it, expect } from 'vitest';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';

describe('RoadmapStore — reportEmailCaptured lead flag', () => {
  it('defaults false, sets true, and persists across a reload (returning user)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(store.getReportEmailCaptured()).toBe(false);

    store.markReportEmailCaptured();
    expect(store.getReportEmailCaptured()).toBe(true);
    await store.flush();

    // A fresh store over the SAME cloud = the user returning / a second device.
    // The flag must survive the persist → reload → migrate round-trip.
    const reloaded = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(reloaded.getReportEmailCaptured()).toBe(true);
  });

  it('is idempotent — marking twice stays true and does not throw', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    store.markReportEmailCaptured();
    store.markReportEmailCaptured();
    expect(store.getReportEmailCaptured()).toBe(true);
  });
});
