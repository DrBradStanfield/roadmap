// US-62 AC8, US-21, US-12 AC20: the lab test rows both apps draw (labSeriesRows): a limit reads
// with its symbol and is flagged on the trend, so the web draws it hollow; the iPhone leaves it off.
import { describe, expect, it } from 'vitest';
import { labSeriesRows, mixedUnitsNote } from './lab-series';

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

describe('mixedUnitsNote (US-21 AC3a)', () => {
  it('names each unit, an empty one as "no unit", in the web\'s words', () => {
    expect(mixedUnitsNote(['µmol/L', '', 'µg/dL'])).toBe('Units vary between reports (µmol/L, no unit, µg/dL), so this test is not charted.');
  });
});

