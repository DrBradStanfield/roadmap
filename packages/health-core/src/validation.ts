import { z } from 'zod';

/**
 * Valid metric types for the health_measurements table.
 */
export const METRIC_TYPES = [
  'height', 'weight', 'waist',
  'hba1c', 'ldl', 'hdl', 'triglycerides', 'fasting_glucose',
  'systolic_bp', 'diastolic_bp',
  'sex', 'birth_year', 'birth_month',
  'unit_system',
] as const;

export type MetricTypeValue = typeof METRIC_TYPES[number];

/**
 * Schema for validating health inputs.
 *
 * ALL numeric values are in SI canonical units:
 *   height/waist: cm | weight: kg | BP: mmHg
 *   HbA1c: mmol/mol (IFCC) | lipids/glucose: mmol/L
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
  fastingGlucose: z
    .number()
    .min(0, 'Fasting glucose must be positive')
    .max(27.8, 'Fasting glucose must be at most 27.8 mmol/L')
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
 * Schema for a single measurement record (used by API endpoints).
 * Value is always in SI canonical units.
 */
export const measurementSchema = z.object({
  metricType: z.enum(METRIC_TYPES),
  value: z.number(),
  recordedAt: z.string().datetime().optional(), // defaults to now on server
});

export type ValidatedMeasurement = z.infer<typeof measurementSchema>;
