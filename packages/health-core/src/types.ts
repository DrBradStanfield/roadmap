/**
 * Health input data from user.
 *
 * ALL numeric values are in SI canonical units:
 *   height/waist: cm | weight: kg | BP: mmHg
 *   HbA1c: mmol/mol (IFCC) | lipids/glucose: mmol/L
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
  hdlC?: number;        // mmol/L
  triglycerides?: number; // mmol/L
  fastingGlucose?: number; // mmol/L
  systolicBp?: number;  // mmHg
  diastolicBp?: number; // mmHg
  // User preference (stored as 1=si, 2=conventional in DB)
  unitSystem?: 'si' | 'conventional';
}

/**
 * Calculated health results
 */
export interface HealthResults {
  idealBodyWeight: number;
  proteinTarget: number;
  bmi?: number;
  waistToHeightRatio?: number;
  age?: number;
  suggestions: Suggestion[];
}

/**
 * A health suggestion to discuss with doctor
 */
export interface Suggestion {
  id: string;
  category: 'nutrition' | 'exercise' | 'bloodwork' | 'general';
  priority: 'info' | 'attention' | 'urgent';
  title: string;
  description: string;
  discussWithDoctor: boolean;
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
