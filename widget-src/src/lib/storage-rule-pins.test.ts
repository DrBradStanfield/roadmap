// @vitest-environment jsdom
// Rules in lib/storage.ts (the device mirror the chatbot embed and blog bubble
// read) that no existing test pinned. Each test fails when one small change to
// the rule it names is made in storage.ts, a change the existing tests that
// use the module still pass with.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import {
  saveToLocalStorage, loadFromLocalStorage, clearOffFileHealthData,
  saveUnitPreference, loadUnitPreference, getJson, loadGuestInputs,
  MIRROR_KEY, DOC_KEY_PREFIX,
} from './storage';

const row = (metricType: string, value: number, day = '2026-09-01'): ApiMeasurement => ({
  id: metricType, metricType, value, recordedAt: `${day}T00:00:00Z`, createdAt: `${day}T00:00:00Z`,
});
const PROFILE = { heightCm: 178, sex: 'male' as const, birthYear: 1970, unitSystem: 'si' as const };
const SAVED = [row('weight', 82), row('ldl', 3.1)];
const LAB = { labEgfr: 40, labEgfrDate: '2026-09-01' };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('mirror writes and reads', () => {
  it('a full or refused storage never throws out of a mirror write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(() => saveToLocalStorage(PROFILE, SAVED, [], [])).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('a corrupt mirror reads as null and never throws', () => {
    localStorage.setItem(MIRROR_KEY, '{not json');
    expect(() => loadFromLocalStorage()).not.toThrow();
    expect(loadFromLocalStorage()).toBeNull();
  });

  it('a saved value of 0 (an undetectable PSA or Lp(a)) is kept', () => {
    saveToLocalStorage(PROFILE, [row('psa', 0), row('lpa', 0)], [], []);
    expect(loadFromLocalStorage()!.previousMeasurements.map((m) => m.value)).toEqual([0, 0]);
  });
});

describe('US-11: erase', () => {
  it('clearOffFileHealthData with no keeper removes every document blob', () => {
    localStorage.setItem(`${DOC_KEY_PREFIX}a`, 'blob-a');
    localStorage.setItem(`${DOC_KEY_PREFIX}b`, 'blob-b');
    clearOffFileHealthData();
    expect(localStorage.getItem(`${DOC_KEY_PREFIX}a`)).toBeNull();
    expect(localStorage.getItem(`${DOC_KEY_PREFIX}b`)).toBeNull();
  });
});

describe('unit preference and JSON accessors', () => {
  it('a refused write never throws out of saveUnitPreference', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(() => saveUnitPreference('si')).not.toThrow();
  });

  it('storage that throws on read (sandboxed iframe) reads as no preference', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(() => loadUnitPreference()).not.toThrow();
    expect(loadUnitPreference()).toBeNull();
  });

  it('getJson reads a corrupt value as null', () => {
    localStorage.setItem('k', '{not json');
    expect(() => getJson('k')).not.toThrow();
    expect(getJson('k')).toBeNull();
  });
});

describe('loadGuestInputs (the blog bubble and chatbot embed context)', () => {
  it('US-07 AC7: the creatinine row\'s own day, not another row\'s, decides against the lab eGFR', () => {
    // Creatinine before the lab's day: the lab's eGFR is the plan's. The other
    // rows are newer than the lab, and sort either side of 'creatinine'.
    saveToLocalStorage(PROFILE, [row('weight', 82, '2026-10-01'), row('apob', 0.9, '2026-10-01'), row('creatinine', 80, '2026-08-01')], [], [], [], LAB);
    expect(loadGuestInputs()).toMatchObject(LAB);
  });
});
