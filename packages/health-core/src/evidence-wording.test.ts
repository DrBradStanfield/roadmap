// US-07 AC9: the "why" texts say what their sources show (issues 473, 474, 475).
import { describe, expect, it } from 'vitest';
import { generateSuggestions } from './suggestions';
import { STAT_CARD_EVIDENCE, getIbwEvidence } from './evidence';
import { getBMICategory } from './calculations';
import { toCanonicalValue } from './units';
import type { HealthInputs, HealthResults } from './types';

describe('US-07 AC9: SGLT2 inhibitor card (issue 473)', () => {
  // Austin's case: no diabetes, no heart failure, on tirzepatide at its highest dose.
  const inputs: HealthInputs = { heightCm: 178, sex: 'male', hba1c: 36, triglycerides: toCanonicalValue('triglycerides', 177, 'conventional') };
  const results: HealthResults = { heightCm: 178, idealBodyWeight: 76, proteinTarget: 91, age: 50, bmi: 27, bmiCategory: getBMICategory(27), suggestions: [] };
  const card = generateSuggestions(inputs, results, 'si', { glp1: { drug: 'tirzepatide', dose: 15 } })
    .find((s) => s.id === 'weight-med-sglt2i');

  it('names the trial populations and does not claim the benefit outside them', () => {
    expect(card).toBeDefined();
    expect(card!.reason).not.toMatch(/proven cardiovascular and kidney protection/);
    expect(card!.reason).toContain('type 2 diabetes at high cardiovascular risk, or with heart failure');
    expect(card!.reason).toContain('Those trials did not study people without these conditions, so for them this heart benefit is not proven.');
    expect(card!.reason).toContain('Weight loss on them is modest.');
    expect(card!.reason).not.toMatch(/kidney protection/);
  });
});

describe('US-07 AC9: eGFR card (issue 474)', () => {
  const { reason, references } = STAT_CARD_EVIDENCE['egfr'];

  it("calls the labels the tool's own and gives KDIGO's names beside its categories", () => {
    expect(reason).toContain("These labels are the tool's own.");
    expect(reason).toContain('G3a (45-59) mildly to moderately decreased');
    expect(reason).toContain('G3b (30-44) moderately to severely decreased');
    // The old text put a KDIGO stage beside a name KDIGO does not use.
    expect(reason).not.toMatch(/Mildly Decreased \(Stage 3a\)|Moderately Decreased \(Stage 3b\)/);
  });

  it('cites the KDIGO guideline it is tagged with', () => {
    expect(references.map((r) => r.url)).toContain('https://doi.org/10.1016/j.kint.2023.10.018');
  });
});

describe('US-07 AC9: ideal body weight card (issue 475)', () => {
  it.each(['male', 'female'] as const)('for %s: sex enters only through the target BMI; Devine is the sex-specific one', (sex) => {
    const { reason } = getIbwEvidence(sex);
    expect(reason).not.toMatch(/Peterson formula accounts for both sex and height/);
    expect(reason).toContain('The Peterson formula has no sex term');
    expect(reason).toContain('sex enters only through the target BMI');
    expect(reason).toContain('a fixed weight for men and for women');
  });
});
