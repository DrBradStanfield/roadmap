/**
 * US-21 phase 1 — grouping/series logic for the read-only additional-lab
 * rows surfaced beneath the core blood-test matrix.
 */
import { describe, it, expect } from 'vitest';
import { groupLabValues, countLabValuePoints, labGroupMatrix } from './lab-rows';
import type { ApiLabValue } from './api-types';

function row(overrides: Partial<ApiLabValue> & { status?: string }): ApiLabValue & { status?: string } {
  return {
    id: 'id-' + Math.random(),
    metricName: 'sodium',
    value: 140,
    unit: 'mmol/L',
    referenceLow: null,
    referenceHigh: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
    source: 'lab_import',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('US-21: groupLabValues', () => {
  it('groups a catalogued metric into its panel with the LAB_GROUPS order', () => {
    const groups = groupLabValues([
      row({ metricName: 'crp', value: 2.1, unit: 'mg/L' }),
      row({ metricName: 'sodium', value: 139, unit: 'mmol/L' }),
    ]);
    const ids = groups.map(g => g.id);
    // renal comes before inflammation in LAB_GROUPS.
    expect(ids.indexOf('renal')).toBeLessThan(ids.indexOf('inflammation'));
    const renal = groups.find(g => g.id === 'renal');
    expect(renal?.series[0].label).toBe('Sodium');
  });

  it('resolves aliases case/spelling-insensitively (Gamma GT -> ggt)', () => {
    const groups = groupLabValues([row({ metricName: 'Gamma GT', value: 30, unit: 'U/L' })]);
    const liver = groups.find(g => g.id === 'liver');
    expect(liver).toBeDefined();
    expect(liver!.series).toHaveLength(1);
    expect(liver!.series[0].seriesKey).toBe('ggt');
    expect(liver!.series[0].label).toBe('GGT');
  });

  it('resolves underscore-vs-space alias variance (free_t4 -> ft4)', () => {
    const groups = groupLabValues([row({ metricName: 'free_t4', value: 15, unit: 'pmol/L' })]);
    const thyroid = groups.find(g => g.id === 'thyroid');
    expect(thyroid?.series[0].seriesKey).toBe('ft4');
  });

  it('buckets uncatalogued names into the trailing "other" group', () => {
    const groups = groupLabValues([row({ metricName: 'haemoglobin', value: 145, unit: 'g/L' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('other');
    expect(groups[0].label).toBe('Other tests');
    expect(groups[0].icon).toBe('flask');
    expect(groups[0].series[0].label).toBe('Haemoglobin');
  });

  it('merges LLM re-extraction spelling drift into the same series via the catalogue key', () => {
    const groups = groupLabValues([
      row({ id: 'a', metricName: 'gamma gt', value: 30, unit: 'U/L', recordedAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'b', metricName: 'GGT', value: 32, unit: 'U/L', recordedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    const liver = groups.find(g => g.id === 'liver')!;
    expect(liver.series).toHaveLength(1);
    expect(liver.series[0].points).toHaveLength(2);
  });

  it('filters entered-in-error rows', () => {
    const groups = groupLabValues([
      row({ metricName: 'sodium', value: 139, status: 'active' }),
      row({ metricName: 'sodium', value: 999, status: 'entered-in-error', recordedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    const renal = groups.find(g => g.id === 'renal')!;
    expect(renal.series[0].points).toHaveLength(1);
    expect(renal.series[0].points[0].value).toBe(139);
  });

  it('sorts a series ascending by recordedAt (oldest first)', () => {
    const groups = groupLabValues([
      row({ id: 'later', metricName: 'sodium', value: 141, recordedAt: '2026-03-01T00:00:00.000Z' }),
      row({ id: 'earlier', metricName: 'sodium', value: 139, recordedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    const renal = groups.find(g => g.id === 'renal')!;
    expect(renal.series[0].points.map(p => p.id)).toEqual(['earlier', 'later']);
  });

  it('flags mixedUnits when a series has more than one distinct unit', () => {
    const groups = groupLabValues([
      row({ metricName: 'crp', value: 2.1, unit: 'mg/L', recordedAt: '2026-01-01T00:00:00.000Z' }),
      row({ metricName: 'crp', value: 0.2, unit: 'mg/dL', recordedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    const inflammation = groups.find(g => g.id === 'inflammation')!;
    expect(inflammation.series[0].mixedUnits).toBe(true);
    // Display unit is the most recent point's unit.
    expect(inflammation.series[0].unit).toBe('mg/dL');
  });

  it('does not flag mixedUnits when a series has one unit', () => {
    const groups = groupLabValues([
      row({ metricName: 'crp', value: 2.1, unit: 'mg/L', recordedAt: '2026-01-01T00:00:00.000Z' }),
      row({ metricName: 'crp', value: 2.3, unit: 'mg/L', recordedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    const inflammation = groups.find(g => g.id === 'inflammation')!;
    expect(inflammation.series[0].mixedUnits).toBe(false);
  });

  it('returns an empty array for no rows', () => {
    expect(groupLabValues([])).toEqual([]);
  });

  it('omits empty groups entirely (no rows -> no "other" group either)', () => {
    const groups = groupLabValues([row({ metricName: 'sodium' })]);
    expect(groups).toHaveLength(1);
    expect(groups.some(g => g.id === 'other')).toBe(false);
    expect(groups.some(g => g.id === 'liver')).toBe(false);
  });
});

describe('US-21 AC1: labGroupMatrix', () => {
  it('unions dates across series, ascending, and indexes points by seriesKey + day', () => {
    const groups = groupLabValues([
      row({ id: 'na1', metricName: 'sodium', value: 139, recordedAt: '2026-01-10T00:00:00.000Z' }),
      row({ id: 'na2', metricName: 'sodium', value: 141, recordedAt: '2026-05-12T00:00:00.000Z' }),
      row({ id: 'k1', metricName: 'potassium', value: 4.7, unit: 'mmol/L', recordedAt: '2026-05-12T00:00:00.000Z' }),
    ]);
    const renal = groups.find(g => g.id === 'renal')!;
    const { dates, points } = labGroupMatrix(renal);
    expect(dates).toEqual(['2026-01-10', '2026-05-12']);
    expect(points['sodium']['2026-01-10'].id).toBe('na1');
    expect(points['sodium']['2026-05-12'].id).toBe('na2');
    expect(points['potassium']['2026-01-10']).toBeUndefined();
    expect(points['potassium']['2026-05-12'].id).toBe('k1');
  });

  it('two same-day points in one series: the later recordedAt wins (LWW, like the core matrix)', () => {
    const groups = groupLabValues([
      row({ id: 'am', metricName: 'sodium', value: 138, recordedAt: '2026-01-10T08:00:00.000Z' }),
      row({ id: 'pm', metricName: 'sodium', value: 142, recordedAt: '2026-01-10T18:00:00.000Z' }),
    ]);
    const renal = groups.find(g => g.id === 'renal')!;
    const { dates, points } = labGroupMatrix(renal);
    expect(dates).toEqual(['2026-01-10']);
    expect(points['sodium']['2026-01-10'].id).toBe('pm');
  });
});

describe('US-21: countLabValuePoints', () => {
  it('sums points across all groups and series', () => {
    const groups = groupLabValues([
      row({ metricName: 'sodium', recordedAt: '2026-01-01T00:00:00.000Z' }),
      row({ metricName: 'sodium', recordedAt: '2026-02-01T00:00:00.000Z' }),
      row({ metricName: 'crp', unit: 'mg/L' }),
      row({ metricName: 'haemoglobin', unit: 'g/L' }),
    ]);
    expect(countLabValuePoints(groups)).toBe(4);
  });

  it('is zero for no groups', () => {
    expect(countLabValuePoints([])).toBe(0);
  });
});
