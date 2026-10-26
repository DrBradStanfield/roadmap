// US-56 AC8: the engine serves the person's VO2 max band row (FRIEND 2022, vo2max-bands.ts)
// on My data, for their age today. No VO2 max value enters the engine (AC1).
import { describe, expect, it } from 'vitest';
import { myData, newRecord } from './my-data';
import { stampProfile } from '../../packages/health-core/src/state-edits';

const NOW = '2026-10-15T12:00:00.000Z';
const person = (sex?: 'male' | 'female', birthYear?: number, birthMonth?: number) =>
  myData(stampProfile(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { sex, birthYear, birthMonth }, NOW), NOW).vo2Bands;

describe('vo2Bands on My data (US-56 AC8)', () => {
  it('is the FRIEND 2022 row for the person\'s sex and age decade', () => {
    expect(person('female', 1984, 6)).toEqual({ sex: 'female', fromAge: 40, toAge: 49, p20: 19.7, p50: 25.7, p80: 33.0 });
    expect(person('male', 1960, 1)).toEqual({ sex: 'male', fromAge: 60, toAge: 69, p20: 18.5, p50: 24.6, p80: 32.0 });
  });

  it('covers ages 20 to 89 only', () => {
    expect(person('male', 2007, 1)).toBeNull(); // 19
    expect(person('male', 2006, 1)?.fromAge).toBe(20);
    expect(person('female', 1937, 1)?.fromAge).toBe(80); // 89
    expect(person('female', 1936, 1)).toBeNull(); // 90
  });

  it('turns over at the birth month, January when none is recorded', () => {
    expect(person('male', 1996, 11)?.fromAge).toBe(20); // 29 until November
    expect(person('male', 1996, 10)?.fromAge).toBe(30); // 30 in October
    expect(person('male', 1996)?.fromAge).toBe(30);
  });

  it('is null without a sex or a birth year', () => {
    expect(person(undefined, 1980, 1)).toBeNull();
    expect(person('male', undefined, 1)).toBeNull();
  });
});
