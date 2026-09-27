// Test support for the suites that render the whole HealthTool over a real
// RoadmapStore on jsdom's localStorage (HealthTool.chat-copy.test.tsx; the
// weight-meds suite is next). The vi.mock calls stay in each file: Vitest
// hoists them per file. Imported by tests only.

import { beforeEach, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { HealthInputs } from '@roadmap/health-core';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import {
  addMeasurement,
  flushRoadmapStore,
  initRoadmapStore,
  saveChangedMeasurements,
  saveMedication,
} from '../lib/roadmap-data';

/**
 * Register the lifecycle once, at a suite file's top level: a clean browser
 * store and a wide desktop (the plan and the form both on screen) before each
 * test; unmount, the store's pending writes and every stub undone after it.
 */
export function useHealthToolLifecycle(): void {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {},
    }));
    Element.prototype.scrollIntoView ??= () => {}; // jsdom has no layout to scroll
  });
  afterEach(async () => {
    cleanup();
    await flushRoadmapStore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}

/**
 * A guest's saved record, written through the real store before the page
 * renders: the profile, one measurement per [metric, value] on `day`, and each
 * [medication key, drug name, dose in mg].
 */
export async function seedGuest(
  profile: Partial<HealthInputs>,
  measurements: Array<[metric: string, value: number]> = [],
  meds: Array<[key: string, drug: string, dose?: number]> = [],
  day = '2026-09-01',
): Promise<void> {
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements(profile, {});
  for (const [metric, value] of measurements) await addMeasurement(metric, value, day);
  for (const [key, drug, dose] of meds) await saveMedication(key, drug, dose ?? null, dose ? 'mg' : null);
  await flushRoadmapStore();
}
