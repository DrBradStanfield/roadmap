import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { initRoadmapStore, flushRoadmapStore } from './roadmap-data';
import * as data from './roadmap-data';
import { getChatHistory } from './chat-history-access';
import { trackProductEvent } from './server-api';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./server-api', async importOriginal => ({
  ...await importOriginal<typeof import('./server-api')>(),
  trackProductEvent: vi.fn(),
}));

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
    expect(await data.correctValue(added.row.id, 3.1)).toBe('ok');
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
  // US-11 · the erase has to reach chat-history.json, which the record erase
  // never touches. It goes through the getChatHistory() singleton so an open
  // chat panel's instance is the one tombstoned, and it runs BEFORE the record
  // erase (in local mode the record erase then removes the named-file keys).
  it('tombstones chat history when the user deletes all their data', async () => {
    const chat = await getChatHistory();
    expect(chat).not.toBeNull();
    await chat!.recordExchange({ conversationId: 'c1', isNew: true, userText: 'my ldl is 3.2', assistantText: 'ok' });

    expect(await data.deleteUserData()).toEqual({ success: true, chatErased: true });

    expect(chat!.listConversations()).toEqual([]);
    const persisted = cloud.files.get('chat-history.json')!.json;
    expect(JSON.parse(persisted).conversations[0].deleted).toBe(true);
    expect(persisted).not.toMatch(/ldl/);
  });

  // The failure is swallowed on purpose, but it must be REPORTED: the caller
  // picks the post-erase alert from this flag, and claiming the chat history
  // is deleted when the write failed is the overclaim this pins shut.
  it('erases the record even when the chat-history write fails, and says so', async () => {
    const chat = await getChatHistory();
    await chat!.recordExchange({ conversationId: 'c1', isNew: true, userText: 'hello', assistantText: 'ok' });
    vi.spyOn(chat!, 'eraseAll').mockRejectedValue(new Error('cloud unreachable'));

    expect(await data.deleteUserData()).toEqual({ success: true, chatErased: false });
    expect(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json).meta.eraseEpoch).toBe(1);
  });

  // US-21 phase 3 · the usage signal. A refused unit is the only way to learn
  // which spelling to teach the catalogue next, and the counter must carry the
  // key and the spelling ALONE — the value is the one thing it may never hold.
  it('counts a refused lab unit with the catalogue key and the spelling, never the value', async () => {
    vi.mocked(trackProductEvent).mockClear();

    const result = await data.bulkSaveLabValues([
      { metricName: 'ferritin', value: 80, unit: 'mg/dL', recordedAt: '2024-06-01T09:00:00.000Z' },
      { metricName: 'sodium', value: 140, unit: 'mEq/L', recordedAt: '2024-06-01T09:00:00.000Z' },
    ]);

    expect(result.saved).toHaveLength(1);
    expect(trackProductEvent).toHaveBeenCalledTimes(1);
    expect(trackProductEvent).toHaveBeenCalledWith('lab_unit_refused', { key: 'ferritin', unit: 'mg/dL' });
  });

  // US-21 AC15 · the signal is a spelling to teach the catalogue: a count
  // refused for its NUMBER under a spelling the test takes is not one.
  it('US-21 AC15 — does not count a refusal under a spelling the test takes', async () => {
    vi.mocked(trackProductEvent).mockClear();

    const result = await data.bulkSaveLabValues([
      { metricName: 'Neutrophils', value: 2.4, unit: 'cells/uL', recordedAt: '2024-06-01T09:00:00.000Z' },
      { metricName: 'Platelets', value: 250000, unit: 'cells/µL', referenceLow: 150, referenceHigh: 400, recordedAt: '2024-06-01T09:00:00.000Z' },
      { metricName: 'Lymphocytes', value: 30, unit: '%', recordedAt: '2024-06-01T09:00:00.000Z' },
    ]);

    expect(result.refused.map((r) => r.key)).toEqual(['neutrophils', 'platelets', 'lymphocytes']);
    expect(trackProductEvent).toHaveBeenCalledTimes(1);
    expect(trackProductEvent).toHaveBeenCalledWith('lab_unit_refused', { key: 'lymphocytes', unit: '%' });
  });
});
