// Test support for the suites that render the whole HealthTool over a real
// RoadmapStore on jsdom's localStorage (HealthTool.chat-copy.test.tsx; the
// weight-meds suite is next). The vi.mock calls stay in each file: Vitest
// hoists them per file. Imported by tests only.

import { beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent } from '@testing-library/react';
import { openSettings } from './settings';
import type { HealthInputs } from '@roadmap/health-core/types';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { createEmptyFile, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import {
  addMeasurement,
  flushRoadmapStore,
  initRoadmapStore,
  saveChangedMeasurements,
  saveMedication,
} from '../lib/roadmap-data';

/**
 * What the fake-timer mode fakes: the timers and the clock the app's debounces,
 * glow and re-read throttle run on. queueMicrotask and promises stay real, so a
 * test that relies on a microtask gap still sees it. jsdom's requestAnimationFrame
 * is not faked itself but runs on the faked setInterval, so frames move with the
 * fake clock (still with the wall clock too, through shouldAdvanceTime).
 */
const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const;

/**
 * Register the lifecycle once, at a suite file's top level: a clean browser
 * store and a wide desktop (the plan and the form both on screen) before each
 * test; unmount, the store's pending writes and every stub undone after it.
 *
 * `fakeTimers: true` runs each test on fake timers that still move with the
 * wall clock (shouldAdvanceTime), so `wait(ms)` jumps a debounce at once and a
 * waitFor still gets there; real timers come back after each test. Opt-in: a
 * file that leaves it off runs exactly as before.
 */
export function useHealthToolLifecycle({ fakeTimers = false }: { fakeTimers?: boolean } = {}): void {
  beforeEach(() => {
    if (fakeTimers) vi.useFakeTimers({ shouldAdvanceTime: true, toFake: [...FAKED] });
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {},
    }));
    Element.prototype.scrollIntoView ??= () => {}; // jsdom has no layout to scroll
  });
  afterEach(async () => {
    cleanup();
    // Spies come off before the flush: a test that throws past its release leaves
    // the flush hung until the hook times out, and a spy left on would be wrapped
    // again by the next test's spyOn (Maximum call stack size exceeded).
    vi.restoreAllMocks();
    await flushRoadmapStore();
    // Vitest 4's restoreAllMocks only undoes vi.spyOn; resetAllMocks also drops
    // each vi.fn's calls and unused mock*Once values, as restoreAllMocks did in 1.x.
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    if (fakeTimers) {
      // jsdom runs its animation frames on the global setInterval, faked here. A frame
      // still pending when real timers come back leaves jsdom waiting on a fake interval
      // that never fires, and every later frame in the file hangs: cancel them first.
      const last = requestAnimationFrame(() => {});
      for (let handle = 1; handle <= last; handle++) cancelAnimationFrame(handle);
      vi.useRealTimers();
    }
  });
}

/** Fake-timer mode only: run every timer due in the next `ms`, inside act. */
export const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** Settle microtasks and short timers without leaving the act scope (so React renders nothing). */
export const drain = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };

/** Wait `ms` of real time, then drain, inside act. */
export const settle = async (ms = 0) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); await drain(); }); };

const liveRefreshStops: Array<() => void> = [];

/**
 * Call in beforeEach: each page's real live re-read still starts, and
 * `stopLiveRefresh()` (call in afterEach) stops it, as a closed page's is. A
 * guest page's listener stays on while hidden (US-34 AC6), so a page an earlier
 * test left behind would otherwise take in, and announce, every later test's
 * other-tab save. A file that re-imports its modules (vi.resetModules) passes
 * the RoadmapStore it imported.
 */
export function trackLiveRefresh(Store: typeof RoadmapStore = RoadmapStore): void {
  const start = Store.prototype.startLiveRefresh;
  vi.spyOn(Store.prototype, 'startLiveRefresh').mockImplementation(function (this: RoadmapStore) {
    const stop = start.call(this);
    liveRefreshStops.push(stop);
    return stop;
  });
}

/** Stop every live refresh started since `trackLiveRefresh()`. */
export function stopLiveRefresh(): void {
  for (const stop of liveRefreshStops.splice(0)) stop();
}

/** The record as saved on this device, once the store's pending writes land.
 *  A record nothing was saved to is never written (US-10 AC5a): read it as empty. */
export async function recordOnDisk(): Promise<RoadmapFile> {
  await act(async () => { await flushRoadmapStore(); });
  const { body } = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
  return (body ?? createEmptyFile({ deviceId: 'test', now: new Date().toISOString() })) as RoadmapFile;
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
