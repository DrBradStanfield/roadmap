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
  lpa?: number;         // nmol/L (no unit conversion — same in both systems)
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
  bmiCategory?: string;         // e.g. 'Normal', 'Overweight', 'Obese (Class I)' — computed by getBMICategory
  waistToHeightRatio?: number;
  nonHdlCholesterol?: number; // mmol/L (total cholesterol - HDL)
  apoB?: number;              // g/L (passthrough from inputs)
  ldlC?: number;              // mmol/L (passthrough from inputs)
  eGFR?: number;              // mL/min/1.73m² (CKD-EPI 2021)
  lpa?: number;               // nmol/L (passthrough from inputs)
  age?: number;
  suggestions: Suggestion[];
}

/**
 * A health suggestion
 */
export interface Suggestion {
  id: string;
  category: 'nutrition' | 'exercise' | 'bloodwork' | 'blood_pressure' | 'general' | 'sleep' | 'medication' | 'screening' | 'supplements' | 'skin';
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

// ===== GLP-1 Configuration =====

/**
 * Available GLP-1 drugs with their dose options.
 */
export const GLP1_DRUGS: Record<string, { doses: number[]; unit: string }> = {
  tirzepatide: { doses: [2.5, 5, 7.5, 10, 12.5, 15], unit: 'mg' },
  semaglutide_injection: { doses: [0.25, 0.5, 1, 1.7, 2.4], unit: 'mg' },
  semaglutide_oral: { doses: [3, 7, 14], unit: 'mg' },
  dulaglutide: { doses: [0.75, 1.5, 3, 4.5], unit: 'mg' },
};

/**
 * GLP-1 names for dropdown selection.
 */
export const GLP1_NAMES = [
  { value: 'none', label: "Haven't tried yet" },
  { value: 'tirzepatide', label: 'Tirzepatide (Mounjaro/Zepbound)' },
  { value: 'semaglutide_injection', label: 'Semaglutide injection (Ozempic/Wegovy)' },
  { value: 'semaglutide_oral', label: 'Semaglutide oral (Rybelsus)' },
  { value: 'dulaglutide', label: 'Dulaglutide (Trulicity)' },
  { value: 'other', label: 'Other GLP-1' },
  { value: 'not_tolerated', label: 'Not tolerated' },
] as const;

export type Glp1NameValue = typeof GLP1_NAMES[number]['value'];

// ===== GLP-1 Escalation Configuration =====

/** The most potent GLP-1 drug — used as the switch target in escalation. */
export const MAX_GLP1_DRUG = 'tirzepatide';

/** Check if user can increase their current GLP-1 dose (higher dose available). */
export function canIncreaseGlp1Dose(drug: string | undefined, dose: number | null): boolean {
  if (!drug || drug === 'none' || drug === 'not_tolerated' || drug === 'other' || dose === null) return false;
  const doses = GLP1_DRUGS[drug]?.doses;
  if (!doses) return false;
  const currentIndex = doses.indexOf(dose);
  return currentIndex >= 0 && currentIndex < doses.length - 1;
}

/** Check if user should switch to tirzepatide (on max dose of a less potent GLP-1). */
export function shouldSuggestGlp1Switch(drug: string | undefined, dose: number | null): boolean {
  if (!drug || drug === 'none' || drug === 'not_tolerated') return false;
  if (drug === 'other') return true;
  if (dose === null) return false;
  if (drug === MAX_GLP1_DRUG) return false;
  return !canIncreaseGlp1Dose(drug, dose);
}

/** Check if user is on maximum GLP-1 potency (tirzepatide at max dose). */
export function isOnMaxGlp1Potency(drug: string | undefined, dose: number | null): boolean {
  if (dose === null) return false;
  return drug === MAX_GLP1_DRUG && !canIncreaseGlp1Dose(drug, dose);
}

/** Get the appropriate GLP-1 escalation action. */
export function getGlp1EscalationType(drug: string | undefined, dose: number | null): 'increase_dose' | 'switch_glp1' | 'none' {
  if (!drug || drug === 'none' || drug === 'not_tolerated') return 'none';
  if (drug === 'other') return 'switch_glp1';
  if (dose === null) return 'none';
  if (canIncreaseGlp1Dose(drug, dose)) return 'increase_dose';
  if (shouldSuggestGlp1Switch(drug, dose)) return 'switch_glp1';
  return 'none';
}

// ===== SGLT2i Configuration =====

/**
 * Available SGLT2 inhibitor drugs with their dose options.
 */
export const SGLT2I_DRUGS: Record<string, { doses: number[]; unit: string }> = {
  empagliflozin: { doses: [10, 25], unit: 'mg' },
  dapagliflozin: { doses: [5, 10], unit: 'mg' },
  canagliflozin: { doses: [100, 300], unit: 'mg' },
};

/**
 * SGLT2i names for dropdown selection.
 */
export const SGLT2I_NAMES = [
  { value: 'none', label: "Haven't tried yet" },
  { value: 'empagliflozin', label: 'Empagliflozin (Jardiance)' },
  { value: 'dapagliflozin', label: 'Dapagliflozin (Farxiga)' },
  { value: 'canagliflozin', label: 'Canagliflozin (Invokana)' },
  { value: 'not_tolerated', label: 'Not tolerated' },
] as const;

export type Sglt2iNameValue = typeof SGLT2I_NAMES[number]['value'];

// ===== Metformin Configuration =====

/**
 * Metformin options for dropdown (formulation + daily dose).
 */
export const METFORMIN_OPTIONS = [
  { value: 'none', label: "Haven't tried yet" },
  { value: 'ir_500', label: 'IR 500mg/day' },
  { value: 'ir_1000', label: 'IR 1000mg/day' },
  { value: 'ir_1500', label: 'IR 1500mg/day' },
  { value: 'ir_2000', label: 'IR 2000mg/day' },
  { value: 'xr_500', label: 'XR 500mg/day' },
  { value: 'xr_1000', label: 'XR 1000mg/day' },
  { value: 'xr_1500', label: 'XR 1500mg/day' },
  { value: 'xr_2000', label: 'XR 2000mg/day' },
  { value: 'not_tolerated', label: 'Not tolerated' },
] as const;

export type MetforminValue = typeof METFORMIN_OPTIONS[number]['value'];

/** Result of a screening test. */
export type ScreeningResult = 'normal' | 'abnormal' | 'awaiting';

/** Follow-up status after an abnormal screening result. */
export type ScreeningFollowupStatus = 'not_organized' | 'scheduled' | 'completed';

/**
 * Cancer screening inputs for the screening cascade.
 * Date fields use "YYYY-MM" format (month precision).
 */
export interface ScreeningInputs {
  // Colorectal
  colorectalMethod?: 'fit_annual' | 'colonoscopy_10yr' | 'other' | 'not_yet_started';
  colorectalLastDate?: string; // YYYY-MM
  colorectalResult?: ScreeningResult;
  colorectalFollowupStatus?: ScreeningFollowupStatus;
  colorectalFollowupDate?: string; // YYYY-MM

  // Breast
  breastFrequency?: 'annual' | 'biennial' | 'not_yet_started';
  breastLastDate?: string;
  breastResult?: ScreeningResult;
  breastFollowupStatus?: ScreeningFollowupStatus;
  breastFollowupDate?: string;

  // Cervical
  cervicalMethod?: 'hpv_every_5yr' | 'pap_every_3yr' | 'other' | 'not_yet_started';
  cervicalLastDate?: string;
  cervicalResult?: ScreeningResult;
  cervicalFollowupStatus?: ScreeningFollowupStatus;
  cervicalFollowupDate?: string;

  // Lung
  lungSmokingHistory?: 'never_smoked' | 'former_smoker' | 'current_smoker';
  lungPackYears?: number;
  lungScreening?: 'annual_ldct' | 'not_yet_started';
  lungLastDate?: string;
  lungResult?: ScreeningResult;
  lungFollowupStatus?: ScreeningFollowupStatus;
  lungFollowupDate?: string;

  // Prostate
  prostateDiscussion?: 'not_yet' | 'elected_not_to' | 'will_screen';
  prostatePsaValue?: number;
  prostateLastDate?: string;

  // Endometrial
  endometrialDiscussion?: 'not_yet' | 'discussed';
  endometrialAbnormalBleeding?: 'no' | 'yes_reported' | 'yes_need_to_report';

  // Bone Density (DEXA)
  dexaScreening?: 'dexa_scan' | 'not_yet_started';
  dexaLastDate?: string; // YYYY-MM
  dexaResult?: 'normal' | 'osteopenia' | 'osteoporosis' | 'awaiting';
  dexaFollowupStatus?: ScreeningFollowupStatus;
  dexaFollowupDate?: string; // YYYY-MM
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
  dexa_normal: 60,      // DEXA: 5 years for normal result
  dexa_osteopenia: 24,  // DEXA: 2 years for osteopenia
  dexa_scan: 24,        // DEXA: default 2 years if no result yet
};

/**
 * Calculate the next-due date for a screening based on last date and method interval.
 * Shared by suggestions.ts (screeningStatus) and reminders.ts (isScreeningOverdue).
 * Returns null if inputs are invalid or missing.
 */
export function getScreeningNextDueDate(lastDate: string | undefined, method: string | undefined): Date | null {
  if (!lastDate || !method) return null;
  const intervalMonths = SCREENING_INTERVALS[method] ?? 12;
  const [year, month] = lastDate.split('-').map(Number);
  if (!year || !month) return null;
  return new Date(year, month - 1 + intervalMonths);
}

/**
 * Post-follow-up repeat intervals in months.
 * After an abnormal result + completed follow-up, use these instead of SCREENING_INTERVALS.
 * Keyed by "{screeningType}_{method}".
 */
export const POST_FOLLOWUP_INTERVALS: Record<string, number> = {
  colorectal_fit_annual: 36,       // Positive FIT → colonoscopy → repeat in 3 years
  colorectal_colonoscopy_10yr: 36, // Polyps found → repeat colonoscopy in 3 years
  colorectal_other: 36,            // Default 3 years post-follow-up
  breast_annual: 12,               // Resume normal annual schedule
  breast_biennial: 24,             // Resume normal biennial schedule
  cervical_hpv_every_5yr: 12,     // HPV+ → colposcopy → rescreen in 1 year
  cervical_pap_every_3yr: 12,     // Abnormal Pap → colposcopy → rescreen in 1 year
  cervical_other: 12,              // Default 1 year
  lung_annual_ldct: 12,           // Resume annual LDCT
  dexa_dexa_scan: 12,             // Osteoporosis follow-up → recheck in 1 year
};

/**
 * Human-readable follow-up information for abnormal screening results.
 * Keyed by "{screeningType}_{method}".
 */
export const SCREENING_FOLLOWUP_INFO: Record<string, { followupName: string; abnormalMeans: string }> = {
  colorectal_fit_annual: { followupName: 'colonoscopy', abnormalMeans: 'positive FIT test' },
  colorectal_colonoscopy_10yr: { followupName: 'repeat colonoscopy', abnormalMeans: 'polyps found on colonoscopy' },
  colorectal_other: { followupName: 'follow-up investigation', abnormalMeans: 'abnormal result' },
  breast_annual: { followupName: 'diagnostic imaging/biopsy', abnormalMeans: 'abnormal mammogram' },
  breast_biennial: { followupName: 'diagnostic imaging/biopsy', abnormalMeans: 'abnormal mammogram' },
  cervical_hpv_every_5yr: { followupName: 'colposcopy', abnormalMeans: 'HPV positive result' },
  cervical_pap_every_3yr: { followupName: 'colposcopy', abnormalMeans: 'abnormal Pap test' },
  cervical_other: { followupName: 'colposcopy', abnormalMeans: 'abnormal result' },
  lung_annual_ldct: { followupName: 'follow-up imaging', abnormalMeans: 'abnormal LDCT result' },
  dexa_dexa_scan: { followupName: 'treatment review', abnormalMeans: 'osteoporosis diagnosed — treatment and monitoring required' },
};

/**
 * Statin medication input with separate drug and dose (FHIR-compatible).
 */
export interface StatinInput {
  drug: string;        // e.g., 'atorvastatin', 'none', 'not_tolerated'
  dose: number | null; // e.g., 40, null for 'none'/'not_tolerated'
}

/**
 * GLP-1 medication input with separate drug and dose (FHIR-compatible).
 */
export interface Glp1Input {
  drug: string;        // e.g., 'tirzepatide', 'semaglutide_injection', 'none', 'not_tolerated'
  dose: number | null; // e.g., 2.5, null for 'none'/'not_tolerated'/'other'
}

/**
 * SGLT2i medication input with separate drug and dose (FHIR-compatible).
 */
export interface Sglt2iInput {
  drug: string;        // e.g., 'empagliflozin', 'none', 'not_tolerated'
  dose: number | null; // e.g., 10, null for 'none'/'not_tolerated'
}

/**
 * Medication inputs for the cholesterol and weight/diabetes medication cascades.
 */
export interface MedicationInputs {
  // Cholesterol cascade
  statin?: StatinInput;
  ezetimibe?: EzetimibeValue;
  statinEscalation?: 'not_yet' | 'not_tolerated';
  pcsk9i?: Pcsk9iValue;
  // Weight & diabetes cascade
  glp1?: Glp1Input;
  glp1Escalation?: 'not_yet' | 'not_tolerated';
  sglt2i?: Sglt2iInput;
  metformin?: MetforminValue;
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
