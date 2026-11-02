import { describe, expect, it } from 'vitest';
import { parseUnifiedResult, toUnifiedResult, unreadLines } from './lab-extraction';
import { labSlotKey } from './lab-catalog';

// US-12 AC11a: a row the model puts under `values` with a metric that is not
// one of the core keys was dropped by `resolveLabValues` after the parse had
// counted it as read, so it vanished with no notice (droppedValueCount 0).
// Brad 2026-11-03, option (b): such a row goes through the printed-name filing
// step (US-07 AC10), keeps its printed name, and keeps the model's confidence
// and question when it lands in a core metric.
const extract = (values: unknown[], additionalValues: unknown[] = [], mode: 'full' | 'metadata' = 'full') =>
  toUnifiedResult(parseUnifiedResult({
    classification: 'lab_report', reportDate: '2026-10-10', values, additionalValues, document: null,
  }), mode);

describe('US-12 AC11a — a core row naming no core metric is never silently dropped', () => {
  it('a core alias the model used as the key becomes that core value', () => {
    const result = extract([{ metric: 'LDL-Cholesterol', value: 2.6, unit: 'mmol/L', confidence: 'high' }]);
    expect(result.values.map(v => [v.metric, v.valueSI, v.confidence])).toEqual([['ldl', 2.6, 'high']]);
    expect(result.additionalValues).toEqual([]);
    expect(result.droppedValueCount).toBe(0);
  });

  it('a core key in the wrong case ("LDL") is filed under ldl', () => {
    const result = extract([{ metric: 'LDL', value: 2.6, unit: 'mmol/L', confidence: 'high' }]);
    expect(result.values.map(v => [v.metric, v.valueSI])).toEqual([['ldl', 2.6]]);
    expect(result.droppedValueCount).toBe(0);
  });

  it.each(['low', 'medium'] as const)('the model\'s "%s" confidence and its question are kept, never upgraded', (confidence) => {
    const [row] = extract([{ metric: 'LDL-Cholesterol', value: 2.6, unit: 'mmol/L', confidence, question: 'Is this fasting?' }]).values;
    expect(row.metric).toBe('ldl');
    expect(row.confidence).toBe(confidence);
    expect(row.question).toContain('Is this fasting?');
  });

  it('the printed name files the row and is kept, on a core value and on a lab row', () => {
    const result = extract([
      { metric: 'LDL', value: 2.6, unit: 'mmol/L', confidence: 'high', printedName: 'LDL Cholesterol' },
      { metric: 'thyroid', value: 4.56, unit: 'mIU/L', confidence: 'high', printedName: 'TSH' },
    ]);
    expect(result.values.map(v => [v.metric, v.printedName])).toEqual([['ldl', 'LDL Cholesterol']]);
    expect(result.additionalValues.map(v => [labSlotKey(v.name), v.printedName])).toEqual([['tsh', 'TSH']]);
  });

  it('a printed name that resolves wins over the model\'s non-core key', () => {
    const result = extract([{ metric: 'cholesterol_ldl_calc', value: 2.6, unit: 'mmol/L', confidence: 'medium', printedName: 'LDL-C' }]);
    expect(result.values.map(v => [v.metric, v.confidence, v.printedName])).toEqual([['ldl', 'medium', 'LDL-C']]);
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
    expect(result.additionalValues).toEqual([{ name: 'tsh', value: 4.56, unit: 'mIU/L', referenceLow: null, referenceHigh: null, recordedAt: '2026-10-09' }]);
    expect(result.droppedValueCount).toBe(0);
  });

  it('a held core metric keeps the core row; a second reading named by alias stays a lab row', () => {
    const result = extract([
      { metric: 'ldl', value: 2.6, unit: 'mmol/L', confidence: 'high' },
      { metric: 'LDL-Cholesterol', value: 2.9, unit: 'mmol/L', confidence: 'high' },
    ]);
    expect(result.values.map(v => [v.metric, v.valueSI])).toEqual([['ldl', 2.6]]);
    expect(result.additionalValues.map(v => [v.name, v.value])).toEqual([['LDL-Cholesterol', 2.9]]);
  });

  it('a renamed core row takes the slot before an additional value, which stays a lab row', () => {
    const result = extract(
      [{ metric: ' LDL-Cholesterol ', value: 2.6, unit: 'mmol/L', confidence: 'high' }],
      [{ name: 'ferritin', value: 45, unit: 'ug/L' }, { name: 'ldl', value: 2.9, unit: 'mmol/L' }],
    );
    expect(result.values.map(v => [v.metric, v.valueSI])).toEqual([['ldl', 2.6]]);
    expect(result.additionalValues.map(v => [v.name, v.value])).toEqual([['ferritin', 45], ['ldl', 2.9]]);
  });

  it('creatinine is never filed by the model\'s name alone (AC11): it stays a lab row', () => {
    const result = extract([
      { metric: 'Serum Creatinine', value: 80, unit: 'µmol/L', confidence: 'high' },
      { metric: 'Cr', value: 0.3, unit: 'µg/L', confidence: 'high' },
    ]);
    expect(result.values).toEqual([]);
    expect(result.additionalValues.map(v => v.name)).toEqual(['Serum Creatinine', 'Cr']);
  });

  it('a printed serum creatinine name files it as creatinine (US-07 AC10)', () => {
    const result = extract([{ metric: 'Creat', value: 80, unit: 'µmol/L', confidence: 'medium', printedName: 'Serum Creatinine' }]);
    expect(result.values.map(v => [v.metric, v.confidence])).toEqual([['creatinine', 'medium']]);
  });

  it('a blank metric with a printed name is filed by that name', () => {
    const result = extract([{ metric: ' ', value: 5.6, unit: '%', confidence: 'high', printedName: 'HbA1c' }]);
    expect(result.values.map(v => v.metric)).toEqual(['hba1c']);
    expect(result.droppedValueCount).toBe(0);
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

  it('the connector prompt path reads it the same way, ignoring a printed name', () => {
    const result = extract([
      { metric: 'ferritin', value: 45, unit: 'ug/L', confidence: 'high' },
      { metric: 'LDL-Cholesterol', value: 2.6, unit: 'mmol/L', confidence: 'low', printedName: 'Triglycerides' },
    ], [], 'metadata');
    expect(result.values.map(v => [v.metric, v.confidence])).toEqual([['ldl', 'low']]);
    expect(result.additionalValues.map(v => v.name)).toEqual(['ferritin']);
    expect(result.droppedValueCount).toBe(0);
  });
});
