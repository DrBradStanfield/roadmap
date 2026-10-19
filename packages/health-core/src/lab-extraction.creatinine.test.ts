/**
 * Issue #166: urine PCR and ACR results were saved as serum creatinine. The
 * extractor guessed a unit it did not know from the number's size, so ACR 2
 * became 177 µmol/L and a low eGFR. A creatinine whose unit is still unknown
 * after a narrow clean-up is now refused and listed, never guessed (US-12
 * AC15); a guessed unit on any other metric is marked (AC16); the review shows
 * what was printed and asks about a creatinine too high for blood (US-13 AC11).
 * Synthetic model JSON only, no API call.
 */
import { describe, it, expect } from 'vitest';
import { parseExtractionJson, parseUnifiedResult, toUnifiedResult } from './lab-extraction';

/** The extractor's own steps on a model answer, as every path runs them. */
const extract = (values: unknown[], additionalValues: unknown[] = []) => toUnifiedResult(parseUnifiedResult(parseExtractionJson(JSON.stringify({
  classification: 'lab_report', reportDate: '2026-10-10', values, additionalValues, document: null,
}))), 'full');
const creat = (value: number, unit: string) => ({ metric: 'creatinine', value, unit, confidence: 'high' });

describe('US-12 AC15: a creatinine in a unit the table does not know is refused, never guessed', () => {
  const URINE = ['mg/mmol', 'g/mol', 'mg/g', 'mg/mg', 'g/g', 'mg/g creat', 'mg/g Cr', 'mg/24h', 'mmol/24h', 'mL/min', 'mg/mmol H'];

  it('mmol/L is refused with the neutral line: a serum creatinine can print in it too', () => {
    expect(extract([creat(0.08, 'mmol/L')]).refusedValues?.[0].reason).toBe('This unit could not be read as a blood creatinine.');
  });

  it.each(URINE)('PCR or ACR filed as creatinine in %s: refused as usually a urine result', (unit) => {
    for (const value of [2, 25]) {
      const result = extract([creat(value, unit)]);
      expect(result.values).toEqual([]);
      expect(result.refusedValues).toEqual([{ metric: 'creatinine', value, unit, reason: 'This unit is usually a urine result.' }]);
      // Never a parse drop: the new review shows it once, under "Not saved".
      expect(result.droppedValueCount).toBe(0);
    }
  });

  it('a blank unit is refused, not guessed from the number (ACR 2 used to become 177 µmol/L)', () => {
    const result = extract([creat(2, ''), { metric: 'creatinine', value: 2, unit: null, confidence: 'high' }]);
    expect(result.values).toEqual([]);
    expect(result.refusedValues?.map(r => [r.unit, r.reason])).toEqual([['', 'No unit was printed.'], ['', 'No unit was printed.']]);
  });

  it('a bracket or a word is never stripped: "mg/dL (urine)", "µmol/L (U)", "mg/dL (24h)" stay unknown', () => {
    const result = extract([creat(80, 'mg/dL (urine)'), creat(80, 'µmol/L (U)'), creat(80, 'mg/dL (24h)')]);
    expect(result.values).toEqual([]);
    expect(result.refusedValues?.map(r => r.reason)).toEqual(Array(3).fill('This unit could not be read as a blood creatinine.'));
  });

  it('a lab row named creatinine in an unknown unit is refused too; "Cr" (chromium) and a known unit stay lab rows', () => {
    const result = extract([], [
      { name: 'creatinine', value: 2, unit: 'mg/mmol' },
      { name: 'Serum Creatinine', value: 3, unit: '' },
      { name: 'Cr', value: 0.4, unit: 'ug/L' },
      { name: 'creatinine', value: 25, unit: 'mg/dL' },
    ]);
    expect(result.refusedValues?.map(r => [r.value, r.unit])).toEqual([[2, 'mg/mmol'], [3, '']]);
    expect(result.additionalValues.map(v => v.name)).toEqual(['Cr', 'creatinine']);
  });

  it('keeps a refused value\'s own previous-column day', () => {
    const result = extract([{ ...creat(2, 'mg/mmol'), recordedAt: '2026-01-05' }]);
    expect(result.refusedValues).toEqual([expect.objectContaining({ recordedAt: '2026-01-05' })]);
  });

  it('refuses nothing in a document that is not a lab report', () => {
    const result = toUnifiedResult(parseUnifiedResult({
      classification: 'clinic_letter', reportDate: null, values: [creat(2, 'mg/mmol')], additionalValues: [],
      document: { title: 'Letter', documentDate: null, contentMarkdown: '', metadata: {} },
    }), 'full');
    expect(result.refusedValues).toBeUndefined();
  });
});

describe('US-12 AC15: a serum creatinine with a garbled unit is read after a narrow clean-up', () => {
  it.each([
    ['µmol/L H', 120, 120], ['µmol/L L', 50, 50], ['µmol/L HH', 300, 300], ['µmol/L LL', 30, 30], ['µmol/L *', 90, 90],
    ['µmol/I', 85, 85], ['mcmol/L', 85, 85], ['mg%', 1, 88.4], ['mg %', 1, 88.4], ['µmol/L ↑', 120, 120], ['µmol/L (H)', 120, 120], ['µmol/L*', 90, 90], ['µmol/L h', 120, 120], ['µmol/L [L]', 50, 50], ['mg/dL H', 1.5, 132.6], ['µmol / L', 85, 85],
  ])('"%s" %s reads as %s µmol/L, confident', (unit, value, si) => {
    const [v] = extract([creat(value, unit)]).values;
    expect(v.valueSI).toBeCloseTo(si, 6);
    expect(v.displayUnit).toBe(unit);
    expect(v.unitGuessed).toBeUndefined();
    expect(v.confidence).toBe('high');
  });

  it('the clean-up is creatinine only: LDL in "mmol/L H" is still a guess, marked', () => {
    const [v] = extract([{ metric: 'ldl', value: 2.8, unit: 'mmol/L H', confidence: 'high' }]).values;
    expect(v.unitGuessed).toBe(true);
  });
});

describe('US-12 AC16: a guessed unit is marked on the value', () => {
  it('marks a guess, and only a guess', () => {
    const values = extract([
      { metric: 'ldl', value: 2.8, unit: '', confidence: 'high' },
      { metric: 'hdl', value: 1.3, unit: 'mmol/L', confidence: 'high' },
    ]).values;
    expect(values.map(v => v.unitGuessed)).toEqual([true, undefined]);
  });
});

describe('US-13 AC11: a question flags the value, and a creatinine too high for blood asks', () => {
  it('a value the model doubted is medium, never high, with its question', () => {
    const [v] = extract([{ metric: 'ldl', value: 2.8, unit: 'mmol/L', confidence: 'high', question: 'Faint print' }]).values;
    expect(v).toMatchObject({ confidence: 'medium', question: 'Faint print' });
  });

  it('a creatinine above 500 µmol/L asks "Was this a blood test?" and is medium; 500 itself does not', () => {
    const [high, edge, mg] = extract([creat(1200, 'µmol/L'), creat(500, 'µmol/L'), creat(8, 'mg/dL')]).values;
    expect(high).toMatchObject({ confidence: 'medium', question: 'Was this a blood test?' });
    expect(edge).toMatchObject({ confidence: 'high' });
    expect(edge.question).toBeUndefined();
    expect(mg).toMatchObject({ confidence: 'medium', question: 'Was this a blood test?' });
  });

  it('keeps the model\'s own question in front', () => {
    const [v] = extract([{ ...creat(900, 'µmol/L'), question: 'Value smudged' }]).values;
    expect(v.question).toBe('Value smudged. Was this a blood test?');
  });
});
