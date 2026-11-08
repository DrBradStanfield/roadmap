// US-62 AC8, US-21, US-12 AC20: the lab test rows both apps draw (labSeriesRows): a limit reads
// with its symbol and is flagged on the trend, so the web draws it hollow; the iPhone leaves it off.
import { describe, expect, it } from 'vitest';
import { formatLabValue, labSeriesRows, mixedUnitsNote, savedLabText } from './lab-series';

const NOW = new Date('2026-10-21T08:00:00.000Z');
const lab = (id: string, value: number, recordedAt: string, extra: Record<string, unknown> = {}) => ({
  id, metricName: 'ferritin', value, unit: 'µg/L', recordedAt, referenceLow: 30, referenceHigh: 400, ...extra,
});

describe('labSeriesRows with a limit (US-12 AC20)', () => {
  const rows = [lab('a', 80, '2026-10-01T00:00:00.000Z'), lab('b', 20, '2026-10-10T00:00:00.000Z', { comparator: '<' })];

  it('reads the limit with its symbol and flags it on the trend', () => {
    const [row] = labSeriesRows(rows, NOW);
    expect(row).toMatchObject({ label: 'Ferritin', latest: { id: 'b', value: '< 20', day: '2026-10-10' }, previous: '80', target: 'Ref 30–400' });
    expect(row.trend).toEqual([80, 20]);
    expect(row.trendLimits).toEqual([false, true]);
  });

  it('leaves the limit off the trend with exactOnly, as the iPhone draws it', () => {
    const [row] = labSeriesRows(rows, NOW, true);
    expect(row.trend).toEqual([80]);
    expect(row.trendLimits).toEqual([false]);
  });

  it('draws no trend and no previous value for a series in more than one unit (US-21 AC3a)', () => {
    const [row] = labSeriesRows([...rows, lab('c', 9, '2026-10-12T00:00:00.000Z', { unit: 'mg/dL' })], NOW);
    expect(row).toMatchObject({ previous: null, trend: [] });
    expect(row.trendLimits).toBeUndefined();
  });

  it('shows a row with no unit, as readers accept one, with no unit rather than throwing (US-65)', () => {
    const [row] = labSeriesRows([lab('a', 80, '2026-10-01T00:00:00.000Z', { unit: null }), lab('b', 90, '2026-10-02T00:00:00.000Z', { unit: undefined })], NOW);
    expect(row).toMatchObject({ unit: '', latest: { value: '90' }, previous: '80' });
  });
});

// US-07 AC4, Brad 2026-11-09: day first, then time; equal instants fall to createdAt, then id.
describe('labSeriesRows order: day first, then time (US-07 AC4)', () => {
  it('puts Tokyo 06:00+09:00 on Nov 2 after London 22:00+00:00 on Nov 1', () => {
    const [row] = labSeriesRows([lab('tokyo', 90, '2026-11-02T06:00:00.000+09:00'), lab('london', 80, '2026-11-01T22:00:00.000+00:00')], NOW);
    expect(row.latest.id).toBe('tokyo');
    expect(row.previous).toBe('80');
  });

  it('breaks a tie on equal instants by createdAt, whatever the input order', () => {
    const early = lab('zz', 80, '2026-11-01T22:00:00.000Z', { createdAt: '2026-11-02T08:00:00Z' });
    const late = lab('aa', 90, '2026-11-01T22:00:00.000+00:00', { createdAt: '2026-11-02T09:00:00Z' });
    for (const rows of [[early, late], [late, early]]) expect(labSeriesRows(rows, NOW)[0].latest.id).toBe('aa');
  });
});

describe('mixedUnitsNote (US-21 AC3a)', () => {
  it('names each unit, an empty one as "no unit", in the web\'s words', () => {
    expect(mixedUnitsNote(['µmol/L', '', 'µg/dL'])).toBe('Units vary between reports (µmol/L, no unit, µg/dL), so this test is not charted.');
  });
});


// US-21 AC25 (Brad 2026-11-04): two decimals printed a suppressed TSH of 0.004 as "0", while a
// "< 0.005" limit printed exactly. Below 0.1 a value keeps two significant figures.
describe('formatLabValue keeps two significant figures below 0.1 (US-21 AC25)', () => {
  it('prints a small value, never "0"', () => {
    expect(formatLabValue(0.004)).toBe('0.004');
    expect(formatLabValue(0.0456)).toBe('0.046');
    expect(formatLabValue(0.0041234)).toBe('0.0041');
    expect(formatLabValue(0.05)).toBe('0.05');
    expect(formatLabValue(-0.004)).toBe('-0.004');
    expect(formatLabValue(0.0000004)).toBe('0.0000004');
  });

  it('never throws on a value too small for toFixed, so one row never blanks the table (US-65)', () => {
    const tiny = (id: string, value: number, recordedAt: string) => ({ id, metricName: 'tsh', value, unit: 'mIU/L', recordedAt });
    const [row] = labSeriesRows([tiny('a', 1e-120, '2026-10-01T00:00:00.000Z'), tiny('b', 5e-324, '2026-10-10T00:00:00.000Z')], NOW);
    expect(row).toMatchObject({ latest: { value: '5e-324' }, previous: '1e-120' });
    const [small] = labSeriesRows([tiny('c', 4e-7, '2026-10-01T00:00:00.000Z')], NOW);
    expect(small.latest.value).toBe('0.0000004');
  });

  it('keeps two decimals from 0.1 up, and 0 as 0', () => {
    expect(formatLabValue(0)).toBe('0');
    expect(formatLabValue(0.123)).toBe('0.12');
    expect(formatLabValue(1.234)).toBe('1.23');
    expect(formatLabValue(80)).toBe('80');
    expect(formatLabValue(4.5)).toBe('4.5');
  });

  it('shows a suppressed TSH as stored on the rows both apps draw; a limit still prints as printed', () => {
    const tsh = (id: string, value: number, recordedAt: string, extra: Record<string, unknown> = {}) =>
      ({ id, metricName: 'tsh', value, unit: 'mIU/L', recordedAt, ...extra });
    const [row] = labSeriesRows([tsh('a', 0.004, '2026-10-01T00:00:00.000Z'), tsh('b', 0.03, '2026-10-10T00:00:00.000Z')], NOW);
    expect(row).toMatchObject({ latest: { value: '0.03' }, previous: '0.004' });
    expect(savedLabText(0.005, '<')).toBe('< 0.005');
  });
});

// US-21 AC14 (amended 2026-11-04, Brad): a test the catalogue does not know compared its units
// case-sensitively, so "mg/dL" against "mg/dl" read "Units vary between reports" and lost its
// chart, previous value and trend. dL, mL and µL now read the same in any case; G/L and g/L stay apart.
describe('an uncatalogued test\'s volume units ignore case (US-21 AC14)', () => {
  const nonHdl = (id: string, value: number, recordedAt: string, unit: string) =>
    ({ id, metricName: 'non_hdl_cholesterol_calc', value, unit, recordedAt });

  it('charts mg/dL beside mg/dl as one unit', () => {
    const [row] = labSeriesRows([nonHdl('a', 130, '2026-10-01T00:00:00.000Z', 'mg/dL'), nonHdl('b', 120, '2026-10-10T00:00:00.000Z', 'mg/dl')], NOW);
    expect(row).toMatchObject({ unit: 'mg/dL', previous: '130', trend: [130, 120] });
  });

  it('keeps G/L and g/L apart (G is giga)', () => {
    const [row] = labSeriesRows([nonHdl('a', 4, '2026-10-01T00:00:00.000Z', 'G/L'), nonHdl('b', 5, '2026-10-10T00:00:00.000Z', 'g/L')], NOW);
    expect(row).toMatchObject({ previous: null, trend: [] });
  });
});
