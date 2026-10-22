// US-25 AC8, US-06: the form's medication, screening and supplement questions
// as data, shared by the web form and the iPhone app.
import { describe, expect, it } from 'vitest';
import {
  customSupplementAddKey, customSupplementKey, medicationForm, medicationWrites, screeningForm, screeningMonths, screeningWrites,
  type FormField, type FormSection, type MedicationBasis,
} from './input-form';
import type { MedicationInputs, ScreeningInputs } from './types';

// US-06 AC1a: additions share identity rules without changing explicit keyed edits.
describe('customSupplementAddKey', () => {
  it.each(['active', 'stopped'] as const)('reuses a case-insensitive stored name on an arbitrary legacy key (%s)', status => {
    const rows = [{ supplementKey: 'custom_old_7', supplementName: 'Taurine', status }];
    expect(customSupplementAddKey('  TAURINE  ', rows)).toBe('custom_old_7');
    expect(rows).toEqual([{ supplementKey: 'custom_old_7', supplementName: 'Taurine', status }]);
  });

  it('reserves stopped different names and takes the first unoccupied suffix gap', () => {
    const rows = [
      { supplementKey: 'custom_alanine', supplementName: 'β-alanine', status: 'stopped' },
      { supplementKey: 'custom_alanine_2', supplementName: 'alanine 2', status: 'active' },
      { supplementKey: 'custom_alanine_4', supplementName: 'alanine 4', status: 'active' },
    ];
    expect(customSupplementAddKey('alanine', rows)).toBe('custom_alanine_3');
    expect(customSupplementAddKey('β-ALANINE', rows)).toBe('custom_alanine');
    expect(customSupplementKey('alanine')).toBe('custom_alanine');
    expect(customSupplementKey('β-alanine')).toBe('custom_alanine');
  });

  it('compares the actual truncated stored name without truncating legacy longer names', () => {
    const name = 'Taurine' + ' '.repeat(93) + 'x';
    const stored = name.trim().slice(0, 100);
    expect(customSupplementAddKey(name.toUpperCase(), [{ supplementKey: 'custom_legacy', supplementName: stored }])).toBe('custom_legacy');
    expect(customSupplementAddKey(name, [{ supplementKey: 'custom_taurine', supplementName: name }])).toBe('custom_taurine_2');
    expect(customSupplementAddKey('  Lion\'s Mane  ', [])).toBe('custom_lion_s_mane');
  });

  it.each([90, 91, 92])('reserves suffix space at the 99/100/101-character candidate boundary (%i letters)', length => {
    const name = 'a'.repeat(length);
    const base = customSupplementKey(name);
    const rows = [{ supplementKey: base, supplementName: name + '+' }];
    expect(customSupplementAddKey(name, rows)).toBe(`${base.slice(0, 98)}_2`);
  });

  it('bounds a new key for the full accepted 100-character name', () => {
    expect(customSupplementAddKey('a'.repeat(100), [])).toBe('custom_' + 'a'.repeat(93));
  });

  it('checks truncated suffixes against all rows and takes the first gap', () => {
    const name = 'a'.repeat(100);
    const base = 'custom_' + 'a'.repeat(93);
    const rows = [
      { supplementKey: base, supplementName: 'a'.repeat(99) + 'b' },
      { supplementKey: base.slice(0, 98) + '_2', supplementName: 'occupied two' },
      { supplementKey: base.slice(0, 98) + '_4', supplementName: 'occupied four' },
    ];
    expect(customSupplementAddKey(name, rows)).toBe(base.slice(0, 98) + '_3');
    for (let suffix = 3; suffix <= 9; suffix++) rows.push({ supplementKey: base.slice(0, 98) + '_' + suffix, supplementName: `occupied ${suffix}` });
    rows.push({ supplementKey: base.slice(0, 97) + '_10', supplementName: 'occupied ten' });
    expect(customSupplementAddKey(name, rows)).toBe(base.slice(0, 97) + '_11');
  });

  it('returns a matched legacy overlong key byte-for-byte without rewriting it', () => {
    const key = 'custom_' + 'a'.repeat(100);
    const rows = [{ supplementKey: key, supplementName: 'a'.repeat(100) }];
    expect(customSupplementAddKey('A'.repeat(100), rows)).toBe(key);
    expect(rows).toEqual([{ supplementKey: key, supplementName: 'a'.repeat(100) }]);
  });

  it('does not rewrite or deduplicate previously duplicated histories', () => {
    const rows = [
      { supplementKey: 'custom_taurine_2', supplementName: 'Taurine' },
      { supplementKey: 'custom_taurine', supplementName: 'Taurine' },
    ];
    expect(customSupplementAddKey('Taurine', rows)).toBe('custom_taurine_2');
    expect(rows.map(s => s.supplementKey)).toEqual(['custom_taurine_2', 'custom_taurine']);
  });
});

const keys = (sections: FormSection[]) => sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f) => ('key' in f ? f.key : f.metric))));
const field = (sections: FormSection[], key: string) =>
  sections.flatMap((s) => s.groups.flatMap((g) => g.fields)).find((f) => 'key' in f && f.key === key) as Extract<FormField, { key: string }> & { options?: { value: string; label: string; disabled?: boolean }[]; hint?: string };

const flat: MedicationBasis = {
  lipidMarker: null, weightMedTrigger: { on: false, reasons: [] }, bmi: 24, hasLipidInput: true, hasWeightInput: true, unitFor: () => 'si',
};
const elevated: MedicationBasis = {
  ...flat, lipidMarker: { kind: 'apoB', label: 'ApoB', value: 1.2, target: 0.8, elevated: true },
  weightMedTrigger: { on: true, reasons: ['prediabetic HbA1c'] }, bmi: 31,
};

describe('screeningForm', () => {
  it('shows nothing without the plan\'s age', () => {
    expect(screeningForm(undefined, 'female', {})).toEqual([]);
  });

  it('asks a 30-year-old woman about cervical screening only', () => {
    const form = screeningForm(30, 'female', {});
    expect(form.map((s) => s.id)).toEqual(['cancer-screening']);
    expect(form[0].groups.map((g) => g.id)).toEqual(['cervical']);
    expect(keys(form)).toEqual(['cervical_method']);
  });

  it('asks a 60-year-old man about colorectal, lung and prostate, no bone density', () => {
    const form = screeningForm(60, 'male', {});
    expect(form[0].groups.map((g) => g.id)).toEqual(['colorectal', 'lung', 'prostate']);
    expect(form.some((s) => s.id === 'bone-density')).toBe(false);
  });

  it('adds bone density for a woman of 50 and the web\'s notes by age', () => {
    const form = screeningForm(50, 'female', {});
    expect(form.map((s) => s.id)).toEqual(['cancer-screening', 'bone-density']);
    expect(form[0].groups.find((g) => g.id === 'breast')!.notes).toEqual(['Annual mammograms are recommended at your age (45–54).']);
    expect(screeningForm(40, 'male', {})[0].groups[0].notes[0]).toMatch(/^Note: ACS guidelines/);
  });

  it('opens the date, result and follow-up as each is answered', () => {
    const scr: ScreeningInputs = { colorectalMethod: 'fit_annual' };
    expect(keys(screeningForm(50, 'male', scr))).toContain('colorectal_last_date');
    expect(keys(screeningForm(50, 'male', scr))).not.toContain('colorectal_result');
    const done = { ...scr, colorectalLastDate: '2025-03', colorectalResult: 'abnormal', colorectalFollowupStatus: 'scheduled' } as ScreeningInputs;
    const form = screeningForm(50, 'male', done);
    expect(field(form, 'colorectal_followup_status').label).toBe('Colonoscopy status');
    expect(field(form, 'colorectal_followup_date')).toMatchObject({ kind: 'month', label: 'When is the colonoscopy scheduled?', when: 'future' });
  });

  it('asks for PSA as a measurement once a man will screen', () => {
    const form = screeningForm(55, 'male', { prostateDiscussion: 'will_screen' });
    expect(form[0].groups.find((g) => g.id === 'prostate')!.fields[1]).toMatchObject({ kind: 'measurement', metric: 'psa', label: 'PSA (ng/mL)' });
  });

  it('opens lung screening at 20 pack-years', () => {
    expect(keys(screeningForm(60, 'male', { lungSmokingHistory: 'former_smoker', lungPackYears: 19 }))).not.toContain('lung_screening');
    expect(keys(screeningForm(60, 'male', { lungSmokingHistory: 'former_smoker', lungPackYears: 20 }))).toContain('lung_screening');
  });
});

describe('screeningWrites', () => {
  it('"Not yet started" clears the date and the result chain that hold values', () => {
    const scr = { colorectalMethod: 'fit_annual', colorectalLastDate: '2025-03', colorectalResult: 'normal' } as ScreeningInputs;
    expect(screeningWrites(scr, 'colorectal_method', 'not_yet_started')).toEqual([
      ['colorectal_method', 'not_yet_started'], ['colorectal_last_date', ''], ['colorectal_result', ''],
    ]);
  });

  it('a normal result clears the follow-up; never smoked clears the lung chain', () => {
    const scr = { breastResult: 'abnormal', breastFollowupStatus: 'scheduled', breastFollowupDate: '2027-01' } as ScreeningInputs;
    expect(screeningWrites(scr, 'breast_result', 'normal')).toEqual([['breast_result', 'normal'], ['breast_followup_status', ''], ['breast_followup_date', '']]);
    const lung = { lungSmokingHistory: 'current_smoker', lungPackYears: 30, lungScreening: 'annual_ldct' } as ScreeningInputs;
    expect(screeningWrites(lung, 'lung_smoking_history', 'never_smoked')).toEqual([
      ['lung_smoking_history', 'never_smoked'], ['lung_pack_years', ''], ['lung_screening', ''],
    ]);
  });

  it('DEXA other than osteoporosis clears its review', () => {
    const scr = { dexaResult: 'osteoporosis', dexaFollowupStatus: 'completed', dexaFollowupDate: '2025-01' } as ScreeningInputs;
    expect(screeningWrites(scr, 'dexa_result', 'osteopenia')).toEqual([['dexa_result', 'osteopenia'], ['dexa_followup_status', ''], ['dexa_followup_date', '']]);
  });
});

describe('screeningMonths', () => {
  it('past: the last ten years up to this month; future: this month to five years on', () => {
    const past = screeningMonths('past', '2026-10-21');
    expect(past[0]).toBe('2016-01');
    expect(past[past.length - 1]).toBe('2026-10');
    const future = screeningMonths('future', '2026-10-21');
    expect(future[0]).toBe('2026-10');
    expect(future[future.length - 1]).toBe('2031-12');
  });
});

describe('medicationForm', () => {
  it('shows every cholesterol and weight question, without hints, when no cascade is on', () => {
    const form = medicationForm({}, flat);
    expect(form.map((s) => s.title)).toEqual(['Cholesterol Medications', 'Weight & Diabetes Medications']);
    expect(keys(form)).toEqual(['statin', 'ezetimibe', 'bempedoic_acid', 'pcsk9i', 'glp1', 'sglt2i', 'metformin']);
    expect(field(form, 'statin').hint).toBeUndefined();
  });

  it('hides a section with no cascade and no values', () => {
    expect(medicationForm({}, { ...flat, hasLipidInput: false, hasWeightInput: false })).toEqual([]);
  });

  it('in a cascade, opens the plan\'s steps one at a time, with its words', () => {
    const form = medicationForm({}, elevated);
    expect(keys(form)).toEqual(['statin', 'glp1']);
    expect(form[0].intro).toMatch(/ApoB/);
    expect(field(form, 'statin').hint).toBe('Statins are the most effective first step. They reduce cholesterol production in the liver.');
    const onStatin: MedicationInputs = { statin: { drug: 'atorvastatin', dose: 10 } };
    expect(keys(medicationForm(onStatin, elevated))).toEqual(['statin', 'statin_dose', 'ezetimibe', 'glp1']);
    expect(field(medicationForm(onStatin, elevated), 'ezetimibe').hint).toMatch(/more ApoB reduction/);
  });

  it('shows an unrecorded dose as "Add dose", not pickable', () => {
    const form = medicationForm({ statin: { drug: 'atorvastatin', dose: null } }, flat);
    expect(field(form, 'statin_dose').options![0]).toEqual({ value: '', label: 'Add dose', disabled: true });
  });
});

describe('medicationWrites', () => {
  it('a statin picks its first dose and resets its own escalation in a cascade', () => {
    const meds: MedicationInputs = { statin: { drug: 'atorvastatin', dose: 80 }, statinEscalation: 'not_tolerated' };
    expect(medicationWrites(meds, true, 'statin', 'rosuvastatin')).toEqual([
      { medicationKey: 'statin_escalation', drugName: 'not_yet', doseValue: null, doseUnit: null },
      { medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 5, doseUnit: 'mg' },
    ]);
    expect(medicationWrites(meds, false, 'statin', 'none')).toEqual([{ medicationKey: 'statin', drugName: 'none', doseValue: null, doseUnit: null }]);
  });

  it('"yes" records ezetimibe 10mg and a PCSK9 inhibitor 140mg; a dose keeps the drug', () => {
    expect(medicationWrites({}, true, 'ezetimibe', 'yes')).toEqual([{ medicationKey: 'ezetimibe', drugName: 'ezetimibe', doseValue: 10, doseUnit: 'mg' }]);
    expect(medicationWrites({}, true, 'pcsk9i', 'yes')).toEqual([{ medicationKey: 'pcsk9i', drugName: 'pcsk9i', doseValue: 140, doseUnit: 'mg' }]);
    expect(medicationWrites({ glp1: { drug: 'semaglutide_injection', dose: 0.5 } }, true, 'glp1_dose', '1.7')).toEqual([
      { medicationKey: 'glp1', drugName: 'semaglutide_injection', doseValue: 1.7, doseUnit: 'mg' },
    ]);
  });
});

describe('customSupplementKey', () => {
  it('is the web\'s rule', () => {
    expect(customSupplementKey('  Lion\'s Mane (500) ')).toBe('custom_lion_s_mane_500');
  });
});
