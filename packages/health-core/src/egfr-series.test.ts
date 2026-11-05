// US-73 AC7 (with US-07 AC7, AC8 and US-12 AC20, AC11): the eGFR row's history, one value a day,
// the lab's printed eGFR or ours from that day's core creatinine at the age on that day.
// Synthetic values.
import { describe, expect, it } from 'vitest';
import { ageOnDay, calculateAge, calculateEGFR } from './calculations';
import { createCoreRow } from './blood-tests';
import { computePlan, egfrSeries, whtrSeries } from './plan';
import { createEmptyFile, createMeasurement, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';
const creatinine = (id: string, value: number, day: string, extra: Partial<FileLabValue> = {}) =>
  createCoreRow({ id, metric: 'creatinine', value, recordedAt: `${day}T00:00:00.000Z`, createdAt: NOW, source: 'manual', ...extra });
const lab = (id: string, metricName: string, value: number, unit: string, day: string, extra: Partial<FileLabValue> = {}): FileLabValue => ({
  id, metricName, value, unit, referenceLow: null, referenceHigh: null, recordedAt: `${day}T00:00:00.000Z`, createdAt: NOW,
  source: 'lab_import', status: 'active', correctsId: null, ...extra,
});
const EGFR = 'mL/min/1.73m²';

function record(labValues: FileLabValue[], profile: Partial<RoadmapFile['profile']> = { sex: 'male', birthYear: 1976, birthMonth: 6 }): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'd', now: NOW });
  return { ...file, profile: { ...file.profile, heightCm: 178, ...profile }, labValues };
}
const ours = (value: number, age: number) => Math.round(calculateEGFR(value, age, 'male'));

describe('ageOnDay (US-73 AC7)', () => {
  it('counts a year from the birth month, January when it is not known, as calculateAge does', () => {
    expect(ageOnDay(1976, 6, '2020-05-31')).toBe(43);
    expect(ageOnDay(1976, 6, '2020-06-01')).toBe(44);
    expect(ageOnDay(1976, undefined, '2020-01-01')).toBe(44);
    expect(ageOnDay(2030, 1, '2020-01-01')).toBe(0);
    expect(ageOnDay(1976, 6, '2026-10-21')).toBe(calculateAge(1976, 6, new Date(NOW)));
  });
});

describe('egfrSeries (US-73 AC7)', () => {
  it('works out each day\'s eGFR from the core creatinine with the age on that day, newest first', () => {
    const points = egfrSeries(record([creatinine('c1', 80, '2020-05-01'), creatinine('c2', 90, '2024-07-01')]));
    expect(points).toEqual([
      { id: 'c2', day: '2024-07-01', value: ours(90, 48), source: 'calculated' },
      { id: 'c1', day: '2020-05-01', value: ours(80, 43), source: 'calculated' },
    ]);
  });

  it('a lab eGFR wins its day, rounded as the plan rounds it; another day keeps ours', () => {
    const points = egfrSeries(record([
      creatinine('c1', 80, '2025-01-10'), lab('e1', 'eGFR', 71.6, EGFR, '2025-01-10'), creatinine('c2', 85, '2025-08-01'),
    ]));
    expect(points.map((p) => [p.day, p.value, p.source, p.id])).toEqual([
      ['2025-08-01', ours(85, 49), 'calculated', 'c2'],
      ['2025-01-10', 72, 'lab', 'e1'],
    ]);
  });

  it('a value printed as a limit gives its day no point: a lab eGFR limit holds the day, a creatinine limit gives none (US-12 AC20)', () => {
    const points = egfrSeries(record([
      creatinine('c1', 80, '2025-01-10'), lab('e1', 'eGFR', 90, EGFR, '2025-01-10', { comparator: '>' }),
      creatinine('c2', 60, '2025-03-10', { comparator: '<' }),
      creatinine('c3', 85, '2025-08-01'),
    ]));
    expect(points.map((p) => p.day)).toEqual(['2025-08-01']);
  });

  it('only the core creatinine counts: a kept-apart "creatinine" row may be urine (US-12 AC11)', () => {
    expect(egfrSeries(record([lab('k1', 'creatinine', 80, 'µmol/L', '2025-01-10')]))).toEqual([]);
  });

  it('a lab eGFR the plan would not read (another unit, out of range, cystatin C) is no lab point', () => {
    const points = egfrSeries(record([
      lab('e1', 'eGFR', 70, 'mL/min', '2025-01-10'), lab('e2', 'eGFR (cystatin C)', 70, EGFR, '2025-02-10'), creatinine('c1', 80, '2025-01-10'),
    ]));
    expect(points).toEqual([{ id: 'c1', day: '2025-01-10', value: ours(80, 48), source: 'calculated' }]);
  });

  it('skips entered-in-error rows', () => {
    const points = egfrSeries(record([
      creatinine('c1', 80, '2025-01-10', { status: 'entered-in-error' }), lab('e1', 'eGFR', 70, EGFR, '2025-02-10', { status: 'entered-in-error' }),
    ]));
    expect(points).toEqual([]);
  });

  it('sex and birth year gate only the calculated points (US-07 AC8)', () => {
    const rows = [creatinine('c1', 80, '2025-01-10'), lab('e1', 'eGFR', 70, EGFR, '2025-02-10')];
    for (const profile of [{ sex: undefined, birthYear: 1976 }, { sex: 'male' as const, birthYear: undefined }]) {
      expect(egfrSeries(record(rows, profile)).map((p) => [p.id, p.source])).toEqual([['e1', 'lab']]);
    }
  });

  it('no calculated point from a creatinine taken under 18; a lab one stands (Brad 2026-11-05)', () => {
    const points = egfrSeries(record([
      creatinine('c1', 60, '2025-05-31'), creatinine('c2', 60, '2025-06-01'), lab('e1', 'eGFR', 110, EGFR, '2024-01-10'),
    ], { sex: 'male', birthYear: 2007, birthMonth: 6 }));
    expect(points.map((p) => [p.id, p.source])).toEqual([['c2', 'calculated'], ['e1', 'lab']]);
    expect(points[0].value).toBe(ours(60, 18));
  });

  // US-07 AC7: the plan's own minor gate, a known minor today OR on the creatinine's day,
  // a missing birth month a minor until 1 January after the 18th birthday.
  it('no calculated point while a known minor today: born 2008, no month, creatinine 2026-06-01', () => {
    const file = record([creatinine('c1', 60, '2026-06-01')], { sex: 'male', birthYear: 2008, birthMonth: undefined });
    expect(egfrSeries(file, new Date(NOW))).toEqual([]);
    expect(computePlan(file, new Date(NOW)).results.eGFR).toBeUndefined();
  });

  it('no calculated point from a known minor on its day: born 2007, no month, creatinine 2025-03-01', () => {
    const file = record([creatinine('c1', 60, '2025-03-01')], { sex: 'male', birthYear: 2007, birthMonth: undefined });
    expect(egfrSeries(file, new Date(NOW))).toEqual([]);
    expect(computePlan(file, new Date(NOW)).results.eGFR).toBeUndefined();
  });

  it('a birth month out of range is dropped as the plan drops it: the age counts from January', () => {
    const file = record([creatinine('c1', 80, '2025-12-01')], { sex: 'male', birthYear: 1976, birthMonth: 13 });
    const [newest] = egfrSeries(file, new Date(NOW));
    expect(newest.value).toBe(ours(80, 49));
    expect(newest.value).toBe(computePlan(file, new Date(NOW)).results.eGFR);
  });

  it('the newest point is the plan\'s tile value when the age on its day is not today\'s', () => {
    // Born June 1976: 48 on 2025-01-10, 50 today.
    const file = record([creatinine('c1', 80, '2025-01-10')]);
    const [newest] = egfrSeries(file, new Date(NOW));
    expect(newest.value).toBe(ours(80, 48));
    expect(newest.value).not.toBe(ours(80, 50));
    expect(newest.value).toBe(computePlan(file, new Date(NOW)).results.eGFR);
  });

  it('a legacy row with no status is active: a lab-only history (US-73 AC7)', () => {
    const points = egfrSeries(record([lab('e1', 'eGFR', 70, EGFR, '2025-02-10', { status: undefined as never })]), new Date(NOW));
    expect(points).toEqual([{ id: 'e1', day: '2025-02-10', value: 70, source: 'lab' }]);
  });

  it('a legacy custom lab row with no status is listed in the plan\'s labs, so get_plan agrees with the page (US-73 AC8)', () => {
    const file = record([lab('z1', 'Zinc custom', 80, 'µg/dL', '2025-02-10', { status: undefined as never })]);
    expect(computePlan(file, new Date(NOW)).labs.map((l) => l.id)).toEqual(['z1']);
  });

  it('a legacy lab eGFR with no status still wins its day over the creatinine', () => {
    const points = egfrSeries(record([
      creatinine('c1', 80, '2025-02-10', { status: undefined as never }), lab('e1', 'eGFR', 64, EGFR, '2025-02-10', { status: undefined as never }),
    ]), new Date(NOW));
    expect(points).toEqual([{ id: 'e1', day: '2025-02-10', value: 64, source: 'lab' }]);
  });

  it('the newest point is the plan\'s eGFR when the age on its day is today\'s', () => {
    const calculated = record([lab('e1', 'eGFR', 70, EGFR, '2025-02-10'), creatinine('c1', 95, '2026-07-01')]);
    expect(egfrSeries(calculated)[0].value).toBe(computePlan(calculated, new Date(NOW)).results.eGFR);
    const printed = record([creatinine('c1', 95, '2026-07-01'), lab('e1', 'eGFR', 64, EGFR, '2026-07-01')]);
    expect(egfrSeries(printed)[0]).toMatchObject({ value: 64, source: 'lab' });
    expect(computePlan(printed, new Date(NOW)).results.eGFR).toBe(64);
  });
});

describe('whtrSeries (US-73 AC7)', () => {
  const waist = (id: string, value: number, recordedAt: string, extra: Partial<FileMeasurement> = {}) =>
    createMeasurement({ id, metricType: 'waist', value, recordedAt, createdAt: NOW, source: 'manual', ...extra });
  const file = (measurements: FileMeasurement[], heightCm?: number): RoadmapFile => ({ ...record([], { heightCm }), measurements });

  it('is each day\'s waist over the current height, to two places, newest first; none without a height', () => {
    const rows = [waist('w1', 88, '2026-01-01T00:00:00.000Z'), waist('w2', 92.7, '2026-06-01T00:00:00.000Z'),
      waist('w3', 120, '2026-07-01T00:00:00.000Z', { status: 'entered-in-error' })];
    expect(whtrSeries(file(rows, 180))).toEqual([{ id: 'w2', day: '2026-06-01', ratio: 0.52 }, { id: 'w1', day: '2026-01-01', ratio: 0.49 }]);
    expect(whtrSeries(file(rows, undefined))).toEqual([]);
  });

  it('a waist printed as a limit holds its day: no ratio from it, nor from an earlier waist that day (US-12 AC20)', () => {
    const rows = [waist('w1', 88, '2026-06-01T07:00:00.000Z'), waist('w2', 95, '2026-06-01T09:00:00.000Z', { comparator: '>' })];
    expect(whtrSeries(file(rows, 180))).toEqual([]);
  });
});
