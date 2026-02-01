/**
 * Shared mappings between HealthInputs fields and measurement metric types.
 *
 * Used by both the storefront widget and customer account extension
 * to convert between API measurement records and HealthInputs objects.
 */
import type { HealthInputs } from './types';
import type { MetricType } from './units';

/**
 * Maps HealthInputs field names to metric_type values used in the
 * health_measurements table and API.
 */
export const FIELD_TO_METRIC: Record<string, string> = {
  heightCm: 'height',
  weightKg: 'weight',
  waistCm: 'waist',
  hba1c: 'hba1c',
  ldlC: 'ldl',
  hdlC: 'hdl',
  triglycerides: 'triglycerides',
  fastingGlucose: 'fasting_glucose',
  systolicBp: 'systolic_bp',
  diastolicBp: 'diastolic_bp',
  sex: 'sex',
  birthYear: 'birth_year',
  birthMonth: 'birth_month',
};

/** Reverse mapping: metric_type → HealthInputs field name. */
export const METRIC_TO_FIELD: Record<string, keyof HealthInputs> = {
  height: 'heightCm',
  weight: 'weightKg',
  waist: 'waistCm',
  hba1c: 'hba1c',
  ldl: 'ldlC',
  hdl: 'hdlC',
  triglycerides: 'triglycerides',
  fasting_glucose: 'fastingGlucose',
  systolic_bp: 'systolicBp',
  diastolic_bp: 'diastolicBp',
  sex: 'sex',
  birth_year: 'birthYear',
  birth_month: 'birthMonth',
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
  hdlC: 'hdl',
  triglycerides: 'triglycerides',
  fastingGlucose: 'fasting_glucose',
  systolicBp: 'systolic_bp',
  diastolicBp: 'diastolic_bp',
};

/** API measurement record shape (camelCase, as returned by API endpoints). */
export interface ApiMeasurement {
  id: string;
  metricType: string;
  value: number;
  recordedAt: string;
  createdAt: string;
}

/**
 * Convert API measurement records into a partial HealthInputs object.
 * Sex is stored as numeric (1=male, 2=female) and converted back.
 */
export function measurementsToInputs(measurements: ApiMeasurement[]): Partial<HealthInputs> {
  const inputs: Partial<HealthInputs> = {};

  for (const m of measurements) {
    const field = METRIC_TO_FIELD[m.metricType];
    if (!field) continue;

    if (field === 'sex') {
      (inputs as any).sex = m.value === 1 ? 'male' : 'female';
    } else {
      (inputs as any)[field] = m.value;
    }
  }

  return inputs;
}

/**
 * Determine which fields changed and return them as metric/value pairs
 * ready for the API. Sex is encoded as 1=male, 2=female.
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
      const value =
        field === 'sex'
          ? currentVal === 'male' ? 1 : 2
          : (currentVal as number);
      changes.push({ metricType, value });
    }
  }

  return changes;
}
