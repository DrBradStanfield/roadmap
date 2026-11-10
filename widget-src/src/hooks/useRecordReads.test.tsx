// @vitest-environment jsdom
/**
 * US-21, US-07 AC7, US-15 AC10: the page's reads of the record. Page
 * journeys: HealthTool.record-read-pins.test.tsx; these check the hook's own
 * rules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';

const data = vi.hoisted(() => ({
  /** Hold lab reads until the test answers them; otherwise each answers `labRows` at once. */
  hold: false,
  labRows: [] as unknown,
  labReads: [] as Array<{ resolve: (rows: unknown) => void }>,
  latest: null as unknown,
  history: [] as unknown[],
}));
vi.mock('../lib/roadmap-data', () => ({
  loadLabValues: () => (data.hold
    ? new Promise(resolve => { data.labReads.push({ resolve }); })
    : Promise.resolve(data.labRows)),
  loadAllHistory: async () => data.history,
  loadAllHistorySync: () => [],
  loadLatestMeasurements: async () => data.latest,
}));
const mirror = vi.hoisted(() => ({ saved: [] as unknown[][], patches: [] as unknown[], cached: null as unknown }));
vi.mock('../lib/storage', () => ({
  saveToLocalStorage: (...a: unknown[]) => { mirror.saved.push(a); },
  patchMirror: (p: unknown) => { mirror.patches.push(p); },
  loadFromLocalStorage: () => mirror.cached,
}));

import { useRecordReads } from './useRecordReads';

const egfrRow = (value: number) => ({ id: `r${value}`, metricKey: 'egfr', value, unit: 'mL/min/1.73m²', recordedAt: '2026-11-01T00:00:00Z' });

function setup() {
  const setters = { setPreviousMeasurements: vi.fn(), setHistory: vi.fn(), setLabValueHistory: vi.fn() };
  const view = renderHook(() => useRecordReads(setters as never));
  return { view, setters };
}

beforeEach(() => {
  data.labReads = []; data.latest = null; data.history = []; data.hold = true; data.labRows = [];
  mirror.saved = []; mirror.patches = []; mirror.cached = null;
});

describe('US-21: the lab rows', () => {
  it('an older read that answers after a newer one is dropped', async () => {
    const { view, setters } = setup();
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { first = view.result.current.refreshLabValues(); second = view.result.current.refreshLabValues(); });
    await act(async () => { data.labReads[1].resolve([egfrRow(50)]); await second; });
    await act(async () => { data.labReads[0].resolve([egfrRow(40)]); await first; });
    expect(setters.setLabValueHistory).toHaveBeenCalledTimes(1);
    expect(setters.setLabValueHistory).toHaveBeenCalledWith([egfrRow(50)]);
  });

  it('a failed read (null) keeps the rows shown', async () => {
    const { view, setters } = setup();
    let read!: Promise<void>;
    act(() => { read = view.result.current.refreshLabValues(); });
    await act(async () => { data.labReads[0].resolve(null); await read; });
    expect(setters.setLabValueHistory).not.toHaveBeenCalled();
  });

  it('US-07 AC7: a changed lab eGFR is patched into an existing chat mirror; an unchanged one is not', async () => {
    const { view } = setup();
    mirror.cached = { labEgfr: null };
    let read!: Promise<void>;
    act(() => { read = view.result.current.refreshLabValues(); });
    await act(async () => { data.labReads[0].resolve([egfrRow(40)]); await read; });
    expect(mirror.patches).toHaveLength(1);
    mirror.cached = mirror.patches[0];
    act(() => { read = view.result.current.refreshLabValues(); });
    await act(async () => { data.labReads[1].resolve([egfrRow(40)]); await read; });
    expect(mirror.patches).toHaveLength(1);
  });
});

describe('US-15 AC10: reloadValues', () => {
  it('replaces the plan\'s values, writes the mirror, re-reads labs and history, and hands back what it read', async () => {
    const { view, setters } = setup();
    const latest = { inputs: { heightCm: 170 }, previousMeasurements: [{ metricType: 'weight', value: 70 }], medications: [], screenings: [] };
    data.latest = latest;
    data.history = [{ metricType: 'weight', value: 70 }];
    data.hold = false;
    let got: unknown;
    await act(async () => { got = await view.result.current.reloadValues(); });
    expect(got).toBe(latest);
    expect(setters.setPreviousMeasurements).toHaveBeenCalledWith(latest.previousMeasurements);
    expect(mirror.saved).toHaveLength(1);
    expect(mirror.saved[0].slice(0, 4)).toEqual([latest.inputs, latest.previousMeasurements, [], []]);
    expect(setters.setHistory).toHaveBeenCalledWith(data.history);
    expect(setters.setLabValueHistory).toHaveBeenCalledWith([]);
  });

  it('nothing on record: no values replaced and no mirror written, but labs and history are still read', async () => {
    const { view, setters } = setup();
    data.hold = false;
    await act(async () => { await view.result.current.reloadValues(); });
    expect(setters.setPreviousMeasurements).not.toHaveBeenCalled();
    expect(mirror.saved).toEqual([]);
    expect(setters.setHistory).toHaveBeenCalled();
  });
});
