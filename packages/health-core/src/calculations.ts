import type { HealthInputs, HealthResults } from './types';
import type { UnitSystem } from './units';
import { generateSuggestions } from './suggestions';

/**
 * Calculate Ideal Body Weight using the Devine Formula
 * - Males: 50 kg + 0.91 × (height - 152.4 cm)
 * - Females: 45.5 kg + 0.91 × (height - 152.4 cm)
 */
export function calculateIBW(heightCm: number, sex: 'male' | 'female'): number {
  const baseWeight = sex === 'male' ? 50 : 45.5;
  const ibw = baseWeight + 0.91 * (heightCm - 152.4);
  // Ensure IBW is at least a reasonable minimum
  return Math.max(ibw, 30);
}

/**
 * Calculate daily protein target
 * 1.2g per kg of ideal body weight
 */
export function calculateProteinTarget(ibwKg: number): number {
  return Math.round(ibwKg * 1.2);
}

/**
 * Calculate Body Mass Index
 * BMI = weight (kg) / height (m)²
 */
export function calculateBMI(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100;
  return weightKg / (heightM * heightM);
}

/**
 * Calculate waist-to-height ratio
 * Values > 0.5 indicate increased metabolic risk
 */
export function calculateWaistToHeight(waistCm: number, heightCm: number): number {
  return waistCm / heightCm;
}

/**
 * Calculate age from birth year and month
 */
export function calculateAge(birthYear: number, birthMonth: number): number {
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1; // getMonth() is 0-indexed

  let age = currentYear - birthYear;

  // If birthday hasn't occurred yet this year, subtract 1
  if (currentMonth < birthMonth) {
    age--;
  }

  return Math.max(age, 0);
}

/**
 * Get BMI category
 */
export function getBMICategory(bmi: number): string {
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Normal';
  if (bmi < 30) return 'Overweight';
  if (bmi < 35) return 'Obese (Class I)';
  if (bmi < 40) return 'Obese (Class II)';
  return 'Obese (Class III)';
}

/**
 * Main calculation function - takes all inputs and returns all results
 */
export function calculateHealthResults(inputs: HealthInputs, unitSystem?: UnitSystem): HealthResults {
  // Calculate ideal body weight and protein target (always available with height + sex)
  const ibw = calculateIBW(inputs.heightCm, inputs.sex);
  const proteinTarget = calculateProteinTarget(ibw);

  const results: HealthResults = {
    idealBodyWeight: Math.round(ibw * 10) / 10,
    proteinTarget,
    suggestions: [],
  };

  // Calculate BMI if weight is provided
  if (inputs.weightKg) {
    const bmi = calculateBMI(inputs.weightKg, inputs.heightCm);
    results.bmi = Math.round(bmi * 10) / 10;
  }

  // Calculate waist-to-height ratio if waist is provided
  if (inputs.waistCm) {
    const ratio = calculateWaistToHeight(inputs.waistCm, inputs.heightCm);
    results.waistToHeightRatio = Math.round(ratio * 100) / 100;
  }

  // Calculate age if birth info is provided
  if (inputs.birthYear && inputs.birthMonth) {
    results.age = calculateAge(inputs.birthYear, inputs.birthMonth);
  }

  // Generate personalized suggestions based on all inputs and results
  results.suggestions = generateSuggestions(inputs, results, unitSystem);

  return results;
}
