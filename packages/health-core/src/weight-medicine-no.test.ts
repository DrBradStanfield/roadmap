/**
 * US-06 AC22 (Brad 2026-11-23): "The metformin picker, it needs a no option."
 * Each weight and diabetes picker (GLP-1, SGLT2 inhibitor, metformin) offers
 * "No": not taking it, move on to the next step, as "Not tolerated" does.
 * The picker stays, so the person can change the answer and the card returns.
 */
import { describe, it, expect } from 'vitest';
import { calculateHealthResults } from './calculations';
import { GLP1_NAMES, SGLT2I_NAMES, METFORMIN_OPTIONS, type MedicationInputs } from './types';
import { medicationForm, medicationWrites, type MedicationBasis } from './input-form';
import { medicationsToInputs } from './mappings';
import { classifyMedicationChange, isTakingDrug } from './history-change';
import { isActiveMedication } from './reminders';
import { parseProposedEdit, PROPOSE_MEDICATION_EDIT_TOOL, type ProposedMedicationEdit } from './chat-edits';

const BMI_32 = { heightCm: 178, sex: 'male', birthYear: 1980, weightKg: 101.4 } as const;
const cards = (meds: MedicationInputs) => calculateHealthResults(BMI_32, 'si', meds).suggestions
  .map((s) => s.id).filter((id) => id.startsWith('weight-med-'));
const cascadeOn: MedicationBasis = {
  lipidMarker: null, weightMedTrigger: { on: true, reasons: [] }, bmi: 32, hasLipidInput: false, hasWeightInput: true, unitFor: () => 'si',
};
const fields = (meds: MedicationInputs) => medicationForm(meds, cascadeOn).flatMap((s) => s.groups.flatMap((g) => g.fields))
  .flatMap((f) => ('key' in f ? [f] : [])) as Array<{ key: string; value?: string; options?: Array<{ value: string; label: string }> }>;
/** The answer saved through the form, read back from its rows as the plan reads the file. */
const roundTrip = (meds: MedicationInputs, field: string, value: string): MedicationInputs =>
  medicationsToInputs(medicationWrites(meds, true, field, value).map((w, i) => ({ ...w, id: String(i), updatedAt: '' })));

const GLP1_NO: MedicationInputs = { glp1: { drug: 'no', dose: null } };
const SGLT2I_NO: MedicationInputs = { ...GLP1_NO, sglt2i: { drug: 'no', dose: null } };

describe('US-06 AC22: "No" on each weight and diabetes picker', () => {
  it.each([['glp1', GLP1_NAMES], ['sglt2i', SGLT2I_NAMES], ['metformin', METFORMIN_OPTIONS]] as const)(
    'US-06 AC22: the %s picker offers "No" just before "Not tolerated"', (key, options) => {
      const labels = options.map((o) => o.label);
      expect(labels.slice(-2)).toEqual(['No', 'Not tolerated']);
      expect(options.find((o) => o.label === 'No')?.value).toBe('no');
      const recorded = key === 'metformin' ? { glp1: GLP1_NO.glp1, sglt2i: SGLT2I_NO.sglt2i, metformin: 'no' as const } : key === 'sglt2i' ? SGLT2I_NO : GLP1_NO;
      // The recorded "No" shows as itself, not as "Other (recorded)".
      expect(fields(recorded).find((f) => f.key === key)?.options?.map((o) => o.label)).toEqual(labels);
    });

  it('US-06 AC22: GLP-1 "No": its card goes, no dose or step-up question, and the SGLT2 inhibitor card shows', () => {
    expect(cards({})).toEqual(['weight-med-glp1']);
    expect(cards(GLP1_NO)).toEqual(['weight-med-sglt2i']);
    const keys = fields(GLP1_NO).map((f) => f.key);
    expect(keys).toEqual(['glp1', 'sglt2i']);
  });

  it('US-06 AC22: SGLT2 inhibitor "No" moves on to metformin; metformin "No" leaves no card', () => {
    expect(cards(SGLT2I_NO)).toEqual(['weight-med-metformin']);
    expect(cards({ ...SGLT2I_NO, metformin: 'no' })).toEqual([]);
    expect(fields({ ...SGLT2I_NO, metformin: 'no' }).map((f) => f.key)).toEqual(['glp1', 'sglt2i', 'metformin']);
  });

  it('US-06 AC22: the picker stays after "No", and "Haven\'t tried yet" brings the card back', () => {
    const all = { ...SGLT2I_NO, metformin: 'no' as const };
    expect(fields(all).find((f) => f.key === 'metformin')?.value).toBe('no');
    expect(cards({ ...all, metformin: 'none' })).toEqual(['weight-med-metformin']);
    expect(cards({ ...all, sglt2i: { drug: 'none', dose: null } })).toEqual(['weight-med-sglt2i']);
    expect(cards({ ...all, glp1: { drug: 'none', dose: null } })).toEqual(['weight-med-glp1']);
  });

  it('US-06 AC22: GLP-1 "No" after a recorded step-up answer still shows that answer, as "Not tolerated" does', () => {
    for (const drug of ['no', 'not_tolerated']) {
      const meds: MedicationInputs = { glp1: { drug, dose: null }, glp1Escalation: 'not_tolerated' };
      expect(cards(meds), drug).toEqual(['weight-med-sglt2i']);
      expect(fields(meds).map((f) => f.key), drug).toEqual(['glp1', 'glp1_escalation', 'sglt2i']);
      expect(fields(meds).find((f) => f.key === 'glp1_escalation')?.value, drug).toBe('not_tolerated');
    }
  });

  it.each([['statin', 'tier_1'], ['glp1', 'liraglutide'], ['sglt2i', 'ertugliflozin']])(
    'US-06 AC22: a %s answer off the dose table (%s) saves with no dose and no unit', (key, value) => {
      expect(medicationWrites({}, false, key, value)).toEqual([{ medicationKey: key, drugName: value, doseValue: null, doseUnit: null }]);
    });

  it.each(['glp1', 'sglt2i', 'metformin'])('US-06 AC22: %s "No" saves as no with no dose, and reads back as no', (key) => {
    expect(medicationWrites({}, true, key, 'no')).toEqual([{ medicationKey: key, drugName: 'no', doseValue: null, doseUnit: null }]);
    const back = roundTrip({}, key, 'no');
    expect(key === 'metformin' ? back.metformin : back[key as 'glp1' | 'sglt2i']).toEqual(key === 'metformin' ? 'no' : { drug: 'no', dose: null });
  });

  it('US-06 AC22: "No" is not taking: no history row, no chart pin, no medication review', () => {
    expect(isTakingDrug('no')).toBe(false);
    expect(classifyMedicationChange(undefined, { medicationKey: 'metformin', drugName: 'no', doseValue: null, doseUnit: null })).toBeNull();
    expect(classifyMedicationChange({ drugName: 'none', doseValue: null, doseUnit: null }, { medicationKey: 'glp1', drugName: 'no', doseValue: null, doseUnit: null })).toBeNull();
    expect(isActiveMedication({ medicationKey: 'sglt2i', drugName: 'no' })).toBe(false);
  });

  it.each(['glp1', 'sglt2i', 'metformin'])('US-06 AC22: the chat saves "no" and "not taking" for %s as no', (medicationKey) => {
    const saved = (drugName: string) =>
      (parseProposedEdit(PROPOSE_MEDICATION_EDIT_TOOL.name, { medicationKey, drugName }) as ProposedMedicationEdit | null)?.drugName ?? null;
    expect(saved('no')).toBe('no');
    expect(saved('not taking')).toBe('no');
    expect(saved('not yet')).toBe('none');
  });

  // Deliberate: a weight medicine's own "Haven't tried yet" value is 'none', so the chat's "none" keeps it;
  // ezetimibe and the PCSK9 inhibitor have no 'none' answer, and their "none" means "no" (US-16 AC3).
  it.each([['glp1', 'none'], ['sglt2i', 'none'], ['metformin', 'none'], ['ezetimibe', 'no'], ['pcsk9i', 'no']])(
    'US-06 AC22: the chat saves "none" for %s as %s', (medicationKey, value) => {
      expect((parseProposedEdit(PROPOSE_MEDICATION_EDIT_TOOL.name, { medicationKey, drugName: 'none' }) as ProposedMedicationEdit | null)?.drugName)
        .toBe(value);
    });
});
