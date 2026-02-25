import type { HealthInputs, HealthResults, MedicationInputs, ScreeningInputs } from './types';
import type { UnitSystem } from './units';
import { EGFR_THRESHOLDS, LPA_THRESHOLDS } from './units';
import { generateSuggestions } from './suggestions';

/**
 * Calculate Ideal Body Weight using the Peterson Formula (2016)
 * IBW = 2.2 × BMI_target + 3.5 × BMI_target × (height_m − 1.5)
 * Sex-specific target BMIs (mortality meta-analyses):
 * - Males: BMI 24 (optimal range 23-26)
 * - Females: BMI 22 (optimal range 20-23)
 */
export function calculateIBW(heightCm: number, sex: 'male' | 'female'): number {
  const bmiTarget = sex === 'male' ? 24 : 22;
  const heightM = heightCm / 100;
  const ibw = 2.2 * bmiTarget + 3.5 * bmiTarget * (heightM - 1.5);
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
 * Calculate eGFR using the CKD-EPI 2021 equation (race-free).
 * Creatinine input is in µmol/L (SI canonical). Internally converted to mg/dL.
 * Returns eGFR in mL/min/1.73m².
 */
export function calculateEGFR(creatinineUmolL: number, age: number, sex: 'male' | 'female'): number {
  const cr = creatinineUmolL / 88.4; // convert to mg/dL

  if (sex === 'female') {
    const kappa = 0.7;
    const alpha = cr <= kappa ? -0.241 : -1.200;
    return 142 * Math.pow(cr / kappa, alpha) * Math.pow(0.9938, age) * 1.012;
  } else {
    const kappa = 0.9;
    const alpha = cr <= kappa ? -0.302 : -1.200;
    return 142 * Math.pow(cr / kappa, alpha) * Math.pow(0.9938, age);
  }
}

/**
 * Get BMI category, optionally adjusted by waist-to-height ratio.
 * Per AACE 2025 / NICE guidelines, BMI 25-29.9 with healthy WHtR (< 0.5)
 * is reclassified as "Normal" since central adiposity is absent.
 */
export function getBMICategory(bmi: number, waistToHeightRatio?: number): string {
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Normal';
  if (bmi < 30) {
    if (waistToHeightRatio !== undefined && waistToHeightRatio < 0.5) return 'Normal';
    return 'Overweight';
  }
  if (bmi < 35) return 'Obese (Class I)';
  if (bmi < 40) return 'Obese (Class II)';
  return 'Obese (Class III)';
}

/**
 * Get eGFR status label.
 * Uses CKD staging: Normal (≥70), Low Normal (60-69), Mildly Decreased (45-59),
 * Moderately Decreased (30-44), Severely Decreased (15-29), Kidney Failure (<15).
 */
export function getEgfrStatus(egfr: number): string {
  if (egfr >= 70) return 'Normal';
  if (egfr >= EGFR_THRESHOLDS.lowNormal) return 'Low Normal';
  if (egfr >= EGFR_THRESHOLDS.mildlyDecreased) return 'Mildly Decreased';
  if (egfr >= EGFR_THRESHOLDS.moderatelyDecreased) return 'Moderately Decreased';
  if (egfr >= EGFR_THRESHOLDS.severelyDecreased) return 'Severely Decreased';
  return 'Kidney Failure';
}

/**
 * Get Lp(a) status label.
 * Normal (<75 nmol/L), Borderline (75-124), Elevated (≥125).
 */
export function getLpaStatus(lpa: number): string {
  if (lpa >= LPA_THRESHOLDS.elevated) return 'Elevated';
  if (lpa >= LPA_THRESHOLDS.normal) return 'Borderline';
  return 'Normal';
}

/**
 * Get lipid status label from a value and its thresholds.
 * Works for ApoB (2-tier), Non-HDL, LDL, triglycerides (3-tier with veryHigh).
 */
export function getLipidStatus(value: number, thresholds: { borderline: number; high: number; veryHigh?: number }): string {
  if (thresholds.veryHigh !== undefined && value >= thresholds.veryHigh) return 'Very High';
  if (value >= thresholds.high) return 'High';
  if (value >= thresholds.borderline) return 'Borderline';
  return 'Optimal';
}

/**
 * Get protein intake rate per kg IBW based on kidney function.
 * CKD Stage 3b+ (eGFR < 45): 1.0g/kg; otherwise 1.2g/kg.
 */
export function getProteinRate(eGFR?: number): number {
  return eGFR !== undefined && eGFR < EGFR_THRESHOLDS.mildlyDecreased ? 1.0 : 1.2;
}

/**
 * Main calculation function - takes all inputs and returns all results
 */
export function calculateHealthResults(inputs: HealthInputs, unitSystem?: UnitSystem, medications?: MedicationInputs, screenings?: ScreeningInputs): HealthResults {
  // Calculate ideal body weight and protein target (always available with height + sex)
  const ibw = calculateIBW(inputs.heightCm, inputs.sex);
  const proteinTarget = calculateProteinTarget(ibw);

  const results: HealthResults = {
    heightCm: inputs.heightCm,
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

  // Calculate non-HDL cholesterol if both total and HDL are provided
  if (inputs.totalCholesterol !== undefined && inputs.hdlC !== undefined) {
    const nonHdl = inputs.totalCholesterol - inputs.hdlC;
    results.nonHdlCholesterol = Math.round(nonHdl * 10) / 10;
  }

  // Pass through lipid values for snapshot tile cascade
  if (inputs.apoB !== undefined) {
    results.apoB = inputs.apoB;
  }
  if (inputs.ldlC !== undefined) {
    results.ldlC = inputs.ldlC;
  }
  if (inputs.lpa !== undefined) {
    results.lpa = inputs.lpa;
  }

  // Calculate age if birth year is provided (default to January if month not set)
  if (inputs.birthYear) {
    results.age = calculateAge(inputs.birthYear, inputs.birthMonth ?? 1);
  }

  // Calculate eGFR if creatinine + age + sex are available
  if (inputs.creatinine !== undefined && results.age !== undefined) {
    results.eGFR = Math.round(calculateEGFR(inputs.creatinine, results.age, inputs.sex));
  }

  // Adjust protein target for CKD Stage 3b+ (eGFR < 45): 1.0g/kg instead of 1.2g/kg
  if (results.eGFR !== undefined && results.eGFR < EGFR_THRESHOLDS.mildlyDecreased) {
    results.proteinTarget = Math.round(ibw * 1.0);
  }

  // Generate personalized suggestions based on all inputs and results
  results.suggestions = generateSuggestions(inputs, results, unitSystem, medications, screenings);

  return results;
}
