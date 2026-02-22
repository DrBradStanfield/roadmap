/**
 * Shared mappings between HealthInputs fields and measurement metric types.
 *
 * Used by both the storefront widget and customer account extension
 * to convert between API measurement records and HealthInputs objects.
 *
 * Demographics (sex, birthYear, birthMonth, unitSystem) are stored on the
 * profiles table, not as measurements. Use diffProfileFields() for those.
 */
import type { HealthInputs } from './types';
import { encodeSex, decodeSex, encodeUnitSystem, decodeUnitSystem } from './types';
import type { MetricType } from './units';

/**
 * Maps HealthInputs field names to metric_type values for storage in the
 * health_measurements table. Used when saving longitudinal measurements.
 *
 * NOTE: Excludes heightCm because height is stored on the profiles table,
 * not as a time-series measurement. For unit conversions (which include
 * height), use FIELD_METRIC_MAP instead.
 */
export const FIELD_TO_METRIC: Record<string, string> = {
  weightKg: 'weight',
  waistCm: 'waist',
  hba1c: 'hba1c',
  ldlC: 'ldl',
  totalCholesterol: 'total_cholesterol',
  hdlC: 'hdl',
  triglycerides: 'triglycerides',
  systolicBp: 'systolic_bp',
  diastolicBp: 'diastolic_bp',
  apoB: 'apob',
  creatinine: 'creatinine',
  psa: 'psa',
  lpa: 'lpa',
};

/** Reverse mapping: metric_type → HealthInputs field name. */
export const METRIC_TO_FIELD: Record<string, keyof HealthInputs> = {
  weight: 'weightKg',
  waist: 'waistCm',
  hba1c: 'hba1c',
  ldl: 'ldlC',
  total_cholesterol: 'totalCholesterol',
  hdl: 'hdlC',
  triglycerides: 'triglycerides',
  systolic_bp: 'systolicBp',
  diastolic_bp: 'diastolicBp',
  apob: 'apoB',
  creatinine: 'creatinine',
  psa: 'psa',
  lpa: 'lpa',
};

/**
 * Maps HealthInputs field names to MetricType for unit conversions.
 * Used by UI components to convert between SI and conventional units.
 *
 * NOTE: Includes heightCm (unlike FIELD_TO_METRIC) because height requires
 * unit conversion even though it's stored on profiles, not measurements.
 */
export const FIELD_METRIC_MAP: Record<string, MetricType> = {
  heightCm: 'height',
  weightKg: 'weight',
  waistCm: 'waist',
  hba1c: 'hba1c',
  ldlC: 'ldl',
  totalCholesterol: 'total_cholesterol',
  hdlC: 'hdl',
  triglycerides: 'triglycerides',
  systolicBp: 'systolic_bp',
  diastolicBp: 'diastolic_bp',
  apoB: 'apob',
  creatinine: 'creatinine',
  psa: 'psa',
  lpa: 'lpa',
};

/**
 * Fields that are always pre-filled from saved data (demographics + height).
 * These are mutable profile-level data or rarely-changing measurements.
 */
export const PREFILL_FIELDS: ReadonlyArray<keyof HealthInputs> = [
  'heightCm', 'sex', 'birthYear', 'birthMonth',
];

/**
 * Fields that use longitudinal UX: empty input + "Previous: value (date)" label.
 * These are immutable time-series measurements that accumulate over time.
 */
export const LONGITUDINAL_FIELDS: ReadonlyArray<keyof HealthInputs> = [
  'weightKg', 'waistCm', 'hba1c', 'creatinine', 'psa', 'apoB', 'ldlC', 'totalCholesterol', 'hdlC',
  'triglycerides', 'systolicBp', 'diastolicBp', 'lpa',
];

/**
 * Metric types for blood test results (as opposed to body measurements).
 * Used to determine which measurements should use the user-selected blood test date.
 */
export const BLOOD_TEST_METRICS: ReadonlyArray<string> = [
  'hba1c', 'creatinine', 'psa', 'apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa',
];

/** API measurement record shape (camelCase, as returned by API endpoints). */
export interface ApiMeasurement {
  id: string;
  metricType: string;
  value: number;
  recordedAt: string;
  createdAt: string;
}

/** API medication record shape (camelCase, as returned by API endpoints). FHIR-compatible. */
export interface ApiMedication {
  id: string;
  medicationKey: string;
  drugName: string;           // e.g., 'atorvastatin', 'yes', 'not_yet'
  doseValue: number | null;   // e.g., 40, null for non-drug fields
  doseUnit: string | null;    // e.g., 'mg', null for non-drug fields
  updatedAt: string;
}

/**
 * Convert API medication records into a MedicationInputs object.
 * Handles FHIR-compliant data (actual drug names) and converts to UI format.
 */
export function medicationsToInputs(
  medications: ApiMedication[],
): import('./types').MedicationInputs {
  const inputs: import('./types').MedicationInputs = {};
  for (const m of medications) {
    switch (m.medicationKey) {
      case 'statin':
        inputs.statin = {
          drug: m.drugName,
          dose: m.doseValue,
        };
        break;
      case 'ezetimibe':
        // FHIR-compliant: 'ezetimibe' with dose means taking it, convert to 'yes'
        if (m.drugName === 'ezetimibe' && m.doseValue !== null) {
          inputs.ezetimibe = 'yes';
        } else {
          inputs.ezetimibe = m.drugName as 'not_yet' | 'yes' | 'no' | 'not_tolerated';
        }
        break;
      case 'statin_escalation':
        inputs.statinEscalation = m.drugName as 'not_yet' | 'not_tolerated';
        break;
      case 'pcsk9i':
        // FHIR-compliant: 'pcsk9i' with dose means taking it, convert to 'yes'
        if (m.drugName === 'pcsk9i' && m.doseValue !== null) {
          inputs.pcsk9i = 'yes';
        } else {
          inputs.pcsk9i = m.drugName as 'not_yet' | 'yes' | 'no' | 'not_tolerated';
        }
        break;
      // Weight & diabetes cascade
      case 'glp1':
        inputs.glp1 = { drug: m.drugName, dose: m.doseValue };
        break;
      case 'glp1_escalation':
        inputs.glp1Escalation = m.drugName as 'not_yet' | 'not_tolerated';
        break;
      case 'sglt2i':
        inputs.sglt2i = { drug: m.drugName, dose: m.doseValue };
        break;
      case 'metformin':
        inputs.metformin = m.drugName as import('./types').MetforminValue;
        break;
    }
  }
  return inputs;
}

/** API screening record shape (camelCase, as returned by API endpoints). */
export interface ApiScreening {
  id: string;
  screeningKey: string;
  value: string;
  updatedAt: string;
}

/** Cast a DB string to a union type, returning undefined if invalid. */
function castEnum<T extends string>(value: string, valid: readonly T[]): T | undefined {
  return valid.includes(value as T) ? (value as T) : undefined;
}

// Valid values for each screening enum field (derived from ScreeningInputs in types.ts)
const COLORECTAL_METHODS = ['fit_annual', 'colonoscopy_10yr', 'other', 'not_yet_started'] as const;
const BREAST_FREQUENCIES = ['annual', 'biennial', 'not_yet_started'] as const;
const CERVICAL_METHODS = ['hpv_every_5yr', 'pap_every_3yr', 'other', 'not_yet_started'] as const;
const SCREENING_RESULTS = ['normal', 'abnormal', 'awaiting'] as const;
const FOLLOWUP_STATUSES = ['not_organized', 'scheduled', 'completed'] as const;
const SMOKING_HISTORIES = ['never_smoked', 'former_smoker', 'current_smoker'] as const;
const LUNG_SCREENINGS = ['annual_ldct', 'not_yet_started'] as const;
const PROSTATE_DISCUSSIONS = ['not_yet', 'elected_not_to', 'will_screen'] as const;
const ENDOMETRIAL_DISCUSSIONS = ['not_yet', 'discussed'] as const;
const ENDOMETRIAL_BLEEDING = ['no', 'yes_reported', 'yes_need_to_report'] as const;
const DEXA_SCREENINGS = ['dexa_scan', 'not_yet_started'] as const;
const DEXA_RESULTS = ['normal', 'osteopenia', 'osteoporosis', 'awaiting'] as const;

/**
 * Convert API screening records into a ScreeningInputs object.
 */
export function screeningsToInputs(
  screenings: ApiScreening[],
): import('./types').ScreeningInputs {
  const inputs: import('./types').ScreeningInputs = {};
  for (const s of screenings) {
    switch (s.screeningKey) {
      case 'colorectal_method':
        inputs.colorectalMethod = castEnum(s.value, COLORECTAL_METHODS);
        break;
      case 'colorectal_last_date':
        inputs.colorectalLastDate = s.value;
        break;
      case 'colorectal_result':
        inputs.colorectalResult = castEnum(s.value, SCREENING_RESULTS);
        break;
      case 'colorectal_followup_status':
        inputs.colorectalFollowupStatus = castEnum(s.value, FOLLOWUP_STATUSES);
        break;
      case 'colorectal_followup_date':
        inputs.colorectalFollowupDate = s.value;
        break;
      case 'breast_frequency':
        inputs.breastFrequency = castEnum(s.value, BREAST_FREQUENCIES);
        break;
      case 'breast_last_date':
        inputs.breastLastDate = s.value;
        break;
      case 'breast_result':
        inputs.breastResult = castEnum(s.value, SCREENING_RESULTS);
        break;
      case 'breast_followup_status':
        inputs.breastFollowupStatus = castEnum(s.value, FOLLOWUP_STATUSES);
        break;
      case 'breast_followup_date':
        inputs.breastFollowupDate = s.value;
        break;
      case 'cervical_method':
        inputs.cervicalMethod = castEnum(s.value, CERVICAL_METHODS);
        break;
      case 'cervical_last_date':
        inputs.cervicalLastDate = s.value;
        break;
      case 'cervical_result':
        inputs.cervicalResult = castEnum(s.value, SCREENING_RESULTS);
        break;
      case 'cervical_followup_status':
        inputs.cervicalFollowupStatus = castEnum(s.value, FOLLOWUP_STATUSES);
        break;
      case 'cervical_followup_date':
        inputs.cervicalFollowupDate = s.value;
        break;
      case 'lung_smoking_history':
        inputs.lungSmokingHistory = castEnum(s.value, SMOKING_HISTORIES);
        break;
      case 'lung_pack_years':
        inputs.lungPackYears = parseFloat(s.value);
        break;
      case 'lung_screening':
        inputs.lungScreening = castEnum(s.value, LUNG_SCREENINGS);
        break;
      case 'lung_last_date':
        inputs.lungLastDate = s.value;
        break;
      case 'lung_result':
        inputs.lungResult = castEnum(s.value, SCREENING_RESULTS);
        break;
      case 'lung_followup_status':
        inputs.lungFollowupStatus = castEnum(s.value, FOLLOWUP_STATUSES);
        break;
      case 'lung_followup_date':
        inputs.lungFollowupDate = s.value;
        break;
      case 'prostate_discussion':
        inputs.prostateDiscussion = castEnum(s.value, PROSTATE_DISCUSSIONS);
        break;
      case 'prostate_psa_value':
        inputs.prostatePsaValue = parseFloat(s.value);
        break;
      case 'prostate_last_date':
        inputs.prostateLastDate = s.value;
        break;
      case 'endometrial_discussion':
        inputs.endometrialDiscussion = castEnum(s.value, ENDOMETRIAL_DISCUSSIONS);
        break;
      case 'endometrial_abnormal_bleeding':
        inputs.endometrialAbnormalBleeding = castEnum(s.value, ENDOMETRIAL_BLEEDING);
        break;
      case 'dexa_screening':
        inputs.dexaScreening = castEnum(s.value, DEXA_SCREENINGS);
        break;
      case 'dexa_last_date':
        inputs.dexaLastDate = s.value;
        break;
      case 'dexa_result':
        inputs.dexaResult = castEnum(s.value, DEXA_RESULTS);
        break;
      case 'dexa_followup_status':
        inputs.dexaFollowupStatus = castEnum(s.value, FOLLOWUP_STATUSES);
        break;
      case 'dexa_followup_date':
        inputs.dexaFollowupDate = s.value;
        break;
    }
  }
  return inputs;
}

/** API profile shape (camelCase, as returned by API endpoints). */
export interface ApiProfile {
  sex: number | null;
  birthYear: number | null;
  birthMonth: number | null;
  unitSystem: number | null;
  firstName: string | null;
  lastName: string | null;
  height: number | null;
}

/**
 * Convert API measurement records + optional profile data into a partial HealthInputs object.
 * Profile demographics (sex, birthYear, birthMonth, unitSystem) come from the profile object.
 */
export function measurementsToInputs(
  measurements: ApiMeasurement[],
  profile?: ApiProfile | null,
): Partial<HealthInputs> {
  const inputs: Partial<HealthInputs> = {};

  for (const m of measurements) {
    const field = METRIC_TO_FIELD[m.metricType];
    if (field) {
      (inputs as any)[field] = m.value;
    }
  }

  if (profile) {
    if (profile.sex != null) {
      (inputs as any).sex = decodeSex(profile.sex);
    }
    if (profile.birthYear != null) {
      (inputs as any).birthYear = profile.birthYear;
    }
    if (profile.birthMonth != null) {
      (inputs as any).birthMonth = profile.birthMonth;
    }
    if (profile.unitSystem != null) {
      (inputs as any).unitSystem = decodeUnitSystem(profile.unitSystem);
    }
    if (profile.height != null) {
      (inputs as any).heightCm = profile.height;
    }
  }

  return inputs;
}

/**
 * Determine which health measurement fields changed and return them as metric/value pairs
 * ready for the API. Only includes health metrics — use diffProfileFields() for demographics.
 */
export function diffInputsToMeasurements(
  current: Partial<HealthInputs>,
  previous: Partial<HealthInputs>,
): Array<{ metricType: string; value: number }> {
  const changes: Array<{ metricType: string; value: number }> = [];

  for (const [field, metricType] of Object.entries(FIELD_TO_METRIC)) {
    const currentVal = current[field as keyof HealthInputs];
    const previousVal = previous[field as keyof HealthInputs];

    if (currentVal !== undefined && currentVal !== previousVal) {
      changes.push({ metricType, value: currentVal as number });
    }
  }

  return changes;
}

/**
 * Check if an API response contains meaningful user-entered health data.
 * An auto-created profile row with all NULL fields does NOT count as "has data."
 *
 * Used by both sync-embed.liquid (duplicated in plain JS) and HealthTool.tsx
 * to decide whether localStorage→cloud sync should be skipped.
 *
 * Bug history: Before this check, the code used `!!profile` which is always
 * truthy for auto-created profile rows ({sex: null, birthYear: null, ...}),
 * causing sync to never run for new users.
 */
export function hasCloudData(
  profile: ApiProfile | null | undefined,
  measurements: ApiMeasurement[],
  medications?: ApiMedication[],
  screenings?: ApiScreening[],
): boolean {
  if (measurements.length > 0) return true;
  if (medications && medications.length > 0) return true;
  if (screenings && screenings.length > 0) return true;
  if (profile && (
    profile.sex != null ||
    profile.birthYear != null ||
    profile.height != null ||
    profile.unitSystem != null
  )) return true;
  return false;
}

/**
 * Determine which profile fields changed and return them as API-ready numeric values.
 * Encodes sex (1=male, 2=female) and unitSystem (1=si, 2=conventional).
 * Height is stored directly in cm.
 * Returns null if nothing changed.
 */
export function diffProfileFields(
  current: Partial<HealthInputs>,
  previous: Partial<HealthInputs>,
): { sex?: number; birthYear?: number; birthMonth?: number; unitSystem?: number; height?: number } | null {
  const changes: Record<string, number> = {};

  if (current.sex !== undefined && current.sex !== previous.sex) {
    changes.sex = encodeSex(current.sex);
  }
  if (current.birthYear !== undefined && current.birthYear !== previous.birthYear) {
    changes.birthYear = current.birthYear;
  }
  if (current.birthMonth !== undefined && current.birthMonth !== previous.birthMonth) {
    changes.birthMonth = current.birthMonth;
  }
  if (current.unitSystem !== undefined && current.unitSystem !== previous.unitSystem) {
    changes.unitSystem = encodeUnitSystem(current.unitSystem);
  }
  if (current.heightCm !== undefined && current.heightCm !== previous.heightCm) {
    changes.height = current.heightCm;
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Compute the progressive disclosure stage (1–4) based on which inputs are filled.
 *
 * Stage 1: Always (sex + height shown)
 * Stage 2: sex AND heightCm filled (birth month/year shown)
 * Stage 3: birthMonth AND birthYear filled (weight + waist shown)
 * Stage 4: weightKg filled (BP, blood tests, medications, screening shown)
 *
 * Checks from stage 4 downward so returning users with data skip to full form.
 */
export function computeFormStage(inputs: Partial<HealthInputs>): 1 | 2 | 3 | 4 {
  if (inputs.weightKg !== undefined) return 4;
  if (inputs.birthMonth !== undefined && inputs.birthYear !== undefined && inputs.birthYear >= 1900) return 3;
  if (inputs.sex !== undefined && inputs.heightCm !== undefined) return 2;
  return 1;
}

/**
 * Resolve the email confirmation status from a sessionStorage flag value.
 * Used by the widget to show instant email confirmation when sync-embed
 * already sent the welcome email on a previous page.
 */
export function resolveEmailConfirmStatus(
  sessionFlag: string | null,
): 'idle' | 'sent' | 'error' {
  if (!sessionFlag) return 'idle';
  return sessionFlag === 'sent' ? 'sent' : 'error';
}
