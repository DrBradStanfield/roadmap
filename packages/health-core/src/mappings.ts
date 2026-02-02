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
import type { MetricType } from './units';

/**
 * Maps HealthInputs field names to metric_type values used in the
 * health_measurements table and API. Only health metrics — no demographics.
 */
export const FIELD_TO_METRIC: Record<string, string> = {
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
};

/** Reverse mapping: metric_type → HealthInputs field name. */
export const METRIC_TO_FIELD: Record<string, keyof HealthInputs> = {
  height: 'heightCm',
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
};

/**
 * Maps HealthInputs field names that have unit conversions to their MetricType.
 * Used by InputPanel components for display/canonical conversion.
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
  'weightKg', 'waistCm', 'hba1c', 'apoB', 'ldlC', 'totalCholesterol', 'hdlC',
  'triglycerides', 'systolicBp', 'diastolicBp',
];

/** API measurement record shape (camelCase, as returned by API endpoints). */
export interface ApiMeasurement {
  id: string;
  metricType: string;
  value: number;
  recordedAt: string;
  createdAt: string;
}

/** API medication record shape (camelCase, as returned by API endpoints). */
export interface ApiMedication {
  id: string;
  medicationKey: string;
  value: string;
  updatedAt: string;
}

/**
 * Convert API medication records into a MedicationInputs object.
 */
export function medicationsToInputs(
  medications: ApiMedication[],
): import('./types').MedicationInputs {
  const inputs: import('./types').MedicationInputs = {};
  for (const m of medications) {
    switch (m.medicationKey) {
      case 'statin':
        inputs.statin = m.value;
        break;
      case 'ezetimibe':
        inputs.ezetimibe = m.value as 'yes' | 'no' | 'not_tolerated';
        break;
      case 'statin_increase':
        inputs.statinIncrease = m.value as 'not_yet' | 'not_tolerated';
        break;
      case 'pcsk9i':
        inputs.pcsk9i = m.value as 'yes' | 'no' | 'not_tolerated';
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
      (inputs as any).sex = profile.sex === 1 ? 'male' : 'female';
    }
    if (profile.birthYear != null) {
      (inputs as any).birthYear = profile.birthYear;
    }
    if (profile.birthMonth != null) {
      (inputs as any).birthMonth = profile.birthMonth;
    }
    if (profile.unitSystem != null) {
      (inputs as any).unitSystem = profile.unitSystem === 1 ? 'si' : 'conventional';
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
 * Returns null if nothing changed.
 */
export function diffProfileFields(
  current: Partial<HealthInputs>,
  previous: Partial<HealthInputs>,
): { sex?: number; birthYear?: number; birthMonth?: number; unitSystem?: number } | null {
  const changes: Record<string, number> = {};

  if (current.sex !== undefined && current.sex !== previous.sex) {
    changes.sex = current.sex === 'male' ? 1 : 2;
  }
  if (current.birthYear !== undefined && current.birthYear !== previous.birthYear) {
    changes.birthYear = current.birthYear;
  }
  if (current.birthMonth !== undefined && current.birthMonth !== previous.birthMonth) {
    changes.birthMonth = current.birthMonth;
  }
  if (current.unitSystem !== undefined && current.unitSystem !== previous.unitSystem) {
    changes.unitSystem = current.unitSystem === 'si' ? 1 : 2;
  }

  return Object.keys(changes).length > 0 ? changes : null;
}
