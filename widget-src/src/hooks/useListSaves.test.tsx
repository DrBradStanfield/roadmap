// @vitest-environment jsdom
/**
 * US-06 AC13, US-16 AC2a: the medication, screening and supplement saves,
 * one waiting save per row. Page journeys: HealthTool.*med*, *supplement*,
 * *erase* tests; these check the hook's own rules.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';

const store = vi.hoisted(() => ({
  erase: 'e1',
  calls: [] as Array<[string, ...unknown[]]>,
  ok: true,
}));
vi.mock('../lib/roadmap-data', () => ({
  getShownErase: () => store.erase,
  saveMedication: async (...a: unknown[]) => { store.calls.push(['med', ...a]); return store.ok; },
  saveScreening: async (...a: unknown[]) => { store.calls.push(['screening', ...a]); return store.ok; },
  saveSupplement: async (...a: unknown[]) => { store.calls.push(['supplement', ...a]); return store.ok; },
  deleteSupplementApi: async (...a: unknown[]) => { store.calls.push(['stop', ...a]); return store.ok; },
  loadLatestMeasurements: async () => ({ medications: [{ medicationKey: 'statin' }], screenings: [] }),
}));
const mirror = vi.hoisted(() => ({ patches: [] as unknown[] }));
vi.mock('../lib/storage', () => ({ patchMirror: (p: unknown) => { mirror.patches.push(p); } }));

import { useListSaves } from './useListSaves';

function setup() {
  const record = { patchMedication: vi.fn(), patchScreening: vi.fn(), patchSupplement: vi.fn(), stopSupplement: vi.fn() };
  const writeRefused = vi.fn();
  const view = renderHook(() => useListSaves(record as never, writeRefused));
  return { view, record, writeRefused };
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  store.erase = 'e1';
  store.calls = [];
  store.ok = true;
  mirror.patches = [];
});
afterEach(() => { vi.useRealTimers(); });

describe('waiting: one save per row, 300 ms after its last change', () => {
  it('a change shows at once; its save waits 300 ms and carries the erase shown at the change', async () => {
    const { view, record, writeRefused } = setup();
    act(() => view.result.current.handleMedicationChange('statin', 'Atorvastatin', 20, 'mg'));
    expect(record.patchMedication).toHaveBeenCalledTimes(1);
    expect(view.result.current.medicationWaiting('statin')).toBe(true);
    store.erase = 'e2'; // an erase shown before the timer fires
    await tick(299);
    expect(store.calls).toEqual([]);
    await tick(1);
    expect(store.calls).toEqual([['med', 'statin', 'Atorvastatin', 20, 'mg', 'e1']]);
    // US-15 AC10: the chat copy takes the lists the store holds.
    expect(mirror.patches).toEqual([{ medications: [{ medicationKey: 'statin' }], screenings: [] }]);
    expect(writeRefused).not.toHaveBeenCalled();
    expect(view.result.current.medicationWaiting('statin')).toBe(false);
  });

  it('a newer change to the same row restarts its timer and only the last is saved', async () => {
    const { view } = setup();
    act(() => view.result.current.handleScreeningChange('colon', 'yes'));
    await tick(200);
    act(() => view.result.current.handleScreeningChange('colon', 'no'));
    await tick(200);
    expect(store.calls).toEqual([]);
    await tick(100);
    expect(store.calls).toEqual([['screening', 'colon', 'no', 'e1']]);
  });

  it('a screening asked for against an earlier erase (an upload) carries that erase', async () => {
    const { view } = setup();
    act(() => view.result.current.handleScreeningChange('colon', 'yes', 'e0'));
    await tick(300);
    expect(store.calls).toEqual([['screening', 'colon', 'yes', 'e0']]);
  });
});

describe('US-06 AC13, US-16 AC2a: flushed, dropped, refused', () => {
  it('flushAll runs every waiting save now, as the page goes away', async () => {
    const { view } = setup();
    act(() => {
      view.result.current.handleMedicationChange('statin', 'Atorvastatin', 20, 'mg');
      view.result.current.handleSupplementChange('vitd', 'Vitamin D', 1000, 'IU');
    });
    act(() => view.result.current.flushListSaves());
    await act(async () => {});
    expect(store.calls.map(c => c[0]).sort()).toEqual(['med', 'supplement']);
    await tick(1000);
    expect(store.calls).toHaveLength(2);
  });

  it('an erase and unmounting drop what waits, unsaved: a later flush as the page goes sends nothing', async () => {
    const first = setup();
    act(() => first.view.result.current.handleMedicationChange('statin', 'Atorvastatin', 20, 'mg'));
    act(() => first.view.result.current.dropListSaves());
    expect(first.view.result.current.medicationWaiting('statin')).toBe(false);
    act(() => first.view.result.current.flushListSaves());
    const second = setup();
    act(() => second.view.result.current.handleScreeningChange('colon', 'yes'));
    second.view.unmount();
    await tick(1000);
    expect(store.calls).toEqual([]);
  });

  it('stopping a supplement drops its waiting dose save, so the stop is not undone', async () => {
    const { view, record } = setup();
    act(() => view.result.current.handleSupplementChange('vitd', 'Vitamin D', 2000, 'IU'));
    act(() => view.result.current.handleSupplementDelete('vitd'));
    await tick(1000);
    expect(record.stopSupplement).toHaveBeenCalledWith('vitd');
    expect(store.calls).toEqual([['stop', 'vitd']]);
  });

  it('a refused medication save is reported, and the chat copy still takes the stored lists', async () => {
    const { view, writeRefused } = setup();
    store.ok = false;
    act(() => view.result.current.handleMedicationChange('statin', 'Atorvastatin', 20, 'mg'));
    await tick(300);
    expect(writeRefused).toHaveBeenCalledTimes(1);
    expect(mirror.patches).toHaveLength(1);
  });

  it('a refused supplement save is reported', async () => {
    const { view, writeRefused } = setup();
    store.ok = false;
    act(() => view.result.current.handleSupplementChange('vitd', 'Vitamin D', 1000, 'IU'));
    await tick(300);
    expect(writeRefused).toHaveBeenCalledTimes(1);
  });
});
