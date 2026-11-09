// US-66 AC6, Brad D5: an upload's extra value named like a core test, other
// than creatinine, is offered as that core value. On a held day the review
// shows the conflict (US-13 AC3); a unit the test does not take is listed as
// not saved, with why (US-12 AC19); creatinine stays an extra row (US-12 AC11).
import { describe, expect, it } from 'vitest';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { buildMatrixModel, type FileResult } from './ReviewTable';
import { offerCoreExtras } from './UploadModal';
import { parseUnifiedResult, toUnifiedResult } from '@roadmap/health-core/lab-extraction';

const DATE = { day: '01', month: '06', year: '2024' };
const DAY = '2024-06-01T00:00:00.000Z';

const extras = (...additionalValues: FileResult['additionalValues']): FileResult =>
  ({ fileName: 'labs.pdf', reportDate: '2024-06-01', values: [], additionalValues });

describe('offerCoreExtras (US-66 AC6, D5)', () => {
  it('offers "LDL Cholesterol" in mg/dL as the LDL value, converted', () => {
    const offered = offerCoreExtras(extras({ name: 'LDL Cholesterol', value: 116, unit: 'mg/dL' }));
    expect(offered.additionalValues).toEqual([]);
    expect(offered.values).toHaveLength(1);
    expect(offered.values[0]).toMatchObject({ metric: 'ldl', displayValue: 116, displayUnit: 'mg/dL', confidence: 'high' });
    expect(offered.values[0].valueSI).toBeCloseTo(3.0, 1);
    expect(offered.refusedValues).toBeUndefined();
  });

  it('lists one in a unit the test does not take as not saved, with why', () => {
    const offered = offerCoreExtras(extras({ name: 'HbA1c', value: 6, unit: 'g/L' }));
    expect(offered.values).toEqual([]);
    expect(offered.additionalValues).toEqual([]);
    expect(offered.refusedValues).toEqual([{ metric: 'hba1c', value: 6, unit: 'g/L', reason: 'This test is measured in mmol/mol or %.' }]);
  });

  it('keeps creatinine under any name, and every other test, as an extra row', () => {
    const kept = [
      { name: 'Creatinine', value: 80, unit: 'µmol/L' },
      { name: 'Cr', value: 80, unit: 'µmol/L' },
      { name: 'Ferritin', value: 120, unit: 'µg/L' },
      { name: 'Non-HDL Cholesterol', value: 3.1, unit: 'mmol/L' },
    ];
    expect(offerCoreExtras(extras(...kept))).toEqual({ values: [], additionalValues: kept });
  });

  it('keeps its own day on the core value', () => {
    const offered = offerCoreExtras(extras({ name: 'ApoB', value: 0.9, unit: 'g/L', recordedAt: '2024-01-10' }));
    expect(offered.values[0]).toMatchObject({ metric: 'apob', recordedAt: '2024-01-10' });
  });
});

describe('an offered value on a held day is a conflict (US-66 AC6, US-13 AC3)', () => {
  const held: ApiMeasurement[] = [{ id: 'held-ldl', metricType: 'ldl', value: 4.5, recordedAt: DAY, createdAt: DAY }];
  const build = (result: FileResult) => buildMatrixModel([{ ...result, ...offerCoreExtras(result) }], { 0: DATE }, held, [], 'si');

  it('shows the record value against the report value in the LDL row, never as an extra row', () => {
    const { cells, additionalRows, coreRows } = build(extras({ name: 'LDL Cholesterol', value: 3.2, unit: 'mmol/L' }));
    expect(additionalRows).toEqual([]);
    expect(coreRows.map(r => r.metric)).toEqual(['ldl']);
    expect(cells.get('ldl|2024-06-01')).toMatchObject({ state: 'editable', kind: 'core', valueSI: 3.2, existing: { id: 'held-ldl' } });
  });

  it('an equal value is already recorded, not a conflict', () => {
    const { cells } = build(extras({ name: 'LDL Cholesterol', value: 4.5, unit: 'mmol/L' }));
    expect(cells.get('ldl|2024-06-01')).toMatchObject({ state: 'context', id: 'held-ldl' });
  });
});

// US-12 AC11a (PR 759 R3): a second LDL the model listed among the core tests
// under an alias, with its own doubt, is a lab row on a held day; offered back
// as the LDL value it keeps the model's confidence, question and printed name.
describe('offerCoreExtras keeps the extractor\'s flag (US-12 AC11a)', () => {
  it('a held-slot LDL alias is offered low, with its question and printed name', () => {
    const result = toUnifiedResult(parseUnifiedResult({
      classification: 'lab_report', reportDate: '2024-06-01', document: null, additionalValues: [],
      values: [
        { metric: 'ldl', value: 2.6, unit: 'mmol/L', confidence: 'high' },
        { metric: 'LDL-Cholesterol', value: 2.9, unit: 'mmol/L', confidence: 'low', question: 'Two LDL rows?', printedName: 'LDL-C' },
      ],
    }), 'full');
    const offered = offerCoreExtras(result);
    expect(offered.additionalValues).toEqual([]);
    expect(offered.values.map((v) => [v.metric, v.displayValue, v.confidence])).toEqual([['ldl', 2.6, 'high'], ['ldl', 2.9, 'low']]);
    expect(offered.values[1]).toMatchObject({ printedName: 'LDL-C' });
    expect(offered.values[1].question).toContain('Two LDL rows?');
  });
});
