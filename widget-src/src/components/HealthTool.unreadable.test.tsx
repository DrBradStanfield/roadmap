// @vitest-environment jsdom
/**
 * US-65 (Brad 2026-11-01): a record holding a row this build cannot read
 * still opens on the web. The page shows the other values and one calm line
 * with the count; a save writes the row back unchanged. Synthetic values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createEmptyFile, createMeasurement } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { flushRoadmapStore, getUnreadableCount, initRoadmapStore, loadLatestMeasurementsSync, saveChangedMeasurements } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
import { HealthTool } from './HealthTool';

const DAY = '2026-09-01T00:00:00.000Z';
const FUTURE = { ...createMeasurement({ id: 'f1', metricType: 'weight', value: 5, recordedAt: DAY, createdAt: DAY }), metricType: 'synthetic_future_metric' };
const stops: Array<() => void> = [];

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  const file = createEmptyFile({ deviceId: 'dev_writer', now: DAY });
  const record = {
    ...file,
    profile: { updatedAt: DAY, lamport: 1, sex: 'female', heightCm: 165, birthYear: 1975, birthMonth: 5, unitSystem: 'si' },
    measurements: [createMeasurement({ id: 'w1', metricType: 'weight', value: 64, recordedAt: DAY, createdAt: DAY }), FUTURE],
  };
  localStorage.setItem('health_roadmap_file_v2', JSON.stringify(record));
  localStorage.setItem('health_roadmap_file_v2_rev', '1');
  await initRoadmapStore(new LocalStorageAdapter());
});
afterEach(async () => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('US-65 AC1, AC5: the web opens a record holding an unreadable row', () => {
  it('shows the other values and one line with the count, counted without content', async () => {
    const view = render(<HealthTool />);
    await waitFor(() => expect(view.container.querySelector('.hr-unreadable-note')?.textContent)
      .toBe('1 entry in your record could not be read, so it is kept unchanged and not shown.'));
    expect(loadLatestMeasurementsSync()?.previousMeasurements.map((m) => [m.metricType, m.value])).toEqual([['weight', 64]]);
    expect(trackProductEvent).toHaveBeenCalledWith('record_unreadable_kept', { count: 1 });
  });

  it('a save leaves the unreadable row in measurements, unchanged', async () => {
    expect(getUnreadableCount()).toBe(1);
    await saveChangedMeasurements({ weightKg: 65 }, { weightKg: 64 });
    await flushRoadmapStore();
    const stored = JSON.parse(localStorage.getItem('health_roadmap_file_v2')!);
    expect(JSON.stringify(stored.measurements.find((r: { id: string }) => r.id === 'f1'))).toBe(JSON.stringify(FUTURE));
  });
});
