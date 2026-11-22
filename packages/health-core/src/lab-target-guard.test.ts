/**
 * A lab's target read as the result (US-12 AC20b) and one ratio under two
 * names (US-21 AC29), Brad 2026-11-23. Every report line and number here is
 * made up: the shape of a real miss, never its values.
 */
import { describe, it, expect } from 'vitest';
import { parseExtractionJson, parseUnifiedResult, toUnifiedResult, unifiedSystemPrompt } from './lab-extraction';
import { CATALOG_UNITS, canonicalLabValue, labSlotKey, labTestLabel, resolveLabCatalogEntry } from './lab-catalog';
import { groupLabValues } from './lab-series';
import { createEmptyFile, createLabValue } from './roadmap-file';
import { mergeFiles } from './merge';
import { bulkAppendValues } from './record-edits';
import { scrubText } from './sentry-scrub';

/** The model's answer for a synthetic lipid report, mocked: no read is made. */
function read(values: unknown[], additionalValues: unknown[] = []) {
  const text = JSON.stringify({ classification: 'lab_report', reportDate: '2026-03-04', values, additionalValues, document: null });
  return toUnifiedResult(parseUnifiedResult(parseExtractionJson(text)), 'full');
}
const core = (value: string, metric = 'total_cholesterol', printedName = 'Total cholesterol', unit = 'mmol/L') => ({ metric, value, unit, confidence: 'high', printedName });

describe('US-12 AC20b: a target printed after the result is never saved silently as the result (Brad 2026-11-23)', () => {
  it('a result then its target on one value ("4.7 < 5.5") saves the result, not the target', () => {
    const [v] = read([core('4.7 < 5.5')]).values;
    expect(v).toMatchObject({ metric: 'total_cholesterol', displayValue: 4.7, confidence: 'high' });
    expect(v.comparator).toBeUndefined();
  });

  it('a core value read as a bare limit ("< 5.5") is kept as a limit but offered for checking', () => {
    const [v] = read([core('< 5.5')]).values;
    expect(v).toMatchObject({ displayValue: 5.5, comparator: '<' });
    expect(v.confidence).not.toBe('high');
  });

  it('a lab row whose limit equals its own printed bound on that side is offered for checking', () => {
    const { additionalValues } = read([], [
      { name: 'apob_ratio_made_up', value: '< 0.9', unit: '', referenceLow: null, referenceHigh: 0.9 },
      { name: 'egfr', value: '> 60', unit: 'mL/min/1.73m2', referenceLow: 60, referenceHigh: null },
    ]);
    expect(additionalValues.map((a) => [a.comparator, a.confidence])).toEqual([['<', 'low'], ['>', 'low']]);
  });

  it('the legitimate limit shapes still save as limits, unflagged where their bound differs from the range', () => {
    const { additionalValues, values } = read([core('< 10', 'lpa', 'Lipoprotein(a)', 'nmol/L')], [
      { name: 'egfr', value: '> 90', unit: 'mL/min/1.73m2', referenceLow: 60, referenceHigh: null },
      { name: 'hs_crp', value: '< 0.3', unit: 'mg/L', referenceLow: null, referenceHigh: 5 },
    ]);
    expect(additionalValues.map((a) => [a.name, a.value, a.comparator, a.confidence])).toEqual([
      ['egfr', 90, '>', undefined], ['hs_crp', 0.3, '<', undefined],
    ]);
    expect(values[0]).toMatchObject({ metric: 'lpa', displayValue: 10, comparator: '<' });
  });

  it('the prompt says a limit after the result is its target, never its value', () => {
    for (const mode of ['full', 'metadata'] as const) {
      expect(unifiedSystemPrompt(mode)).toContain('A row printed as its result and then a limit ("4.7   < 5.5") has the result 4.7: that limit is its target or range, never its value.');
    }
  });
});

describe('US-21 AC29: the cholesterol/HDL ratio is one test under either stored name (Brad 2026-11-23)', () => {
  const NOW = '2026-11-23T00:00:00.000Z';
  const row = (id: string, metricName: string, recordedAt: string, createdAt = recordedAt) =>
    createLabValue({ id, metricName, value: 3.1, unit: '', recordedAt, createdAt });

  it('both spellings resolve to one catalogued test with one label and one slot', () => {
    const a = resolveLabCatalogEntry('cholesterol_total_hdl_ratio');
    expect(a?.unit).toBe('ratio');
    expect(resolveLabCatalogEntry('total_cholesterol_hdl_ratio')).toBe(a);
    expect(resolveLabCatalogEntry('Total Cholesterol/HDL Ratio')).toBe(a);
    expect(labSlotKey('cholesterol_total_hdl_ratio')).toBe(labSlotKey('total_cholesterol_hdl_ratio'));
    expect(labTestLabel('total_cholesterol_hdl_ratio')).toBe('Cholesterol/HDL ratio');
  });

  it('rows stored under either name read as one series, in one unit, without rewriting them', () => {
    const series = groupLabValues([
      row('r1', 'cholesterol_total_hdl_ratio', '2026-01-01'),
      row('r2', 'total_cholesterol_hdl_ratio', '2026-02-01'),
      { ...row('r3', 'total_cholesterol_hdl_ratio', '2026-03-01'), unit: 'ratio' },
    ]).flatMap((g) => g.series);
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ label: 'Cholesterol/HDL ratio', mixedUnits: false });
    expect(series[0].points.map((p) => p.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('a new read with no unit, or "ratio", is stored; another unit is refused; "ratio" stays no scrub unit, its name scrubs the value', () => {
    const entry = resolveLabCatalogEntry('total_cholesterol_hdl_ratio')!;
    expect(canonicalLabValue(entry, 3.1, '')).toEqual({ value: 3.1, unit: 'ratio', factor: 1 });
    expect(canonicalLabValue(entry, 3.1, 'ratio')).toEqual({ value: 3.1, unit: 'ratio', factor: 1 });
    expect(canonicalLabValue(entry, 3.1, '%')).toBeNull();
    expect(CATALOG_UNITS).not.toContain('ratio');
    expect(scrubText('Total cholesterol/HDL ratio 3.1')).not.toContain('3.1');
    const file = createEmptyFile({ deviceId: 't', now: NOW });
    const written = bulkAppendValues(file, [{ kind: 'lab', metricName: 'total_cholesterol_hdl_ratio', value: 3.1, unit: '', recordedAt: '2026-03-04', source: 'lab_import' }], NOW);
    expect(written.outcomes).toEqual(['written']);
  });

  it('both names on one day: the next merge keeps one active row and demotes the older, never deletes it', () => {
    const file = { ...createEmptyFile({ deviceId: 't', now: NOW }), labValues: [
      row('x1', 'cholesterol_total_hdl_ratio', '2026-03-04', '2026-03-05T00:00:00.000Z'),
      row('x2', 'total_cholesterol_hdl_ratio', '2026-03-04', '2026-03-06T00:00:00.000Z'),
    ] };
    const merged = mergeFiles(file, createEmptyFile({ deviceId: 'u', now: NOW }), { deviceId: 't', now: NOW });
    expect(merged.labValues.map((r) => [r.id, r.status])).toEqual([['x1', 'entered-in-error'], ['x2', 'active']]);
  });
});
