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
    const result = resolveLabValues([
      { metric: 'ldl', value: 2.8, unit: 'unknown_unit', confidence: 'high' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe('medium');
    expect(result[0].question).toContain('inferred');
  });

  it('preserves existing question when unit is inferred', () => {
    const result = resolveLabValues([
      { metric: 'ldl', value: 2.8, unit: 'unknown', confidence: 'low', question: 'Ambiguous value' },
    ]);
    expect(result[0].confidence).toBe('low');
    expect(result[0].question).toBe('Ambiguous value');
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
// Bug: resolveUnit for Lp(a) mg/L was previously broken (stored as nmol/L).
// Verify the conversion factor is applied correctly.
// ---------------------------------------------------------------------------

describe('resolveUnit edge cases', () => {
  it('converts Lp(a) from mg/L to nmol/L', () => {
    const result = resolveUnit('lpa', 'mg/L', 93);
    expect(result.system).toBe('conventional');
    expect(result.valueSI).toBeCloseTo(93 * 2.4, 0);
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

  it('coerces european thousand-separator strings ("1,234")', () => {
    const result = parseUnifiedResult({
      ...base,
      additionalValues: [
        { name: 'platelets', value: '1,234', unit: 'x 10e9/L' },
      ],
    });
    expect(result.additionalValues[0].value).toBe(1234);
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
