import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import {
  parseProposedEdit,
  parseProposedEdits,
  toolOnlyAck,
  EDITABLE_FIELDS,
  PROPOSE_FIELD_EDIT_TOOL,
  PROPOSE_MEDICATION_EDIT_TOOL,
  type ProposedFieldEdit,
  type ProposedMedicationEdit,
} from './chat-edits';
import { FIELD_TO_METRIC, UNIT_DEFS, toCanonicalValue, type MetricType } from './index';
import { lookupUnit, type UnitSystem } from './units';

/** The system a stated unit names, as the chatbot's parser reads it. */
const systemOf = (metric: MetricType, unit: string): UnitSystem | null => lookupUnit(metric, unit)?.system ?? null;

const FIELD = PROPOSE_FIELD_EDIT_TOOL.name;
const MED = PROPOSE_MEDICATION_EDIT_TOOL.name;

/** Pick the SI unit label for a field's metric. */
function siUnitFor(field: string): string {
  const metric = FIELD_TO_METRIC[field] as MetricType;
  return UNIT_DEFS[metric].label.si;
}

describe('lookupUnit — the stated unit\u2019s system', () => {
  it('maps SI lipid unit to si', () => {
    expect(systemOf('ldl', 'mmol/L')).toBe('si');
  });
  it('maps conventional lipid unit to conventional', () => {
    expect(systemOf('ldl', 'mg/dL')).toBe('conventional');
  });
  it('is case- and space-insensitive', () => {
    expect(systemOf('ldl', ' MMOL/L ')).toBe('si');
    expect(systemOf('weight', 'KG')).toBe('si');
  });
  it('normalises the micro sign for creatinine', () => {
    expect(systemOf('creatinine', 'umol/L')).toBe('si');
    expect(systemOf('creatinine', 'µmol/L')).toBe('si');
    expect(systemOf('creatinine', 'mg/dL')).toBe('conventional');
  });
  it('returns null for an unknown unit (ambiguous — should have asked)', () => {
    expect(systemOf('ldl', 'g/L')).toBeNull();
    expect(systemOf('weight', 'stone')).toBeNull();
  });
});

// US-05: Lp(a) off a US report is mg/dL, off an NZ/AU/UK report mg/L. The
// chatbot pre-fills either, converted to the same canonical a clinician expects.
describe('US-05 AC1 — the chatbot reads Lp(a) in mg/dL and in mg/L', () => {
  const canonical = (unit: string, value: number) => {
    const edit = parseProposedEdit(FIELD, { field: 'lpa', value, unit }) as ProposedFieldEdit;
    return toCanonicalValue('lpa', edit.displayValue, edit.unitSystem);
  };
  it('156 mg/dL (a US report) → 390 nmol/L', () => {
    expect(canonical('mg/dL', 156)).toBeCloseTo(390, 9);
  });
  it('93 mg/L (an NZ report) → 23.25 nmol/L', () => {
    expect(canonical('mg/L', 93)).toBeCloseTo(23.25, 9);
  });
  it('ApoB 900 mg/L, the other scaled print, → 0.9 g/L', () => {
    const edit = parseProposedEdit(FIELD, { field: 'apoB', value: 900, unit: 'mg/L' }) as ProposedFieldEdit;
    expect(toCanonicalValue('apob', edit.displayValue, edit.unitSystem)).toBeCloseTo(0.9, 6);
  });
  it('an inherited key is not a unit: "__proto__" and "constructor" are refused', () => {
    expect(parseProposedEdit(FIELD, { field: 'lpa', value: 50, unit: '__proto__' })).toBeNull();
    expect(parseProposedEdit(FIELD, { field: 'lpa', value: 50, unit: 'constructor' })).toBeNull();
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

// ---------------------------------------------------------------------------
// Fixture self-validation: the live tool-use harness (tools/test-tool-edits.ts)
// asserts the model's output against tools/test-tool-edits.json. If a fixture
// expectation states a field/unit the parser can't even produce, the live
// harness would fail for the wrong reason (a stale fixture, not a model bug).
// This guards the fixture's structured expectations are themselves producible
// — without spending any API tokens.
// ---------------------------------------------------------------------------

describe('tools/test-tool-edits.json fixture is self-consistent', () => {
  const fixturePath = new URL('../../../tools/test-tool-edits.json', import.meta.url);
  const cases = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Array<{
    name: string;
    query: string;
    expect: {
      edits: Array<Record<string, unknown> & { kind: 'field' | 'medication' }>;
      mustAskClarifying?: boolean;
    };
  }>;

  it('has unique non-empty case names and queries', () => {
    expect(cases.length).toBeGreaterThan(0);
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of cases) {
      expect(c.name).toBeTruthy();
      expect(c.query).toBeTruthy();
    }
  });

  it('every expected edit is a value the parser would accept', () => {
    for (const c of cases) {
      for (const e of c.expect.edits) {
        if (e.kind === 'field') {
          const metric = FIELD_TO_METRIC[e.field as string] as MetricType;
          // The expectation's stated unitSystem must be a real label for that metric,
          // and feeding it back through the parser must reproduce the same intent.
          const unit = UNIT_DEFS[metric].label[e.unitSystem as 'si' | 'conventional'];
          const parsed = parseProposedEdit(FIELD, {
            field: e.field, value: e.displayValue, unit, date: e.date,
          }) as ProposedFieldEdit | null;
          expect(parsed, `${c.name}: field edit ${JSON.stringify(e)} must round-trip`).not.toBeNull();
          expect(parsed!.field).toBe(e.field);
          expect(parsed!.unitSystem).toBe(e.unitSystem);
          expect(parsed!.displayValue).toBe(e.displayValue);
        } else {
          const parsed = parseProposedEdit(MED, {
            medicationKey: e.medicationKey, drugName: e.drugName,
            doseValue: e.doseValue, doseUnit: e.doseUnit,
          }) as ProposedMedicationEdit | null;
          expect(parsed, `${c.name}: medication edit ${JSON.stringify(e)} must round-trip`).not.toBeNull();
          expect(parsed!.medicationKey).toBe(e.medicationKey);
        }
      }
    }
  });
});

// US-16 / chat audit F5: a tool-only turn gets a line that matches what happened.
// Medication edits save at once (undo banner); measurements wait for Save.
describe('toolOnlyAck', () => {
  const field = parseProposedEdit(FIELD, { field: 'ldlC', value: 2.1, unit: 'mmol/L' })!;
  const med = parseProposedEdit(MED, { medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg' })!;
  it('measurements only: review the highlighted value and press Save', () => {
    expect(toolOnlyAck([field])).toBe("I've pre-filled that in your form — review the highlighted value and press Save.");
  });
  it('medication only: says it is done and points at the undo banner, never "press Save"', () => {
    expect(toolOnlyAck([med])).toBe("Done — I've updated your medications. You can undo this from the banner.");
  });
  it('mixed: covers both the Save and the undo', () => {
    const line = toolOnlyAck([field, med]);
    expect(line).toContain('press Save');
    expect(line).toContain('undo');
  });
});
