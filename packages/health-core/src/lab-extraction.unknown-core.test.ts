import { describe, expect, it } from 'vitest';
import { parseUnifiedResult, toUnifiedResult, unreadLines } from './lab-extraction';

// US-12 AC11a: a row the model puts under `values` with a metric that is not
// one of the core keys was dropped by `resolveLabValues` after the parse had
// counted it as read, so it vanished with no notice (droppedValueCount 0).
const extract = (values: unknown[], additionalValues: unknown[] = [], mode: 'full' | 'metadata' = 'full') =>
  toUnifiedResult(parseUnifiedResult({
    classification: 'lab_report', reportDate: '2026-10-10', values, additionalValues, document: null,
  }), mode);

describe('US-12 AC11a — a core row naming no core metric is never silently dropped', () => {
  it('a core alias the model used as the key becomes that core value (AC11 promotion)', () => {
    const result = extract([{ metric: 'LDL-Cholesterol', value: 2.6, unit: 'mmol/L', confidence: 'high' }]);
    expect(result.values.map(v => [v.metric, v.valueSI])).toEqual([['ldl', 2.6]]);
    expect(result.additionalValues).toEqual([]);
    expect(result.droppedValueCount).toBe(0);
  });

  it('a core key in the wrong case ("LDL") is not a core key, so it is renamed and promoted to ldl', () => {
    const result = extract([{ metric: 'LDL', value: 2.6, unit: 'mmol/L', confidence: 'high' }]);
    expect(result.values.map(v => [v.metric, v.valueSI])).toEqual([['ldl', 2.6]]);
    expect(result.additionalValues).toEqual([]);
    expect(result.droppedValueCount).toBe(0);
  });

  it('a renamed row from an undated column keeps its printed month', () => {
    const result = extract([
      { metric: 'tsh', value: 4.56, unit: 'mIU/L', confidence: 'high', recordedAt: 'undated', printedMonth: '2025-06' },
    ]);
    expect(result.additionalValues.map(v => [v.name, v.printedMonth])).toEqual([['tsh', '2025-06']]);
    expect(result.droppedValueCount).toBe(0);
  });

  it('an unknown name stays as a lab row under that name, with its unit and day', () => {
    const result = extract([
      { metric: 'tsh', value: 4.56, unit: 'mIU/L', confidence: 'high', recordedAt: '2026-10-09' },
      { metric: 'hba1c', value: 5.6, unit: '%', confidence: 'high' },
    ]);
    expect(result.values.map(v => v.metric)).toEqual(['hba1c']);
    expect(result.additionalValues).toEqual([{ name: 'tsh', value: 4.56, unit: 'mIU/L', recordedAt: '2026-10-09' }]);
    expect(result.droppedValueCount).toBe(0);
  });

  it('a held core metric keeps the core row; a second reading named by alias stays a lab row (as AC11)', () => {
    const result = extract([
      { metric: 'ldl', value: 2.6, unit: 'mmol/L', confidence: 'high' },
      { metric: 'LDL-Cholesterol', value: 2.9, unit: 'mmol/L', confidence: 'high' },
    ]);
    expect(result.values.map(v => [v.metric, v.valueSI])).toEqual([['ldl', 2.6]]);
    expect(result.additionalValues.map(v => [v.name, v.value])).toEqual([['LDL-Cholesterol', 2.9]]);
  });

  it('the name is trimmed, and comes after the rows printed as additional values, which keep their order', () => {
    const result = extract(
      [{ metric: ' tsh ', value: 4.56, unit: 'mIU/L', confidence: 'high' }],
      [{ name: 'ferritin', value: 45, unit: 'ug/L' }, { name: 'LDL-Cholesterol', value: 2.9, unit: 'mmol/L' }],
    );
    // The printed additional LDL is promoted first; the renamed row is a lab row after it.
    expect(result.values.map(v => [v.metric, v.valueSI])).toEqual([['ldl', 2.9]]);
    expect(result.additionalValues.map(v => v.name)).toEqual(['ferritin', 'tsh']);
  });

  it('a printed additional reading of a core test keeps the slot over a renamed one', () => {
    const result = extract(
      [{ metric: 'LDL-Cholesterol', value: 2.6, unit: 'mmol/L', confidence: 'high' }],
      [{ name: 'ldl', value: 2.9, unit: 'mmol/L' }],
    );
    expect(result.values.map(v => v.valueSI)).toEqual([2.9]);
    expect(result.additionalValues.map(v => [v.name, v.value])).toEqual([['LDL-Cholesterol', 2.6]]);
  });

  it('a blank metric is dropped and counted', () => {
    const result = extract([
      { metric: '  ', value: 1, unit: 'mmol/L', confidence: 'high' },
      { metric: 'ldl', value: 2.6, unit: 'mmol/L', confidence: 'high' },
    ]);
    expect(result.values.map(v => v.metric)).toEqual(['ldl']);
    expect(result.additionalValues).toEqual([]);
    expect(result.droppedValueCount).toBe(1);
    expect(result.unreadValues).toEqual([{ name: '', reason: 'unreadable' }]);
  });

  it('a blank metric is an unread row with no name and its own day, so it leaves the count with its column (AC19)', () => {
    const result = extract([
      { metric: 'ldl', value: 2.6, unit: 'mmol/L', confidence: 'high' },
      { metric: '', value: 1, unit: 'mmol/L', confidence: 'high', recordedAt: '2025-01-05' },
      { metric: ' ', value: 2, unit: 'mmol/L', confidence: 'high', recordedAt: '2026-12-01' },
    ]);
    // A column dated after the report is not offered, so its unread row is not counted either.
    expect(result.unreadValues).toEqual([{ name: '', reason: 'unreadable', recordedAt: '2025-01-05' }]);
    expect(result.droppedValueCount).toBe(1);
    // "Not saved" names no test for it: it is one of the other values left out.
    expect(unreadLines(result)).toEqual({ lines: [], otherCount: 1 });
  });

  it('every core key is still read as a core row, never moved', () => {
    const parsed = parseUnifiedResult({
      classification: 'lab_report', reportDate: null, document: null, additionalValues: [],
      values: [{ metric: 'apob', value: 0.8, unit: 'g/L', confidence: 'high' }, { metric: 'creatinine', value: 80, unit: 'µmol/L', confidence: 'high' }],
    });
    expect(parsed.values.map(v => v.metric)).toEqual(['apob', 'creatinine']);
    expect(parsed.additionalValues).toEqual([]);
  });

  it('the connector prompt path reads it the same way', () => {
    const result = extract([{ metric: 'ferritin', value: 45, unit: 'ug/L', confidence: 'high' }], [], 'metadata');
    expect(result.additionalValues.map(v => v.name)).toEqual(['ferritin']);
    expect(result.droppedValueCount).toBe(0);
  });
});
