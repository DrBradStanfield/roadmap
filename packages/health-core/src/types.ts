/**
 * Health input data from user
 */
export interface HealthInputs {
  heightCm: number;
  weightKg?: number;
  waistCm?: number;
  sex: 'male' | 'female';
  birthYear?: number;
  birthMonth?: number;
  // Blood test values
  hba1c?: number;
  ldlC?: number;
  hdlC?: number;
  triglycerides?: number;
  fastingGlucose?: number;
  systolicBp?: number;
  diastolicBp?: number;
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
 * Stored health profile (for database)
 */
export interface StoredHealthProfile {
  id: string;
  userId: string;
  heightCm: number | null;
  weightKg: number | null;
  waistCm: number | null;
  sex: 'male' | 'female' | null;
  birthYear: number | null;
  birthMonth: number | null;
  updatedAt: string;
}

/**
 * Stored blood test record (for database)
 */
export interface StoredBloodTest {
  id: string;
  userId: string;
  testDate: string;
  hba1c: number | null;
  ldlC: number | null;
  hdlC: number | null;
  triglycerides: number | null;
  fastingGlucose: number | null;
  systolicBp: number | null;
  diastolicBp: number | null;
  createdAt: string;
}
