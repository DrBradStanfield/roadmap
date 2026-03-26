import { describe, it, expect } from 'vitest';
import { stripCodeFences, resolveLabValues, resolveUnit } from './anthropic.server';

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
