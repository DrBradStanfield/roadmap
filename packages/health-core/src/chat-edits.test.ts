import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import {
  parseProposedEdit,
  parseProposedEdits,
  toolOnlyAck,
  readProposedEdits,
  chatMedicationChange,
  unsavedProfile,
  medicationAnswerMisfit,
  EDITABLE_FIELDS,
  PROPOSE_FIELD_EDIT_TOOL,
  PROPOSE_MEDICATION_EDIT_TOOL,
  PROPOSE_PROFILE_EDIT_TOOL,
  CHAT_EDIT_TOOLS,
  type ProposedFieldEdit,
  type ProposedMedicationEdit,
} from './chat-edits';
import { FIELD_TO_METRIC, UNIT_DEFS, toCanonicalValue, type MetricType } from './index';
import { lookupUnit, type UnitSystem } from './units';
import { medicationsToInputs } from './mappings';
import { lipidCascade, weightCascade } from './medication-cascades';
import {
  BEMPEDOIC_ACID_OPTIONS, EZETIMIBE_OPTIONS, GLP1_NAMES, METFORMIN_OPTIONS, PCSK9I_OPTIONS, SGLT2I_NAMES, STATIN_NAMES,
} from './types';

/** The system a stated unit names, as the chatbot's parser reads it. */
const systemOf = (metric: MetricType, unit: string): UnitSystem | null => lookupUnit(metric, unit)?.system ?? null;

const FIELD = PROPOSE_FIELD_EDIT_TOOL.name;
const MED = PROPOSE_MEDICATION_EDIT_TOOL.name;
const PROFILE = PROPOSE_PROFILE_EDIT_TOOL.name;

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
      edits: Array<Record<string, unknown> & { kind: 'field' | 'medication' | 'profile' }>;
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
        } else if (e.kind === 'profile') {
          const parsed = parseProposedEdit(PROFILE, {
            ...(e.sex ? { sex: e.sex } : {}),
            ...(e.heightCm !== undefined ? { height: { value: e.heightCm, unit: 'cm' } } : {}),
          });
          expect(parsed, `${c.name}: profile edit ${JSON.stringify(e)} must round-trip`)
            .toEqual({ kind: 'profile', sex: e.sex ?? null, heightCm: e.heightCm ?? null });
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

// US-16 AC2 (2026-10-20, Brad): the chat proposes a stated sex or height; the
// widget writes it only when the user confirms. The parser holds the height to
// the schema's range, since the profile has no Save step that would.
describe('US-16 AC2: parseProposedEdit — profile edits', () => {
  it('the form tools include propose_profile_edit', () => {
    expect(CHAT_EDIT_TOOLS.map((t) => t.name)).toContain(PROFILE);
  });
  it('parses a sex and a height in cm', () => {
    expect(parseProposedEdit(PROFILE, { sex: 'male', height: { value: 178, unit: 'cm' } }))
      .toEqual({ kind: 'profile', sex: 'male', heightCm: 178 });
  });
  it('converts a height in inches (5 ft 10 in as 70 in) to cm', () => {
    expect(parseProposedEdit(PROFILE, { height: { value: 70, unit: 'in' } }))
      .toEqual({ kind: 'profile', sex: null, heightCm: toCanonicalValue('height', 70, 'conventional') });
  });
  it('parses a sex alone', () => {
    expect(parseProposedEdit(PROFILE, { sex: 'female' })).toEqual({ kind: 'profile', sex: 'female', heightCm: null });
  });
  it('refuses a height out of range in either unit, and the sex beside it', () => {
    expect(parseProposedEdit(PROFILE, { sex: 'male', height: { value: 17.8, unit: 'cm' } })).toBeNull();
    expect(parseProposedEdit(PROFILE, { height: { value: 251, unit: 'cm' } })).toBeNull();
    expect(parseProposedEdit(PROFILE, { height: { value: 178, unit: 'in' } })).toBeNull(); // 452 cm
    expect(parseProposedEdit(PROFILE, { height: { value: 50, unit: 'cm' } })).not.toBeNull(); // the floor itself
  });
  it('refuses a sex outside the enum, an unknown unit, an unknown key, or nothing at all', () => {
    expect(parseProposedEdit(PROFILE, { sex: 'man' })).toBeNull();
    expect(parseProposedEdit(PROFILE, { sex: 'other' })).toBeNull();
    expect(parseProposedEdit(PROFILE, { height: { value: 5.8, unit: 'ft' } })).toBeNull();
    expect(parseProposedEdit(PROFILE, { height: { value: '178', unit: 'cm' } })).toBeNull();
    expect(parseProposedEdit(PROFILE, { sex: 'male', birthYear: 1974 })).toBeNull();
    expect(parseProposedEdit(PROFILE, {})).toBeNull();
  });
  // Review 2026-10-20 (Codex R3, adversary R5): the nested height is strict too.
  it('refuses an unknown key inside the height, and the sex beside it', () => {
    expect(parseProposedEdit(PROFILE, { sex: 'male', height: { value: 178, unit: 'cm', feet: 5 } })).toBeNull();
    expect(parseProposedEdit(PROFILE, { height: { value: 70, unit: 'in', note: 'about' } })).toBeNull();
  });
  it('treats a null sex or height as absent, not a refusal', () => {
    expect(parseProposedEdit(PROFILE, { sex: null, height: { value: 178, unit: 'cm' } }))
      .toEqual({ kind: 'profile', sex: null, heightCm: 178 });
    expect(parseProposedEdit(PROFILE, { sex: 'female', height: null })).toEqual({ kind: 'profile', sex: 'female', heightCm: null });
    expect(parseProposedEdit(PROFILE, { sex: null, height: null })).toBeNull();
  });
  it('a profile-only turn asks the user to confirm, never claims a save', () => {
    const profile = parseProposedEdit(PROFILE, { sex: 'male' })!;
    const line = toolOnlyAck([profile]);
    expect(line).toContain('press Save');
    expect(line).not.toMatch(/saved|updated|pre-filled/i);
  });

  // US-16 AC2b: the profile banner waits for its own Save, so a mixed turn's
  // line must say so; before, a medication + profile turn said only "Done".
  it.each([
    ['medication', [{ medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg' }], []],
    ['measurement', [], [{ field: 'ldlC', value: 2.1, unit: 'mmol/L' }]],
    ['medication and measurement', [{ medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg' }], [{ field: 'ldlC', value: 2.1, unit: 'mmol/L' }]],
  ] as const)('US-16 AC2b: a %s turn with a profile edit asks for the profile Save too', (_, meds, fields) => {
    const profile = parseProposedEdit(PROFILE, { sex: 'female', height: { value: 165, unit: 'cm' } })!;
    const edits = [...meds.map((m) => parseProposedEdit(MED, m)!), ...fields.map((f) => parseProposedEdit(FIELD, f)!), profile];
    const line = toolOnlyAck(edits);
    expect(line).toContain('press Save to add them to your profile');
    expect(line).toBe(`${toolOnlyAck(edits.filter((e) => e.kind !== 'profile'))} Please check the profile details shown and press Save to add them to your profile.`);
  });
});

// US-67 AC3: the app's tool-only line never says a value is saved before Save.
describe('US-67 AC3: toolOnlyAck in the app', () => {
  const field = parseProposedEdit(FIELD, { field: 'ldlC', value: 3.4, unit: 'mmol/L' })!;
  const med = parseProposedEdit(MED, { medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' })!;
  const profile = parseProposedEdit(PROFILE, { sex: 'male' })!;
  it('US-67 AC3: a value is ready to save, never pre-filled in a form', () => {
    expect(toolOnlyAck([field], true)).toBe("I've put that ready to save — check it and press Save.");
  });
  it('US-67 AC3: a medication is done with undo from the banner, as on the web', () => {
    expect(toolOnlyAck([med], true)).toBe(toolOnlyAck([med]));
  });
  it('US-67 AC3: both name the undo and the Save, and never the form', () => {
    const line = toolOnlyAck([field, med], true);
    expect(line).toMatch(/undo from the banner/);
    expect(line).toMatch(/press Save/);
    expect(line).not.toMatch(/form/);
  });
  it('US-67 AC3: a profile edit asks for Save, as on the web', () => {
    expect(toolOnlyAck([profile], true)).toBe(toolOnlyAck([profile]));
  });
});

// US-67 AC2: what a client receives is read again; junk never throws.
describe('US-67 AC2: readProposedEdits', () => {
  const field = { kind: 'field', field: 'ldlC', displayValue: 3.4, unitSystem: 'si', date: null };
  it('US-67 AC2: keeps valid edits, leaves out unknown kinds, and names a broken known kind', () => {
    const read = readProposedEdits([field, { kind: 'future_kind', x: 1 }, { kind: 'field', field: 'ldlC', displayValue: 'x', unitSystem: 'si', date: null }, null, 7]);
    expect(read.edits).toEqual([field]);
    expect(read.invalid).toEqual(['field']);
  });
  it.each([null, 'x', {}, 3])('US-67 AC2: a list that is not one (%s) is invalid', (raw) => {
    expect(readProposedEdits(raw)).toEqual({ edits: [], invalid: ['list'] });
  });
  it('US-67 AC2: a profile edit with nothing in it, or a bad date, is invalid', () => {
    expect(readProposedEdits([{ kind: 'profile', sex: null, heightCm: null }]).invalid).toEqual(['profile']);
    expect(readProposedEdits([{ ...field, date: '2026-11-02T00:00' }]).invalid).toEqual(['field']);
    expect(readProposedEdits([{ kind: 'medication', medicationKey: '__proto__', drugName: 'x', doseValue: null, doseUnit: null }]).invalid).toEqual(['medication']);
  });
});

// US-06 AC12, shared by the web widget and the iPhone engine (US-67 AC4).
describe('chatMedicationChange: the rows Undo restores and the escalation reset', () => {
  const edit = (drugName: string, doseValue: number | null = null) => ({ kind: 'medication' as const, medicationKey: 'statin' as const, drugName, doseValue, doseUnit: doseValue ? 'mg' : null });
  const row = (medicationKey: string, drugName: string, doseValue: number | null = null) => ({ medicationKey, drugName, doseValue, doseUnit: doseValue ? 'mg' : null });
  it('a key with no row goes back to its unanswered value', () => {
    expect(chatMedicationChange(edit('atorvastatin', 20), [], new Set(['statin'])).undo).toEqual([row('statin', 'none')]);
  });
  it('a new dose resets a held escalation answer, which Undo restores first', () => {
    const saved = [row('statin', 'atorvastatin', 10), row('statin_escalation', 'not_tolerated')];
    expect(chatMedicationChange(edit('atorvastatin', 20), saved, new Set(['statin']))).toEqual({
      undo: [row('statin_escalation', 'not_tolerated'), row('statin', 'atorvastatin', 10)], reset: 'statin_escalation',
    });
  });
  it('the same drug and dose, or an answer the reply states, resets nothing', () => {
    const saved = [row('statin', 'atorvastatin', 20), row('statin_escalation', 'not_tolerated')];
    expect(chatMedicationChange(edit('atorvastatin', 20), saved, new Set(['statin'])).reset).toBeNull();
    expect(chatMedicationChange(edit('rosuvastatin', 10), saved, new Set(['statin', 'statin_escalation'])).reset).toBeNull();
  });
  it('an unsaved form row that differs also resets (the web\'s extra)', () => {
    const saved = [row('statin', 'atorvastatin', 20)];
    expect(chatMedicationChange(edit('atorvastatin', 20), saved, new Set(['statin']), { drugName: 'atorvastatin', doseValue: 40 }).reset).toBe('statin_escalation');
  });
});

describe('unsavedProfile (US-16 AC2)', () => {
  it('drops what the profile already holds as the user sees it', () => {
    expect(unsavedProfile({ kind: 'profile', sex: 'male', heightCm: 178.2 }, { sex: 'male', heightCm: 178 }, 'si')).toBeNull();
    expect(unsavedProfile({ kind: 'profile', sex: 'male', heightCm: 180 }, { sex: 'male', heightCm: 178 }, 'si')).toEqual({ kind: 'profile', sex: null, heightCm: 180 });
    expect(unsavedProfile({ kind: 'profile', sex: 'female', heightCm: null }, { heightCm: null }, 'si')).toEqual({ kind: 'profile', sex: 'female', heightCm: null });
  });
});

// US-16 AC3 (Brad 2026-11-02: "Ideally we want to map to the users data and their
// database. If there's confusion, chat should ask the user"). A medication edit
// saves at once, so its answer is the question's own value, mapped from the
// user's words where they mean one; any other answer is not saved and the
// model is told to ask (run-roadmap.test.ts).
describe('US-16 AC3: a chat medication answer is saved as its question’s own value', () => {
  const saved = (medicationKey: string, drugName: string, doseValue?: number) =>
    (parseProposedEdit(MED, { medicationKey, drugName, ...(doseValue ? { doseValue, doseUnit: 'mg' } : {}) }) as ProposedMedicationEdit | null)?.drugName ?? null;

  it.each(['ezetimibe', 'pcsk9i'])('US-16 AC3: "not taking" (none) for %s saves as no, and the plan still suggests the step', (key) => {
    expect(saved(key, 'none')).toBe('no');
    expect(saved(key, 'None')).toBe('no');
  });

  it('US-16 AC3: ezetimibe saved as no keeps the plan on the ezetimibe step, exactly as not_yet does', () => {
    const plan = (drugName: string) => lipidCascade(medicationsToInputs([
      { medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20 },
      { medicationKey: 'ezetimibe', drugName, doseValue: null },
    ]));
    expect(plan(saved('ezetimibe', 'none')!)).toEqual(plan('not_yet'));
    expect(plan(saved('ezetimibe', 'none')!).suggest).toEqual(['ezetimibe']);
  });

  it.each(['statin', 'glp1', 'sglt2i', 'metformin'])('US-16 AC3: "not yet" for %s saves as none, its "haven’t tried yet"', (key) => {
    expect(saved(key, 'not_yet')).toBe('none');
  });

  it('US-16 AC3: a GLP-1 sent as not_yet keeps the plan on the GLP-1 step', () => {
    const drug = saved('glp1', 'not_yet')!;
    expect(weightCascade(medicationsToInputs([{ medicationKey: 'glp1', drugName: drug, doseValue: null }])).suggest).toEqual(['glp1']);
  });

  it.each(['evolocumab', 'Alirocumab', 'inclisiran', 'Repatha', 'praluent', 'Leqvio', 'pcsk9i'])('US-16 AC3: the PCSK9 drug %s under pcsk9i saves as yes', (name) => {
    expect(saved('pcsk9i', name, 140)).toBe('yes');
  });

  it('US-16 AC3: ezetimibe named under ezetimibe saves as yes', () => {
    expect(saved('ezetimibe', 'ezetimibe', 10)).toBe('yes');
    expect(medicationsToInputs([{ medicationKey: 'ezetimibe', drugName: saved('ezetimibe', 'ezetimibe')!, doseValue: null }]).ezetimibe).toBe('yes');
  });

  it('US-16 AC3: the question’s own answers save unchanged; a listed drug in another case saves as listed', () => {
    for (const [key, name] of [['ezetimibe', 'not_tolerated'], ['pcsk9i', 'not_yet'], ['bempedoic_acid', 'none'], ['metformin', 'xr_1000'],
      ['statin_escalation', 'not_tolerated'], ['glp1', 'other'], ['sglt2i', 'empagliflozin'], ['statin', 'atorvastatin']]) {
      expect(saved(key, name)).toBe(name);
    }
    expect(saved('statin', 'Atorvastatin', 20)).toBe('atorvastatin');
  });

  it('US-16 AC3: a drug key still takes an unlisted drug name as stated', () => {
    expect(saved('statin', 'fluvastatin', 40)).toBe('fluvastatin');
    expect(saved('glp1', 'liraglutide')).toBe('liraglutide');
  });

  it.each([
    ['ezetimibe', 'atorvastatin'], ['ezetimibe', 'constructor'], ['pcsk9i', 'ezetimibe'], ['bempedoic_acid', 'yes'],
    ['metformin', 'yes'], ['statin_escalation', 'none'], ['glp1', 'no'], ['glp1', 'yes'], ['statin', 'yes'],
    ['glp1', 'atorvastatin'], ['statin', 'ezetimibe'], ['sglt2i', 'ir_1000'], ['statin', 'other'],
  ])('US-16 AC3: %s answered "%s" is not saved, and the model is told to ask', (medicationKey, drugName) => {
    expect(parseProposedEdit(MED, { medicationKey, drugName })).toBeNull();
    const ask = medicationAnswerMisfit(MED, { medicationKey, drugName });
    expect(ask).toContain(`Not saved: "${drugName}" is not an answer to the ${medicationKey} question.`);
    expect(ask).toContain('Ask the user which of these applies');
  });

  it('US-16 AC3: the refusal names the question’s exact answers', () => {
    expect(medicationAnswerMisfit(MED, { medicationKey: 'ezetimibe', drugName: 'atorvastatin' })).toBe(
      'Not saved: "atorvastatin" is not an answer to the ezetimibe question. Ask the user which of these applies, then propose it again ' +
      "with that answer: 'not_yet' (Haven't tried yet), 'yes' (Yes), 'no' (No), 'not_tolerated' (Not tolerated).",
    );
  });

  it('US-16 AC3: an answer that fits, or an edit of another shape, gets no refusal', () => {
    expect(medicationAnswerMisfit(MED, { medicationKey: 'ezetimibe', drugName: 'none' })).toBeNull();
    expect(medicationAnswerMisfit(MED, { medicationKey: 'aspirin', drugName: 'aspirin' })).toBeNull();
    expect(medicationAnswerMisfit(FIELD, { medicationKey: 'ezetimibe', drugName: 'atorvastatin' })).toBeNull();
  });

  it('US-16 AC3: the tool description lists each medication key’s exact answers', () => {
    const text = PROPOSE_MEDICATION_EDIT_TOOL.input_schema.properties.drugName.description;
    const lists: Record<string, ReadonlyArray<{ value: string }>> = {
      statin: STATIN_NAMES, ezetimibe: EZETIMIBE_OPTIONS, pcsk9i: PCSK9I_OPTIONS, bempedoic_acid: BEMPEDOIC_ACID_OPTIONS,
      glp1: GLP1_NAMES, sglt2i: SGLT2I_NAMES, metformin: METFORMIN_OPTIONS,
      statin_escalation: [{ value: 'not_yet' }, { value: 'not_tolerated' }], glp1_escalation: [{ value: 'not_yet' }, { value: 'not_tolerated' }],
    };
    for (const [key, options] of Object.entries(lists)) {
      const line = text.replace(/^.*? own: /, '').split('; ').find((l) => l.startsWith(`${key}: `));
      expect(line, key).toBeDefined();
      for (const { value } of options) expect(line, `${key} ${value}`).toContain(`'${value}'`);
    }
    expect(text).not.toMatch(/'none' \(not taking\)/);
  });
});
