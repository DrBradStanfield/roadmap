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
 * A health suggestion to discuss with doctor
 */
export interface Suggestion {
  id: string;
  category: 'nutrition' | 'exercise' | 'bloodwork' | 'blood_pressure' | 'general' | 'sleep' | 'medication' | 'screening' | 'supplements';
  priority: 'info' | 'attention' | 'urgent';
  title: string;
  description: string;
  link?: string;
  discussWithDoctor: boolean;
}

/**
 * Statin tier groupings by equivalent potency.
 */
export const STATIN_OPTIONS = [
  { value: 'none', label: "Haven't tried a statin yet", tier: 0 },
  { value: 'tier_1', label: 'Rosuvastatin 5mg or Pravastatin 20mg or Atorvastatin 10mg', tier: 1 },
  { value: 'tier_2', label: 'Rosuvastatin 10mg or Pravastatin 40mg or Atorvastatin 20mg', tier: 2 },
  { value: 'tier_3', label: 'Rosuvastatin 20mg or Pravastatin 40mg or Atorvastatin 40mg', tier: 3 },
  { value: 'tier_4', label: 'Rosuvastatin 40mg or Pravastatin 40mg or Atorvastatin 80mg', tier: 4 },
  { value: 'not_tolerated', label: 'Statin not tolerated', tier: -1 },
] as const;

export const MAX_STATIN_TIER = 4;

export type StatinValue = typeof STATIN_OPTIONS[number]['value'];

/**
 * Get the tier of a statin value. Returns 0 for 'none', -1 for 'not_tolerated'.
 */
export function getStatinTier(value: string | undefined): number {
  if (!value) return 0;
  const option = STATIN_OPTIONS.find(o => o.value === value);
  return option ? option.tier : 0;
}

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
 * Medication inputs for the cholesterol medication cascade.
 */
export interface MedicationInputs {
  statin?: string;                                    // StatinValue
  ezetimibe?: 'yes' | 'no' | 'not_tolerated';
  statinIncrease?: 'not_yet' | 'not_tolerated';
  pcsk9i?: 'yes' | 'no' | 'not_tolerated';
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
