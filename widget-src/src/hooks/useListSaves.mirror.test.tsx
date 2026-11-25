// @vitest-environment jsdom
/**
 * US-34 AC11, US-15 AC10: a landed list save writes the chat mirror through
 * the one mirror writer, so the PSA flag follows the saved screenings at once,
 * and the mirror keeps its own saved profile. Real mirror storage; the store
 * is a stub. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import type { ApiMeasurement, ApiScreening } from '@roadmap/health-core/mappings';

const { VAGUE, answer } = vi.hoisted(() => ({
  VAGUE: { id: 'vague', metricType: 'psa', value: 5, comparator: '<', recordedAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T09:00:00.000Z', status: 'active' } as ApiMeasurement,
  answer: (screeningKey: string, value: string): ApiScreening => ({ id: screeningKey, screeningKey, value, updatedAt: '2026-01-01T00:00:00.000Z' }),
}));
/** The record: a "< 5" PSA, another writer's birth year, and the screenings the store holds. */
const store = vi.hoisted(() => ({ screenings: [] as unknown[] }));
vi.mock('../lib/roadmap-data', () => {
  const latest = () => ({ inputs: { sex: 'male', birthYear: 1963 }, previousMeasurements: [VAGUE], medications: [], screenings: store.screenings });
  return {
    getShownErase: () => 'e1',
    saveScreening: async (key: string, value: string) => { store.screenings = [...store.screenings, answer(key, value)]; return true; },
    saveMedication: async () => true,
    loadLatestMeasurements: async () => latest(),
    loadLatestMeasurementsSync: () => latest(),
    loadLabValuesSync: () => [],
    loadAllHistorySync: () => [VAGUE],
  };
});

import { useListSaves } from './useListSaves';
import { loadFromLocalStorage, saveToLocalStorage } from '../lib/storage';

const NOW = new Date('2026-11-12T12:00:00Z');
function setup() {
  const record = { patchMedication: vi.fn(), patchScreening: vi.fn(), patchSupplement: vi.fn(), stopSupplement: vi.fn() };
  return renderHook(() => useListSaves(record as never, vi.fn()));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store.screenings = [answer('prostate_psa_value', '6.5')];
  // The mirror as a read wrote it: the page's saved profile, no PSA answers yet, so no flag.
  saveToLocalStorage({ sex: 'male', birthYear: 1962 }, [VAGUE], [], [], undefined, null, VAGUE);
});
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

describe('US-34 AC11 (H406): a screening save that lands refreshes the mirror\'s PSA flag', () => {
  it('the saved answer completes the old raised PSA: the mirror\'s lists and flag move together; its profile stays its own', async () => {
    const view = setup();
    expect(loadFromLocalStorage()!.psa).not.toHaveProperty('raisedBefore');
    act(() => view.result.current.handleScreeningChange('prostate_last_date', '2026-03'));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const m = loadFromLocalStorage()!;
    expect(m.screenings.map((s) => s.screeningKey)).toEqual(['prostate_psa_value', 'prostate_last_date']);
    expect(m.psa).toMatchObject({ id: 'vague', raisedBefore: true }); // was the flag of the read before (H406)
    expect(m.inputs).toEqual({ sex: 'male', birthYear: 1962 }); // not the store's 1963 (US-34 AC9)
  });
});
