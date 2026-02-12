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
  'triglycerides', 'systolicBp', 'diastolicBp',
];

/**
 * Metric types for blood test results (as opposed to body measurements).
 * Used to determine which measurements should use the user-selected blood test date.
 */
export const BLOOD_TEST_METRICS: ReadonlyArray<string> = [
  'hba1c', 'creatinine', 'psa', 'apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides',
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
        inputs.colorectalMethod = s.value as any;
        break;
      case 'colorectal_last_date':
        inputs.colorectalLastDate = s.value;
        break;
      case 'breast_frequency':
        inputs.breastFrequency = s.value as any;
        break;
      case 'breast_last_date':
        inputs.breastLastDate = s.value;
        break;
      case 'cervical_method':
        inputs.cervicalMethod = s.value as any;
        break;
      case 'cervical_last_date':
        inputs.cervicalLastDate = s.value;
        break;
      case 'lung_smoking_history':
        inputs.lungSmokingHistory = s.value as any;
        break;
      case 'lung_pack_years':
        inputs.lungPackYears = parseFloat(s.value);
        break;
      case 'lung_screening':
        inputs.lungScreening = s.value as any;
        break;
      case 'lung_last_date':
        inputs.lungLastDate = s.value;
        break;
      case 'prostate_discussion':
        inputs.prostateDiscussion = s.value as any;
        break;
      case 'prostate_psa_value':
        inputs.prostatePsaValue = parseFloat(s.value);
        break;
      case 'prostate_last_date':
        inputs.prostateLastDate = s.value;
        break;
      case 'endometrial_discussion':
        inputs.endometrialDiscussion = s.value as any;
        break;
      case 'endometrial_abnormal_bleeding':
        inputs.endometrialAbnormalBleeding = s.value as any;
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
