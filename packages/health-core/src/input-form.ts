/**
 * The input form's medication, screening and supplement questions as data:
 * what each asks, its options, its hint, when it shows, and what an answer
 * writes (US-06, US-25 AC8). The web form (InputPanel.tsx) takes its words,
 * options and write rules from here, and the iPhone app's My data tab renders
 * these descriptions natively, so a change made here reaches both, and no
 * clinical wording is typed twice (ios/architecture.md D4).
 *
 * Pure: no DOM, no React. Every text below is the web form's own, moved here
 * word for word.
 */
import { lipidCascade, weightCascade } from './medication-cascades';
import type { MedicationSave } from './state-edits';
import { LIPID_DIET_ADVICE, lipidTargetSentence, weightMedIntro, type LipidMarker, type WeightMedicationTrigger } from './suggestions';
import {
  BEMPEDOIC_ACID_OPTIONS, EZETIMIBE_OPTIONS, GLP1_DRUGS, GLP1_NAMES, METFORMIN_OPTIONS, PCSK9I_OPTIONS,
  SCREENING_FOLLOWUP_INFO, SGLT2I_DRUGS, SGLT2I_NAMES, STATIN_DRUGS, STATIN_NAMES,
  type MedicationInputs, type ScreeningInputs,
} from './types';
import type { MetricType, UnitSystem } from './units';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One choice. `disabled`: shown only while it is the recorded value, never pickable. */
export interface FormOption { value: string; label: string; disabled?: boolean }

export type FormField =
  /** Pick one. `value` '' is unanswered. */
  | { kind: 'choice'; key: string; label: string; hint?: string; options: FormOption[]; value: string }
  /** A month, YYYY-MM: in the last ten years (`past`) or the next five (`future`). */
  | { kind: 'month'; key: string; label: string; value: string; when: 'past' | 'future' }
  /** A whole number. */
  | { kind: 'number'; key: string; label: string; hint?: string; value: string; min: number; max: number }
  /** A dated clinical value (PSA): the form asks for it, the record keeps it as a measurement. */
  | { kind: 'measurement'; metric: MetricType; label: string; hint?: string };

/** A block of questions under one heading. `notes` are the form's guidance lines. */
export interface FormGroup { id: string; title: string; notes: string[]; fields: FormField[] }

/** A card of the form: its title, its lead paragraph and its groups. */
export interface FormSection { id: string; title: string; intro: string; groups: FormGroup[] }

// ---------------------------------------------------------------------------
// Medications (US-06): the cascades' questions, in the plan's own steps
// ---------------------------------------------------------------------------

export const MEDICATION_TEXT = {
  lipidTitle: 'Cholesterol Medications',
  lipidNeutral: 'Are you currently taking any cholesterol medications? Recording these helps track your health over time.',
  weightTitle: 'Weight & Diabetes Medications',
  weightNeutral: 'Are you currently taking any weight or diabetes medications? Recording these helps track your health over time.',
  /** A drug field's hint while the plan asks for its dose (US-06 AC8). */
  doseHint: 'Add your dose: your next step depends on it.',
  /** An escalation field's label when the plan asks no step-up question. */
  escalationRecorded: 'Higher dose or switch (recorded answer)',
  statinLabel: 'Statin',
  statinHint: 'Statins are the most effective first step. They reduce cholesterol production in the liver.',
  ezetimibeLabel: 'On Ezetimibe 10mg?',
  ezetimibeHint: (lipid: string) => `Ezetimibe works differently — it blocks cholesterol absorption in the intestine, adding ~20% more ${lipid} reduction.`,
  bempedoicAcidLabel: 'Bempedoic acid',
  bempedoicAcidHint: 'Bempedoic acid lowers cholesterol production via a different pathway than statins, and can be used alongside them.',
  pcsk9iLabel: 'On a PCSK9 inhibitor?',
  pcsk9iHint: (lipid: string) => `PCSK9 inhibitors are injectable medications that help your body clear ${lipid} from the blood. They can reduce ${lipid} by ~50%.`,
  statinEscalationLabel: { increase: 'Tried increasing statin dose?', switch: 'Tried switching to a more potent statin?' },
  statinEscalationHint: {
    increase: (lipid: string) => `A higher dose may lower your ${lipid} further.`,
    switch: (lipid: string) => `A more potent statin can provide greater ${lipid} reduction at the same or lower dose.`,
  },
  glp1Label: 'GLP-1 Medication',
  glp1Hint: 'GLP-1 medications reduce appetite and improve blood sugar control, often leading to significant weight loss.',
  glp1EscalationLabel: { increase: 'Tried increasing GLP-1 dose?', switch: 'Tried switching to Tirzepatide?' },
  glp1EscalationHint: {
    increase: 'A higher dose may improve results.',
    switch: 'Tirzepatide targets two hormones (GIP + GLP-1) and may be more effective for weight loss.',
  },
  sglt2iLabel: 'SGLT2 Inhibitor',
  sglt2iHint: 'SGLT2 inhibitors help your kidneys remove excess glucose and offer additional heart and kidney protection.',
  metforminLabel: 'Metformin',
  metforminHint: 'Metformin improves insulin sensitivity. It is well-studied and inexpensive.',
  doseLabel: 'Dose',
} as const;

/**
 * A medication select's options, showing what the record holds (US-06 AC5):
 * an empty value reads `unrecorded` ("Not recorded"), and a value the list
 * lacks (a legacy 'tier_1', an agent's 'yes') reads "Other (recorded)", never
 * the first option. Either is shown, not pickable.
 */
export function optionsShowing(options: ReadonlyArray<{ value: string; label: string }>, recorded: string, unrecorded = 'Not recorded'): FormOption[] {
  const list = options.map(({ value, label }) => ({ value, label }));
  if (options.some((opt) => opt.value === recorded)) return list;
  const blank = recorded === '';
  return [{ value: recorded, label: blank ? unrecorded : 'Other (recorded)', ...(blank ? { disabled: true } : null) }, ...list];
}

/**
 * An escalation answer's options: the plan's words while it asks the question
 * (`step`); neutral when it does not, so a recorded answer never pitches a
 * step up the plan is not suggesting (US-06 AC5, AC7).
 */
export function escalationOptions(step: 'increase' | 'switch' | null): FormOption[] {
  return [
    { value: 'not_yet', label: step ? 'Not yet' : 'Not tried' },
    { value: 'not_tolerated', label: step === 'increase' ? "Didn't tolerate a higher dose" : step === 'switch' ? "Didn't tolerate switching" : "Didn't tolerate" },
  ];
}

/** A dose select's options, in mg. */
export const doseOptions = (doses: number[]): FormOption[] => doses.map((dose) => ({ value: String(dose), label: `${dose}mg` }));

/** What the medication questions read from the plan (the web's PlanBasis). */
export interface MedicationBasis {
  /** The plan's lipid marker, null without one or without medicines shown. */
  lipidMarker: LipidMarker | null;
  weightMedTrigger: WeightMedicationTrigger;
  bmi: number | undefined;
  /** Any lipid value entered: the cholesterol questions show without a cascade. */
  hasLipidInput: boolean;
  /** HbA1c, triglycerides, or weight with height entered: the weight questions show without a cascade. */
  hasWeightInput: boolean;
  /** The unit each metric shows in, for the lipid target sentence. */
  unitFor: (metric: MetricType) => UnitSystem;
}

/** The medication cards, as the web form shows them (InputPanel renderMedications). */
export function medicationForm(meds: MedicationInputs, basis: MedicationBasis): FormSection[] {
  const sections: FormSection[] = [];
  const lipid = lipidSection(meds, basis);
  if (lipid) sections.push(lipid);
  const weight = weightSection(meds, basis);
  if (weight) sections.push(weight);
  return sections;
}

const T = MEDICATION_TEXT;

function lipidSection(meds: MedicationInputs, basis: MedicationBasis): FormSection | null {
  const marker = basis.lipidMarker;
  const cascadeMode = !!marker?.elevated;
  if (!cascadeMode && !basis.hasLipidInput) return null;
  const cascade = lipidCascade(meds);
  const statinDrug = meds.statin?.drug ?? 'none';
  const statinDose = meds.statin?.dose ?? null;
  const doses = STATIN_DRUGS[statinDrug]?.doses ?? [];
  const lipidName = marker?.label ?? '';

  const statin: FormField[] = [{
    kind: 'choice', key: 'statin', label: T.statinLabel, options: optionsShowing(STATIN_NAMES, statinDrug), value: statinDrug,
    ...(cascadeMode ? { hint: cascade.suggest.includes('statin-dose') ? T.doseHint : T.statinHint } : null),
  }];
  if (doses.length > 0) {
    const dose = statinDose === null ? '' : String(statinDose);
    statin.push({ kind: 'choice', key: 'statin_dose', label: T.doseLabel, options: optionsShowing(doseOptions(doses), dose, 'Add dose'), value: dose });
  }
  const ezetimibe = meds.ezetimibe || 'not_yet';
  const ezetimibeField: FormField = { kind: 'choice', key: 'ezetimibe', label: T.ezetimibeLabel, options: optionsShowing(EZETIMIBE_OPTIONS, ezetimibe), value: ezetimibe };
  const bempedoic = meds.bempedoicAcid || 'not_yet';
  const bempedoicField: FormField = { kind: 'choice', key: 'bempedoic_acid', label: T.bempedoicAcidLabel, options: optionsShowing(BEMPEDOIC_ACID_OPTIONS, bempedoic), value: bempedoic };
  const pcsk9i = meds.pcsk9i || 'not_yet';
  const pcsk9iField: FormField = { kind: 'choice', key: 'pcsk9i', label: T.pcsk9iLabel, options: optionsShowing(PCSK9I_OPTIONS, pcsk9i), value: pcsk9i };

  if (!cascadeMode) {
    return { id: 'lipid-medications', title: T.lipidTitle, intro: T.lipidNeutral, groups: [
      { id: 'statin', title: '', notes: [], fields: statin },
      { id: 'ezetimibe', title: '', notes: [], fields: [ezetimibeField] },
      { id: 'bempedoic_acid', title: '', notes: [], fields: [bempedoicField] },
      { id: 'pcsk9i', title: '', notes: [], fields: [pcsk9iField] },
    ] };
  }

  // Progressive disclosure opens the plan's next step; a step that holds a
  // recorded value always shows (US-06 AC7).
  const groups: FormGroup[] = [{ id: 'statin', title: '', notes: [], fields: statin }];
  if (cascade.ezetimibeReached || meds.ezetimibe !== undefined) {
    groups.push({ id: 'ezetimibe', title: '', notes: [], fields: [{ ...ezetimibeField, hint: T.ezetimibeHint(lipidName) }] });
  }
  if (cascade.bempedoicAcidReached || meds.bempedoicAcid !== undefined) {
    groups.push({ id: 'bempedoic_acid', title: '', notes: [], fields: [{ ...bempedoicField, hint: T.bempedoicAcidHint }] });
  }
  const step = cascade.escalation;
  if (step || meds.statinEscalation !== undefined) {
    const value = meds.statinEscalation || 'not_yet';
    groups.push({ id: 'statin_escalation', title: '', notes: [], fields: [{
      kind: 'choice', key: 'statin_escalation', label: step ? T.statinEscalationLabel[step] : T.escalationRecorded,
      options: optionsShowing(escalationOptions(step), value), value,
      ...(step ? { hint: T.statinEscalationHint[step](lipidName) } : null),
    }] });
  }
  if (cascade.pcsk9iReached || meds.pcsk9i !== undefined) {
    groups.push({ id: 'pcsk9i', title: '', notes: [], fields: [{ ...pcsk9iField, hint: T.pcsk9iHint(lipidName) }] });
  }
  // It recommends only while the plan shows a step's card: with every step
  // answered the marker stays elevated and the plan shows none.
  const intro = cascade.suggest.length === 0 ? T.lipidNeutral
    : `${lipidTargetSentence(marker!, basis.unitFor)} ${LIPID_DIET_ADVICE} Medications can also be added in steps.`;
  return { id: 'lipid-medications', title: T.lipidTitle, intro, groups };
}

function weightSection(meds: MedicationInputs, basis: MedicationBasis): FormSection | null {
  const trigger = basis.weightMedTrigger;
  const cascadeMode = trigger.on;
  if (!cascadeMode && !basis.hasWeightInput) return null;
  const cascade = weightCascade(meds);

  const glp1Drug = meds.glp1?.drug ?? 'none';
  const glp1Dose = meds.glp1?.dose ?? null;
  const glp1: FormField[] = [{
    kind: 'choice', key: 'glp1', label: T.glp1Label, options: optionsShowing(GLP1_NAMES, glp1Drug), value: glp1Drug,
    ...(cascadeMode ? { hint: cascade.suggest.includes('glp1-dose') ? T.doseHint : T.glp1Hint } : null),
  }];
  const glp1Doses = GLP1_DRUGS[glp1Drug]?.doses ?? [];
  if (glp1Doses.length > 0) {
    const dose = glp1Dose === null ? '' : String(glp1Dose);
    glp1.push({ kind: 'choice', key: 'glp1_dose', label: T.doseLabel, options: optionsShowing(doseOptions(glp1Doses), dose, 'Add dose'), value: dose });
  }
  const sglt2iDrug = meds.sglt2i?.drug ?? 'none';
  const sglt2iDose = meds.sglt2i?.dose ?? null;
  const sglt2i: FormField[] = [{
    kind: 'choice', key: 'sglt2i', label: T.sglt2iLabel, options: optionsShowing(SGLT2I_NAMES, sglt2iDrug), value: sglt2iDrug,
    ...(cascadeMode ? { hint: T.sglt2iHint } : null),
  }];
  const sglt2iDoses = SGLT2I_DRUGS[sglt2iDrug]?.doses ?? [];
  if (sglt2iDoses.length > 0) {
    const dose = sglt2iDose === null ? '' : String(sglt2iDose);
    sglt2i.push({ kind: 'choice', key: 'sglt2i_dose', label: T.doseLabel, options: optionsShowing(doseOptions(sglt2iDoses), dose, 'Add dose'), value: dose });
  }
  const metformin = meds.metformin || 'none';
  const metforminField: FormField = {
    kind: 'choice', key: 'metformin', label: T.metforminLabel, options: optionsShowing(METFORMIN_OPTIONS, metformin), value: metformin,
    ...(cascadeMode ? { hint: T.metforminHint } : null),
  };

  if (!cascadeMode) {
    return { id: 'weight-medications', title: T.weightTitle, intro: T.weightNeutral, groups: [
      { id: 'glp1', title: '', notes: [], fields: glp1 },
      { id: 'sglt2i', title: '', notes: [], fields: sglt2i },
      { id: 'metformin', title: '', notes: [], fields: [metforminField] },
    ] };
  }

  const groups: FormGroup[] = [{ id: 'glp1', title: '', notes: [], fields: glp1 }];
  const step = cascade.escalation;
  if (step || meds.glp1Escalation !== undefined) {
    const value = meds.glp1Escalation || 'not_yet';
    groups.push({ id: 'glp1_escalation', title: '', notes: [], fields: [{
      kind: 'choice', key: 'glp1_escalation', label: step ? T.glp1EscalationLabel[step] : T.escalationRecorded,
      options: optionsShowing(escalationOptions(step), value), value,
      ...(step ? { hint: T.glp1EscalationHint[step] } : null),
    }] });
  }
  if (cascade.sglt2iReached || meds.sglt2i !== undefined) groups.push({ id: 'sglt2i', title: '', notes: [], fields: sglt2i });
  if (cascade.metforminReached || meds.metformin !== undefined) groups.push({ id: 'metformin', title: '', notes: [], fields: [metforminField] });
  const intro = cascade.suggest.length === 0 || basis.bmi === undefined ? T.weightNeutral : weightMedIntro(basis.bmi, trigger.reasons);
  return { id: 'weight-medications', title: T.weightTitle, intro, groups };
}

/**
 * What one medication answer writes, in order (the web form's onChange rules).
 * A drug picks its first listed dose; a drug or dose change in a cascade
 * resets that drug's own escalation answer and writes no other medication
 * (US-06 AC7); "yes" to ezetimibe or a PCSK9 inhibitor records the drug and
 * its standard dose. `field` is a key of `medicationForm`'s fields.
 */
export function medicationWrites(meds: MedicationInputs, cascadeMode: boolean, field: string, value: string): MedicationSave[] {
  const save = (medicationKey: string, drugName: string, doseValue: number | null = null, doseUnit: string | null = null): MedicationSave =>
    ({ medicationKey, drugName, doseValue, doseUnit });
  const reset = (key: 'statin_escalation' | 'glp1_escalation', recorded: string | undefined) =>
    cascadeMode && recorded ? [save(key, 'not_yet')] : [];
  const pickDrug = (key: string, drugs: Record<string, { doses: number[] }>, plain: string[]) =>
    plain.includes(value) ? save(key, value) : save(key, value, drugs[value]?.doses[0] ?? null, 'mg');
  switch (field) {
    case 'statin': return [...reset('statin_escalation', meds.statinEscalation), pickDrug('statin', STATIN_DRUGS, ['none', 'not_tolerated'])];
    case 'statin_dose': return [...reset('statin_escalation', meds.statinEscalation), save('statin', meds.statin?.drug ?? 'none', parseInt(value, 10), 'mg')];
    case 'ezetimibe': return [value === 'yes' ? save('ezetimibe', 'ezetimibe', 10, 'mg') : save('ezetimibe', value)];
    case 'pcsk9i': return [value === 'yes' ? save('pcsk9i', 'pcsk9i', 140, 'mg') : save('pcsk9i', value)];
    case 'bempedoic_acid':
      return [value === 'bempedoic_acid' || value === 'bempedoic_acid_ezetimibe' ? save('bempedoic_acid', value, 180, 'mg') : save('bempedoic_acid', value)];
    case 'statin_escalation': case 'glp1_escalation': return [save(field, value)];
    case 'glp1': return [...reset('glp1_escalation', meds.glp1Escalation), pickDrug('glp1', GLP1_DRUGS, ['none', 'not_tolerated', 'other'])];
    case 'glp1_dose': return [...reset('glp1_escalation', meds.glp1Escalation), save('glp1', meds.glp1?.drug ?? 'none', Number(value), 'mg')];
    case 'sglt2i': return [pickDrug('sglt2i', SGLT2I_DRUGS, ['none', 'not_tolerated'])];
    case 'sglt2i_dose': return [save('sglt2i', meds.sglt2i?.drug ?? 'none', Number(value), 'mg')];
    case 'metformin': return [save('metformin', value)];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Screenings (cancer screening and bone density)
// ---------------------------------------------------------------------------

const SELECT: FormOption = { value: '', label: 'Select...' };

export const SCREENING_TEXT = {
  title: 'Cancer Screening',
  intro: 'Screening recommendations based on your age and sex. Discuss all screening decisions with your doctor.',
  colorectalEarly: 'Note: ACS guidelines recommend starting colorectal screening at age 45. Given rising rates of colorectal cancer in younger adults, some clinicians consider starting earlier, around age 35. Discuss timing with your doctor.',
  colorectalIndividual: 'Screening is individualized at your age. Discuss with your doctor whether continued screening is appropriate.',
  breastByAge: (age: number) => age <= 44
    ? 'Annual mammograms are optional at your age (40–44).'
    : age <= 54
      ? 'Annual mammograms are recommended at your age (45–54).'
      : 'Annual or biennial mammograms are recommended at your age (55+).',
  cervicalStop: 'Routine cervical screening typically stops at age 65 if you have no history of abnormal results. Discuss with your doctor.',
  prostateByAge: (age: number) => age < 50
    ? 'Screening typically starts at 50, but consider at 45 if you are at higher risk (African American or family history).'
    : 'PSA testing is an option after an informed discussion with your doctor.',
  packYearsLabel: 'Pack-years (packs/day × years smoked)',
  packYearsHint: 'Screening recommended if ≥20 pack-years',
  psaLabel: 'PSA (ng/mL)',
  psaHint: 'Normal: <4.0 ng/mL',
  boneTitle: 'Bone Density',
  boneIntro: 'DEXA scans measure bone mineral density to detect osteoporosis. Discuss screening with your doctor.',
} as const;

/** Every screening select's options, the web form's own (Select... first: it clears the answer). */
export const SCREENING_OPTIONS = {
  colorectal_method: [SELECT, { value: 'fit_annual', label: 'FIT test (annual)' }, { value: 'colonoscopy_10yr', label: 'Colonoscopy (every 10 years)' }, { value: 'other', label: 'Other method' }, { value: 'not_yet_started', label: 'Not yet started' }],
  breast_frequency: [SELECT, { value: 'annual', label: 'Annual' }, { value: 'biennial', label: 'Every 2 years' }, { value: 'not_yet_started', label: 'Not yet started' }],
  cervical_method: [SELECT, { value: 'hpv_every_5yr', label: 'HPV test every 5 years (preferred)' }, { value: 'pap_every_3yr', label: 'Pap test every 3 years' }, { value: 'other', label: 'Other method' }, { value: 'not_yet_started', label: 'Not yet started' }],
  lung_smoking_history: [SELECT, { value: 'never_smoked', label: 'Never smoked' }, { value: 'former_smoker', label: 'Former smoker' }, { value: 'current_smoker', label: 'Current smoker' }],
  lung_screening: [SELECT, { value: 'annual_ldct', label: 'Annual low-dose CT' }, { value: 'not_yet_started', label: 'Not yet started' }],
  prostate_discussion: [SELECT, { value: 'not_yet', label: 'Not yet' }, { value: 'elected_not_to', label: "Yes, and I've elected not to screen" }, { value: 'will_screen', label: 'Yes, and I will screen' }],
  endometrial_discussion: [SELECT, { value: 'not_yet', label: 'Not yet' }, { value: 'discussed', label: 'Yes, discussed' }],
  endometrial_abnormal_bleeding: [SELECT, { value: 'no', label: 'No' }, { value: 'yes_reported', label: 'Yes, reported to doctor' }, { value: 'yes_need_to_report', label: 'Yes, need to report to doctor' }],
  result: [SELECT, { value: 'normal', label: 'Normal' }, { value: 'abnormal', label: 'Abnormal' }, { value: 'awaiting', label: 'Awaiting results' }],
  followup_status: [SELECT, { value: 'not_organized', label: 'Not yet organized' }, { value: 'scheduled', label: 'Scheduled' }, { value: 'completed', label: 'Completed' }],
  dexa_screening: [SELECT, { value: 'dexa_scan', label: 'Had a DEXA scan' }, { value: 'not_yet_started', label: 'Not yet started' }],
  dexa_result: [SELECT, { value: 'normal', label: 'Normal' }, { value: 'osteopenia', label: 'Osteopenia' }, { value: 'osteoporosis', label: 'Osteoporosis' }, { value: 'awaiting', label: 'Awaiting results' }],
} satisfies Record<string, FormOption[]>;

export const SCREENING_LABELS = {
  method: 'Screening method',
  frequency: 'Screening frequency',
  lastScreening: 'Date of last screening',
  lastMammogram: 'Date of last mammogram',
  lastLdct: 'Date of last low-dose CT',
  lastDexa: 'Date of last DEXA scan',
  smokingHistory: 'Smoking history',
  lungScreening: 'Screening status',
  prostateDiscussion: 'Discussed prostate screening with your doctor?',
  endometrialDiscussion: 'Discussed endometrial cancer risk at menopause?',
  endometrialBleeding: 'Any abnormal uterine bleeding?',
  result: 'Result',
  dexaScreening: 'DEXA scan status',
  dexaFollowupStatus: 'Treatment review status',
} as const;

/** Each screening type's result answer that opens a follow-up. */
const FOLLOWUP_TRIGGER: Record<string, string> = {
  colorectal: 'abnormal', breast: 'abnormal', cervical: 'abnormal', lung: 'abnormal', dexa: 'osteoporosis',
};

/** The follow-up's name, from its type and method (SCREENING_FOLLOWUP_INFO), capitalised for a label. */
export function followupName(type: string, method: string | undefined): string | undefined {
  return SCREENING_FOLLOWUP_INFO[method ? `${type}_${method}` : `${type}_other`]?.followupName;
}

/** The follow-up date's question: when it was done, or when it is booked. */
export function followupDateLabel(name: string | undefined, status: string): string {
  return status === 'completed' ? `When was the ${name ?? 'follow-up'} completed?` : `When is the ${name ?? 'follow-up'} scheduled?`;
}

/** Whether any cancer screening applies at this age and sex (the web shows the card only then). */
export function anyScreeningEligible(age: number, sex: string | undefined): boolean {
  return age >= 35
    || (sex === 'female' && age >= 25)
    || (age >= 50 && age <= 80)
    || (sex === 'male' && age >= 45);
}

/** DEXA applies to women from 50 and men from 70. */
export function dexaEligible(age: number, sex: string | undefined): boolean {
  return (sex === 'female' && age >= 50) || (sex === 'male' && age >= 70);
}

/**
 * The screening cards, as the web form shows them (InputPanel renderScreening
 * and renderBoneDensity). `age` is the plan's; without one, no card shows.
 */
export function screeningForm(age: number | undefined, sex: string | undefined, scr: ScreeningInputs): FormSection[] {
  if (age === undefined) return [];
  const str = (key: string) => readScreening(scr, key);
  const choice = (key: string, label: string, options: FormOption[]): FormField => ({ kind: 'choice', key, label, options, value: str(key) });
  const month = (key: string, label: string, when: 'past' | 'future' = 'past'): FormField => ({ kind: 'month', key, label, value: str(key), when });
  const L = SCREENING_LABELS, O = SCREENING_OPTIONS, X = SCREENING_TEXT;

  /** The result, then the follow-up's status and date: shown once the last screening has a date. */
  const resultChain = (type: string, method: string): FormField[] => {
    if (!str(`${type}_last_date`)) return [];
    const result = str(`${type}_result`);
    const status = str(`${type}_followup_status`);
    const name = followupName(type, method);
    const fields: FormField[] = [choice(`${type}_result`, L.result, O.result)];
    if (result !== FOLLOWUP_TRIGGER[type]) return fields;
    const statusLabel = `${name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Follow-up'} status`;
    fields.push(choice(`${type}_followup_status`, statusLabel, O.followup_status));
    if (status === 'scheduled' || status === 'completed') {
      fields.push(month(`${type}_followup_date`, followupDateLabel(name, status), status === 'scheduled' ? 'future' : 'past'));
    }
    return fields;
  };
  /** A method question, then the date and result once a method is chosen. */
  const started = (type: string, methodKey: string, label: string, options: FormOption[], dateLabel: string): FormField[] => {
    const method = str(methodKey);
    const fields = [choice(methodKey, label, options)];
    if (method && method !== 'not_yet_started') fields.push(month(`${type}_last_date`, dateLabel), ...resultChain(type, method));
    return fields;
  };

  const sections: FormSection[] = [];
  if (anyScreeningEligible(age, sex)) {
    const groups: FormGroup[] = [];
    if (age >= 35 && age <= 85) {
      groups.push({
        id: 'colorectal', title: 'Colorectal',
        notes: [...(age < 45 ? [X.colorectalEarly] : []), ...(age > 75 ? [X.colorectalIndividual] : [])],
        fields: age <= 75 ? started('colorectal', 'colorectal_method', L.method, O.colorectal_method, L.lastScreening) : [],
      });
    }
    if (sex === 'female' && age >= 40) {
      groups.push({ id: 'breast', title: 'Breast', notes: [X.breastByAge(age)], fields: started('breast', 'breast_frequency', L.frequency, O.breast_frequency, L.lastMammogram) });
    }
    if (sex === 'female' && age >= 25) {
      groups.push(age <= 65
        ? { id: 'cervical', title: 'Cervical', notes: [], fields: started('cervical', 'cervical_method', L.method, O.cervical_method, L.lastScreening) }
        : { id: 'cervical', title: 'Cervical', notes: [X.cervicalStop], fields: [] });
    }
    if (age >= 50 && age <= 80) {
      const history = str('lung_smoking_history');
      const fields = [choice('lung_smoking_history', L.smokingHistory, O.lung_smoking_history)];
      if (history === 'former_smoker' || history === 'current_smoker') {
        fields.push({ kind: 'number', key: 'lung_pack_years', label: X.packYearsLabel, hint: X.packYearsHint, value: str('lung_pack_years'), min: 0, max: 200 });
        const packYears = scr.lungPackYears;
        if (packYears !== undefined && packYears >= 20) {
          fields.push(choice('lung_screening', L.lungScreening, O.lung_screening));
          if (str('lung_screening') === 'annual_ldct') fields.push(month('lung_last_date', L.lastLdct), ...resultChain('lung', 'annual_ldct'));
        }
      }
      groups.push({ id: 'lung', title: 'Lung', notes: [], fields });
    }
    if (sex === 'male' && age >= 45) {
      const fields = [choice('prostate_discussion', L.prostateDiscussion, O.prostate_discussion)];
      if (str('prostate_discussion') === 'will_screen') fields.push({ kind: 'measurement', metric: 'psa', label: X.psaLabel, hint: X.psaHint });
      groups.push({ id: 'prostate', title: 'Prostate', notes: [X.prostateByAge(age)], fields });
    }
    if (sex === 'female' && age >= 45) {
      groups.push({ id: 'endometrial', title: 'Endometrial', notes: [], fields: [
        choice('endometrial_discussion', L.endometrialDiscussion, O.endometrial_discussion),
        choice('endometrial_abnormal_bleeding', L.endometrialBleeding, O.endometrial_abnormal_bleeding),
      ] });
    }
    sections.push({ id: 'cancer-screening', title: X.title, intro: X.intro, groups });
  }

  if (dexaEligible(age, sex)) {
    const fields = [choice('dexa_screening', L.dexaScreening, O.dexa_screening)];
    if (str('dexa_screening') === 'dexa_scan') {
      fields.push(month('dexa_last_date', L.lastDexa));
      if (str('dexa_last_date')) fields.push(choice('dexa_result', L.result, O.dexa_result));
      if (str('dexa_result') === 'osteoporosis') {
        const status = str('dexa_followup_status');
        fields.push(choice('dexa_followup_status', L.dexaFollowupStatus, O.followup_status));
        if (status === 'scheduled' || status === 'completed') {
          fields.push(month('dexa_followup_date', followupDateLabel('treatment review', status), status === 'scheduled' ? 'future' : 'past'));
        }
      }
    }
    sections.push({ id: 'bone-density', title: X.boneTitle, intro: X.boneIntro, groups: [{ id: 'dexa', title: '', notes: [], fields }] });
  }
  return sections;
}

/** A screening answer by its snake_case key, as text ('' when unanswered). */
export function readScreening(scr: ScreeningInputs, key: string): string {
  const value = scr[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof ScreeningInputs];
  return value === undefined || value === null ? '' : String(value);
}

/** The answers that depend on each earlier answer, cleared when it no longer opens them. */
function dependents(type: string): string[] {
  return [`${type}_result`, `${type}_followup_status`, `${type}_followup_date`];
}

/**
 * What one screening answer writes, in order (the web form's onChange rules):
 * the answer itself, then '' for each later answer it closes, and only for
 * those that hold a value. "Not yet started" closes the date and the result;
 * a result that is not abnormal closes the follow-up; a follow-up not yet
 * organized closes its date; "Never smoked" closes the whole lung chain.
 */
export function screeningWrites(scr: ScreeningInputs, key: string, value: string): Array<[string, string]> {
  const writes: Array<[string, string]> = [[key, value]];
  const clear = (...keys: string[]) => { for (const k of keys) if (readScreening(scr, k)) writes.push([k, '']); };
  const type = key.split('_')[0];
  if (['colorectal_method', 'breast_frequency', 'cervical_method', 'lung_screening'].includes(key)) {
    if (value === 'not_yet_started' || value === '') clear(`${type}_last_date`, ...dependents(type));
  } else if (key === 'lung_smoking_history') {
    if (value === 'never_smoked' || value === '') clear('lung_pack_years', 'lung_screening', 'lung_last_date', ...dependents('lung'));
  } else if (key === 'dexa_screening') {
    if (value !== 'dexa_scan') clear('dexa_last_date', ...dependents('dexa'));
  } else if (key.endsWith('_result') && FOLLOWUP_TRIGGER[type]) {
    if (value !== FOLLOWUP_TRIGGER[type]) clear(`${type}_followup_status`, `${type}_followup_date`);
  } else if (key.endsWith('_followup_status')) {
    if (value === 'not_organized' || value === '') clear(`${type}_followup_date`);
  }
  return writes;
}

/** The months a screening date may name (the web form's year and month lists): YYYY-MM, oldest first. */
export function screeningMonths(when: 'past' | 'future', today: string): string[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const months: string[] = [];
  const [from, to] = when === 'past' ? [year - 10, year] : [year, year + 5];
  for (let y = from; y <= to; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === year && (when === 'past' ? m > month : m < month)) continue;
      months.push(`${y}-${String(m).padStart(2, '0')}`);
    }
  }
  return months;
}

// ---------------------------------------------------------------------------
// Supplements
// ---------------------------------------------------------------------------

export const SUPPLEMENT_TEXT = {
  title: 'Supplements',
  intro: 'Track supplements you take regularly.',
  addPlaceholder: 'Add another supplement...',
} as const;

/** The dose units a supplement row offers. */
export const SUPPLEMENT_DOSE_UNITS = ['mg', 'mcg', 'g', 'IU', 'capsules', 'scoop'] as const;

/** A typed supplement's key: `custom_` and its name in lowercase letters, digits and single underscores. */
export function customSupplementKey(name: string): string {
  return `custom_${name.trim().toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
}

/** Reuse a recorded name (active or stopped); reserve every other recorded key. */
export function customSupplementAddKey(name: string, supplements: readonly { supplementKey: string; supplementName: string }[]): string {
  const storedName = name.trim().slice(0, 100).toLowerCase();
  const existing = supplements.find(s => typeof s.supplementName === 'string' && s.supplementName.toLowerCase() === storedName);
  if (existing) return existing.supplementKey;
  const base = customSupplementKey(name.trim().slice(0, 100)).slice(0, 100);
  let key = base;
  for (let suffix = 2; supplements.some(s => s.supplementKey === key); suffix++) {
    const ending = `_${suffix}`;
    key = `${base.slice(0, 100 - ending.length)}${ending}`;
  }
  return key;
}
