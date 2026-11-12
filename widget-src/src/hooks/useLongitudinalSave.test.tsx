// @vitest-environment jsdom
/**
 * US-03 AC9: the save's state, made explicit. "Saving…" holds while any save
 * of the record's values is still running, and an erase forgets the field
 * save waiting on its timer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import type { SaveTask } from '../lib/matrix-save';

// The erase the page shows now; a test changes it to stand for an erase after the blur.
const shown = vi.hoisted(() => ({ erase: 'erase-1' }));
vi.mock('../lib/roadmap-data', () => ({
  addMeasurement: vi.fn(async () => ({ status: 'inserted' })),
  correctValue: vi.fn(async () => 'ok'),
  getBackendKind: () => 'cloud',
  getShownErase: () => shown.erase,
  loadAllHistorySync: () => [],
}));
vi.mock('../lib/storage', () => ({ healthWritesAllowed: () => true }));
vi.mock('../lib/server-api', () => ({ trackABConversion: vi.fn(), trackProductEvent: vi.fn() }));

import { addMeasurement } from '../lib/roadmap-data';
import { useLongitudinalSave } from './useLongitudinalSave';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const task = (date: string, weight: number): SaveTask => ({ date, values: { weight }, expected: { weight: null }, unit: 'si' });

function setup(inputs: Record<string, number> = {}) {
  const reloads: ReturnType<typeof deferred>[] = [];
  const reloadValues = vi.fn(() => { const d = deferred(); reloads.push(d); return d.promise; });
  const hook = renderHook(() => useLongitudinalSave({
    inputs, setInputs: vi.fn(), history: [], unitOverrides: {}, unitSystem: 'si', reread: reloadValues,
    flushPendingProfileSave: async () => true,
    typedIn: { current: {} }, firstSave: false,
  }));
  return { hook, reloads };
}

/** Lets queued promise steps run until every save has reached its re-read. */
async function settle(reloads: unknown[], count: number) {
  for (let i = 0; i < 50 && reloads.length < count; i++) await act(async () => { await Promise.resolve(); });
  expect(reloads).toHaveLength(count);
}

beforeEach(() => { vi.mocked(addMeasurement).mockClear(); shown.erase = 'erase-1'; });

describe('US-03 AC9: the save state', () => {
  it('US-03 AC9: "Saving…" holds until the last of two overlapping saves ends (a departure staged during a queued save)', async () => {
    const { hook, reloads } = setup();
    act(() => { void hook.result.current.handleSaveLongitudinal([task('2026-11-01', 80)]); });
    act(() => { void hook.result.current.handleSaveLongitudinal([task('2026-11-02', 81)], 'erase-1', true); });
    await settle(reloads, 2);
    expect(hook.result.current.isSavingLongitudinal).toBe(true);
    await act(async () => { reloads[0].resolve(); });
    expect(hook.result.current.isSavingLongitudinal).toBe(true);
    await act(async () => { reloads[1].resolve(); });
    expect(hook.result.current.isSavingLongitudinal).toBe(false);
  });

  it('US-03 AC9: an erase forgets the field save waiting on its timer, so a departure after it writes nothing', async () => {
    const { hook } = setup({ weightKg: 80 });
    act(() => { hook.result.current.scheduleLongitudinalSave(); });
    act(() => { hook.result.current.cancelPendingSave(); });
    act(() => { hook.result.current.stagePendingSave(); });
    await act(async () => { await Promise.resolve(); });
    expect(addMeasurement).not.toHaveBeenCalled();
  });

  it('US-03 AC9 control: without the erase, the departure writes the waiting save at once', async () => {
    const { hook } = setup({ weightKg: 80 });
    act(() => { hook.result.current.scheduleLongitudinalSave(); });
    act(() => { hook.result.current.stagePendingSave(); });
    await act(async () => { await Promise.resolve(); });
    expect(addMeasurement).toHaveBeenCalledOnce();
  });
});

// The fields' waiting save at departure, flush and erase (US-06 AC15, US-03 AC9).
// Pins for lead A5: they hold before and after the debouncer became the one
// holder of the waiting save.
describe('US-06 AC15 / US-03 AC9: the waiting field save', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const erasesWritten = () => vi.mocked(addMeasurement).mock.calls.map(call => call[3]);

  it('US-06 AC15: a departure inside the 500 ms wait writes at once, under the erase as the field was left', async () => {
    const { hook } = setup({ weightKg: 80 });
    act(() => { hook.result.current.scheduleLongitudinalSave(); });
    shown.erase = 'erase-2'; // the shown erase changes after the blur
    act(() => { hook.result.current.stagePendingSave(); });
    expect(erasesWritten()).toEqual(['erase-1']); // staged before stagePendingSave returned
  });

  it('US-06 AC15: a departure after the timer fired stages nothing new: one write, not two', async () => {
    const { hook, reloads } = setup({ weightKg: 80 });
    act(() => { hook.result.current.scheduleLongitudinalSave(); });
    act(() => { vi.advanceTimersByTime(500); });
    await settle(reloads, 1);
    act(() => { hook.result.current.stagePendingSave(); });
    await act(async () => { await Promise.resolve(); });
    expect(addMeasurement).toHaveBeenCalledOnce();
  });

  it('US-03 AC9: an erase drops the waiting save; neither the timer nor a departure writes it', async () => {
    const { hook } = setup({ weightKg: 80 });
    act(() => { hook.result.current.scheduleLongitudinalSave(); });
    act(() => { hook.result.current.cancelPendingSave(); });
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { hook.result.current.stagePendingSave(); });
    await act(async () => { await Promise.resolve(); });
    expect(addMeasurement).not.toHaveBeenCalled();
  });

  it('US-06 AC15: flushPendingSave runs the waiting save once, under the erase as the field was left', async () => {
    const { hook, reloads } = setup({ weightKg: 80 });
    act(() => { hook.result.current.scheduleLongitudinalSave(); });
    shown.erase = 'erase-2';
    act(() => { hook.result.current.flushPendingSave(); });
    await settle(reloads, 1);
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { hook.result.current.stagePendingSave(); });
    act(() => { hook.result.current.flushPendingSave(); });
    await act(async () => { await Promise.resolve(); });
    expect(erasesWritten()).toEqual(['erase-1']);
  });
});
