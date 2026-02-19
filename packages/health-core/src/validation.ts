import { z } from 'zod';
import { UNIT_DEFS, UnitSystem, MetricType } from './units';
import { FIELD_METRIC_MAP } from './mappings';

/**
 * Valid metric types for the health_measurements table.
 */
export const METRIC_TYPES = [
  'weight', 'waist',
  'hba1c', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides',
  'systolic_bp', 'diastolic_bp', 'apob', 'creatinine', 'psa', 'lpa',
] as const;

export type MetricTypeValue = typeof METRIC_TYPES[number];

/**
 * Schema for validating health inputs.
 *
 * ALL numeric values are in SI canonical units:
 *   height/waist: cm | weight: kg | BP: mmHg
 *   HbA1c: mmol/mol (IFCC) | lipids: mmol/L
 */
export const healthInputSchema = z.object({
  // Required fields
  heightCm: z
    .number()
    .min(50, 'Height must be at least 50 cm')
    .max(250, 'Height must be at most 250 cm'),
  sex: z.enum(['male', 'female'], {
    errorMap: () => ({ message: 'Please select male or female' }),
  }),

  // Optional body measurements
  weightKg: z
    .number()
    .min(20, 'Weight must be at least 20 kg')
    .max(300, 'Weight must be at most 300 kg')
    .optional(),
  waistCm: z
    .number()
    .min(40, 'Waist must be at least 40 cm')
    .max(200, 'Waist must be at most 200 cm')
    .optional(),

  // Optional birth info
  birthYear: z
    .number()
    .min(1900, 'Birth year must be after 1900')
    .max(new Date().getFullYear(), 'Birth year cannot be in the future')
    .optional(),
  birthMonth: z
    .number()
    .min(1, 'Month must be between 1 and 12')
    .max(12, 'Month must be between 1 and 12')
    .optional(),

  // Blood test values — SI canonical units
  hba1c: z
    .number()
    .min(9, 'HbA1c must be at least 9 mmol/mol')
    .max(195, 'HbA1c must be at most 195 mmol/mol')
    .optional(),
  ldlC: z
    .number()
    .min(0, 'LDL must be positive')
    .max(12.9, 'LDL must be at most 12.9 mmol/L')
    .optional(),
  totalCholesterol: z
    .number()
    .min(0, 'Total cholesterol must be positive')
    .max(15, 'Total cholesterol must be at most 15 mmol/L')
    .optional(),
  hdlC: z
    .number()
    .min(0, 'HDL must be positive')
    .max(5.2, 'HDL must be at most 5.2 mmol/L')
    .optional(),
  triglycerides: z
    .number()
    .min(0, 'Triglycerides must be positive')
    .max(22.6, 'Triglycerides must be at most 22.6 mmol/L')
    .optional(),
  apoB: z
    .number()
    .min(0, 'ApoB must be positive')
    .max(3, 'ApoB must be at most 3 g/L')
    .optional(),
  creatinine: z
    .number()
    .min(10, 'Creatinine must be at least 10 µmol/L')
    .max(2650, 'Creatinine must be at most 2650 µmol/L')
    .optional(),
  psa: z
    .number()
    .min(0, 'PSA must be positive')
    .max(100, 'PSA must be at most 100 ng/mL')
    .optional(),
  lpa: z
    .number()
    .min(0, 'Lp(a) must be positive')
    .max(750, 'Lp(a) must be at most 750 nmol/L')
    .optional(),
  systolicBp: z
    .number()
    .min(60, 'Systolic BP must be at least 60 mmHg')
    .max(250, 'Systolic BP must be at most 250 mmHg')
    .optional(),
  diastolicBp: z
    .number()
    .min(40, 'Diastolic BP must be at least 40 mmHg')
    .max(150, 'Diastolic BP must be at most 150 mmHg')
    .optional(),
});

/**
 * Type inferred from the schema
 */
export type ValidatedHealthInputs = z.infer<typeof healthInputSchema>;

/**
 * Validate health inputs and return result
 */
export function validateHealthInputs(data: unknown): {
  success: boolean;
  data?: ValidatedHealthInputs;
  errors?: z.ZodError;
} {
  const result = healthInputSchema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return { success: false, errors: result.error };
}

/**
 * Get human-readable error messages from validation result
 */
export function getValidationErrors(errors: z.ZodError): Record<string, string> {
  const errorMap: Record<string, string> = {};

  for (const issue of errors.issues) {
    const path = issue.path.join('.');
    if (!errorMap[path]) {
      errorMap[path] = issue.message;
    }
  }

  return errorMap;
}

/**
 * Valid measurement sources for the health_measurements table.
 * Tracks where the measurement came from (for Apple HealthKit deduplication, etc.)
 */
export const MEASUREMENT_SOURCES = ['manual', 'apple_health', 'fitbit', 'lab_import'] as const;

/**
 * Schema for a single measurement record (used by API endpoints).
 * Value is always in SI canonical units.
 */
export const measurementSchema = z.object({
  metricType: z.enum(METRIC_TYPES),
  value: z.number(),
  recordedAt: z.string().datetime().optional(), // defaults to now on server
  source: z.enum(MEASUREMENT_SOURCES).optional(), // defaults to 'manual' in DB
  externalId: z.string().max(200).optional(), // external system ID (e.g. HealthKit sample UUID)
});

export type ValidatedMeasurement = z.infer<typeof measurementSchema>;

/**
 * Schema for updating profile demographics.
 * All fields are optional integers with the same encoding as the DB.
 */
export const profileUpdateSchema = z.object({
  sex: z.number().int().min(1).max(2).optional(),
  birthYear: z
    .number()
    .int()
    .min(1900, 'Birth year must be after 1900')
    .max(new Date().getFullYear(), 'Birth year cannot be in the future')
    .optional(),
  birthMonth: z
    .number()
    .int()
    .min(1, 'Month must be between 1 and 12')
    .max(12, 'Month must be between 1 and 12')
    .optional(),
  unitSystem: z.number().int().min(1).max(2).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  height: z.number().min(50).max(250).optional(),
});

export type ValidatedProfileUpdate = z.infer<typeof profileUpdateSchema>;

/**
 * Valid medication keys for the medications table.
 */
export const MEDICATION_KEYS = [
  'statin', 'ezetimibe', 'statin_escalation', 'pcsk9i',
  'glp1', 'glp1_escalation', 'sglt2i', 'metformin',
] as const;

/**
 * Valid statin drug names.
 */
export const STATIN_DRUG_NAMES = ['atorvastatin', 'pitavastatin', 'pravastatin', 'rosuvastatin', 'simvastatin', 'none', 'not_tolerated'] as const;

/**
 * Schema for validating a medication upsert request (FHIR-compatible).
 */
export const medicationSchema = z.object({
  medicationKey: z.enum(MEDICATION_KEYS),
  drugName: z.string().min(1, 'Drug name is required').max(100),
  doseValue: z.number().positive().nullable().optional(),
  doseUnit: z.string().max(20).nullable().optional(),
});

export type ValidatedMedication = z.infer<typeof medicationSchema>;

/**
 * Valid screening keys for the screenings table.
 */
export const SCREENING_KEYS = [
  'colorectal_method', 'colorectal_last_date',
  'colorectal_result', 'colorectal_followup_status', 'colorectal_followup_date',
  'breast_frequency', 'breast_last_date',
  'breast_result', 'breast_followup_status', 'breast_followup_date',
  'cervical_method', 'cervical_last_date',
  'cervical_result', 'cervical_followup_status', 'cervical_followup_date',
  'lung_smoking_history', 'lung_pack_years', 'lung_screening', 'lung_last_date',
  'lung_result', 'lung_followup_status', 'lung_followup_date',
  'prostate_discussion', 'prostate_psa_value', 'prostate_last_date',
  'endometrial_discussion', 'endometrial_abnormal_bleeding',
  'dexa_screening', 'dexa_last_date', 'dexa_result',
  'dexa_followup_status', 'dexa_followup_date',
] as const;

/**
 * Schema for validating a screening upsert request.
 */
export const screeningSchema = z.object({
  screeningKey: z.enum(SCREENING_KEYS),
  value: z.string().min(1, 'Screening value is required').max(500),
});

export type ValidatedScreening = z.infer<typeof screeningSchema>;

// ---------------------------------------------------------------------------
// Unit-aware error message conversion
// ---------------------------------------------------------------------------

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a single validation error message from SI units to the user's display units.
 */
function convertErrorMessage(
  field: string,
  message: string,
  unitSystem: UnitSystem
): string {
  // Get the metric type for this field
  const metricType = FIELD_METRIC_MAP[field as keyof typeof FIELD_METRIC_MAP];
  if (!metricType) {
    return message; // Field not mapped, return as-is
  }

  const unitDef = UNIT_DEFS[metricType];
  if (!unitDef) {
    return message; // No unit definition, return as-is
  }

  const siLabel = unitDef.label.si;
  const convLabel = unitDef.label[unitSystem];
  const decimals = unitDef.decimalPlaces[unitSystem];
  const fromCanonical = unitDef.fromCanonical[unitSystem];

  // Pattern: "Value must be at least X unit" or "Value must be at most X unit"
  // Match numbers followed by the SI unit label
  const regex = new RegExp(`(\\d+\\.?\\d*)\\s*${escapeRegex(siLabel)}`, 'g');

  return message.replace(regex, (_match, value) => {
    const siValue = parseFloat(value);
    const convValue = fromCanonical(siValue);
    // Format with appropriate decimal places
    const formatted = decimals === 0
      ? Math.round(convValue).toString()
      : convValue.toFixed(decimals);
    return `${formatted} ${convLabel}`;
  });
}

/**
 * Convert validation error messages from SI units to the user's display units.
 *
 * When the user is in US (conventional) mode, error messages like
 * "Weight must be at least 20 kg" will be converted to
 * "Weight must be at least 44 lbs".
 *
 * @param errors - Record of field names to error messages
 * @param unitSystem - The user's current unit system ('si' or 'conventional')
 * @returns Record with error messages converted to the appropriate units
 */
export function convertValidationErrorsToUnits(
  errors: Record<string, string>,
  unitSystem: UnitSystem
): Record<string, string> {
  if (unitSystem === 'si') {
    return errors; // No conversion needed for SI units
  }

  const converted: Record<string, string> = {};

  for (const [field, message] of Object.entries(errors)) {
    converted[field] = convertErrorMessage(field, message, unitSystem);
  }

  return converted;
}
