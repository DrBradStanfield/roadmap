/**
 * US-21 phase 1 — grouping/series logic for the read-only additional-lab
 * rows surfaced beneath the core blood-test matrix.
 */
import { describe, it, expect } from 'vitest';
import { groupLabValues, countLabValuePoints, labGroupMatrix, groupLabHistory } from './lab-rows';
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

  it('folds spelling variants of one test into a single series (US-10)', () => {
    const groups = groupLabValues([
      row({ metricName: 'vitamin d', value: 80, unit: 'nmol/L', recordedAt: '2026-08-14T00:00:00.000Z' }),
      row({ metricName: 'vitamin_d', value: 88, unit: 'nmol/L', recordedAt: '2026-08-15T00:00:00.000Z' }),
    ]);
    const vitamins = groups.find(g => g.id === 'vitamins');
    expect(vitamins).toBeDefined();
    expect(vitamins!.series).toHaveLength(1);
    expect(vitamins!.series[0].seriesKey).toBe('vitamin_d');
    expect(vitamins!.series[0].points).toHaveLength(2);
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
    const groups = groupLabValues([row({ metricName: 'lipase', value: 27, unit: 'U/L' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('other');
    expect(groups[0].label).toBe('Other tests');
    expect(groups[0].icon).toBe('flask');
    expect(groups[0].series[0].label).toBe('Lipase');
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

// US-21 units fix: chips/cells show the mapped display unit — catalogue
// canonical for same-unit spelling variants, typography-normalized otherwise.
describe('US-21 units fix: display-unit mapping in groupLabValues', () => {
  it('haematocrit "ratio" vs "L/L" is the SAME unit — one series, canonical L/L, not mixed', () => {
    const groups = groupLabValues([
      row({ metricName: 'haematocrit', value: 0.48, unit: 'ratio', recordedAt: '2026-01-01T00:00:00.000Z' }),
      row({ metricName: 'Haematocrit', value: 0.43, unit: 'L/L', recordedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    const haem = groups.find(g => g.id === 'haematology')!;
    expect(haem.series).toHaveLength(1);
    expect(haem.series[0].mixedUnits).toBe(false);
    expect(haem.series[0].unit).toBe('L/L');
  });

  it('ASCII spelling of a catalogued unit displays canonically (umol/L → µmol/L)', () => {
    const groups = groupLabValues([row({ metricName: 'bilirubin', value: 15, unit: 'umol/L' })]);
    const liver = groups.find(g => g.id === 'liver')!;
    expect(liver.series[0].unit).toBe('µmol/L');
    expect(liver.series[0].points[0].unit).toBe('µmol/L');
  });

  it('uncatalogued tests still get typography normalization (x 10e9/L → ×10⁹/L)', () => {
    const groups = groupLabValues([row({ metricName: 'reticulocytes', value: 60, unit: 'x 10e9/L' })]);
    expect(groups[0].id).toBe('other');
    expect(groups[0].series[0].unit).toBe('×10⁹/L');
  });

  it('a genuinely different unit still flags mixedUnits (mg/L vs mg/dL)', () => {
    const groups = groupLabValues([
      row({ metricName: 'crp', value: 2.1, unit: 'mg/L', recordedAt: '2026-01-01T00:00:00.000Z' }),
      row({ metricName: 'crp', value: 0.2, unit: 'mg/dL', recordedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    const inflammation = groups.find(g => g.id === 'inflammation')!;
    expect(inflammation.series[0].mixedUnits).toBe(true);
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

describe('US-10: groupLabHistory (history charts)', () => {
  it('gives spelling variants of one test a single series, labelled from the catalogue', () => {
    const { keys, series } = groupLabHistory([
      row({ id: 'a', metricName: 'Vitamin D', value: 80, unit: 'nmol/L' }),
      row({ id: 'b', metricName: 'vitamin_d', value: 88, unit: 'nmol/L' }),
    ]);

    expect(keys).toEqual(['vitamin_d']);
    expect(series.vitamin_d.label).toBe('Vitamin D (25-OH)');
    expect(series.vitamin_d.rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('keeps uncatalogued tests apart, title-cased, and sorts series by label', () => {
    const { keys, series } = groupLabHistory([
      row({ metricName: 'zinc', value: 12 }),
      row({ metricName: 'some_novel_assay', value: 3 }),
      row({ metricName: 'Some Novel Assay', value: 4 }),
    ]);

    expect(keys).toEqual(['some novel assay', 'zinc']);
    expect(series['some novel assay'].rows).toHaveLength(2);
    expect(series['some novel assay'].label).toBe('Some Novel Assay');
  });
});
