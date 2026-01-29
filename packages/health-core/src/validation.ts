import { z } from 'zod';

/**
 * Schema for validating health inputs
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

  // Blood test values (optional)
  hba1c: z
    .number()
    .min(3, 'HbA1c must be at least 3%')
    .max(20, 'HbA1c must be at most 20%')
    .optional(),
  ldlC: z
    .number()
    .min(0, 'LDL must be positive')
    .max(500, 'LDL must be at most 500 mg/dL')
    .optional(),
  hdlC: z
    .number()
    .min(0, 'HDL must be positive')
    .max(200, 'HDL must be at most 200 mg/dL')
    .optional(),
  triglycerides: z
    .number()
    .min(0, 'Triglycerides must be positive')
    .max(2000, 'Triglycerides must be at most 2000 mg/dL')
    .optional(),
  fastingGlucose: z
    .number()
    .min(0, 'Fasting glucose must be positive')
    .max(500, 'Fasting glucose must be at most 500 mg/dL')
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
 * Schema for a single blood test record
 */
export const bloodTestSchema = z.object({
  testDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  hba1c: z.number().min(3).max(20).optional(),
  ldlC: z.number().min(0).max(500).optional(),
  hdlC: z.number().min(0).max(200).optional(),
  triglycerides: z.number().min(0).max(2000).optional(),
  fastingGlucose: z.number().min(0).max(500).optional(),
  systolicBp: z.number().min(60).max(250).optional(),
  diastolicBp: z.number().min(40).max(150).optional(),
});

export type ValidatedBloodTest = z.infer<typeof bloodTestSchema>;
