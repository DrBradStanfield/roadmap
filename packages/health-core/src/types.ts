/**
 * Health input data from user.
 *
 * ALL numeric values are in SI canonical units:
 *   height/waist: cm | weight: kg | BP: mmHg
 *   HbA1c: mmol/mol (IFCC) | lipids: mmol/L
 *
 * Conversion to/from display units is handled by units.ts.
 */
export interface HealthInputs {
  heightCm: number;
  weightKg?: number;
  waistCm?: number;
  sex: 'male' | 'female';
  birthYear?: number;
  birthMonth?: number;
  // Blood test values (SI canonical units)
  hba1c?: number;       // mmol/mol (IFCC)
  ldlC?: number;        // mmol/L
  totalCholesterol?: number; // mmol/L
  hdlC?: number;        // mmol/L
  triglycerides?: number; // mmol/L
  apoB?: number;          // g/L
  creatinine?: number;  // µmol/L
  psa?: number;         // ng/mL (no unit conversion)
  systolicBp?: number;  // mmHg
  diastolicBp?: number; // mmHg
  // User preference (stored as 1=si, 2=conventional in DB)
  unitSystem?: 'si' | 'conventional';
}

/**
 * Calculated health results
 */
export interface HealthResults {
  heightCm: number;
  idealBodyWeight: number;
  proteinTarget: number;
  bmi?: number;
  waistToHeightRatio?: number;
  nonHdlCholesterol?: number; // mmol/L (total cholesterol - HDL)
  apoB?: number;              // g/L (passthrough from inputs)
  ldlC?: number;              // mmol/L (passthrough from inputs)
  eGFR?: number;              // mL/min/1.73m² (CKD-EPI 2021)
  age?: number;
  suggestions: Suggestion[];
}

/**
 * A health suggestion
 */
export interface Suggestion {
  id: string;
  category: 'nutrition' | 'exercise' | 'bloodwork' | 'blood_pressure' | 'general' | 'sleep' | 'medication' | 'screening' | 'supplements';
  priority: 'info' | 'attention' | 'urgent';
  title: string;
  description: string;
  link?: string;
}

// ===== Statin Configuration (BPAC 2021) =====
// Source: https://bpac.org.nz/2021/statins.aspx

/**
 * Available statin drugs with their dose options.
 * Alphabetical order for UI dropdown.
 */
export const STATIN_DRUGS: Record<string, { doses: number[]; unit: string }> = {
  atorvastatin: { doses: [10, 20, 40, 80], unit: 'mg' },
  pitavastatin: { doses: [1, 2, 4], unit: 'mg' },
  pravastatin: { doses: [20, 40], unit: 'mg' },
  rosuvastatin: { doses: [5, 10, 20, 40], unit: 'mg' },
  simvastatin: { doses: [10, 20, 40], unit: 'mg' }, // 80mg excluded (myopathy risk)
};

/**
 * Statin names for dropdown selection.
 */
export const STATIN_NAMES = [
  { value: 'none', label: "Haven't tried yet" },
  { value: 'atorvastatin', label: 'Atorvastatin' },
  { value: 'pitavastatin', label: 'Pitavastatin' },
  { value: 'pravastatin', label: 'Pravastatin' },
  { value: 'rosuvastatin', label: 'Rosuvastatin' },
  { value: 'simvastatin', label: 'Simvastatin' },
  { value: 'not_tolerated', label: 'Not tolerated' },
] as const;

export type StatinNameValue = typeof STATIN_NAMES[number]['value'];

/**
 * Potency equivalency table: approximate % LDL-C reduction per dose.
 * Based on BPAC 2021 statin potency table.
 */
export const STATIN_POTENCY: Record<string, Record<number, number>> = {
  rosuvastatin: { 5: 40, 10: 47, 20: 55, 40: 63 },
  atorvastatin: { 10: 30, 20: 40, 40: 47, 80: 55 },
  simvastatin: { 10: 30, 20: 35, 40: 40 },
  pravastatin: { 20: 30, 40: 40 },
  pitavastatin: { 1: 30, 2: 35, 4: 40 },
};

/**
 * Maximum potency achievable (rosuvastatin 40mg = 63% LDL reduction).
 */
export const MAX_STATIN_POTENCY = 63;

/**
 * Get available doses for a statin drug.
 */
export function getStatinDoses(drug: string): number[] {
  return STATIN_DRUGS[drug]?.doses ?? [];
}

/**
 * Get the potency (% LDL reduction) of a statin/dose combination.
 * Returns 0 for 'none' or invalid combinations.
 */
export function getCurrentPotency(drug: string | undefined, dose: number | null): number {
  if (!drug || drug === 'none' || drug === 'not_tolerated' || dose === null) return 0;
  return STATIN_POTENCY[drug]?.[dose] ?? 0;
}

/**
 * Check if user can increase dose (has higher dose available for current statin).
 */
export function canIncreaseDose(drug: string | undefined, dose: number | null): boolean {
  if (!drug || drug === 'none' || drug === 'not_tolerated' || dose === null) return false;
  const doses = STATIN_DRUGS[drug]?.doses;
  if (!doses) return false;
  const currentIndex = doses.indexOf(dose);
  return currentIndex >= 0 && currentIndex < doses.length - 1;
}

/**
 * Check if user should be suggested to switch to a higher potency statin.
 * Returns true if on max dose of current statin but not at max overall potency.
 */
export function shouldSuggestSwitch(drug: string | undefined, dose: number | null): boolean {
  if (!drug || drug === 'none' || drug === 'not_tolerated' || dose === null) return false;
  const currentPotency = getCurrentPotency(drug, dose);
  const isOnMaxDose = !canIncreaseDose(drug, dose);
  return isOnMaxDose && currentPotency > 0 && currentPotency < MAX_STATIN_POTENCY;
}

/**
 * Check if user is on maximum possible potency (rosuvastatin 40mg).
 */
export function isOnMaxPotency(drug: string | undefined, dose: number | null): boolean {
  return getCurrentPotency(drug, dose) >= MAX_STATIN_POTENCY;
}

/**
 * Get the appropriate escalation suggestion type.
 */
export function getStatinEscalationType(drug: string | undefined, dose: number | null): 'increase_dose' | 'switch_statin' | 'none' {
  if (!drug || drug === 'none' || drug === 'not_tolerated' || dose === null) return 'none';
  if (canIncreaseDose(drug, dose)) return 'increase_dose';
  if (shouldSuggestSwitch(drug, dose)) return 'switch_statin';
  return 'none';
}

/**
 * Ezetimibe options for dropdown.
 */
export const EZETIMIBE_OPTIONS = [
  { value: 'not_yet', label: "Haven't tried yet" },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'not_tolerated', label: 'Not tolerated' },
] as const;

export type EzetimibeValue = typeof EZETIMIBE_OPTIONS[number]['value'];

/**
 * PCSK9i options for dropdown.
 */
export const PCSK9I_OPTIONS = [
  { value: 'not_yet', label: "Haven't tried yet" },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'not_tolerated', label: 'Not tolerated' },
] as const;

export type Pcsk9iValue = typeof PCSK9I_OPTIONS[number]['value'];

/**
 * Cancer screening inputs for the screening cascade.
 * Date fields use "YYYY-MM" format (month precision).
 */
export interface ScreeningInputs {
  // Colorectal
  colorectalMethod?: 'fit_annual' | 'colonoscopy_10yr' | 'other' | 'not_yet_started';
  colorectalLastDate?: string; // YYYY-MM

  // Breast
  breastFrequency?: 'annual' | 'biennial' | 'not_yet_started';
  breastLastDate?: string;

  // Cervical
  cervicalMethod?: 'hpv_every_5yr' | 'pap_every_3yr' | 'other' | 'not_yet_started';
  cervicalLastDate?: string;

  // Lung
  lungSmokingHistory?: 'never_smoked' | 'former_smoker' | 'current_smoker';
  lungPackYears?: number;
  lungScreening?: 'annual_ldct' | 'not_yet_started';
  lungLastDate?: string;

  // Prostate
  prostateDiscussion?: 'not_yet' | 'elected_not_to' | 'will_screen';
  prostatePsaValue?: number;
  prostateLastDate?: string;

  // Endometrial
  endometrialDiscussion?: 'not_yet' | 'discussed';
  endometrialAbnormalBleeding?: 'no' | 'yes_reported' | 'yes_need_to_report';
}

/**
 * Screening interval in months, keyed by screening method value.
 */
export const SCREENING_INTERVALS: Record<string, number> = {
  fit_annual: 12,
  colonoscopy_10yr: 120,
  annual: 12,       // breast annual
  biennial: 24,     // breast biennial
  hpv_every_5yr: 60,
  pap_every_3yr: 36,
  annual_ldct: 12,
  will_screen: 12,  // prostate PSA default
  other: 12,        // fallback for "other" methods
};

/**
 * Statin medication input with separate drug and dose (FHIR-compatible).
 */
export interface StatinInput {
  drug: string;        // e.g., 'atorvastatin', 'none', 'not_tolerated'
  dose: number | null; // e.g., 40, null for 'none'/'not_tolerated'
}

/**
 * Medication inputs for the cholesterol medication cascade.
 */
export interface MedicationInputs {
  statin?: StatinInput;
  ezetimibe?: EzetimibeValue;
  statinEscalation?: 'not_yet' | 'not_tolerated';
  pcsk9i?: Pcsk9iValue;
}

/**
 * A single immutable measurement record (maps to health_measurements table).
 */
export interface Measurement {
  id: string;
  userId: string;
  metricType: string;
  value: number; // SI canonical unit
  recordedAt: string; // ISO 8601
  createdAt: string;  // ISO 8601
}

/**
 * Database encoding for sex field (profiles table).
 * 1 = male, 2 = female
 */
export const SEX_DB = { MALE: 1, FEMALE: 2 } as const;

/**
 * Database encoding for unit_system field (profiles table).
 * 1 = SI, 2 = conventional (US)
 */
export const UNIT_SYSTEM_DB = { SI: 1, CONVENTIONAL: 2 } as const;

/** Encode sex string to database integer */
export function encodeSex(sex: 'male' | 'female'): number {
  return sex === 'male' ? SEX_DB.MALE : SEX_DB.FEMALE;
}

/** Decode database integer to sex string */
export function decodeSex(encoded: number): 'male' | 'female' {
  return encoded === SEX_DB.MALE ? 'male' : 'female';
}

/** Encode unit system string to database integer */
export function encodeUnitSystem(unitSystem: 'si' | 'conventional'): number {
  return unitSystem === 'si' ? UNIT_SYSTEM_DB.SI : UNIT_SYSTEM_DB.CONVENTIONAL;
}

/** Decode database integer to unit system string */
export function decodeUnitSystem(encoded: number): 'si' | 'conventional' {
  return encoded === UNIT_SYSTEM_DB.SI ? 'si' : 'conventional';
}
