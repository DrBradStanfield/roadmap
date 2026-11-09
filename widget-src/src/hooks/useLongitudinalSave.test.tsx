// @vitest-environment jsdom
/**
 * US-03 AC9: the save's state, made explicit. "Saving…" holds while any save
 * of the record's values is still running, and an erase forgets the field
 * save waiting on its timer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import type { SaveTask } from '../lib/matrix-save';

vi.mock('../lib/roadmap-data', () => ({
  addMeasurement: vi.fn(async () => ({ status: 'inserted' })),
  correctValue: vi.fn(async () => 'ok'),
  getBackendKind: () => 'cloud',
  getShownErase: () => 'erase-1',
  loadAllHistorySync: () => [],
}));
vi.mock('../lib/storage', () => ({ localHealthWritesStopped: () => false }));
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
    inputs, setInputs: vi.fn(), history: [], unitOverrides: {}, unitSystem: 'si', reloadValues,
    flushPendingProfileSave: async () => true,
    typedIn: { current: {} }, isFirstSaveRef: { current: false },
  }));
  return { hook, reloads };
}

/** Lets queued promise steps run until every save has reached its re-read. */
async function settle(reloads: unknown[], count: number) {
  for (let i = 0; i < 50 && reloads.length < count; i++) await act(async () => { await Promise.resolve(); });
  expect(reloads).toHaveLength(count);
}

beforeEach(() => { vi.mocked(addMeasurement).mockClear(); });

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
