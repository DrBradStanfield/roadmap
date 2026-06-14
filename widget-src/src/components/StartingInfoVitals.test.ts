import { describe, it, expect } from 'vitest';
import type { ApiMeasurement } from '@roadmap/health-core';
import { buildColumns } from './StartingInfoVitals';

// `buildColumns` is the one genuinely new pure helper introduced when the
// vitals section was unified onto the blood-test matrix's column grid: it
// folds the flat vitals history into one column per distinct date (sparse),
// pairs systolic+diastolic into the same column, and sorts oldest → newest.

function m(metricType: string, value: number, date: string, id = `${metricType}-${date}`): ApiMeasurement {
  return {
    id, metricType, value,
    recordedAt: `${date}T09:00:00.000Z`,
    createdAt: `${date}T09:00:00.000Z`,
    source: 'manual', status: 'active', correctsId: null, externalId: null,
  };
}

describe('buildColumns', () => {
  it('returns one column per distinct date, sorted oldest → newest', () => {
    const cols = buildColumns([
      m('weight', 80, '2025-06-01'),
      m('weight', 88, '2024-03-01'),
      m('weight', 85, '2024-12-15'),
    ]);
    expect(cols.map(c => c.date)).toEqual(['2024-03-01', '2024-12-15', '2025-06-01']);
    expect(cols.map(c => c.weight)).toEqual([88, 85, 80]);
  });

  it('pairs systolic + diastolic recorded on the same date into one column', () => {
    const cols = buildColumns([
      m('systolic_bp', 138, '2024-03-01'),
      m('diastolic_bp', 88, '2024-03-01'),
    ]);
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ date: '2024-03-01', sys: 138, dia: 88 });
  });

  it('keeps cells sparse — a date with only a weight has undefined waist/bp', () => {
    const cols = buildColumns([
      m('weight', 85, '2024-12-15'),
      m('weight', 88, '2024-03-01'),
      m('waist', 98, '2024-03-01'),
    ]);
    const visit = cols.find(c => c.date === '2024-03-01')!;
    const weighIn = cols.find(c => c.date === '2024-12-15')!;
    expect(visit).toMatchObject({ weight: 88, waist: 98 });
    expect(weighIn.weight).toBe(85);
    expect(weighIn.waist).toBeUndefined();
    expect(weighIn.sys).toBeUndefined();
  });

  it('groups all four vitals measured at one visit into a single column', () => {
    const cols = buildColumns([
      m('weight', 80, '2025-06-01'),
      m('waist', 89, '2025-06-01'),
      m('systolic_bp', 122, '2025-06-01'),
      m('diastolic_bp', 79, '2025-06-01'),
    ]);
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ weight: 80, waist: 89, sys: 122, dia: 79 });
  });

  it('carries the row id for each value (needed for click-to-correct)', () => {
    const cols = buildColumns([
      m('weight', 80, '2025-06-01', 'w1'),
      m('waist', 89, '2025-06-01', 'wa1'),
    ]);
    expect(cols[0].weightId).toBe('w1');
    expect(cols[0].waistId).toBe('wa1');
  });

  it('collapses to a date-keyed column even when only the day differs by time', () => {
    const cols = buildColumns([
      m('weight', 80, '2025-06-01'),
      { ...m('waist', 89, '2025-06-01'), recordedAt: '2025-06-01T18:30:00.000Z' },
    ]);
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ weight: 80, waist: 89 });
  });

  it('returns an empty array for no measurements', () => {
    expect(buildColumns([])).toEqual([]);
  });
});
