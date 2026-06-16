import { describe, it, expect } from 'vitest';
import {
  parseProposedEdit,
  parseProposedEdits,
  resolveUnitSystem,
  EDITABLE_FIELDS,
  PROPOSE_FIELD_EDIT_TOOL,
  PROPOSE_MEDICATION_EDIT_TOOL,
  type ProposedFieldEdit,
  type ProposedMedicationEdit,
} from './chat-edits';
import { FIELD_TO_METRIC, UNIT_DEFS, type MetricType } from './index';

const FIELD = PROPOSE_FIELD_EDIT_TOOL.name;
const MED = PROPOSE_MEDICATION_EDIT_TOOL.name;

/** Pick the SI unit label for a field's metric. */
function siUnitFor(field: string): string {
  const metric = FIELD_TO_METRIC[field] as MetricType;
  return UNIT_DEFS[metric].label.si;
}

describe('resolveUnitSystem', () => {
  it('maps SI lipid unit to si', () => {
    expect(resolveUnitSystem('ldl', 'mmol/L')).toBe('si');
  });
  it('maps conventional lipid unit to conventional', () => {
    expect(resolveUnitSystem('ldl', 'mg/dL')).toBe('conventional');
  });
  it('is case- and space-insensitive', () => {
    expect(resolveUnitSystem('ldl', ' MMOL/L ')).toBe('si');
    expect(resolveUnitSystem('weight', 'KG')).toBe('si');
  });
  it('normalises the micro sign for creatinine', () => {
    expect(resolveUnitSystem('creatinine', 'umol/L')).toBe('si');
    expect(resolveUnitSystem('creatinine', 'µmol/L')).toBe('si');
    expect(resolveUnitSystem('creatinine', 'mg/dL')).toBe('conventional');
  });
  it('returns null for an unknown unit (ambiguous — should have asked)', () => {
    expect(resolveUnitSystem('ldl', 'g/L')).toBeNull();
    expect(resolveUnitSystem('weight', 'stone')).toBeNull();
  });
});

describe('parseProposedEdit — field edits', () => {
  it('parses a valid mmol/L LDL edit with a date', () => {
    const edit = parseProposedEdit(FIELD, {
      field: 'ldlC', value: 3.8, unit: 'mmol/L', date: '2026-06-01',
    }) as ProposedFieldEdit;
    expect(edit).toMatchObject({
      kind: 'field', field: 'ldlC', displayValue: 3.8, unitSystem: 'si', date: '2026-06-01',
    });
  });

  it('defaults date to null when omitted', () => {
    const edit = parseProposedEdit(FIELD, { field: 'weightKg', value: 80, unit: 'kg' }) as ProposedFieldEdit;
    expect(edit.date).toBeNull();
    expect(edit.unitSystem).toBe('si');
  });

  it('parses a conventional (mg/dL) edit', () => {
    const edit = parseProposedEdit(FIELD, { field: 'ldlC', value: 147, unit: 'mg/dL' }) as ProposedFieldEdit;
    expect(edit.unitSystem).toBe('conventional');
    expect(edit.displayValue).toBe(147);
  });

  it('rejects an unknown/ambiguous unit (drops rather than guesses)', () => {
    expect(parseProposedEdit(FIELD, { field: 'ldlC', value: 3.8, unit: 'g/L' })).toBeNull();
  });

  it('rejects an unknown field', () => {
    expect(parseProposedEdit(FIELD, { field: 'cholesterolRatio', value: 3, unit: 'x' })).toBeNull();
  });

  it('rejects a non-numeric value', () => {
    expect(parseProposedEdit(FIELD, { field: 'ldlC', value: 'high', unit: 'mmol/L' })).toBeNull();
  });

  it('rejects a malformed date', () => {
    expect(parseProposedEdit(FIELD, { field: 'ldlC', value: 3.8, unit: 'mmol/L', date: 'June 1' })).toBeNull();
  });

  it('does NOT range-check (out-of-range pre-fill allowed; Save blocks it)', () => {
    const edit = parseProposedEdit(FIELD, { field: 'ldlC', value: 999, unit: 'mmol/L' }) as ProposedFieldEdit;
    expect(edit).not.toBeNull();
    expect(edit.displayValue).toBe(999);
  });

  it('covers every editable field for at least one unit', () => {
    for (const field of EDITABLE_FIELDS) {
      // pick the SI unit label by parsing with a value; just confirm a valid si unit resolves
      const edit = parseProposedEdit(FIELD, { field, value: 1, unit: siUnitFor(field) });
      expect(edit, `field ${field} should parse with its SI unit`).not.toBeNull();
    }
  });
});

describe('parseProposedEdit — medication edits', () => {
  it('parses a statin with drug + dose', () => {
    const edit = parseProposedEdit(MED, {
      medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg',
    }) as ProposedMedicationEdit;
    expect(edit).toMatchObject({
      kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg',
    });
  });

  it('parses a status token without a dose', () => {
    const edit = parseProposedEdit(MED, { medicationKey: 'ezetimibe', drugName: 'yes' }) as ProposedMedicationEdit;
    expect(edit.doseValue).toBeNull();
    expect(edit.doseUnit).toBeNull();
  });

  it('rejects an unknown medication key', () => {
    expect(parseProposedEdit(MED, { medicationKey: 'aspirin', drugName: 'aspirin' })).toBeNull();
  });

  it('rejects a missing drugName', () => {
    expect(parseProposedEdit(MED, { medicationKey: 'statin' })).toBeNull();
  });
});

describe('parseProposedEdits — block array', () => {
  it('keeps only valid tool_use blocks, preserving order', () => {
    const edits = parseProposedEdits([
      { type: 'text', name: undefined },
      { type: 'tool_use', name: FIELD, input: { field: 'ldlC', value: 3.8, unit: 'mmol/L', date: '2026-06-01' } },
      { type: 'tool_use', name: FIELD, input: { field: 'hdlC', value: 1.1, unit: 'mmol/L', date: '2026-06-01' } },
      { type: 'tool_use', name: FIELD, input: { field: 'ldlC', value: 3.8, unit: 'g/L' } }, // bad unit → dropped
      { type: 'tool_use', name: 'unknown_tool', input: {} },
    ]);
    expect(edits).toHaveLength(2);
    expect((edits[0] as ProposedFieldEdit).field).toBe('ldlC');
    expect((edits[1] as ProposedFieldEdit).field).toBe('hdlC');
  });

  it('returns empty for a pure text response (no tool use — additive, no regression)', () => {
    expect(parseProposedEdits([{ type: 'text' }])).toEqual([]);
  });
});
