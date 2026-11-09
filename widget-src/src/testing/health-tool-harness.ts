// Test support for the suites that render the whole HealthTool over a real
// RoadmapStore on jsdom's localStorage (HealthTool.chat-copy.test.tsx; the
// weight-meds suite is next). The vi.mock calls stay in each file: Vitest
// hoists them per file. Imported by tests only.

import { beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { openSettings } from './settings';
import type { HealthInputs } from '@roadmap/health-core/types';
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
    // Vitest 4's restoreAllMocks only undoes vi.spyOn; resetAllMocks also drops
    // each vi.fn's calls and unused mock*Once values, as restoreAllMocks did in 1.x.
    vi.resetAllMocks();
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

/** US-62 AC11: rows show on phone and desktop; this shows the grids, which
 *  sit mounted but hidden under them. */
export function showTables(root: ParentNode = document): void {
  const button = [...root.querySelectorAll('button')].find(b => b.textContent === 'All results as a table');
  if (button) fireEvent.click(button);
}

/** US-62 AC12: a returning record's About you is rows; this opens each, so its field shows. */
export function openAboutYou(root: ParentNode = document): void {
  // Since US-62 AC24 a returning record's About you sits in Settings: open them first.
  if (!root.querySelector('.about-card') && root.querySelector('button[aria-label="Settings"], [role="tab"]')) openSettings(root);
  root.querySelectorAll<HTMLButtonElement>('.about-row').forEach(b => fireEvent.click(b));
}
