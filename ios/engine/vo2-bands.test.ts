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

// Brad 2026-10-27: from 60, the Low line (p20) is Apple's Low Cardio Fitness alert line: 18 for men, 15 for women.
describe("vo2Bands from 60: Apple's Low line (US-56 AC8)", () => {
  it.each([
    ['male', 1961, { fromAge: 60, toAge: 69, p20: 18, p50: 24.6, p80: 32.0 }],
    ['male', 1951, { fromAge: 70, toAge: 79, p20: 18, p50: 20.6, p80: 25.9 }],
    ['male', 1941, { fromAge: 80, toAge: 89, p20: 18, p50: 17.6, p80: 21.4 }],
    ['female', 1961, { fromAge: 60, toAge: 69, p20: 15, p50: 19.6, p80: 24.3 }],
    ['female', 1951, { fromAge: 70, toAge: 79, p20: 15, p50: 17.2, p80: 20.8 }],
    ['female', 1941, { fromAge: 80, toAge: 89, p20: 15, p50: 15.4, p80: 18.4 }],
  ] as const)('%s born %i: the Low line is Apple\'s, P50 and P80 are FRIEND\'s', (sex, year, row) => {
    expect(person(sex, year, 1)).toEqual({ sex, ...row });
  });

  it('men 80 to 89: the Low line sits above the median, so Below Average is empty', () => {
    const row = person('male', 1941, 1)!;
    expect(row.p20).toBeGreaterThan(row.p50);
  });

  it('turns at 60: FRIEND P20 at 59, Apple\'s line at 60', () => {
    expect(person('male', 1967, 1)?.p20).toBe(22.2); // 59
    expect(person('male', 1966, 1)?.p20).toBe(18); // 60
    expect(person('female', 1967, 1)?.p20).toBe(18.5); // 59
    expect(person('female', 1966, 1)?.p20).toBe(15); // 60
  });
});
