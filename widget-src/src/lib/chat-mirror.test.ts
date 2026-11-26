// @vitest-environment jsdom
/**
 * US-34 AC11, US-15 AC10: the chat mirror is made by one function from saved
 * values, its derived fields (the lab eGFR, the PSA and its `raisedBefore`)
 * worked out there for every writer. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiMeasurement, ApiScreening } from '@roadmap/health-core/mappings';
import type { ApiLabValue } from './api-types';

const store = vi.hoisted(() => ({ latest: null as unknown, labRows: null as unknown, history: [] as unknown[] }));
vi.mock('./roadmap-data', () => ({
  loadLatestMeasurementsSync: () => store.latest,
  loadLabValuesSync: () => store.labRows,
  loadAllHistorySync: () => store.history,
}));

import { mirrorOf, NO_RECORD, writeMirror, type MirrorSources } from './chat-mirror';
import { loadFromLocalStorage, MIRROR_KEY, saveToLocalStorage } from './storage';

const NOW = new Date('2026-11-12T12:00:00Z');
const psa = (id: string, value: number, day: string, comparator?: '<'): ApiMeasurement =>
  ({ id, metricType: 'psa', value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T09:00:00.000Z`, status: 'active', ...(comparator && { comparator }) }) as ApiMeasurement;
const VAGUE = psa('vague', 5, '2026-06-01', '<');
const answer = (screeningKey: string, value: string): ApiScreening => ({ id: screeningKey, screeningKey, value, updatedAt: '2026-01-01T00:00:00.000Z' });
/** Old PSA answers on record: 6.5 in March 2026 (US-06 AC14). */
const RAISED_ANSWERS = [answer('prostate_psa_value', '6.5'), answer('prostate_last_date', '2026-03')];
const egfr = (value: number, day: string): ApiLabValue =>
  ({ id: `e${value}`, metricName: 'eGFR', value, unit: 'mL/min/1.73m²', referenceLow: null, referenceHigh: null, recordedAt: `${day}T00:00:00Z`, source: 'manual', createdAt: `${day}T09:00:00Z` });
const sources = (over: Partial<MirrorSources>): MirrorSources => ({ ...NO_RECORD, ...over });

describe('mirrorOf: the whole mirror from saved values (US-34 AC11)', () => {
  it.each<[string, Partial<MirrorSources>, { psa: unknown; raised: boolean; labEgfr: unknown }]>([
    ['nothing on record', {}, { psa: null, raised: false, labEgfr: null }],
    ['a "< 5" PSA, no old answer: no flag', { history: [VAGUE] }, { psa: 'vague', raised: false, labEgfr: null }],
    ['a "< 5" PSA after an old raised answer: flagged', { history: [VAGUE], screenings: RAISED_ANSWERS }, { psa: 'vague', raised: true, labEgfr: null }],
    ['the same lists without the history: no PSA', { screenings: RAISED_ANSWERS }, { psa: null, raised: false, labEgfr: null }],
    ['a lab eGFR', { labRows: [egfr(40, '2026-10-01'), egfr(55, '2026-11-01')] }, { psa: null, raised: false, labEgfr: { labEgfr: 55, labEgfrDate: '2026-11-01' } }],
  ])('%s', (_name, over, want) => {
    const m = mirrorOf(sources(over), NOW);
    expect(m.psa?.id ?? null).toBe(want.psa);
    expect(m.psa?.raisedBefore === true).toBe(want.raised);
    if (want.labEgfr) expect(m.labEgfr).toMatchObject(want.labEgfr);
    else expect(m.labEgfr).toBeNull();
  });

  it('carries the saved profile, latest values and lists as given', () => {
    const profile = { sex: 'male' as const, birthYear: 1962 };
    const m = mirrorOf(sources({ profile, latest: [VAGUE], medications: [], screenings: RAISED_ANSWERS }), NOW);
    expect(m).toMatchObject({ inputs: profile, previousMeasurements: [VAGUE], medications: [], screenings: RAISED_ANSWERS });
  });
});

describe('writeMirror: what a writer leaves out (US-34 AC11)', () => {
  beforeEach(() => { store.latest = null; store.labRows = null; store.history = []; });
  afterEach(() => { localStorage.clear(); });

  it('the profile and lists from the mirror, the measurements and lab rows from the store; the flag from both', () => {
    saveToLocalStorage({ sex: 'male', birthYear: 1962 }, [], [], RAISED_ANSWERS);
    store.latest = { previousMeasurements: [VAGUE] };
    store.history = [VAGUE];
    store.labRows = [egfr(55, '2026-11-01')];
    writeMirror({ medications: [] });
    const m = loadFromLocalStorage()!;
    expect(m.inputs).toEqual({ sex: 'male', birthYear: 1962 });
    expect(m.screenings).toEqual(RAISED_ANSWERS);
    expect(m.previousMeasurements.map((r) => r.id)).toEqual(['vague']);
    expect(m.psa).toMatchObject({ id: 'vague', raisedBefore: true });
    expect(m.labEgfr).toMatchObject({ labEgfr: 55 });
  });

  it('a malformed stored mirror (screenings [null]) never makes a write throw: the save that writes it goes on (US-34 AC11)', () => {
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ inputs: { sex: 'male' }, medications: [], screenings: [null] }));
    expect(() => writeMirror({ profile: { sex: 'female' } })).not.toThrow();
    expect(() => writeMirror({ medications: [] })).not.toThrow();
  });

  it('NO_RECORD empties every field, whatever the store holds', () => {
    saveToLocalStorage({ sex: 'male' }, [VAGUE], [], RAISED_ANSWERS, null, { ...VAGUE, raisedBefore: true });
    store.history = [VAGUE];
    store.labRows = [egfr(55, '2026-11-01')];
    writeMirror(NO_RECORD);
    expect(loadFromLocalStorage()).toMatchObject({ inputs: {}, previousMeasurements: [], medications: [], screenings: [], labEgfr: null, psa: null });
  });
});
