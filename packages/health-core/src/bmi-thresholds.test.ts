// US-64, lead A2-3: every BMI rule reads bmi-thresholds.ts. Here each cut-off
// is moved up by one, and every reader must move with it. A reader that grows
// its own literal back (25, 28, 30, ...) keeps the old line and fails here.
import { describe, it, expect, vi } from 'vitest';
import type { HealthInputs, HealthResults } from './types';
import { getBMICategory } from './calculations';
import { getBmiEvidence } from './evidence';
import { generateSuggestions, weightMedicationTrigger, REDUCE_ALCOHOL_ID } from './suggestions';
import { toCanonicalValue } from './units';

vi.mock('./bmi-thresholds', () => ({
  BMI_THRESHOLDS: { normal: 19.5, overweight: 26, obese: 31, obeseClass2: 36, obeseClass3: 41 },
  BMI_WEIGHT_MEDICINE_ALONE: 29,
}));

const inputs: HealthInputs = { heightCm: 175, sex: 'male' };
const resultsAt = (bmi: number, extra: Partial<HealthResults> = {}): HealthResults => {
  const r: HealthResults = { heightCm: 175, idealBodyWeight: 73.8, proteinTarget: 89, age: 40, suggestions: [], bmi, ...extra };
  return { ...r, bmiCategory: getBMICategory(bmi, r.waistToHeightRatio) };
};

describe('BMI rules all move with BMI_THRESHOLDS (US-64, A2-3)', () => {
  it.each([
    [19, 'Underweight'], [25.5, 'Normal'], [30.5, 'Overweight'], [35.5, 'Obese (Class I)'], [40.5, 'Obese (Class II)'],
  ])('getBMICategory(%s) is %s', (bmi, category) => {
    expect(getBMICategory(bmi)).toBe(category);
  });

  it('the evidence waist note follows the overweight band', () => {
    expect(getBmiEvidence(25.5, 'male').guidelines).toEqual([]);
    expect(getBmiEvidence(30.5, 'male').guidelines).toEqual(['AACE 2025']);
  });

  it('the weight-medicine trigger follows the overweight line and the alone line', () => {
    const prediabetic = { ...inputs, hba1c: toCanonicalValue('hba1c', 5.9, 'conventional') };
    expect(weightMedicationTrigger(prediabetic, resultsAt(25.5)).on).toBe(false);
    expect(weightMedicationTrigger(inputs, resultsAt(28.5)).on).toBe(false);
    expect(weightMedicationTrigger(inputs, resultsAt(29.5)).on).toBe(true);
  });

  it('the alcohol card follows the obese and overweight lines', () => {
    const alcohol = (r: HealthResults) => generateSuggestions(inputs, r).some((s) => s.id === REDUCE_ALCOHOL_ID);
    expect(alcohol(resultsAt(30.5))).toBe(false);
    expect(alcohol(resultsAt(25.5, { waistToHeightRatio: 0.55 }))).toBe(false);
    expect(alcohol(resultsAt(31))).toBe(true);
  });

  it('the Lp(a) checklist grades and names the moved lines', () => {
    const lpa = { ...inputs, lpa: 200 };
    const text = generateSuggestions(lpa, resultsAt(25.5), 'conventional').find((s) => s.id === 'lpa-elevated')?.description;
    expect(text).toContain('✅ BMI: 25.5 — target <26, or <31 with a healthy waist-to-height ratio');
  });
});
