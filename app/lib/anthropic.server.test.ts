import { describe, it, expect } from 'vitest';
import { stripCodeFences, extractJsonObject, resolveLabValues, resolveUnit, parseUnifiedResult } from './anthropic.server';

// ---------------------------------------------------------------------------
// Bug: LLM wraps JSON response in markdown code fences (```json ... ```)
// The Batch API returns responses with code fences that broke JSON.parse.
// ---------------------------------------------------------------------------

describe('stripCodeFences', () => {
  it('strips ```json wrapper from LLM response', () => {
    const input = '```json\n{"classification": "lab_report"}\n```';
    expect(stripCodeFences(input)).toBe('{"classification": "lab_report"}');
  });

  it('strips ``` wrapper without language tag', () => {
    const input = '```\n{"key": "value"}\n```';
    expect(stripCodeFences(input)).toBe('{"key": "value"}');
  });

  it('returns plain JSON unchanged', () => {
    const input = '{"classification": "lab_report"}';
    expect(stripCodeFences(input)).toBe('{"classification": "lab_report"}');
  });

  it('handles whitespace around code fences', () => {
    const input = '  ```json\n{"key": "value"}\n```  ';
    expect(stripCodeFences(input)).toBe('{"key": "value"}');
  });

  it('handles multiline JSON inside code fences', () => {
    const input = '```json\n{\n  "classification": "clinic_letter",\n  "values": []\n}\n```';
    const result = stripCodeFences(input);
    expect(JSON.parse(result)).toEqual({
      classification: 'clinic_letter',
      values: [],
    });
  });

  it('does not strip fences from middle of text', () => {
    const input = 'Some text ```json\n{"key": "value"}\n``` more text';
    expect(stripCodeFences(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Bug: Haiku occasionally appends explanation prose after the JSON, breaking
// JSON.parse with "Unexpected non-whitespace character after JSON at position X".
// extractJsonObject must slice from the first { to the last } to survive this.
// ---------------------------------------------------------------------------

describe('extractJsonObject', () => {
  it('extracts JSON when model appends trailing prose', () => {
    const input = '{"foo": "bar"} Here is some explanation.';
    expect(JSON.parse(extractJsonObject(input))).toEqual({ foo: 'bar' });
  });

  it('extracts JSON from inside code fences', () => {
    const input = '```json\n{"foo": "bar"}\n```';
    expect(JSON.parse(extractJsonObject(input))).toEqual({ foo: 'bar' });
  });

  it('extracts JSON with both leading prose and trailing fence', () => {
    const input = 'Here is the result:\n```json\n{"foo": "bar"}\n```\nDone.';
    expect(JSON.parse(extractJsonObject(input))).toEqual({ foo: 'bar' });
  });

  it('preserves braces inside string values', () => {
    const input = '{"desc": "use {placeholder} syntax"} extra';
    expect(JSON.parse(extractJsonObject(input))).toEqual({ desc: 'use {placeholder} syntax' });
  });

  it('returns text unchanged when no braces present', () => {
    expect(extractJsonObject('no json here')).toBe('no json here');
  });

  it('returns plain JSON unchanged', () => {
    const input = '{"foo": "bar"}';
    expect(extractJsonObject(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Bug: Unit resolution produced wrong values or crashed on unknown units.
// resolveLabValues must handle all valid metrics and edge cases.
// ---------------------------------------------------------------------------

describe('resolveLabValues', () => {
  it('resolves known SI units for LDL', () => {
    const result = resolveLabValues([
      { metric: 'ldl', value: 2.8, unit: 'mmol/L', confidence: 'high' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].metric).toBe('ldl');
    expect(result[0].valueSI).toBe(2.8);
    expect(result[0].confidence).toBe('high');
  });

  it('resolves conventional units for LDL', () => {
    const result = resolveLabValues([
      { metric: 'ldl', value: 130, unit: 'mg/dL', confidence: 'high' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].valueSI).toBeCloseTo(3.36, 1);
  });

  it('filters out invalid metrics', () => {
    const result = resolveLabValues([
      { metric: 'vitamin_d', value: 45, unit: 'ng/mL', confidence: 'high' },
    ]);
    expect(result).toHaveLength(0);
  });

  it('downgrades confidence when unit is inferred', () => {
    // 100 fits mg/dL only; 2.8 fits both scales, which is 'low' (US-21 AC18).
    const result = resolveLabValues([
      { metric: 'ldl', value: 100, unit: 'unknown_unit', confidence: 'high' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe('medium');
    expect(result[0].question).toContain('inferred');
  });

  it('preserves existing question when unit is inferred, and adds the inferred-unit note to it (US-21 AC18)', () => {
    const result = resolveLabValues([
      { metric: 'ldl', value: 2.8, unit: 'unknown', confidence: 'low', question: 'Ambiguous value' },
    ]);
    expect(result[0].confidence).toBe('low');
    expect(result[0].question).toBe('Ambiguous value. Unit "unknown" was inferred — please verify this value');
  });

  it('handles empty array', () => {
    expect(resolveLabValues([])).toEqual([]);
  });

  it('handles multiple values', () => {
    const result = resolveLabValues([
      { metric: 'ldl', value: 2.8, unit: 'mmol/L', confidence: 'high' },
      { metric: 'hdl', value: 1.5, unit: 'mmol/L', confidence: 'high' },
      { metric: 'hba1c', value: 5.7, unit: '%', confidence: 'medium' },
    ]);
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Bug: resolveUnit for Lp(a) mg/L was previously broken (stored as nmol/L),
// then over-corrected (×2.4 per mg/L; the factor is per mg/dL). 93 mg/L is
// 23.25 nmol/L at 2.5 nmol/L per mg/dL (US-05 AC1), not 223.
// ---------------------------------------------------------------------------

describe('resolveUnit edge cases', () => {
  it('converts Lp(a) from mg/L to nmol/L', () => {
    const result = resolveUnit('lpa', 'mg/L', 93);
    expect(result.system).toBe('conventional');
    expect(result.valueSI).toBeCloseTo(23.25, 9);
    expect(result.confident).toBe(true);
  });

  it('handles creatinine µmol/L alias', () => {
    const result = resolveUnit('creatinine', 'umol/l', 95);
    expect(result.system).toBe('si');
    expect(result.valueSI).toBe(95);
    expect(result.confident).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug: ZodError POST /api/lab-import on additionalValues[N].value with
// "Expected number, received string". The LLM sometimes returns string
// values for non-numeric lab results ("<5", "trace", "POS"). The schema
// then rejected the entire response, causing all 3 retry attempts to
// fail the same way and the user saw "Extraction failed".
//
// Fix: numeric strings get coerced; non-numeric strings filtered out.
// ---------------------------------------------------------------------------

describe('parseUnifiedResult — tolerates string-typed numeric values', () => {
  const base = {
    classification: 'lab_report' as const,
    reportDate: '2026-01-01',
    values: [],
    additionalValues: [],
    document: null,
  };

  it('coerces numeric strings in additionalValues to numbers', () => {
    const result = parseUnifiedResult({
      ...base,
      additionalValues: [
        { name: 'sodium', value: '141', unit: 'mmol/L' },
        { name: 'potassium', value: 4.5, unit: 'mmol/L' },
      ],
    });
    expect(result.additionalValues).toHaveLength(2);
    expect(result.additionalValues[0]).toMatchObject({ name: 'sodium', value: 141 });
    expect(result.additionalValues[1]).toMatchObject({ name: 'potassium', value: 4.5 });
  });

  it('drops non-numeric string values (<5, trace, POS) instead of throwing', () => {
    const result = parseUnifiedResult({
      ...base,
      additionalValues: [
        { name: 'sodium', value: 141, unit: 'mmol/L' },
        { name: 'troponin', value: '<5', unit: 'ng/L' },
        { name: 'urine_protein', value: 'trace', unit: '' },
        { name: 'urine_blood', value: 'POS', unit: '' },
        { name: 'potassium', value: 4.5, unit: 'mmol/L' },
      ],
    });
    expect(result.additionalValues).toHaveLength(2);
    expect(result.additionalValues.map(v => v.name)).toEqual(['sodium', 'potassium']);
  });

  // US-12 AC8: a comma is the decimal point, as in parseLocalisedNumber;
  // stripping it read a European "5,2" as 52. But 1-3 digits, a comma, then
  // exactly 3 digits is either a US thousands separator or a European decimal,
  // and the two readings differ 1000x: "250,000" platelets read as 250 (with a
  // range scaled the same way) passes the count guard, and "1,050" pg/mL B12
  // read as 1.05 is just as silent. Such a string is refused, never guessed.
  it('US-12 AC8: refuses "1,234", "250,000", "1,050", "1,020", "5,200", "-1,050" as ambiguous (thousands or decimal, 1000x apart)', () => {
    const result = parseUnifiedResult({
      ...base,
      values: [
        { metric: 'ldl', value: '1,234', unit: 'mg/dL', confidence: 'high' as const },
        { metric: 'hdl', value: 1.3, unit: 'mmol/L', confidence: 'high' as const },
      ],
      additionalValues: [
        { name: 'platelets', value: '250,000', unit: 'cells/uL', referenceLow: '150,000', referenceHigh: '400,000' },
        { name: 'vitamin_b12', value: '1,050', unit: 'pg/mL' },
        { name: 'urine_specific_gravity', value: '1,020', unit: '' },
        { name: 'wbc', value: '5,200', unit: 'cells/uL' },
        { name: 'base_excess', value: '-1,050', unit: 'mmol/L' },
        { name: 'signed', value: '+1,050', unit: '' },
        { name: 'neutrophils', value: 3000, unit: 'cells/uL', referenceLow: '1,500', referenceHigh: '7,500' },
      ],
    });
    expect(result.values.map(v => v.metric)).toEqual(['hdl']);
    // A count row whose printed bounds read as nothing is refused too: with no
    // range left, the count guard cannot check its scale (Codex round 6).
    expect(result.additionalValues).toEqual([]);
    expect(result.droppedValueCount).toBe(8);
  });

  it('US-12 AC8: unambiguous decimal commas are decimals ("5,2" → 5.2, "0,87" → 0.87, "0,870" → 0.87, "5,2000" → 5.2)', () => {
    const result = parseUnifiedResult({
      ...base,
      values: [{ metric: 'ldl', value: '5,2', unit: 'mmol/L', confidence: 'high' as const }],
      additionalValues: [
        { name: 'creatinine', value: '0,87', unit: 'mg/dL' },
        { name: 'tsh', value: '0,870', unit: 'mIU/L' },
        { name: 'ferritin', value: '5,2000', unit: 'ug/L' },
      ],
    });
    expect(result.values[0].value).toBe(5.2);
    expect(result.additionalValues.map(v => v.value)).toEqual([0.87, 0.87, 5.2]);
  });

  it('US-12 AC8: a number followed by a flag or unit keeps the number ("5.2 H", "5,2 H", "141 mmol/L", "5.2*", "6.1 ↑", "5.2-"); a unit holding a digit ("250 x10^9/L") is refused, as any digit after the number is', () => {
    const result = parseUnifiedResult({
      ...base,
      additionalValues: [
        { name: 'sodium', value: 141, unit: 'mmol/L' },
        { name: 'potassium', value: '4.5', unit: 'mmol/L' },
        { name: 'glucose', value: ' 5 ', unit: 'mmol/L' },
        { name: 'ferritin', value: '5.2 H', unit: 'ug/L' },
        { name: 'iron', value: '5,2 H', unit: 'umol/L' },
        { name: 'chloride', value: '141 mmol/L', unit: 'mmol/L' },
        { name: 'urea', value: '5.2*', unit: 'mmol/L' },
        { name: 'hba1c', value: '6.1 ↑', unit: '%' },
        { name: 'platelets', value: '250 x10^9/L', unit: 'x10^9/L' },
        { name: 'calcium', value: '5.2-', unit: 'mmol/L' },
      ],
    });
    expect(result.additionalValues.map(v => [v.name, v.value])).toEqual([
      ['sodium', 141], ['potassium', 4.5], ['glucose', 5], ['ferritin', 5.2],
      ['iron', 5.2], ['chloride', 141], ['urea', 5.2], ['hba1c', 6.1],
      ['calcium', 5.2],
    ]);
    expect(result.droppedValueCount).toBe(1);
  });

  // The leading token stops at the first non-digit, so "1e3" read as 1 and
  // "0-2" as 0: an exponent, a hex/binary/octal prefix or a range right after
  // the number is a different number, never the first digit of it.
  it('US-12 AC8: drops, never guesses, "1 234", "<5", ">2000", "trace", "", "1.234,5", "1,234.5", "1,234,567", "250,000 H", "1e3", "5.2e3", "0x10", "0-2", "5 – 7"', () => {
    const refused = [
      '1 234', '<5', '>2000', 'trace', '', '1.234,5', '1,234.5', '1,234,567', '250,000 H',
      '1e3', '5.2e3', '5,2E-3', '1e+3', '0x10', '0X1f', '0b1', '0o7', '0-2', '0 - 2', '3.5–5.1', '5 — 7',
    ];
    const result = parseUnifiedResult({
      ...base,
      additionalValues: [
        ...refused.map((value, i) => ({ name: `r${i}`, value, unit: '' })),
        { name: 'sodium', value: 141, unit: 'mmol/L' },
      ],
    });
    expect(result.additionalValues.map(v => v.name)).toEqual(['sodium']);
  });

  it('US-12 AC8: one malformed row is dropped and the good rows kept, instead of failing the file', () => {
    const result = parseUnifiedResult({
      ...base,
      values: [
        { metric: 'ldl', value: 2.5, unit: null, confidence: 'high' },
        { metric: 'hdl', value: 1.3, unit: 'mmol/L', confidence: 'very high' },
        { metric: 'apob', value: 0.9, unit: 'g/L', confidence: 'high' },
      ],
      additionalValues: [
        { name: null, value: 141, unit: 'mmol/L' },
        { name: 'potassium', value: { amount: 4.5 }, unit: 'mmol/L' },
        { name: 'sodium', value: 141, unit: 'mmol/L' },
      ],
    });
    expect(result.values.map(v => v.metric)).toEqual(['apob']);
    expect(result.additionalValues.map(v => v.name)).toEqual(['sodium']);
  });

  it('US-12 AC8: a malformed file shape still fails the whole file', () => {
    expect(() => parseUnifiedResult({ ...base, classification: 'not_a_type' })).toThrow();
    expect(() => parseUnifiedResult({ ...base, values: null })).toThrow();
  });

  it('US-12 AC8: string reference bounds parse ("3,5" and "3.5"); an unreadable bound is null and keeps the row', () => {
    const result = parseUnifiedResult({
      ...base,
      additionalValues: [
        { name: 'potassium', value: '4,1', unit: 'mmol/L', referenceLow: '3,5', referenceHigh: '5.1' },
        { name: 'albumin', value: 40, unit: 'g/L', referenceLow: '3.5', referenceHigh: '<50' },
      ],
    });
    expect(result.additionalValues).toHaveLength(2);
    expect(result.additionalValues[0]).toMatchObject({ value: 4.1, referenceLow: 3.5, referenceHigh: 5.1 });
    expect(result.additionalValues[1]).toMatchObject({ value: 40, referenceLow: 3.5, referenceHigh: null });
  });

  it('US-12 AC8: a null unit on an additional value does not fail the file', () => {
    const result = parseUnifiedResult({
      ...base,
      additionalValues: [{ name: 'urine_ph', value: '6,0', unit: null }],
    });
    expect(result.additionalValues[0]).toMatchObject({ name: 'urine_ph', value: 6, unit: '' });
  });

  it('applies the same coercion to core values[] entries', () => {
    const result = parseUnifiedResult({
      ...base,
      values: [
        { metric: 'ldl', value: '2.5', unit: 'mmol/L', confidence: 'high' as const },
        { metric: 'hdl', value: '<0.5', unit: 'mmol/L', confidence: 'low' as const },
      ],
    });
    expect(result.values).toHaveLength(1);
    expect(result.values[0]).toMatchObject({ metric: 'ldl', value: 2.5 });
  });

  it('numeric values pass through unchanged', () => {
    const result = parseUnifiedResult({
      ...base,
      values: [{ metric: 'ldl', value: 2.5, unit: 'mmol/L', confidence: 'high' as const }],
      additionalValues: [{ name: 'sodium', value: 141, unit: 'mmol/L' }],
    });
    expect(result.values[0].value).toBe(2.5);
    expect(result.additionalValues[0].value).toBe(141);
  });
});
