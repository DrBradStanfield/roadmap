import { describe, it, expect } from 'vitest';
import { generateSuggestions, weightMedicationTrigger, lipidMarkerFor, joinWithAnd } from './suggestions';
import { LIPID_TREATMENT_TARGETS, NON_HDL_THRESHOLDS, type UnitSystem } from './units';
import type { HealthInputs, HealthResults, MedicationInputs, ScreeningInputs } from './types';
import { canIncreaseGlp1Dose, shouldSuggestGlp1Switch } from './types';
import { toCanonicalValue } from './units';
import { calculateHealthResults, getBMICategory, getLipidStatus } from './calculations';

// Shorthand: convert conventional (US) blood test values to SI for test inputs
const hba1c = (pct: number) => toCanonicalValue('hba1c', pct, 'conventional');
const ldl = (mgdl: number) => toCanonicalValue('ldl', mgdl, 'conventional');
const hdl = (mgdl: number) => toCanonicalValue('hdl', mgdl, 'conventional');
const trig = (mgdl: number) => toCanonicalValue('triglycerides', mgdl, 'conventional');
const totalChol = (mgdl: number) => toCanonicalValue('total_cholesterol', mgdl, 'conventional');
const apoB = (mgdl: number) => toCanonicalValue('apob', mgdl, 'conventional');

// Helper to create base inputs and results
function createTestData(
  overrides: Partial<HealthInputs> = {},
  resultOverrides: Partial<HealthResults> = {}
): { inputs: HealthInputs; results: HealthResults } {
  const inputs: HealthInputs = {
    heightCm: 175,
    sex: 'male',
    ...overrides,
  };

  const results: HealthResults = {
    heightCm: 175,
    idealBodyWeight: 73.8,
    proteinTarget: 89,
    suggestions: [],
    ...resultOverrides,
  };

  // Auto-compute bmiCategory to match calculateHealthResults() behavior
  if (results.bmi !== undefined && results.bmiCategory === undefined) {
    results.bmiCategory = getBMICategory(results.bmi, results.waistToHeightRatio);
  }

  return { inputs, results };
}

describe('generateSuggestions', () => {
  describe('Protein target suggestion', () => {
    it('always includes protein target suggestion', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);

      const proteinSuggestion = suggestions.find(s => s.id === 'protein-target');
      expect(proteinSuggestion).toBeDefined();
      expect(proteinSuggestion?.priority).toBe('info');
      expect(proteinSuggestion?.category).toBe('nutrition');
      expect(proteinSuggestion?.title).toContain('89g');
    });
  });

  describe('BMI suggestions', () => {
    it('does not generate BMI suggestion cards (status shown on snapshot tile)', () => {
      const { inputs: i1, results: r1 } = createTestData({}, { bmi: 17.5 });
      const { inputs: i2, results: r2 } = createTestData({}, { bmi: 27.5 });
      const { inputs: i3, results: r3 } = createTestData({}, { bmi: 32 });

      expect(generateSuggestions(i1, r1).filter(s => s.id.startsWith('bmi-')).length).toBe(0);
      expect(generateSuggestions(i2, r2).filter(s => s.id.startsWith('bmi-')).length).toBe(0);
      expect(generateSuggestions(i3, r3).filter(s => s.id.startsWith('bmi-')).length).toBe(0);
    });
  });

  describe('Waist-to-height ratio suggestions', () => {
    it('does not generate waist-to-height suggestion card (status shown on snapshot tile)', () => {
      const { inputs, results } = createTestData({}, { waistToHeightRatio: 0.55 });
      const suggestions = generateSuggestions(inputs, results);

      const waistSuggestion = suggestions.find(s => s.id === 'waist-height-elevated');
      expect(waistSuggestion).toBeUndefined();
    });
  });

  describe('HbA1c suggestions', () => {
    it('generates diabetic suggestion for HbA1c >= 6.5% (≥47.5 mmol/mol)', () => {
      const { inputs, results } = createTestData({ hba1c: hba1c(7.2) });
      const suggestions = generateSuggestions(inputs, results);

      const hba1cSuggestion = suggestions.find(s => s.id === 'hba1c-diabetic');
      expect(hba1cSuggestion).toBeDefined();
      expect(hba1cSuggestion?.priority).toBe('urgent');
    });

    it('generates prediabetic suggestion for HbA1c 5.7-6.4% (38.8-47.5 mmol/mol)', () => {
      const { inputs, results } = createTestData({ hba1c: hba1c(6.0) });
      const suggestions = generateSuggestions(inputs, results);

      const hba1cSuggestion = suggestions.find(s => s.id === 'hba1c-prediabetic');
      expect(hba1cSuggestion).toBeDefined();
      expect(hba1cSuggestion?.priority).toBe('attention');
    });

    it('generates normal suggestion for HbA1c < 5.7% (<38.8 mmol/mol)', () => {
      const { inputs, results } = createTestData({ hba1c: hba1c(5.2) });
      const suggestions = generateSuggestions(inputs, results);

      const hba1cSuggestion = suggestions.find(s => s.id === 'hba1c-normal');
      expect(hba1cSuggestion).toBeDefined();
      expect(hba1cSuggestion?.priority).toBe('info');
    });
  });

  describe('LDL cholesterol suggestions', () => {
    it('generates very high suggestion for LDL >= 190 mg/dL (≥4.91 mmol/L)', () => {
      const { inputs, results } = createTestData({ ldlC: ldl(200) });
      const suggestions = generateSuggestions(inputs, results);

      const ldlSuggestion = suggestions.find(s => s.id === 'ldl-very-high');
      expect(ldlSuggestion).toBeDefined();
      expect(ldlSuggestion?.priority).toBe('urgent');
    });

    it('generates high suggestion for LDL 160-189 mg/dL (4.14-4.91 mmol/L)', () => {
      const { inputs, results } = createTestData({ ldlC: ldl(175) });
      const suggestions = generateSuggestions(inputs, results);

      const ldlSuggestion = suggestions.find(s => s.id === 'ldl-high');
      expect(ldlSuggestion).toBeDefined();
      expect(ldlSuggestion?.priority).toBe('attention');
    });

    it('generates borderline suggestion for LDL 130-159 mg/dL (3.36-4.14 mmol/L)', () => {
      const { inputs, results } = createTestData({ ldlC: ldl(140) });
      const suggestions = generateSuggestions(inputs, results);

      const ldlSuggestion = suggestions.find(s => s.id === 'ldl-borderline');
      expect(ldlSuggestion).toBeDefined();
      expect(ldlSuggestion?.priority).toBe('info');
    });

    // In mg/dL the line prints as 55: 54 mg/dL is 1.396 mmol/L, which the plan calls optimal.
    it('ldl-borderline names the 1.4 optimal line (US-07 AC5)', () => {
      const { inputs, results } = createTestData({ ldlC: 3.5 });
      expect(generateSuggestions(inputs, results).find(s => s.id === 'ldl-borderline')?.description)
        .toBe('Your LDL-c of 3.5 mmol/L is borderline high. Optimal is <1.4 mmol/L.');
      expect(generateSuggestions(inputs, results, 'conventional').find(s => s.id === 'ldl-borderline')?.description)
        .toBe('Your LDL-c of 135 mg/dL is borderline high. Optimal is <55 mg/dL.');
    });

    it('LDL 3.2 is above optimal but below borderline: no LDL card (US-07 AC5)', () => {
      const { inputs, results } = createTestData({ ldlC: 3.2 });
      expect(generateSuggestions(inputs, results).filter(s => s.id.startsWith('ldl-'))).toEqual([]);
    });

    it('does not generate suggestion for optimal LDL < 130 mg/dL (<3.36 mmol/L)', () => {
      const { inputs, results } = createTestData({ ldlC: ldl(90) });
      const suggestions = generateSuggestions(inputs, results);

      const ldlSuggestions = suggestions.filter(s => s.id.startsWith('ldl-'));
      expect(ldlSuggestions.length).toBe(0);
    });
  });

  describe('Total cholesterol suggestions', () => {
    it('generates high suggestion for total cholesterol >= 240 mg/dL', () => {
      const { inputs, results } = createTestData({ totalCholesterol: totalChol(250) });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'total-chol-high')).toBeDefined();
      expect(suggestions.find(s => s.id === 'total-chol-high')?.priority).toBe('attention');
    });

    it('generates borderline suggestion for total cholesterol 200-239 mg/dL', () => {
      const { inputs, results } = createTestData({ totalCholesterol: totalChol(220) });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'total-chol-borderline')).toBeDefined();
      expect(suggestions.find(s => s.id === 'total-chol-borderline')?.priority).toBe('info');
    });

    it('does not generate suggestion for desirable total cholesterol < 200 mg/dL', () => {
      const { inputs, results } = createTestData({ totalCholesterol: totalChol(180) });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.filter(s => s.id.startsWith('total-chol-')).length).toBe(0);
    });
  });

  describe('Non-HDL cholesterol suggestions (thresholds: 160/190/220 mg/dL = LDL + 30)', () => {
    it('generates very high suggestion for non-HDL >= 220 mg/dL', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(310), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(310) - hdl(50) } // 260 mg/dL
      );
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'non-hdl-very-high')).toBeDefined();
      expect(suggestions.find(s => s.id === 'non-hdl-very-high')?.priority).toBe('urgent');
    });

    it('generates high suggestion for non-HDL 190-219 mg/dL', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(250), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(250) - hdl(50) } // 200 mg/dL
      );
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'non-hdl-high')).toBeDefined();
      expect(suggestions.find(s => s.id === 'non-hdl-high')?.priority).toBe('attention');
    });

    it('generates borderline suggestion for non-HDL 160-189 mg/dL', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(220), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(220) - hdl(50) } // 170 mg/dL
      );
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'non-hdl-borderline')).toBeDefined();
      expect(suggestions.find(s => s.id === 'non-hdl-borderline')?.priority).toBe('info');
    });

    it('non-hdl-borderline names the 1.6 optimal line (US-07 AC5)', () => {
      const { inputs, results } = createTestData({}, { nonHdlCholesterol: 4.5 });
      expect(generateSuggestions(inputs, results).find(s => s.id === 'non-hdl-borderline')?.description)
        .toBe('Your non-HDL cholesterol of 4.5 mmol/L is borderline. Optimal is <1.6 mmol/L.');
    });

    it('does not generate suggestion for optimal non-HDL < 160 mg/dL', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(200), hdlC: hdl(60) },
        { nonHdlCholesterol: totalChol(200) - hdl(60) } // 140 mg/dL
      );
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.filter(s => s.id.startsWith('non-hdl-')).length).toBe(0);
    });
  });

  describe('HDL cholesterol suggestions', () => {
    it('generates low HDL suggestion for males with HDL < 40 mg/dL (<1.03 mmol/L)', () => {
      const { inputs, results } = createTestData({ hdlC: hdl(35), sex: 'male' });
      const suggestions = generateSuggestions(inputs, results);

      const hdlSuggestion = suggestions.find(s => s.id === 'hdl-low');
      expect(hdlSuggestion).toBeDefined();
    });

    it('generates low HDL suggestion for females with HDL < 50 mg/dL (<1.29 mmol/L)', () => {
      const { inputs, results } = createTestData({ hdlC: hdl(45), sex: 'female' });
      const suggestions = generateSuggestions(inputs, results);

      const hdlSuggestion = suggestions.find(s => s.id === 'hdl-low');
      expect(hdlSuggestion).toBeDefined();
    });

    it('does not generate suggestion for normal HDL', () => {
      const { inputs, results } = createTestData({ hdlC: hdl(55), sex: 'male' });
      const suggestions = generateSuggestions(inputs, results);

      const hdlSuggestion = suggestions.find(s => s.id === 'hdl-low');
      expect(hdlSuggestion).toBeUndefined();
    });

    it('displays threshold with enough precision to distinguish from user value (SI)', () => {
      // HDL = 1.0 mmol/L (≈38.67 mg/dL), threshold for males is ~1.034 mmol/L (40 mg/dL)
      // The displayed threshold must NOT round to "1.0" — would read "1.0 is below 1.0"
      const hdlSI = 1.0; // Already in SI (mmol/L)
      const { inputs, results } = createTestData({ hdlC: hdlSI, sex: 'male' });
      const suggestions = generateSuggestions(inputs, results, 'si');

      const hdlSuggestion = suggestions.find(s => s.id === 'hdl-low');
      expect(hdlSuggestion).toBeDefined();
      // Threshold should show as "1.03" not "1.0"
      expect(hdlSuggestion!.description).toContain('1.03');
      expect(hdlSuggestion!.description).not.toMatch(/\(1\.0 mmol/);
    });

    it('displays threshold correctly in conventional units', () => {
      const { inputs, results } = createTestData({ hdlC: hdl(35), sex: 'male' });
      const suggestions = generateSuggestions(inputs, results, 'conventional');

      const hdlSuggestion = suggestions.find(s => s.id === 'hdl-low');
      expect(hdlSuggestion).toBeDefined();
      expect(hdlSuggestion!.description).toContain('40 mg/dL');
    });
  });

  describe('Triglycerides suggestions', () => {
    // Nutrition suggestion (diet is first-line treatment for elevated trigs)
    it('generates nutrition suggestion with attention priority for borderline triglycerides', () => {
      const { inputs, results } = createTestData({ triglycerides: trig(160) });
      const suggestions = generateSuggestions(inputs, results);

      const nutritionSuggestion = suggestions.find(s => s.id === 'trig-nutrition');
      expect(nutritionSuggestion).toBeDefined();
      expect(nutritionSuggestion?.category).toBe('nutrition');
      expect(nutritionSuggestion?.priority).toBe('attention');
      expect(nutritionSuggestion?.description).toContain('limit alcohol');
      expect(nutritionSuggestion?.description).toContain('reduce sugar');
    });

    it('generates nutrition suggestion for high triglycerides', () => {
      const { inputs, results } = createTestData({ triglycerides: trig(250) });
      const suggestions = generateSuggestions(inputs, results);

      const nutritionSuggestion = suggestions.find(s => s.id === 'trig-nutrition');
      expect(nutritionSuggestion).toBeDefined();
      expect(nutritionSuggestion?.priority).toBe('attention');
    });

    it('generates nutrition suggestion for very high triglycerides', () => {
      const { inputs, results } = createTestData({ triglycerides: trig(550) });
      const suggestions = generateSuggestions(inputs, results);

      const nutritionSuggestion = suggestions.find(s => s.id === 'trig-nutrition');
      expect(nutritionSuggestion).toBeDefined();
      expect(nutritionSuggestion?.priority).toBe('attention');
    });

    it('does not generate nutrition suggestion for normal triglycerides', () => {
      const { inputs, results } = createTestData({ triglycerides: trig(120) });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'trig-nutrition')).toBeUndefined();
    });

    // Urgent bloodwork warning (pancreatitis risk at very high levels)
    it('generates urgent bloodwork warning for very high triglycerides (>= 500 mg/dL)', () => {
      const { inputs, results } = createTestData({ triglycerides: trig(550) });
      const suggestions = generateSuggestions(inputs, results);

      const trigSuggestion = suggestions.find(s => s.id === 'trig-very-high');
      expect(trigSuggestion).toBeDefined();
      expect(trigSuggestion?.priority).toBe('urgent');
    });

    it('does not generate bloodwork suggestion for high triglycerides (handled by nutrition)', () => {
      const { inputs, results } = createTestData({ triglycerides: trig(300) });
      const suggestions = generateSuggestions(inputs, results);

      expect(suggestions.find(s => s.id === 'trig-high')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'trig-nutrition')).toBeDefined();
    });

    it('does not generate bloodwork suggestion for borderline triglycerides (handled by nutrition)', () => {
      const { inputs, results } = createTestData({ triglycerides: trig(175) });
      const suggestions = generateSuggestions(inputs, results);

      expect(suggestions.find(s => s.id === 'trig-borderline')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'trig-nutrition')).toBeDefined();
    });
  });

  describe('Blood pressure suggestions', () => {
    it('generates crisis suggestion for BP >= 180/120', () => {
      const { inputs, results } = createTestData({ systolicBp: 185, diastolicBp: 125 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-crisis');
      expect(bpSuggestion).toBeDefined();
      expect(bpSuggestion?.priority).toBe('urgent');
    });

    it('generates stage 2 suggestion for BP >= 140/90', () => {
      const { inputs, results } = createTestData({ systolicBp: 145, diastolicBp: 95 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage2');
      expect(bpSuggestion).toBeDefined();
      expect(bpSuggestion?.priority).toBe('urgent');
    });

    it('generates stage 1 suggestion for BP >= 130/80', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion).toBeDefined();
      expect(bpSuggestion?.priority).toBe('attention');
    });

    it('does not generate suggestion for elevated BP 120-129/<80', () => {
      const { inputs, results } = createTestData({ systolicBp: 125, diastolicBp: 75 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestions = suggestions.filter(s => s.id.startsWith('bp-'));
      expect(bpSuggestions.length).toBe(0);
    });

    it('does not generate suggestion for BP 126/80 (diastolic 80 is not elevated)', () => {
      const { inputs, results } = createTestData({ systolicBp: 126, diastolicBp: 80 }, { age: 55 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestions = suggestions.filter(s => s.id.startsWith('bp-'));
      expect(bpSuggestions.length).toBe(0);
    });

    it('generates stage 1 for diastolic 81 when systolic is below 130', () => {
      const { inputs, results } = createTestData({ systolicBp: 126, diastolicBp: 81 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion).toBeDefined();
    });

    it('does not generate suggestion for normal BP < 120/80', () => {
      const { inputs, results } = createTestData({ systolicBp: 115, diastolicBp: 75 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestions = suggestions.filter(s => s.id.startsWith('bp-'));
      expect(bpSuggestions.length).toBe(0);
    });

    it('shows target <120/80 for stage 1 when age < 65', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { age: 55 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).toContain('Target is <120/80');
    });

    it('shows target <130/80 for stage 1 when age >= 65', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { age: 70 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).toContain('Target is <130/80');
    });

    it('triggers on systolic alone when diastolic is normal', () => {
      const { inputs, results } = createTestData({ systolicBp: 145, diastolicBp: 75 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage2');
      expect(bpSuggestion).toBeDefined();
    });

    it('triggers on diastolic alone when systolic is normal', () => {
      const { inputs, results } = createTestData({ systolicBp: 115, diastolicBp: 95 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage2');
      expect(bpSuggestion).toBeDefined();
    });

    it('stage 1 mentions sodium reduction', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).toContain('reduce sodium intake (<1,500mg/day)');
    });

    it('stage 2 mentions sodium reduction', () => {
      const { inputs, results } = createTestData({ systolicBp: 145, diastolicBp: 95 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage2');
      expect(bpSuggestion?.description).toContain('reduce sodium intake (<1,500mg/day)');
    });

    it('stage 1 mentions weight loss when BMI >= 30', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { bmi: 31 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).toContain('Weight loss is one of the most effective ways to lower blood pressure');
      expect(bpSuggestion?.description).toContain('GLP-1 medications');
    });

    it('stage 1 mentions weight loss when BMI 25-29.9 and WHtR >= 0.5', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { bmi: 27, waistToHeightRatio: 0.55 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).toContain('Weight loss');
    });

    it('stage 1 mentions weight loss when BMI 25-29.9 and WHtR < 0.5: the raised BP turns the trigger on (US-06 AC6)', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { bmi: 27, waistToHeightRatio: 0.45 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).toContain('Weight loss');
    });

    it('stage 1 mentions weight loss when BMI 25-29.9 and WHtR unavailable (US-06 AC6)', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { bmi: 27 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).toContain('Weight loss');
    });

    it('stage 1 does not mention weight loss when BMI < 25', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { bmi: 23 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).not.toContain('Weight loss');
    });

    it('stage 1 does not mention weight loss when BMI is undefined', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).not.toContain('Weight loss');
    });

    it('stage 1 mentions potassium when eGFR >= 45', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { eGFR: 60 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).toContain('potassium-rich foods');
    });

    it('stage 1 does not mention potassium when eGFR is undefined', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).not.toContain('potassium');
    });

    it('stage 1 does not mention potassium when eGFR < 45', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { eGFR: 30 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).not.toContain('potassium');
    });

    it('stage 2 mentions weight loss and potassium when both apply', () => {
      const { inputs, results } = createTestData({ systolicBp: 145, diastolicBp: 95 }, { bmi: 30, eGFR: 80 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage2');
      expect(bpSuggestion?.description).toContain('Weight loss');
      expect(bpSuggestion?.description).toContain('potassium-rich foods');
      expect(bpSuggestion?.description).toContain('Medication is typically recommended');
    });

    it('crisis does not include lifestyle advice', () => {
      const { inputs, results } = createTestData({ systolicBp: 185, diastolicBp: 125 }, { bmi: 30, eGFR: 80 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-crisis');
      expect(bpSuggestion?.description).not.toContain('sodium');
      expect(bpSuggestion?.description).not.toContain('Weight loss');
      expect(bpSuggestion?.description).not.toContain('potassium');
    });
  });

  describe('ApoB suggestions', () => {
    it('generates very high suggestion for ApoB >= 100 mg/dL', () => {
      const { inputs, results } = createTestData({ apoB: apoB(110) });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'apob-very-high')).toBeDefined();
      expect(suggestions.find(s => s.id === 'apob-very-high')?.priority).toBe('urgent');
    });

    it('generates high suggestion for ApoB 70-99 mg/dL', () => {
      const { inputs, results } = createTestData({ apoB: apoB(80) });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'apob-high')).toBeDefined();
      expect(suggestions.find(s => s.id === 'apob-high')?.priority).toBe('attention');
    });

    it('generates borderline suggestion for ApoB 50-69 mg/dL', () => {
      const { inputs, results } = createTestData({ apoB: apoB(60) });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'apob-borderline')).toBeDefined();
      expect(suggestions.find(s => s.id === 'apob-borderline')?.priority).toBe('info');
    });

    it('does not generate suggestion for optimal ApoB < 50 mg/dL', () => {
      const { inputs, results } = createTestData({ apoB: apoB(40) });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.filter(s => s.id.startsWith('apob-')).length).toBe(0);
    });

    it('formats ApoB in conventional units', () => {
      const { inputs, results } = createTestData({ apoB: apoB(110) });
      const suggestions = generateSuggestions(inputs, results, 'conventional');
      expect(suggestions.find(s => s.id === 'apob-very-high')?.description).toContain('mg/dL');
    });

    it('formats ApoB in SI units', () => {
      const { inputs, results } = createTestData({ apoB: apoB(110) });
      const suggestions = generateSuggestions(inputs, results, 'si');
      expect(suggestions.find(s => s.id === 'apob-very-high')?.description).toContain('g/L');
    });
  });

  describe('Atherogenic marker hierarchy (ApoB > non-HDL > LDL)', () => {
    it('suppresses non-HDL and LDL when ApoB is available', () => {
      const { inputs, results } = createTestData(
        { apoB: apoB(80), ldlC: ldl(180), totalCholesterol: totalChol(280), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(280) - hdl(50) }
      );
      const suggestions = generateSuggestions(inputs, results);

      expect(suggestions.find(s => s.id === 'apob-high')).toBeDefined();
      expect(suggestions.filter(s => s.id.startsWith('non-hdl-')).length).toBe(0);
      expect(suggestions.filter(s => s.id.startsWith('ldl-')).length).toBe(0);
    });

    it('suppresses LDL when non-HDL is available (no ApoB)', () => {
      const { inputs, results } = createTestData(
        { ldlC: ldl(180), totalCholesterol: totalChol(280), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(280) - hdl(50) }
      );
      const suggestions = generateSuggestions(inputs, results);

      expect(suggestions.find(s => s.id === 'non-hdl-very-high')).toBeDefined();
      expect(suggestions.filter(s => s.id.startsWith('ldl-')).length).toBe(0);
    });

    it('shows LDL when neither ApoB nor non-HDL available', () => {
      const { inputs, results } = createTestData({ ldlC: ldl(180) });
      const suggestions = generateSuggestions(inputs, results);

      expect(suggestions.find(s => s.id === 'ldl-high')).toBeDefined();
    });

    it('suppresses total cholesterol when ApoB is elevated', () => {
      const { inputs, results } = createTestData(
        { apoB: apoB(80), totalCholesterol: totalChol(250) }
      );
      const suggestions = generateSuggestions(inputs, results);

      expect(suggestions.find(s => s.id === 'apob-high')).toBeDefined();
      expect(suggestions.filter(s => s.id.startsWith('total-chol-')).length).toBe(0);
    });

    it('suppresses total cholesterol when non-HDL is elevated (no ApoB)', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(280), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(280) - hdl(50) }
      );
      const suggestions = generateSuggestions(inputs, results);

      expect(suggestions.find(s => s.id === 'non-hdl-very-high')).toBeDefined();
      expect(suggestions.filter(s => s.id.startsWith('total-chol-')).length).toBe(0);
    });

    it('suppresses total cholesterol when medication cascade active for lipids', () => {
      const { inputs, results } = createTestData(
        { apoB: apoB(60), totalCholesterol: totalChol(250) }
      );
      // ApoB 60 mg/dL = 0.6 g/L > 0.5 target, so medication cascade triggers
      // User has engaged with medication questions (statin status recorded)
      const meds: MedicationInputs = { statin: { drug: 'none', dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);

      expect(suggestions.filter(s => s.id.startsWith('total-chol-')).length).toBe(0);
    });

    it('shows total cholesterol when no better atherogenic marker elevated', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(250) }
      );
      const suggestions = generateSuggestions(inputs, results);

      expect(suggestions.find(s => s.id === 'total-chol-high')).toBeDefined();
    });

    it('shows total cholesterol when ApoB is optimal (below all thresholds)', () => {
      const { inputs, results } = createTestData(
        { apoB: apoB(40), totalCholesterol: totalChol(250) }
      );
      // ApoB 40 = optimal, no suggestion generated, but hasApoBData is true
      // However, no elevated atherogenic suggestion and no med cascade (no medications param)
      const suggestions = generateSuggestions(inputs, results);

      // ApoB is optimal so no atherogenic suggestion → total cholesterol shows
      expect(suggestions.filter(s => s.id.startsWith('apob-')).length).toBe(0);
      expect(suggestions.find(s => s.id === 'total-chol-high')).toBeDefined();
    });

    it('suppresses standalone ApoB card when medication cascade is active (statin decision recorded)', () => {
      // ApoB 51 mg/dL = 0.51 g/L > 0.50 target → borderline + cascade active
      const { inputs, results } = createTestData({ apoB: apoB(51) });
      const meds: MedicationInputs = { statin: { drug: 'none', dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);

      // Medication cascade fires, standalone ApoB card suppressed
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
      expect(suggestions.find(s => s.id === 'apob-borderline')).toBeUndefined();
    });

    it('suppresses standalone LDL card when medication cascade is active (statin decision recorded)', () => {
      const { inputs, results } = createTestData({ ldlC: ldl(60) }); // ~1.55 mmol/L > 1.4
      const meds: MedicationInputs = { statin: { drug: 'none', dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);

      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
      expect(suggestions.filter(s => s.id.startsWith('ldl-')).length).toBe(0);
    });

    it('suppresses standalone non-HDL card when medication cascade is active (statin decision recorded)', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(200), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(200) - hdl(50) },
      );
      const meds: MedicationInputs = { statin: { drug: 'none', dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);

      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
      expect(suggestions.filter(s => s.id.startsWith('non-hdl-')).length).toBe(0);
    });

    it('still shows standalone ApoB card when no medications provided', () => {
      const { inputs, results } = createTestData({ apoB: apoB(51) });
      const suggestions = generateSuggestions(inputs, results);

      expect(suggestions.find(s => s.id === 'apob-borderline')).toBeDefined();
      expect(suggestions.find(s => s.id === 'med-statin')).toBeUndefined();
    });

    it('shows standalone LDL card AND med-statin when medications is empty (no statin decision)', () => {
      // User has medications object but hasn't answered statin question yet
      const { inputs, results } = createTestData({ ldlC: ldl(200) }); // ~5.17 mmol/L, very high
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);

      // Both the urgent bloodwork alert AND the statin suggestion should appear
      expect(suggestions.find(s => s.id === 'ldl-very-high')).toBeDefined();
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
    });

    it('shows standalone ApoB card AND med-statin when medications is empty (no statin decision)', () => {
      const { inputs, results } = createTestData({ apoB: apoB(51) });
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);

      expect(suggestions.find(s => s.id === 'apob-borderline')).toBeDefined();
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
    });
  });

  describe('Multiple suggestions', () => {
    it('generates multiple suggestions for complex case', () => {
      const { inputs, results } = createTestData(
        {
          hba1c: hba1c(6.8),
          ldlC: ldl(180),
          systolicBp: 145,
          diastolicBp: 92,
        },
        { bmi: 32, waistToHeightRatio: 0.58 }
      );
      const suggestions = generateSuggestions(inputs, results);

      // Should have: protein, bmi-obese, waist-height, hba1c-diabetic, ldl-high, bp-stage2
      expect(suggestions.length).toBeGreaterThanOrEqual(6);

      const urgentCount = suggestions.filter(s => s.priority === 'urgent').length;
      expect(urgentCount).toBeGreaterThanOrEqual(2); // hba1c and bp
    });
  });

  describe('Always-show lifestyle suggestions', () => {
    it('includes fiber suggestion when no lipids are elevated', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'fiber')).toBeDefined();
      expect(suggestions.find(s => s.id === 'fiber')?.category).toBe('nutrition');
    });

    it('suppresses fiber suggestion when lipid-diet is active', () => {
      const { inputs, results } = createTestData({ ldlC: 4.0 }); // above borderline (3.36)
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'fiber')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'lipid-diet')).toBeDefined();
    });

    it('always includes exercise suggestion', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'exercise')).toBeDefined();
      expect(suggestions.find(s => s.id === 'exercise')?.category).toBe('exercise');
    });

    it('always includes sleep suggestion', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'sleep')).toBeDefined();
      expect(suggestions.find(s => s.id === 'sleep')?.category).toBe('sleep');
    });

    it('shows low salt for age <65 when SBP > 120', () => {
      const { inputs, results } = createTestData({ systolicBp: 125, diastolicBp: 75 }, { age: 50 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'low-salt')).toBeDefined();
    });

    it('hides low salt for age <65 when SBP = 120', () => {
      const { inputs, results } = createTestData({ systolicBp: 120, diastolicBp: 75 }, { age: 50 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'low-salt')).toBeUndefined();
    });

    it('shows low salt for age ≥65 when SBP > 130', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 75 }, { age: 70 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'low-salt')).toBeDefined();
    });

    it('hides low salt for age ≥65 when SBP = 125', () => {
      const { inputs, results } = createTestData({ systolicBp: 125, diastolicBp: 75 }, { age: 70 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'low-salt')).toBeUndefined();
    });

    it('hides low salt when no BP data', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'low-salt')).toBeUndefined();
    });
  });

  describe('Lipid-lowering diet suggestion', () => {
    it('shows lipid-diet when ApoB is borderline or above', () => {
      const { inputs, results } = createTestData({ apoB: 0.5 }); // borderline
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'lipid-diet')).toBeDefined();
      expect(suggestions.find(s => s.id === 'lipid-diet')?.category).toBe('nutrition');
    });

    it('shows lipid-diet when LDL-C is borderline or above', () => {
      const { inputs, results } = createTestData({ ldlC: 3.4 }); // above borderline (3.36)
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'lipid-diet')).toBeDefined();
    });

    it('shows lipid-diet when non-HDL is borderline or above', () => {
      const { inputs, results } = createTestData({}, { nonHdlCholesterol: 4.2 }); // above borderline (4.14)
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'lipid-diet')).toBeDefined();
    });

    it('does not show lipid-diet when every lipid marker is below its optimal line (US-07 AC5)', () => {
      const { inputs, results } = createTestData({ apoB: 0.4, ldlC: 1.39 }, { nonHdlCholesterol: 1.5 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'lipid-diet')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'fiber')).toBeDefined();
    });

    it('shows lipid-diet and hides fiber at LDL 2.0, above the 1.4 optimal line (US-07 AC5)', () => {
      const { inputs, results } = createTestData({ ldlC: 2.0 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'lipid-diet')).toBeDefined();
      expect(suggestions.find(s => s.id === 'fiber')).toBeUndefined();
    });

    it.each([
      { name: 'LDL 1.39', ldlC: 1.39, shows: false },
      { name: 'LDL 1.4', ldlC: 1.4, shows: true },
      { name: 'non-HDL 1.5', nonHdl: 1.5, shows: false },
      { name: 'non-HDL 1.6', nonHdl: 1.6, shows: true },
    ])('lipid-diet at $name: $shows (US-07 AC5)', ({ ldlC, nonHdl, shows }) => {
      const { inputs, results } = createTestData({ ldlC }, { nonHdlCholesterol: nonHdl });
      expect(generateSuggestions(inputs, results).some(s => s.id === 'lipid-diet')).toBe(shows);
    });

    it('does not show lipid-diet when no lipid data present', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'lipid-diet')).toBeUndefined();
    });

    it('shows lipid-diet even when medication cascade is active', () => {
      const { inputs, results } = createTestData({ apoB: 0.8 }); // elevated
      const medications: MedicationInputs = { statin: { drug: 'atorvastatin', dose: 10 } };
      const suggestions = generateSuggestions(inputs, results, 'si', medications);
      expect(suggestions.find(s => s.id === 'lipid-diet')).toBeDefined();
    });
  });

  describe('GLP-1 weight management suggestion', () => {
    it('suggests GLP-1 when BMI > 28', () => {
      const { inputs, results } = createTestData({}, { bmi: 29 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeDefined();
      expect(suggestions.find(s => s.id === 'weight-glp1')?.category).toBe('medication');
    });

    it('does not suggest GLP-1 when BMI <= 25', () => {
      const { inputs, results } = createTestData({}, { bmi: 24 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeUndefined();
    });

    it('suggests GLP-1 when BMI 25-28 and waist-to-height >= 0.5', () => {
      const { inputs, results } = createTestData({}, { bmi: 26, waistToHeightRatio: 0.52 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeDefined();
    });

    it('does not suggest GLP-1 when BMI 25-28 and waist-to-height < 0.5', () => {
      const { inputs, results } = createTestData({}, { bmi: 26, waistToHeightRatio: 0.45 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeUndefined();
    });

    it('does NOT suggest GLP-1 when BMI 25-28 and no waist data (prompts waist measurement instead)', () => {
      const { inputs, results } = createTestData({}, { bmi: 26 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'measure-waist')).toBeDefined();
    });

    it('suggests GLP-1 when BMI 25-28 with elevated trigs and a healthy waist: a raised marker counts (US-06 AC6)', () => {
      const { inputs, results } = createTestData(
        { triglycerides: trig(160) },  // borderline elevated
        { bmi: 26, waistToHeightRatio: 0.45 }  // normal waist → bmiCategory = 'Normal'
      );
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeDefined();
    });

    it('does not suggest GLP-1 when BMI 25-28 with normal trigs and normal waist', () => {
      const { inputs, results } = createTestData(
        { triglycerides: trig(120) },  // normal
        { bmi: 26, waistToHeightRatio: 0.45 }  // normal waist
      );
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeUndefined();
    });

    it('mentions waist in GLP-1 description when triggered by waist (not trigs)', () => {
      const { inputs, results } = createTestData(
        { triglycerides: trig(120) },  // normal
        { bmi: 26, waistToHeightRatio: 0.52 }  // elevated waist
      );
      const suggestions = generateSuggestions(inputs, results);
      const glp1 = suggestions.find(s => s.id === 'weight-glp1');
      expect(glp1).toBeDefined();
      expect(glp1?.description).toContain('waist');
    });

    // WHtR reclassification: BMI 25-29.9 with healthy WHtR (<0.5) = Normal → no GLP-1
    it('does NOT suggest GLP-1 when BMI > 28 but healthy WHtR (reclassified Normal)', () => {
      const { inputs, results } = createTestData({}, { bmi: 29, waistToHeightRatio: 0.4 });
      expect(results.bmiCategory).toBe('Normal');
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeUndefined();
    });

    it('still suggests GLP-1 when BMI > 28 and no WHtR data (no reclassification)', () => {
      const { inputs, results } = createTestData({}, { bmi: 29 });
      expect(results.bmiCategory).toBe('Overweight');
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeDefined();
    });

    it('still suggests GLP-1 when BMI > 28 and elevated WHtR', () => {
      const { inputs, results } = createTestData({}, { bmi: 29, waistToHeightRatio: 0.55 });
      expect(results.bmiCategory).toBe('Overweight');
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeDefined();
    });
  });

  describe('Measure waist circumference suggestion', () => {
    it('shows when BMI 25-29.9 and no waist data', () => {
      const { inputs, results } = createTestData({}, { bmi: 26 });
      const suggestions = generateSuggestions(inputs, results);
      const waistSuggestion = suggestions.find(s => s.id === 'measure-waist');
      expect(waistSuggestion).toBeDefined();
      expect(waistSuggestion?.priority).toBe('attention');
      expect(waistSuggestion?.description).toContain('waist');
    });

    it('does not show when BMI 25-29.9 and waist data is present (healthy)', () => {
      const { inputs, results } = createTestData({}, { bmi: 26, waistToHeightRatio: 0.45 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'measure-waist')).toBeUndefined();
    });

    it('does not show when BMI 25-29.9 and waist data is present (elevated)', () => {
      const { inputs, results } = createTestData({}, { bmi: 26, waistToHeightRatio: 0.55 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'measure-waist')).toBeUndefined();
    });

    it('does not show when BMI < 25', () => {
      const { inputs, results } = createTestData({}, { bmi: 23 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'measure-waist')).toBeUndefined();
    });

    it('does not show when BMI >= 30', () => {
      const { inputs, results } = createTestData({}, { bmi: 31 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'measure-waist')).toBeUndefined();
    });
  });

  describe('Medication cascade suggestions', () => {
    // Helper: elevated lipids to trigger cascade
    const elevatedLipids = { apoB: apoB(60) }; // 60 mg/dL = 0.6 g/L > 0.5 threshold

    it('suggests statin when no medications set and lipids elevated', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
    });

    it('suggests statin (not ezetimibe) when statin drug is null (migration edge case)', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      // Simulate old data from before migration: statin object exists but drug is null
      const meds: MedicationInputs = { statin: { drug: null as unknown as string, dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
      expect(suggestions.find(s => s.id === 'med-ezetimibe')).toBeUndefined();
    });

    it('suggests statin (not ezetimibe) when statin drug is undefined (edge case)', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      // Edge case: statin object exists but drug is undefined
      const meds: MedicationInputs = { statin: { drug: undefined as unknown as string, dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
      expect(suggestions.find(s => s.id === 'med-ezetimibe')).toBeUndefined();
    });

    it('suggests statin (not ezetimibe) when statin drug is empty string (edge case)', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      // Edge case: statin object exists but drug is empty string
      const meds: MedicationInputs = { statin: { drug: '', dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
      expect(suggestions.find(s => s.id === 'med-ezetimibe')).toBeUndefined();
    });

    it('suggests statin (not PCSK9i) when statin has old tier-based value (migration edge case)', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      // Old tier-based data: 'tier_1' is not a valid statin drug name
      const meds: MedicationInputs = {
        statin: { drug: 'tier_1', dose: null },
        ezetimibe: 'yes', // Even with ezetimibe yes, should still suggest statin first
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
      expect(suggestions.find(s => s.id === 'med-pcsk9i')).toBeUndefined();
    });

    it('suggests statin (not PCSK9i) when statin has unknown drug value', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      // Any unknown value that's not in STATIN_DRUGS should be treated as 'none'
      const meds: MedicationInputs = {
        statin: { drug: 'unknown_drug', dose: 10 },
        ezetimibe: 'yes',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
      expect(suggestions.find(s => s.id === 'med-pcsk9i')).toBeUndefined();
    });

    it('does not treat prototype properties as valid statin drugs', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = {
        statin: { drug: 'toString', dose: 10 },
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      // 'toString' is not a valid statin — should suggest starting one
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
    });

    it('does not suggest medications when lipids below targets', () => {
      const { inputs, results } = createTestData({ apoB: apoB(30) }); // below 50
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id?.startsWith('med-'))).toBeUndefined();
    });

    it('suggests ezetimibe when on statin but lipids still elevated', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = { statin: { drug: 'atorvastatin', dose: 10 } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-ezetimibe')).toBeDefined();
      expect(suggestions.find(s => s.id === 'med-statin')).toBeUndefined();
    });

    it('suggests statin dose increase when on statin + ezetimibe, not max dose', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      // Atorvastatin 10mg can be increased to 20, 40, 80
      const meds: MedicationInputs = { statin: { drug: 'atorvastatin', dose: 10 }, ezetimibe: 'yes' };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin-increase')).toBeDefined();
    });

    it('suggests switching to more potent statin when on max dose of weaker statin', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      // Simvastatin 40mg is max dose but not max potency
      const meds: MedicationInputs = { statin: { drug: 'simvastatin', dose: 40 }, ezetimibe: 'yes' };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin-switch')).toBeDefined();
      expect(suggestions.find(s => s.id === 'med-statin-increase')).toBeUndefined();
    });

    it('skips statin escalation when already on max potency', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      // Rosuvastatin 40mg is max potency
      const meds: MedicationInputs = { statin: { drug: 'rosuvastatin', dose: 40 }, ezetimibe: 'yes' };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin-increase')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'med-statin-switch')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'med-pcsk9i')).toBeDefined();
    });

    it('skips statin escalation when statin not tolerated', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = { statin: { drug: 'not_tolerated', dose: null }, ezetimibe: 'yes' };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin-increase')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'med-pcsk9i')).toBeDefined();
    });

    it('suggests PCSK9i when statin escalation not tolerated', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = {
        statin: { drug: 'atorvastatin', dose: 10 },
        ezetimibe: 'yes',
        statinEscalation: 'not_tolerated',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-pcsk9i')).toBeDefined();
    });

    it('no medication suggestions when all cascade steps completed', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = {
        statin: { drug: 'rosuvastatin', dose: 40 },
        ezetimibe: 'yes',
        bempedoicAcid: 'bempedoic_acid',
        pcsk9i: 'yes',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.filter(s => s.id?.startsWith('med-')).length).toBe(0);
    });

    it('triggers cascade on elevated LDL', () => {
      const { inputs, results } = createTestData({ ldlC: ldl(60) }); // 60 mg/dL = ~1.55 mmol/L > 1.4
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
    });

    it('triggers cascade on elevated non-HDL', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(200), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(200) - hdl(50) }, // ~3.88 mmol/L > 1.4
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin')).toBeDefined();
    });

    it('does not show cascade when medications param not provided', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id?.startsWith('med-'))).toBeUndefined();
    });

    it('med-statin description includes ApoB value and target when ApoB triggers cascade', () => {
      const { inputs, results } = createTestData({ apoB: apoB(60) }); // 0.6 g/L
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      const statin = suggestions.find(s => s.id === 'med-statin');
      expect(statin).toBeDefined();
      expect(statin!.description).toContain('ApoB');
      expect(statin!.description).toContain('the treatment target is below');
    });

    it('med-statin description uses non-HDL when ApoB unavailable', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(200), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(200) - hdl(50) },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      const statin = suggestions.find(s => s.id === 'med-statin');
      expect(statin).toBeDefined();
      expect(statin!.description).toContain('non-HDL');
      expect(statin!.description).toContain('the treatment target is below');
    });

    it('med-statin description uses LDL as fallback', () => {
      const { inputs, results } = createTestData({ ldlC: ldl(60) }); // ~1.55 mmol/L > 1.4
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      const statin = suggestions.find(s => s.id === 'med-statin');
      expect(statin).toBeDefined();
      expect(statin!.description).toContain('LDL-c');
      expect(statin!.description).toContain('the treatment target is below');
    });

    it('med-ezetimibe description includes specific lipid reason', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = { statin: { drug: 'atorvastatin', dose: 10 } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      const eze = suggestions.find(s => s.id === 'med-ezetimibe');
      expect(eze).toBeDefined();
      expect(eze!.description).toContain('ApoB');
      expect(eze!.description).toContain('the treatment target is below');
    });

    // US-07 AC5: the sentence reads true at exactly the target.
    it.each([
      { name: 'LDL 1.4', values: { ldlC: 1.4 }, text: 'Your LDL-c is 1.4 mmol/L; the treatment target is below 1.4 mmol/L. Discuss starting a statin (e.g. Rosuvastatin 5mg) with your doctor.' },
      { name: 'ApoB 0.5', values: { apoB: 0.5 }, text: 'Your ApoB is 0.50 g/L; the treatment target is below 0.50 g/L. Discuss starting a statin (e.g. Rosuvastatin 5mg) with your doctor.' },
    ])('med-statin at exactly the target, $name, shows and reads true (US-07 AC5)', ({ values, text }) => {
      const { inputs, results } = createTestData(values);
      expect(generateSuggestions(inputs, results, 'si', {}).find(s => s.id === 'med-statin')?.description).toBe(text);
    });

    it('med-statin at exactly the non-HDL target of 1.6 shows (US-07 AC5)', () => {
      const { inputs, results } = createTestData({}, { nonHdlCholesterol: 1.6 });
      expect(generateSuggestions(inputs, results, 'si', {}).find(s => s.id === 'med-statin')?.description)
        .toBe('Your non-HDL cholesterol is 1.6 mmol/L; the treatment target is below 1.6 mmol/L. Discuss starting a statin (e.g. Rosuvastatin 5mg) with your doctor.');
    });

    it.each([
      { name: 'LDL 1.39', values: { ldlC: 1.39 }, results: {} },
      { name: 'ApoB 0.49', values: { apoB: 0.49 }, results: {} },
      { name: 'non-HDL 1.5', values: {}, results: { nonHdlCholesterol: 1.5 } },
    ])('no statin card just below the target, $name (US-07 AC5)', ({ values, results: r }) => {
      const { inputs, results } = createTestData(values, r);
      expect(generateSuggestions(inputs, results, 'si', {}).some(s => s.id.startsWith('med-'))).toBe(false);
    });

    it('med-pcsk9i description includes specific lipid reason', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = {
        statin: { drug: 'rosuvastatin', dose: 40 },
        ezetimibe: 'yes',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      const pcsk9i = suggestions.find(s => s.id === 'med-pcsk9i');
      expect(pcsk9i).toBeDefined();
      expect(pcsk9i!.description).toContain('ApoB');
      expect(pcsk9i!.description).toContain('the treatment target is below');
    });
  });

  describe('Unit system display in suggestion text', () => {
    it('formats values in conventional units when specified', () => {
      const { inputs, results } = createTestData({ ldlC: ldl(200) });
      const suggestions = generateSuggestions(inputs, results, 'conventional');

      const ldlSuggestion = suggestions.find(s => s.id === 'ldl-very-high');
      expect(ldlSuggestion?.description).toContain('mg/dL');
    });

    it('formats values in SI units by default', () => {
      const { inputs, results } = createTestData({ ldlC: ldl(200) });
      const suggestions = generateSuggestions(inputs, results);

      const ldlSuggestion = suggestions.find(s => s.id === 'ldl-very-high');
      expect(ldlSuggestion?.description).toContain('mmol/L');
    });
  });

  describe('High-potassium diet suggestion (eGFR-based)', () => {
    it('suggests high potassium when eGFR >= 45', () => {
      const { inputs, results } = createTestData({}, { eGFR: 90 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'high-potassium')).toBeDefined();
    });

    it('suggests high potassium at eGFR exactly 45', () => {
      const { inputs, results } = createTestData({}, { eGFR: 45 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'high-potassium')).toBeDefined();
    });

    it('does not suggest high potassium when eGFR < 45', () => {
      const { inputs, results } = createTestData({}, { eGFR: 44 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'high-potassium')).toBeUndefined();
    });

    it('does not suggest high potassium when eGFR is undefined', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'high-potassium')).toBeUndefined();
    });

  });

  describe('Cancer screening suggestions', () => {
    // Colorectal
    it('suggests colorectal screening for age 35+ with no method selected', () => {
      const { inputs, results } = createTestData({ birthYear: 1985, birthMonth: 1 }, { age: 41 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-colorectal')).toBeDefined();
    });

    it('does not suggest colorectal screening for age 34', () => {
      const { inputs, results } = createTestData({ birthYear: 1992, birthMonth: 1 }, { age: 34 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-colorectal')).toBeUndefined();
    });

    it('shows overdue when colorectal last date is past interval', () => {
      const { inputs, results } = createTestData({ birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = { colorectalMethod: 'fit_annual', colorectalLastDate: '2024-01' };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-colorectal-overdue')).toBeDefined();
    });

    it('shows up-to-date when colorectal screening is recent', () => {
      const { inputs, results } = createTestData({ birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const now = new Date();
      const lastMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const scr: ScreeningInputs = { colorectalMethod: 'fit_annual', colorectalLastDate: lastMonth };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-colorectal-upcoming')).toBeDefined();
    });

    // Breast
    it('suggests breast screening for female age 40+', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-breast')).toBeDefined();
      expect(suggestions.find(s => s.id === 'screening-breast')?.priority).toBe('attention');
    });

    it('does not suggest breast screening for males', () => {
      const { inputs, results } = createTestData({ sex: 'male', birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-breast')).toBeUndefined();
    });

    it('breast screening is info priority for age 40-44', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1984, birthMonth: 1 }, { age: 42 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-breast')?.priority).toBe('info');
    });

    // Cervical
    it('suggests cervical screening for female age 25-65', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 2000, birthMonth: 1 }, { age: 26 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-cervical')).toBeDefined();
    });

    it('does not suggest cervical screening for female age 66+', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1958, birthMonth: 1 }, { age: 68 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-cervical')).toBeUndefined();
    });

    // Lung
    it('suggests lung screening for smoker 50+ with 15+ pack-years (USPSTF 2021)', () => {
      const { inputs, results } = createTestData({ birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { lungSmokingHistory: 'current_smoker', lungPackYears: 25 };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-lung')).toBeDefined();
    });

    it('suggests lung screening at exactly 15 pack-years (boundary)', () => {
      const { inputs, results } = createTestData({ birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { lungSmokingHistory: 'former_smoker', lungPackYears: 15 };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-lung')).toBeDefined();
    });

    it('does not suggest lung screening for never smoker', () => {
      const { inputs, results } = createTestData({ birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { lungSmokingHistory: 'never_smoked' };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-lung')).toBeUndefined();
    });

    it('does not suggest lung screening for smoker with <15 pack-years', () => {
      const { inputs, results } = createTestData({ birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { lungSmokingHistory: 'former_smoker', lungPackYears: 14 };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-lung')).toBeUndefined();
    });

    // Prostate
    it('suggests prostate discussion for male age 50+', () => {
      const { inputs, results } = createTestData({ sex: 'male', birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-prostate')).toBeDefined();
    });

    it('does not suggest prostate for female', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-prostate')).toBeUndefined();
    });

    it('warns about elevated PSA > 4.0', () => {
      const { inputs, results } = createTestData({ sex: 'male', birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { prostateDiscussion: 'will_screen', prostatePsaValue: 5.2 };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-prostate-elevated')).toBeDefined();
    });

    it('no elevated PSA warning when PSA <= 4.0', () => {
      const { inputs, results } = createTestData({ sex: 'male', birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { prostateDiscussion: 'will_screen', prostatePsaValue: 2.1 };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-prostate-elevated')).toBeUndefined();
    });

    // Endometrial
    it('shows urgent suggestion for unreported abnormal bleeding', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1975, birthMonth: 1 }, { age: 51 });
      const scr: ScreeningInputs = { endometrialAbnormalBleeding: 'yes_need_to_report' };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const bleeding = suggestions.find(s => s.id === 'screening-endometrial-bleeding');
      expect(bleeding).toBeDefined();
      expect(bleeding?.priority).toBe('urgent');
    });

    it('suggests endometrial discussion for female 45+ who have not discussed', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1975, birthMonth: 1 }, { age: 51 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-endometrial')).toBeDefined();
    });

    it('no endometrial discussion suggestion if already discussed', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1975, birthMonth: 1 }, { age: 51 });
      const scr: ScreeningInputs = { endometrialDiscussion: 'discussed' };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-endometrial')).toBeUndefined();
    });

    // No screening suggestions without age
    it('no screening suggestions when age is undefined', () => {
      const { inputs, results } = createTestData({});
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const screeningSuggestions = suggestions.filter(s => s.category === 'screening');
      expect(screeningSuggestions).toHaveLength(0);
    });

    // All screening suggestions have 'screening' category
    it('all screening suggestions use screening category', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1975, birthMonth: 1 }, { age: 51 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const screeningSuggestions = suggestions.filter(s => s.id.startsWith('screening-'));
      expect(screeningSuggestions.length).toBeGreaterThan(0);
      for (const s of screeningSuggestions) {
        expect(s.category).toBe('screening');
      }
    });
  });

  describe('Screening follow-up pathways', () => {
    // --- Colorectal ---
    it('shows urgent follow-up when colorectal result is abnormal and no follow-up organized', () => {
      const { inputs, results } = createTestData({ birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: '2025-06',
        colorectalResult: 'abnormal',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-colorectal-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('urgent');
      expect(followup?.description).toContain('colonoscopy');
    });

    it('shows urgent follow-up when colorectal abnormal with followupStatus not_organized', () => {
      const { inputs, results } = createTestData({ birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: '2025-06',
        colorectalResult: 'abnormal',
        colorectalFollowupStatus: 'not_organized',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-colorectal-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('urgent');
    });

    it('shows info when colorectal follow-up is scheduled', () => {
      const { inputs, results } = createTestData({ birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: '2025-06',
        colorectalResult: 'abnormal',
        colorectalFollowupStatus: 'scheduled',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-colorectal-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('info');
    });

    it('uses 3-year interval after completed colorectal follow-up (FIT positive)', () => {
      const { inputs, results } = createTestData({ birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: '2025-06',
        colorectalResult: 'abnormal',
        colorectalFollowupStatus: 'completed',
        colorectalFollowupDate: '2025-08',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-colorectal-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('info');
      expect(followup?.description).toContain('Aug 2028');
    });

    it('shows overdue after completed colorectal follow-up when past interval', () => {
      const { inputs, results } = createTestData({ birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: '2021-01',
        colorectalResult: 'abnormal',
        colorectalFollowupStatus: 'completed',
        colorectalFollowupDate: '2021-03', // 3 years ago → overdue
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-colorectal-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('attention');
    });

    it('falls back to normal overdue logic when colorectal result is normal', () => {
      const { inputs, results } = createTestData({ birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: '2024-01',
        colorectalResult: 'normal',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-colorectal-overdue')).toBeDefined();
      expect(suggestions.find(s => s.id === 'screening-colorectal-followup')).toBeUndefined();
    });

    it('falls back to normal logic when colorectal result is awaiting', () => {
      const { inputs, results } = createTestData({ birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: '2024-01',
        colorectalResult: 'awaiting',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-colorectal-overdue')).toBeDefined();
      expect(suggestions.find(s => s.id === 'screening-colorectal-followup')).toBeUndefined();
    });

    it('gracefully handles abnormal + completed but no followup date', () => {
      const { inputs, results } = createTestData({ birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: '2025-06',
        colorectalResult: 'abnormal',
        colorectalFollowupStatus: 'completed',
        // no followupDate
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      // Should fall back to default logic
      expect(suggestions.find(s => s.id === 'screening-colorectal-followup')).toBeUndefined();
    });

    // --- Breast ---
    it('shows urgent follow-up for abnormal breast screening', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {
        breastFrequency: 'annual',
        breastLastDate: '2025-06',
        breastResult: 'abnormal',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-breast-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('urgent');
      expect(followup?.description).toContain('diagnostic imaging');
    });

    it('resumes normal annual schedule after completed breast follow-up', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const now = new Date();
      const recentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const scr: ScreeningInputs = {
        breastFrequency: 'annual',
        breastLastDate: '2025-01',
        breastResult: 'abnormal',
        breastFollowupStatus: 'completed',
        breastFollowupDate: recentMonth, // recent → next due in 12 months
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-breast-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('info');
    });

    // --- Cervical ---
    it('shows urgent follow-up for abnormal cervical screening (HPV+)', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1990, birthMonth: 1 }, { age: 36 });
      const scr: ScreeningInputs = {
        cervicalMethod: 'hpv_every_5yr',
        cervicalLastDate: '2025-06',
        cervicalResult: 'abnormal',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-cervical-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('urgent');
      expect(followup?.description).toContain('colposcopy');
    });

    it('uses 1-year interval after completed cervical follow-up', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1990, birthMonth: 1 }, { age: 36 });
      // Time-relative so the test never rots: a follow-up completed 6 months ago
      // means the next cervical screen (12-month post-follow-up interval) is due
      // ~6 months out — comfortably in the future, so priority is 'info'.
      const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const now = new Date();
      const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const followupDate = new Date(now.getFullYear(), now.getMonth() - 6, 1);
      const nextDue = new Date(followupDate.getFullYear(), followupDate.getMonth() + 12);
      const nextDueLabel = `${MONTHS[nextDue.getMonth()]} ${nextDue.getFullYear()}`;
      const scr: ScreeningInputs = {
        cervicalMethod: 'hpv_every_5yr',
        cervicalLastDate: ym(new Date(now.getFullYear(), now.getMonth() - 18, 1)),
        cervicalResult: 'abnormal',
        cervicalFollowupStatus: 'completed',
        cervicalFollowupDate: ym(followupDate),
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-cervical-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('info');
      expect(followup?.description).toContain(nextDueLabel);
    });

    it('falls back to normal logic when cervical result is normal', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1990, birthMonth: 1 }, { age: 36 });
      const now = new Date();
      const recentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const scr: ScreeningInputs = {
        cervicalMethod: 'hpv_every_5yr',
        cervicalLastDate: recentMonth,
        cervicalResult: 'normal',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-cervical-upcoming')).toBeDefined();
      expect(suggestions.find(s => s.id === 'screening-cervical-followup')).toBeUndefined();
    });

    // --- Lung ---
    it('shows urgent follow-up for abnormal lung screening', () => {
      const { inputs, results } = createTestData({ birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = {
        lungSmokingHistory: 'current_smoker',
        lungPackYears: 25,
        lungScreening: 'annual_ldct',
        lungLastDate: '2025-06',
        lungResult: 'abnormal',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-lung-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('urgent');
      expect(followup?.description).toContain('follow-up imaging');
    });

    it('resumes annual LDCT after completed lung follow-up', () => {
      const { inputs, results } = createTestData({ birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const now = new Date();
      const recentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const scr: ScreeningInputs = {
        lungSmokingHistory: 'current_smoker',
        lungPackYears: 25,
        lungScreening: 'annual_ldct',
        lungLastDate: '2025-01',
        lungResult: 'abnormal',
        lungFollowupStatus: 'completed',
        lungFollowupDate: recentMonth,
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-lung-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('info');
    });

    it('colonoscopy abnormal shows repeat colonoscopy follow-up', () => {
      const { inputs, results } = createTestData({ birthYear: 1980, birthMonth: 1 }, { age: 46 });
      const scr: ScreeningInputs = {
        colorectalMethod: 'colonoscopy_10yr',
        colorectalLastDate: '2025-06',
        colorectalResult: 'abnormal',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-colorectal-followup');
      expect(followup).toBeDefined();
      expect(followup?.description).toContain('repeat colonoscopy');
    });

    // --- No follow-up for screening types without result tracking ---
    it('does not interfere with prostate suggestions', () => {
      const { inputs, results } = createTestData({ sex: 'male', birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { prostateDiscussion: 'will_screen', prostatePsaValue: 5.2 };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-prostate-elevated')).toBeDefined();
    });
  });

  describe('Weight & diabetes medication cascade', () => {
    // Trigger (US-06 AC6): BMI >= 25 with a raised marker (HbA1c prediabetic, trigs >= 150,
    // BP >= 130 systolic or > 80 diastolic, the plan's lipid marker at its risk-enhancing
    // line, WHtR >= 0.5), or an elevated BMI category with BMI > 28
    it('shows GLP-1 suggestion when BMI > 25 AND HbA1c prediabetic', () => {
      const { inputs, results } = createTestData(
        { hba1c: hba1c(5.8) },
        { bmi: 27 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeDefined();
    });

    it('shows GLP-1 suggestion when BMI > 25 AND elevated triglycerides', () => {
      const { inputs, results } = createTestData(
        { triglycerides: trig(160) },
        { bmi: 26 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeDefined();
    });

    it('shows GLP-1 suggestion when BMI > 25 AND SBP >= 130', () => {
      const { inputs, results } = createTestData(
        { systolicBp: 135, diastolicBp: 75 },
        { bmi: 26 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeDefined();
    });

    it('shows GLP-1 suggestion when BMI > 25 AND waist-to-height >= 0.5', () => {
      const { inputs, results } = createTestData(
        {},
        { bmi: 26, waistToHeightRatio: 0.55 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeDefined();
    });

    it('does NOT show cascade when BMI 25-28 but no secondary criteria', () => {
      const { inputs, results } = createTestData(
        {},
        { bmi: 27 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeUndefined();
    });

    it('shows cascade when BMI > 28 with NO secondary criteria', () => {
      const { inputs, results } = createTestData(
        {},
        { bmi: 29 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeDefined();
    });

    it('does NOT show cascade when BMI <= 25 even with secondary criteria', () => {
      const { inputs, results } = createTestData(
        { hba1c: hba1c(6.0) },
        { bmi: 24 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeUndefined();
    });

    it('does NOT show cascade when medications param not provided', () => {
      const { inputs, results } = createTestData(
        { hba1c: hba1c(6.0) },
        { bmi: 28 },
      );
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeUndefined();
    });

    // WHtR reclassification: BMI 25-29.9 with healthy WHtR (<0.5) = Normal → no cascade
    it('does NOT show cascade when BMI > 28 but healthy WHtR (reclassified Normal)', () => {
      const { inputs, results } = createTestData(
        {},
        { bmi: 29, waistToHeightRatio: 0.4 },
      );
      expect(results.bmiCategory).toBe('Normal');
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeUndefined();
    });

    it('shows cascade when BMI 25-28 with healthy WHtR and elevated BP (US-06 AC6)', () => {
      const { inputs, results } = createTestData(
        { systolicBp: 140, diastolicBp: 85 },
        { bmi: 26, waistToHeightRatio: 0.4 },
      );
      expect(results.bmiCategory).toBe('Normal');
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeDefined();
    });

    it('shows cascade when BMI 25-28 with elevated WHtR and elevated BP', () => {
      const { inputs, results } = createTestData(
        { systolicBp: 140 },
        { bmi: 26, waistToHeightRatio: 0.55 },
      );
      expect(results.bmiCategory).toBe('Overweight');
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeDefined();
    });

    it('shows cascade when BMI > 28 with no WHtR data (no reclassification)', () => {
      const { inputs, results } = createTestData(
        {},
        { bmi: 29 },
      );
      expect(results.bmiCategory).toBe('Overweight');
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeDefined();
    });

    // Cascade progression (GLP-1 at max potency → SGLT2i → Metformin)
    it('shows SGLT2i when on GLP-1 at max potency', () => {
      const { inputs, results } = createTestData(
        { hba1c: hba1c(5.8) },
        { bmi: 28 },
      );
      const meds: MedicationInputs = { glp1: { drug: 'tirzepatide', dose: 15 } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'weight-med-glp1-increase')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'weight-med-sglt2i')).toBeDefined();
    });

    it('shows SGLT2i when GLP-1 not tolerated', () => {
      const { inputs, results } = createTestData(
        { hba1c: hba1c(5.8) },
        { bmi: 28 },
      );
      const meds: MedicationInputs = { glp1: { drug: 'not_tolerated', dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-sglt2i')).toBeDefined();
    });

    it('shows GLP-1 switch suggestion when on "other" GLP-1', () => {
      const { inputs, results } = createTestData(
        { hba1c: hba1c(5.8) },
        { bmi: 28 },
      );
      const meds: MedicationInputs = { glp1: { drug: 'other', dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1-switch')).toBeDefined();
      expect(suggestions.find(s => s.id === 'weight-med-sglt2i')).toBeUndefined();
    });

    it('shows metformin when on GLP-1 at max potency and SGLT2i', () => {
      const { inputs, results } = createTestData(
        { hba1c: hba1c(5.8) },
        { bmi: 28 },
      );
      const meds: MedicationInputs = {
        glp1: { drug: 'tirzepatide', dose: 15 },
        sglt2i: { drug: 'empagliflozin', dose: 10 },
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-metformin')).toBeDefined();
    });

    it('shows metformin when SGLT2i not tolerated', () => {
      const { inputs, results } = createTestData(
        { hba1c: hba1c(5.8) },
        { bmi: 28 },
      );
      const meds: MedicationInputs = {
        glp1: { drug: 'tirzepatide', dose: 15 },
        sglt2i: { drug: 'not_tolerated', dose: null },
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-metformin')).toBeDefined();
    });

    it('no weight-med suggestions when all cascade steps completed', () => {
      const { inputs, results } = createTestData(
        { hba1c: hba1c(5.8) },
        { bmi: 28 },
      );
      const meds: MedicationInputs = {
        glp1: { drug: 'tirzepatide', dose: 15 },
        sglt2i: { drug: 'dapagliflozin', dose: 10 },
        metformin: 'xr_1000',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.filter(s => s.id?.startsWith('weight-med-')).length).toBe(0);
    });

    // Suppresses standalone GLP-1 suggestion
    it('suppresses standalone weight-glp1 when cascade is active', () => {
      const { inputs, results } = createTestData(
        { hba1c: hba1c(5.8) },
        { bmi: 28 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      // Cascade suggestion should appear, standalone should not
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeDefined();
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeUndefined();
    });

    it('shows standalone weight-glp1 when BMI 25-28 with elevated WHtR and no secondary criteria (no cascade)', () => {
      const { inputs, results } = createTestData(
        {},
        { bmi: 27, waistToHeightRatio: 0.52 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      // Cascade IS active because WHtR >= 0.5 is a secondary criterion, so cascade suggestion appears
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeDefined();
    });

    it('does not show standalone weight-glp1 when BMI 25-28 and no waist data (prompts waist measurement)', () => {
      const { inputs, results } = createTestData(
        {},
        { bmi: 27 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'measure-waist')).toBeDefined();
    });

    // Description context
    it('mentions HbA1c in description when HbA1c is a trigger', () => {
      const { inputs, results } = createTestData(
        { hba1c: hba1c(6.0) },
        { bmi: 26 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      const glp1 = suggestions.find(s => s.id === 'weight-med-glp1');
      expect(glp1?.description).toContain('HbA1c');
    });

    it('mentions triglycerides in description when trigs are a trigger', () => {
      const { inputs, results } = createTestData(
        { triglycerides: trig(200) },
        { bmi: 26 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      const glp1 = suggestions.find(s => s.id === 'weight-med-glp1');
      expect(glp1?.description).toContain('triglycerides');
    });

    it('mentions blood pressure in description when BP is a trigger', () => {
      const { inputs, results } = createTestData(
        { systolicBp: 140, diastolicBp: 85 },
        { bmi: 26 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      const glp1 = suggestions.find(s => s.id === 'weight-med-glp1');
      expect(glp1?.description).toContain('blood pressure');
    });
  });

  // US-06 AC5: the plan and the input form share one weight-medication trigger.
  // US-06 AC6: the trigger rule Brad set on 2026-09-26 and 2026-09-28. From
  // BMI 25 a raised marker turns it on, even with a healthy waist; above BMI
  // 28 an elevated BMI category turns it on alone; below 25 it is always off.
  // Raw values go through calculateHealthResults, so its rounding is part of
  // the case: 178 cm tall, BMI to 1 decimal place, waist-to-height ratio to 2,
  // non-HDL unrounded.
  describe('weightMedicationTrigger: one trigger for the plan and the form (US-06 AC5, US-06 AC6)', () => {
    interface Row {
      name: string;
      weightKg?: number;
      waistCm?: number;
      hba1c?: number;
      triglycerides?: number;
      systolicBp?: number;
      diastolicBp?: number;
      apoB?: number;
      ldlC?: number;
      totalCholesterol?: number;
      hdlC?: number;
      on: boolean;
      reasons: string[];
    }
    const HBA1C = 'prediabetic HbA1c';
    const TG = 'elevated triglycerides';
    const BP = 'elevated blood pressure';
    const APOB = 'elevated ApoB';
    const NON_HDL = 'elevated non-HDL cholesterol';
    const LDL = 'elevated LDL cholesterol';
    const WAIST = 'elevated waist-to-height ratio';
    const table: Row[] = [
      { name: 'no weight', on: false, reasons: [] },
      { name: 'BMI 18.0 with every marker raised', weightKg: 57, waistCm: 106.8, hba1c: 48, triglycerides: 2, systolicBp: 140, diastolicBp: 90, apoB: 1.5, on: false, reasons: [] },
      { name: 'BMI 24.9 with every marker raised', weightKg: 78.9, waistCm: 106.8, hba1c: 48, triglycerides: 2, systolicBp: 140, diastolicBp: 90, apoB: 1.5, on: false, reasons: [] },
      { name: 'BMI 24.9 with a raised HbA1c', weightKg: 78.9, hba1c: 48, on: false, reasons: [] },
      { name: 'BMI 25.0 (24.97 raw), no waist, no marker', weightKg: 79.1, on: false, reasons: [] },
      { name: 'BMI 25.0 (24.97 raw), no waist, HbA1c 40', weightKg: 79.1, hba1c: 40, on: true, reasons: [HBA1C] },
      { name: 'BMI 25.0, healthy waist (WHtR 0.47), HbA1c 40', weightKg: 79.1, waistCm: 83.7, hba1c: 40, on: true, reasons: [HBA1C] },
      { name: 'BMI 26.0, healthy waist (WHtR 0.46), BP 135/85 (group 2)', weightKg: 82.4, waistCm: 81.9, systolicBp: 135, diastolicBp: 85, on: true, reasons: [BP] },
      { name: 'BMI 26.0, healthy waist, BP 125/85 only', weightKg: 82.4, waistCm: 81.9, systolicBp: 125, diastolicBp: 85, on: true, reasons: [BP] },
      { name: 'BMI 26.0, healthy waist, BP 129/80', weightKg: 82.4, waistCm: 81.9, systolicBp: 129, diastolicBp: 80, on: false, reasons: [] },
      { name: 'BMI 26.0, healthy waist, BP 129/81', weightKg: 82.4, waistCm: 81.9, systolicBp: 129, diastolicBp: 81, on: true, reasons: [BP] },
      { name: 'BMI 26.0, healthy waist, systolic 135 with no diastolic (either half counts)', weightKg: 82.4, waistCm: 81.9, systolicBp: 135, on: true, reasons: [BP] },
      { name: 'BMI 26.0, healthy waist, systolic 129 with no diastolic', weightKg: 82.4, waistCm: 81.9, systolicBp: 129, on: false, reasons: [] },
      { name: 'BMI 26.0, healthy waist, diastolic 85 with no systolic (either half counts)', weightKg: 82.4, waistCm: 81.9, diastolicBp: 85, on: true, reasons: [BP] },
      { name: 'BMI 26.0, healthy waist, diastolic 80 with no systolic', weightKg: 82.4, waistCm: 81.9, diastolicBp: 80, on: false, reasons: [] },
      { name: 'BMI 26.0, healthy waist, LDL 4.2 alone', weightKg: 82.4, waistCm: 81.9, ldlC: 4.2, on: true, reasons: [LDL] },
      { name: 'BMI 26.0, healthy waist, LDL 4.0 alone', weightKg: 82.4, waistCm: 81.9, ldlC: 4.0, on: false, reasons: [] },
      { name: 'BMI 26.0, healthy waist, LDL 160 mg/dL', weightKg: 82.4, waistCm: 81.9, ldlC: ldl(160), on: true, reasons: [LDL] },
      { name: 'BMI 26.0, healthy waist, ApoB 1.3', weightKg: 82.4, waistCm: 81.9, apoB: 1.3, on: true, reasons: [APOB] },
      { name: 'BMI 26.0, healthy waist, ApoB 1.29', weightKg: 82.4, waistCm: 81.9, apoB: 1.29, on: false, reasons: [] },
      { name: 'BMI 26.0, healthy waist, ApoB 1.0 with LDL 4.5 (ApoB is the plan\'s marker)', weightKg: 82.4, waistCm: 81.9, apoB: 1.0, ldlC: 4.5, on: false, reasons: [] },
      { name: 'BMI 26.0, healthy waist, non-HDL 5.0 (TC 6.2, HDL 1.2)', weightKg: 82.4, waistCm: 81.9, totalCholesterol: 6.2, hdlC: 1.2, on: true, reasons: [NON_HDL] },
      { name: 'BMI 26.0, healthy waist, non-HDL 4.9 (TC 6.1, HDL 1.2): under the 4.91 line', weightKg: 82.4, waistCm: 81.9, totalCholesterol: 6.1, hdlC: 1.2, on: false, reasons: [] },
      { name: 'BMI 26.0, healthy waist, non-HDL 4.9 with LDL 4.5 (non-HDL is the plan\'s marker)', weightKg: 82.4, waistCm: 81.9, totalCholesterol: 6.1, hdlC: 1.2, ldlC: 4.5, on: false, reasons: [] },
      { name: 'BMI 26.0, WHtR 0.4978 (0.50 rounded)', weightKg: 82.4, waistCm: 88.6, on: true, reasons: [WAIST] },
      { name: 'BMI 26.0, WHtR 0.4949 (0.49 rounded)', weightKg: 82.4, waistCm: 88.1, on: false, reasons: [] },
      { name: 'BMI 26.0, WHtR 0.52, TG 2.0', weightKg: 82.4, waistCm: 92.6, triglycerides: 2, on: true, reasons: [TG, WAIST] },
      { name: 'BMI 26.0, no waist, TG 150 mg/dL', weightKg: 82.4, triglycerides: trig(150), on: true, reasons: [TG] },
      { name: 'BMI 26.0, no waist, TG 149 mg/dL', weightKg: 82.4, triglycerides: trig(149), on: false, reasons: [] },
      { name: 'BMI 26.0, no waist, BP 130/75', weightKg: 82.4, systolicBp: 130, diastolicBp: 75, on: true, reasons: [BP] },
      { name: 'BMI 26.0, no waist, BP 129/75', weightKg: 82.4, systolicBp: 129, diastolicBp: 75, on: false, reasons: [] },
      { name: 'BMI 26.0, no waist, HbA1c 5.7%', weightKg: 82.4, hba1c: hba1c(5.7), on: true, reasons: [HBA1C] },
      { name: 'BMI 26.0, no waist, HbA1c 5.6%', weightKg: 82.4, hba1c: hba1c(5.6), on: false, reasons: [] },
      { name: 'BMI 27.0, unknown waist, no marker', weightKg: 85.5, on: false, reasons: [] },
      { name: 'BMI 28.0 (28.03 raw), no waist, no marker', weightKg: 88.8, on: false, reasons: [] },
      { name: 'BMI 28.1, no waist, no marker', weightKg: 89, on: true, reasons: [] },
      { name: 'BMI 28.5, unknown waist, no marker', weightKg: 90.3, on: true, reasons: [] },
      { name: 'BMI 28.5, healthy waist, no marker', weightKg: 90.3, waistCm: 83.7, on: false, reasons: [] },
      { name: "BMI 28.6, WHtR 0.47, no marker (Brad's ruling 1)", weightKg: 90.6, waistCm: 83.7, on: false, reasons: [] },
      { name: 'BMI 28.6, WHtR 0.47, HbA1c, TG and BP raised (group 2)', weightKg: 90.6, waistCm: 83.7, hba1c: 48, triglycerides: 2, systolicBp: 140, diastolicBp: 90, on: true, reasons: [HBA1C, TG, BP] },
      { name: 'BMI 29.9, WHtR 0.52', weightKg: 94.7, waistCm: 92.6, on: true, reasons: [WAIST] },
      { name: 'BMI 30.0, WHtR 0.40', weightKg: 95.1, waistCm: 71.2, on: true, reasons: [] },
      { name: 'BMI 30.5, healthy waist, no marker', weightKg: 96.6, waistCm: 83.7, on: true, reasons: [] },
      { name: 'BMI 35.0 with every marker raised', weightKg: 111, waistCm: 106.8, hba1c: 48, triglycerides: 2, systolicBp: 140, diastolicBp: 90, apoB: 1.5, on: true, reasons: [HBA1C, TG, BP, APOB, WAIST] },
    ];
    const inputsOf = ({ name: _n, on: _o, reasons: _r, ...values }: Row): HealthInputs => ({ heightCm: 178, sex: 'male', ...values });

    it.each(table)('the plan, medications tracked: $name', (row) => {
      const results = calculateHealthResults(inputsOf(row), 'si', {});
      const glp1 = results.suggestions.find(s => s.id === 'weight-med-glp1');
      expect(glp1 !== undefined).toBe(row.on);
      if (row.on) {
        const and = row.reasons.length > 0 ? ` and ${joinWithAnd(row.reasons)}` : '';
        expect(glp1!.description).toBe(`With a BMI of ${results.bmi}${and}, you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor, alongside diet, exercise and sleep. These medications support weight management and metabolic health.`);
      }
    });

    it.each(table)('the plan, medications not tracked, shows the standalone card on the same trigger: $name', (row) => {
      const ids = calculateHealthResults(inputsOf(row), 'si').suggestions.map(s => s.id);
      expect(ids.includes('weight-glp1')).toBe(row.on);
      expect(ids.some(id => id.startsWith('weight-med-'))).toBe(false);
    });

    it.each(table)('the trigger: $name', (row) => {
      const inputs = inputsOf(row);
      expect(weightMedicationTrigger(inputs, calculateHealthResults(inputs, 'si', {})))
        .toEqual({ on: row.on, reasons: row.reasons });
    });

    it('non-HDL 4.95, at or above the 190 mg/dL (4.91) line, is a marker at BMI 26 with a healthy waist', () => {
      const { inputs, results } = createTestData({}, { bmi: 26, waistToHeightRatio: 0.46, nonHdlCholesterol: 4.95 });
      expect(weightMedicationTrigger(inputs, results)).toEqual({ on: true, reasons: [NON_HDL] });
    });
  });

  describe('Weight medication card wording (US-06 AC6)', () => {
    const TAIL = ', you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor, alongside diet, exercise and sleep. These medications support weight management and metabolic health.';
    const cases: { name: string; bmi: number; whr?: number; inputs: Partial<HealthInputs>; text: string }[] = [
      { name: 'no reason', bmi: 30.5, inputs: {}, text: `With a BMI of 30.5${TAIL}` },
      { name: 'a whole-number BMI prints as the tile shows it', bmi: 31, inputs: {}, text: `With a BMI of 31${TAIL}` },
      { name: 'one reason', bmi: 26, whr: 0.46, inputs: { hba1c: 40 }, text: `With a BMI of 26 and prediabetic HbA1c${TAIL}` },
      {
        name: 'three reasons',
        bmi: 26,
        whr: 0.46,
        inputs: { hba1c: 40, triglycerides: 2, systolicBp: 135, diastolicBp: 85 },
        text: `With a BMI of 26 and prediabetic HbA1c, elevated triglycerides and elevated blood pressure${TAIL}`,
      },
    ];

    it.each(cases)('step 1 card, $name', ({ bmi, whr, inputs: values, text }) => {
      const { inputs, results } = createTestData(values, { bmi, waistToHeightRatio: whr });
      const card = generateSuggestions(inputs, results, 'si', {}).find(s => s.id === 'weight-med-glp1');
      expect(card?.title).toBe('Consider a GLP-1 medication');
      expect(card?.description).toBe(text);
    });

    it.each(cases)('standalone card, $name', ({ bmi, whr, inputs: values, text }) => {
      const { inputs, results } = createTestData(values, { bmi, waistToHeightRatio: whr });
      const card = generateSuggestions(inputs, results).find(s => s.id === 'weight-glp1');
      expect(card?.title).toBe('Weight management medication');
      expect(card?.description).toBe(text);
    });

    it('joinWithAnd joins "a, b and c"', () => {
      expect(joinWithAnd([])).toBe('');
      expect(joinWithAnd(['a'])).toBe('a');
      expect(joinWithAnd(['a', 'b'])).toBe('a and b');
      expect(joinWithAnd(['a', 'b', 'c'])).toBe('a, b and c');
    });
  });

  describe('The BP weight paragraph follows the weight-medication trigger (US-06 AC6)', () => {
    const PARAGRAPH = 'Weight loss is one of the most effective ways to lower blood pressure. Even a 5% reduction can make a meaningful difference. GLP-1 medications (tirzepatide, semaglutide) can assist with both weight loss and blood pressure reduction.';

    it('shows at BMI 26 with a healthy waist and BP 135/85', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { bmi: 26, waistToHeightRatio: 0.46 });
      const card = generateSuggestions(inputs, results).find(s => s.id === 'bp-stage1');
      expect(card?.description).toContain(PARAGRAPH);
      expect(card?.description).not.toContain('\u2014');
    });

    it('does not show at BMI 24 with BP 135/85', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { bmi: 24 });
      const card = generateSuggestions(inputs, results).find(s => s.id === 'bp-stage1');
      expect(card).toBeDefined();
      expect(card?.description).not.toContain('Weight loss');
    });
  });

  describe('lipidMarkerFor: the plan\'s one lipid marker (US-06 AC6)', () => {
    it('reads ApoB, then the computed non-HDL, then LDL', () => {
      const { inputs, results } = createTestData({ apoB: 0.9, ldlC: 3 }, { nonHdlCholesterol: 3.5 });
      expect(lipidMarkerFor(inputs, results)?.kind).toBe('apoB');
      expect(lipidMarkerFor({ ...inputs, apoB: undefined }, results)?.kind).toBe('nonHdl');
      expect(lipidMarkerFor({ ...inputs, apoB: undefined }, { ...results, nonHdlCholesterol: undefined })?.kind).toBe('ldl');
      expect(lipidMarkerFor({}, { ...results, nonHdlCholesterol: undefined })).toBeNull();
    });
  });

  describe('GLP-1 escalation in weight & diabetes cascade', () => {
    // All tests use BMI > 28 with HbA1c to trigger cascade
    const cascadeOverrides = { hba1c: hba1c(5.8) };
    const cascadeBmi = { bmi: 29 };

    it('suggests GLP-1 dose increase when not on max dose', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = { glp1: { drug: 'semaglutide_injection', dose: 1 } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1-increase')).toBeDefined();
      expect(suggestions.find(s => s.id === 'weight-med-glp1-switch')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'weight-med-sglt2i')).toBeUndefined();
    });

    it('suggests GLP-1 dose increase for sub-max tirzepatide', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = { glp1: { drug: 'tirzepatide', dose: 5 } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1-increase')).toBeDefined();
      expect(suggestions.find(s => s.id === 'weight-med-glp1-switch')).toBeUndefined();
    });

    it('suggests switching to tirzepatide when on max dose of semaglutide injection', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = { glp1: { drug: 'semaglutide_injection', dose: 2.4 } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1-switch')).toBeDefined();
      expect(suggestions.find(s => s.id === 'weight-med-glp1-increase')).toBeUndefined();
    });

    it('suggests switching to tirzepatide when on max dose of dulaglutide', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = { glp1: { drug: 'dulaglutide', dose: 4.5 } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1-switch')).toBeDefined();
    });

    it('suggests switching to tirzepatide when on max dose of oral semaglutide', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = { glp1: { drug: 'semaglutide_oral', dose: 14 } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1-switch')).toBeDefined();
    });

    it('suggests switching to tirzepatide when on "other" GLP-1', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = { glp1: { drug: 'other', dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1-switch')).toBeDefined();
      expect(suggestions.find(s => s.id === 'weight-med-sglt2i')).toBeUndefined();
    });

    it('skips escalation when on tirzepatide max dose (15mg) → shows SGLT2i', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = { glp1: { drug: 'tirzepatide', dose: 15 } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1-increase')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'weight-med-glp1-switch')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'weight-med-sglt2i')).toBeDefined();
    });

    it('skips escalation when GLP-1 not tolerated → shows SGLT2i', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = { glp1: { drug: 'not_tolerated', dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1-increase')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'weight-med-glp1-switch')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'weight-med-sglt2i')).toBeDefined();
    });

    it('shows SGLT2i when GLP-1 escalation not tolerated', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = {
        glp1: { drug: 'semaglutide_injection', dose: 1 },
        glp1Escalation: 'not_tolerated',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1-increase')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'weight-med-sglt2i')).toBeDefined();
    });

    it('shows SGLT2i when "other" GLP-1 escalation not tolerated', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = {
        glp1: { drug: 'other', dose: null },
        glp1Escalation: 'not_tolerated',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'weight-med-glp1-switch')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'weight-med-sglt2i')).toBeDefined();
    });

    it('full 4-step cascade: no suggestions when all completed', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = {
        glp1: { drug: 'tirzepatide', dose: 15 },
        sglt2i: { drug: 'empagliflozin', dose: 10 },
        metformin: 'xr_1000',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.filter(s => s.id?.startsWith('weight-med-')).length).toBe(0);
    });

    it('handles GLP-1 with null dose without crashing', () => {
      const { inputs, results } = createTestData(cascadeOverrides, cascadeBmi);
      const meds: MedicationInputs = { glp1: { drug: 'semaglutide_injection', dose: null } };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      // Should not crash — dose: null means we can't confirm dose so no escalation
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeUndefined(); // already on a GLP-1
    });
  });

  describe('GLP-1 escalation helper functions', () => {
    it('canIncreaseGlp1Dose returns true for sub-max dose', () => {
      expect(canIncreaseGlp1Dose('semaglutide_injection', 1)).toBe(true);
      expect(canIncreaseGlp1Dose('tirzepatide', 5)).toBe(true);
      expect(canIncreaseGlp1Dose('dulaglutide', 0.75)).toBe(true);
      expect(canIncreaseGlp1Dose('semaglutide_oral', 3)).toBe(true);
    });

    it('canIncreaseGlp1Dose returns false for max dose', () => {
      expect(canIncreaseGlp1Dose('semaglutide_injection', 2.4)).toBe(false);
      expect(canIncreaseGlp1Dose('tirzepatide', 15)).toBe(false);
      expect(canIncreaseGlp1Dose('dulaglutide', 4.5)).toBe(false);
      expect(canIncreaseGlp1Dose('semaglutide_oral', 14)).toBe(false);
    });

    it('canIncreaseGlp1Dose returns false for special values', () => {
      expect(canIncreaseGlp1Dose('none', null)).toBe(false);
      expect(canIncreaseGlp1Dose('not_tolerated', null)).toBe(false);
      expect(canIncreaseGlp1Dose('other', null)).toBe(false);
      expect(canIncreaseGlp1Dose(undefined, null)).toBe(false);
    });

    it('shouldSuggestGlp1Switch returns true for max dose of non-tirzepatide', () => {
      expect(shouldSuggestGlp1Switch('semaglutide_injection', 2.4)).toBe(true);
      expect(shouldSuggestGlp1Switch('dulaglutide', 4.5)).toBe(true);
      expect(shouldSuggestGlp1Switch('semaglutide_oral', 14)).toBe(true);
    });

    it('shouldSuggestGlp1Switch returns false for tirzepatide', () => {
      expect(shouldSuggestGlp1Switch('tirzepatide', 15)).toBe(false);
      expect(shouldSuggestGlp1Switch('tirzepatide', 5)).toBe(false);
    });

    it('shouldSuggestGlp1Switch returns true for "other"', () => {
      expect(shouldSuggestGlp1Switch('other', null)).toBe(true);
    });

    it('shouldSuggestGlp1Switch returns false for sub-max dose', () => {
      expect(shouldSuggestGlp1Switch('semaglutide_injection', 1)).toBe(false);
    });
  });

  describe('Supplement suggestions', () => {
    it('always includes five generic supplement profiles', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);

      const supplements = suggestions.filter(s => s.category === 'supplements');
      expect(supplements).toHaveLength(5);
      expect(supplements.map(s => s.id)).toEqual([
        'supplement-micronutrient-base',
        'supplement-creatine',
        'supplement-collagen',
        'supplement-omega3',
        'supplement-sleep',
      ]);
    });

    it('no supplement suggestion has a commerce link (compliance)', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);

      const supplements = suggestions.filter(s => s.category === 'supplements');
      expect(supplements.every(s => s.link === undefined)).toBe(true);
    });

    it('no supplement suggestion names a branded product (compliance)', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);

      const supplements = suggestions.filter(s => s.category === 'supplements');
      const text = supplements
        .map(s => `${s.title} ${s.description} ${(s.ingredients ?? []).join(' ')}`)
        .join(' ')
        .toLowerCase();
      expect(text).not.toContain('microvitamin');
      expect(text).not.toContain('dr brad');
      expect(text).not.toContain('drstanfield');
    });

    it('grouped profiles expose ingredient lists', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);

      const base = suggestions.find(s => s.id === 'supplement-micronutrient-base');
      const sleep = suggestions.find(s => s.id === 'supplement-sleep');
      expect(base?.ingredients).toContain('Magnesium taurate');
      expect(sleep?.ingredients).toContain('Low-dose melatonin');
    });

    it('supplement suggestions have info priority', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);

      const supplements = suggestions.filter(s => s.category === 'supplements');
      expect(supplements.every(s => s.priority === 'info')).toBe(true);
    });

    it('supplement descriptions lead with clinical-trial evidence', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);

      // Each card's user-facing description should surface the actual trial /
      // meta-analysis evidence from evidence.ts (trial + finding + dose), not
      // generic marketing language.
      const expectMentions: Record<string, RegExp> = {
        'supplement-micronutrient-base': /COSMOS/i,
        'supplement-creatine': /meta-analysis/i,
        'supplement-collagen': /26 randomised controlled trials/i,
        'supplement-omega3': /cardiovascular events/i,
        'supplement-sleep': /melatonin/i,
      };
      for (const [id, re] of Object.entries(expectMentions)) {
        const s = suggestions.find(x => x.id === id);
        expect(s, `missing ${id}`).toBeTruthy();
        expect(s!.description, `${id} description should mention trial evidence`).toMatch(re);
      }
    });

    it('supplement suggestions expose DOI references only — no duplicated reason prose', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);

      const supplements = suggestions.filter(s => s.category === 'supplements');
      // The trial summary already lives in the visible card `description`, so the
      // "Why this suggestion?" expansion must render references ONLY — `reason`
      // (and guidelines) are intentionally NOT attached, to avoid repetition.
      expect(supplements.length).toBeGreaterThan(0);
      expect(supplements.every(s => !s.reason)).toBe(true);
      expect(supplements.every(s => (s.guidelines?.length ?? 0) === 0)).toBe(true);
      expect(supplements.every(s => (s.references?.length ?? 0) > 0)).toBe(true);
      expect(supplements.every(s =>
        (s.references ?? []).every(r => r.url.includes('doi.org') || r.url.startsWith('https://')),
      )).toBe(true);
    });

  });

  describe('Protein target CKD adjustment', () => {
    it('shows standard 1.2g/kg protein when eGFR is normal', () => {
      const { inputs, results } = createTestData({}, { eGFR: 90, proteinTarget: 89 });
      const suggestions = generateSuggestions(inputs, results);
      const protein = suggestions.find(s => s.id === 'protein-target');
      expect(protein?.description).not.toContain('kidney function');
    });

    it('shows CKD-adjusted text when eGFR < 45', () => {
      // CKD Stage 3b: eGFR < 45 → 1.0g/kg
      const { inputs, results } = createTestData({}, { eGFR: 40, proteinTarget: 74 });
      const suggestions = generateSuggestions(inputs, results);
      const protein = suggestions.find(s => s.id === 'protein-target');
      expect(protein?.description).toContain('kidney function');
      expect(protein?.description).toContain('1.0g per kg');
    });

    it('shows standard text when eGFR is exactly 45', () => {
      const { inputs, results } = createTestData({}, { eGFR: 45, proteinTarget: 89 });
      const suggestions = generateSuggestions(inputs, results);
      const protein = suggestions.find(s => s.id === 'protein-target');
      expect(protein?.description).not.toContain('kidney function');
    });
  });

  describe('Alcohol reduction suggestion', () => {
    it('shows alcohol reduction when BMI >= 30', () => {
      const { inputs, results } = createTestData({}, { bmi: 31 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'reduce-alcohol')).toBeDefined();
      expect(suggestions.find(s => s.id === 'reduce-alcohol')?.priority).toBe('attention');
    });

    it('shows alcohol reduction when BMI 25-29.9 and WHtR >= 0.5', () => {
      const { inputs, results } = createTestData({}, { bmi: 27, waistToHeightRatio: 0.55 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'reduce-alcohol')).toBeDefined();
    });

    it('hides alcohol reduction when BMI 25-29.9 and WHtR < 0.5', () => {
      const { inputs, results } = createTestData({}, { bmi: 27, waistToHeightRatio: 0.45 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'reduce-alcohol')).toBeUndefined();
    });

    it('hides alcohol reduction when BMI 25-29.9 and no waist data', () => {
      const { inputs, results } = createTestData({}, { bmi: 27 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'reduce-alcohol')).toBeUndefined();
    });

    it('shows alcohol reduction when triglycerides elevated', () => {
      const { inputs, results } = createTestData({ triglycerides: trig(160) }, { bmi: 22 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'reduce-alcohol')).toBeDefined();
    });

    it('hides alcohol reduction when BMI ≤ 25 and no elevated trigs', () => {
      const { inputs, results } = createTestData({}, { bmi: 23 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'reduce-alcohol')).toBeUndefined();
    });

    it('hides alcohol reduction when no BMI and no trigs', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'reduce-alcohol')).toBeUndefined();
    });
  });

  describe('DEXA bone density screening suggestions', () => {
    it('suggests DEXA for female age 50+', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1975, birthMonth: 1 }, { age: 51 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-dexa')).toBeDefined();
    });

    it('suggests DEXA for male age 70+', () => {
      const { inputs, results } = createTestData({ sex: 'male', birthYear: 1955, birthMonth: 1 }, { age: 71 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-dexa')).toBeDefined();
    });

    it('does not suggest DEXA for female age 49', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1977, birthMonth: 1 }, { age: 49 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-dexa')).toBeUndefined();
    });

    it('does not suggest DEXA for male age 69', () => {
      const { inputs, results } = createTestData({ sex: 'male', birthYear: 1957, birthMonth: 1 }, { age: 69 });
      const scr: ScreeningInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-dexa')).toBeUndefined();
    });

    it('shows overdue when DEXA normal result is past 5-year interval', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { dexaScreening: 'dexa_scan', dexaLastDate: '2019-06', dexaResult: 'normal' };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-dexa-overdue')).toBeDefined();
    });

    it('shows overdue when DEXA osteopenia result is past 2-year interval', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { dexaScreening: 'dexa_scan', dexaLastDate: '2023-01', dexaResult: 'osteopenia' };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-dexa-overdue')).toBeDefined();
    });

    it('shows up-to-date for recent normal DEXA', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const now = new Date();
      const lastMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const scr: ScreeningInputs = { dexaScreening: 'dexa_scan', dexaLastDate: lastMonth, dexaResult: 'normal' };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-dexa-upcoming')).toBeDefined();
    });

    it('shows follow-up for osteoporosis without organized follow-up', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { dexaScreening: 'dexa_scan', dexaLastDate: '2024-06', dexaResult: 'osteoporosis' };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-dexa-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('urgent');
    });

    it('does not suggest when not_yet_started is selected', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { dexaScreening: 'not_yet_started' };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-dexa')).toBeDefined(); // should suggest starting
      expect(suggestions.find(s => s.id === 'screening-dexa-overdue')).toBeUndefined();
    });

    it('shows up-to-date for recent osteoporosis DEXA when follow-up completed without date', () => {
      const { inputs, results } = createTestData({ sex: 'female', birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const now = new Date();
      const lastMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const scr: ScreeningInputs = {
        dexaScreening: 'dexa_scan',
        dexaLastDate: lastMonth,
        dexaResult: 'osteoporosis',
        dexaFollowupStatus: 'completed',
        // no dexaFollowupDate — screeningFollowup returns null, should fall through to upcoming
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-dexa-upcoming')).toBeDefined();
    });
  });

  describe('Skin health suggestions', () => {
    it('includes all four skin suggestions for users age 18+', () => {
      const { inputs, results } = createTestData({}, { age: 26 });
      const suggestions = generateSuggestions(inputs, results);
      const skin = suggestions.filter(s => s.category === 'skin');
      expect(skin).toHaveLength(4);
      expect(skin.map(s => s.id)).toEqual([
        'skin-moisturizer', 'skin-sunscreen', 'skin-retinoid', 'skin-advanced',
      ]);
    });

    it('all skin suggestions have info priority', () => {
      const { inputs, results } = createTestData({}, { age: 26 });
      const suggestions = generateSuggestions(inputs, results);
      const skin = suggestions.filter(s => s.category === 'skin');
      expect(skin.every(s => s.priority === 'info')).toBe(true);
    });

    it('does not include skin suggestions when age < 18', () => {
      const { inputs, results } = createTestData({}, { age: 16 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.filter(s => s.category === 'skin')).toHaveLength(0);
    });

    it('includes skin suggestions at exactly age 18', () => {
      const { inputs, results } = createTestData({}, { age: 18 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.filter(s => s.category === 'skin')).toHaveLength(4);
    });

    it('excludes skin suggestions at exactly age 17', () => {
      const { inputs, results } = createTestData({}, { age: 17 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.filter(s => s.category === 'skin')).toHaveLength(0);
    });

    it('includes skin suggestions when age is undefined', () => {
      const { inputs, results } = createTestData({}, {});
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.filter(s => s.category === 'skin')).toHaveLength(4);
    });

    it('recommends CeraVe mineral sunscreen for conventional (US) unit system', () => {
      const { inputs, results } = createTestData({}, { age: 30 });
      const suggestions = generateSuggestions(inputs, results, 'conventional');
      const sunscreen = suggestions.find(s => s.id === 'skin-sunscreen')!;
      expect(sunscreen.description).toContain('CeraVe');
      expect(sunscreen.description).toContain('Mineral');
      expect(sunscreen.description).not.toContain('Beauty of Joseon');
    });

    it('recommends Beauty of Joseon sunscreen for SI (non-US) unit system', () => {
      const { inputs, results } = createTestData({}, { age: 30 });
      const suggestions = generateSuggestions(inputs, results, 'si');
      const sunscreen = suggestions.find(s => s.id === 'skin-sunscreen')!;
      expect(sunscreen.description).toContain('Beauty of Joseon');
      expect(sunscreen.description).not.toContain('CeraVe');
    });

    it('retinoid suggestion includes pregnancy caution', () => {
      const { inputs, results } = createTestData({}, { age: 30 });
      const suggestions = generateSuggestions(inputs, results);
      const retinoid = suggestions.find(s => s.id === 'skin-retinoid')!;
      expect(retinoid.description).toContain('pregnancy');
    });
  });

  describe('Lp(a) suggestions', () => {
    it('the checklist marks a lipid at exactly its target as above it, and names the target as "<" (US-07 AC5)', () => {
      const { inputs, results } = createTestData({ lpa: 150, ldlC: 1.4 });
      const text = generateSuggestions(inputs, results).find(s => s.id === 'lpa-elevated')?.description;
      expect(text).toContain('\u26A0\uFE0F LDL-c: 1.4 mmol/L \u2014 target <1.4 mmol/L');
      const below = createTestData({ lpa: 150, ldlC: 1.3 });
      expect(generateSuggestions(below.inputs, below.results).find(s => s.id === 'lpa-elevated')?.description)
        .toContain('\u2705 LDL-c: 1.3 mmol/L \u2014 target <1.4 mmol/L');
    });

    // US-07 AC1: the checklist's BP target is the plan's age-dependent one, as on the stage 1 card
    it.each([
      [68, 125, '✅ Blood pressure: 125/75 mmHg — target <130/80'],
      [68, 131, '⚠️ Blood pressure: 131/75 mmHg — target <130/80'],
      [50, 125, '⚠️ Blood pressure: 125/75 mmHg — target <120/80'],
      [undefined, 118, '✅ Blood pressure: 118/75 mmHg — target <120/80'],
    ])('the checklist grades BP against the target for age %s (systolic %s)', (age, systolicBp, line) => {
      const { inputs, results } = createTestData({ lpa: 150, systolicBp, diastolicBp: 75 }, { age });
      expect(generateSuggestions(inputs, results).find(s => s.id === 'lpa-elevated')?.description).toContain(line);
    });

    it('generates normal suggestion for Lp(a) < 75 nmol/L', () => {
      const { inputs, results } = createTestData({ lpa: 30 });
      const suggestions = generateSuggestions(inputs, results);
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-normal');
      expect(lpaSuggestion).toBeDefined();
      expect(lpaSuggestion?.priority).toBe('info');
      expect(lpaSuggestion?.description).toContain('normal range');
      expect(lpaSuggestion?.description).toContain('one-time test');
    });

    it('generates borderline suggestion for Lp(a) 75-124 nmol/L', () => {
      const { inputs, results } = createTestData({ lpa: 100 });
      const suggestions = generateSuggestions(inputs, results);
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-borderline');
      expect(lpaSuggestion).toBeDefined();
      expect(lpaSuggestion?.priority).toBe('info');
      expect(lpaSuggestion?.description).toContain('borderline');
    });

    it('generates elevated suggestion with risk checklist for Lp(a) >= 125 nmol/L', () => {
      const { inputs, results } = createTestData(
        { lpa: 200, apoB: apoB(45), systolicBp: 118, diastolicBp: 75, hba1c: hba1c(5.2) },
        { bmi: 23 }
      );
      const suggestions = generateSuggestions(inputs, results, 'conventional');
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-elevated');
      expect(lpaSuggestion).toBeDefined();
      expect(lpaSuggestion?.priority).toBe('attention');
      expect(lpaSuggestion?.title).toContain('200 nmol/L');
      expect(lpaSuggestion?.description).toContain('genetically determined');
      // On-target items should show checkmark
      expect(lpaSuggestion?.description).toContain('\u2705');
    });

    it('shows warning markers for off-target risk factors', () => {
      const { inputs, results } = createTestData(
        { lpa: 150, apoB: apoB(120), systolicBp: 145, diastolicBp: 95, hba1c: hba1c(6.8) },
        { bmi: 31 }
      );
      const suggestions = generateSuggestions(inputs, results, 'conventional');
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-elevated');
      expect(lpaSuggestion).toBeDefined();
      // Off-target items should show warning
      expect(lpaSuggestion?.description).toContain('\u26A0\uFE0F');
      expect(lpaSuggestion?.description).toContain('ApoB');
      expect(lpaSuggestion?.description).toContain('Blood pressure');
      expect(lpaSuggestion?.description).toContain('BMI');
      expect(lpaSuggestion?.description).toContain('HbA1c');
    });

    it('shows "not tested" prompts for missing data', () => {
      const { inputs, results } = createTestData({ lpa: 200 });
      const suggestions = generateSuggestions(inputs, results);
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-elevated');
      expect(lpaSuggestion).toBeDefined();
      expect(lpaSuggestion?.description).toContain('not tested');
      expect(lpaSuggestion?.description).toContain('not entered');
    });

    it('includes medication status in checklist when medications provided', () => {
      const { inputs, results } = createTestData({ lpa: 200 });
      const meds: MedicationInputs = {
        statin: { drug: 'atorvastatin', dose: 40 },
        ezetimibe: 'yes',
        pcsk9i: 'not_yet',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-elevated');
      expect(lpaSuggestion).toBeDefined();
      expect(lpaSuggestion?.description).toContain('Atorvastatin');
      expect(lpaSuggestion?.description).toContain('40mg');
      expect(lpaSuggestion?.description).toContain('Ezetimibe: taking');
      expect(lpaSuggestion?.description).toContain('PCSK9 inhibitor: not started');
      expect(lpaSuggestion?.description).toContain('25\u201330%');
    });

    it('shows PCSK9i as taking with Lp(a) reduction note', () => {
      const { inputs, results } = createTestData({ lpa: 200 });
      const meds: MedicationInputs = {
        statin: { drug: 'rosuvastatin', dose: 20 },
        ezetimibe: 'yes',
        pcsk9i: 'yes',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-elevated');
      expect(lpaSuggestion?.description).toContain('PCSK9 inhibitor: taking');
      expect(lpaSuggestion?.description).toContain('25\u201330%');
    });

    it('does not generate suggestion when Lp(a) is undefined', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id.startsWith('lpa-'))).toBeUndefined();
    });

    it('shows same unit (nmol/L) in both SI and conventional', () => {
      const { inputs, results } = createTestData({ lpa: 50 });
      const siSuggestions = generateSuggestions(inputs, results, 'si');
      const convSuggestions = generateSuggestions(inputs, results, 'conventional');
      expect(siSuggestions.find(s => s.id === 'lpa-normal')?.title).toContain('nmol/L');
      expect(convSuggestions.find(s => s.id === 'lpa-normal')?.title).toContain('nmol/L');
    });

    it('uses LDL when ApoB is unavailable in checklist', () => {
      const { inputs, results } = createTestData({ lpa: 200, ldlC: ldl(80) });
      const suggestions = generateSuggestions(inputs, results, 'conventional');
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-elevated');
      expect(lpaSuggestion?.description).toContain('LDL-c');
      expect(lpaSuggestion?.description).not.toContain('ApoB');
    });

    it('uses non-HDL when ApoB unavailable but total + HDL provided', () => {
      const { inputs, results } = createTestData(
        { lpa: 200, totalCholesterol: totalChol(250), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(250) - hdl(50) }
      );
      const suggestions = generateSuggestions(inputs, results, 'conventional');
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-elevated');
      expect(lpaSuggestion?.description).toContain('non-HDL cholesterol');
      expect(lpaSuggestion?.description).not.toContain('ApoB');
      expect(lpaSuggestion?.description).not.toContain('LDL-c');
    });

    it('does not include medication checklist when medications not provided', () => {
      const { inputs, results } = createTestData({ lpa: 200 });
      const suggestions = generateSuggestions(inputs, results);
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-elevated');
      expect(lpaSuggestion?.description).not.toContain('Statin');
      expect(lpaSuggestion?.description).not.toContain('Ezetimibe');
      expect(lpaSuggestion?.description).not.toContain('PCSK9');
    });

    it('handles exact boundary at 75 nmol/L (borderline)', () => {
      const { inputs, results } = createTestData({ lpa: 75 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'lpa-borderline')).toBeDefined();
      expect(suggestions.find(s => s.id === 'lpa-normal')).toBeUndefined();
    });

    it('handles exact boundary at 125 nmol/L (elevated)', () => {
      const { inputs, results } = createTestData({ lpa: 125 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'lpa-elevated')).toBeDefined();
      expect(suggestions.find(s => s.id === 'lpa-borderline')).toBeUndefined();
    });

    it('shows BMI checkmark when BMI 25-29.9 with healthy WHtR (composite assessment)', () => {
      const { inputs, results } = createTestData(
        { lpa: 200, apoB: apoB(45), systolicBp: 118, diastolicBp: 75, hba1c: hba1c(5.2) },
        { bmi: 27, waistToHeightRatio: 0.44 }
      );
      const suggestions = generateSuggestions(inputs, results, 'conventional');
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-elevated');
      expect(lpaSuggestion?.description).toContain('\u2705 BMI: 27');
    });

    it('shows BMI warning when BMI 25-29.9 with elevated WHtR', () => {
      const { inputs, results } = createTestData(
        { lpa: 200, apoB: apoB(45), systolicBp: 118, diastolicBp: 75, hba1c: hba1c(5.2) },
        { bmi: 27, waistToHeightRatio: 0.55 }
      );
      const suggestions = generateSuggestions(inputs, results, 'conventional');
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-elevated');
      expect(lpaSuggestion?.description).toContain('\u26A0\uFE0F BMI: 27');
    });
  });
});

describe('lipidMarkerFor: the ApoB > non-HDL > LDL-c hierarchy', () => {
  const markerOf = (apoB: number | undefined, nonHdlCholesterol: number | undefined, ldlC: number | undefined) =>
    lipidMarkerFor({ apoB, ldlC }, { nonHdlCholesterol });

  it('returns ApoB when all markers available', () => {
    const result = markerOf(0.6, 2.0, 1.5);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('apoB');
    expect(result!.label).toBe('ApoB');
    expect(result!.elevated).toBe(true); // 0.6 > 0.5
  });

  it('returns non-HDL when ApoB unavailable', () => {
    const result = markerOf(undefined, 2.0, 1.5);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('nonHdl');
    expect(result!.label).toBe('non-HDL cholesterol');
    expect(result!.elevated).toBe(true); // 2.0 > 1.6
  });

  it('returns LDL when ApoB and non-HDL unavailable', () => {
    const result = markerOf(undefined, undefined, 1.5);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('ldl');
    expect(result!.label).toBe('LDL-c');
    expect(result!.elevated).toBe(true); // 1.5 > 1.4
  });

  it('returns null when no lipid data', () => {
    expect(markerOf(undefined, undefined, undefined)).toBeNull();
  });

  it('reports not elevated when below target', () => {
    const result = markerOf(0.4, undefined, undefined);
    expect(result!.kind).toBe('apoB');
    expect(result!.elevated).toBe(false);
  });

  // US-07 AC5 (Brad, 2026-09-28): the target itself is above target; the
  // treatment target is BELOW 0.5 / 1.6 / 1.4.
  it.each([
    { name: 'ApoB 0.5', args: [0.5, undefined, undefined], elevated: true },
    { name: 'ApoB 0.49', args: [0.49, undefined, undefined], elevated: false },
    { name: 'non-HDL 1.6', args: [undefined, 1.6, undefined], elevated: true },
    { name: 'non-HDL 1.59', args: [undefined, 1.59, undefined], elevated: false },
    { name: 'LDL 1.4', args: [undefined, undefined, 1.4], elevated: true },
    { name: 'LDL 1.39', args: [undefined, undefined, 1.39], elevated: false },
  ] as { name: string; args: [number | undefined, number | undefined, number | undefined]; elevated: boolean }[])(
    'at the target boundary, $name is elevated: $elevated (US-07 AC5)', ({ args, elevated }) => {
      expect(markerOf(...args)!.elevated).toBe(elevated);
    });

  it('includes correct target values', () => {
    const apob = markerOf(0.6, undefined, undefined);
    expect(apob!.target).toBe(LIPID_TREATMENT_TARGETS.apobGl);

    const nonHdl = markerOf(undefined, 2.0, undefined);
    expect(nonHdl!.target).toBe(LIPID_TREATMENT_TARGETS.nonHdlMmol);

    const ldlResult = markerOf(undefined, undefined, 1.5);
    expect(ldlResult!.target).toBe(LIPID_TREATMENT_TARGETS.ldlMmol);
  });
});

describe('Evidence attachment', () => {
  it('attaches reason, guidelines, and references to known suggestions', () => {
    const { inputs, results } = createTestData({}, { bmi: 22 });
    const suggestions = generateSuggestions(inputs, results, 'si');

    // protein-target is always present
    const protein = suggestions.find(s => s.id === 'protein-target');
    expect(protein).toBeDefined();
    expect(protein!.reason).toBeDefined();
    expect(protein!.reason!.length).toBeGreaterThan(0);
    expect(protein!.guidelines).toBeDefined();
    expect(protein!.guidelines!).toContain('ISSN 2017');
    expect(protein!.references).toBeDefined();
    expect(protein!.references!.length).toBeGreaterThan(0);
    expect(protein!.references![0].url).toMatch(/^https:\/\/doi\.org\//);
  });

  it('attaches evidence to exercise and sleep suggestions', () => {
    const { inputs, results } = createTestData({}, { bmi: 22 });
    const suggestions = generateSuggestions(inputs, results, 'si');

    const exercise = suggestions.find(s => s.id === 'exercise');
    expect(exercise?.reason).toBeDefined();
    expect(exercise?.references?.length).toBeGreaterThan(0);

    const sleep = suggestions.find(s => s.id === 'sleep');
    expect(sleep?.reason).toBeDefined();
    expect(sleep?.references?.length).toBeGreaterThan(0);
  });

  it('attaches evidence to screening suggestions via prefix matching', () => {
    const { inputs, results } = createTestData(
      { sex: 'male', birthYear: 1970, birthMonth: 1 },
      { bmi: 22, age: 56 },
    );
    const screenings: ScreeningInputs = { colorectalMethod: 'not_yet_started' };
    const suggestions = generateSuggestions(inputs, results, 'si', undefined, screenings);
    const colorectal = suggestions.find(s => s.id.startsWith('screening-colorectal'));
    expect(colorectal).toBeDefined();
    expect(colorectal!.reason).toBeDefined();
    // Wording changed in the 2026-07-31 de-doctoring pass — assert the stable
    // clinical claim, not attribution phrasing.
    expect(colorectal!.reason).toContain('age 35');
    expect(colorectal!.references!.length).toBeGreaterThan(0);
  });

  it('does not crash for suggestions without evidence entries', () => {
    const { inputs, results } = createTestData({}, { bmi: 22 });
    const suggestions = generateSuggestions(inputs, results, 'si');
    // All suggestions should be valid objects regardless of evidence
    for (const s of suggestions) {
      expect(s.id).toBeDefined();
      expect(s.title).toBeDefined();
    }
  });

  it('attaches evidence to borderline lipid suggestions with PESA', () => {
    const { inputs, results } = createTestData(
      { apoB: apoB(65) },
      { bmi: 22, apoB: apoB(65) },
    );
    const suggestions = generateSuggestions(inputs, results, 'si');
    const apobBorderline = suggestions.find(s => s.id === 'apob-borderline');
    expect(apobBorderline).toBeDefined();
    expect(apobBorderline!.reason).toContain('PESA');
    expect(apobBorderline!.references!.some(r => r.label.includes('PESA'))).toBe(true);
  });
});

// US-07 AC5 and US-06 AC6 (adversarial review, 2026-09-28): the plan compares
// non-HDL unrounded and rounds it only to show it. A rounded 1.6 once put a
// real 1.56 at the target, and 190 mg/dL never reached its 4.91 line. Typed
// total cholesterol and HDL go through calculateHealthResults, as in the widget.
describe('non-HDL is compared unrounded and rounded only for display (US-07 AC5, US-06 AC6)', () => {
  const planOf = (totalCholesterol: number, hdlC: number, unitSystem: UnitSystem = 'si') =>
    calculateHealthResults({ heightCm: 178, sex: 'male', totalCholesterol, hdlC }, unitSystem, {});
  const ids = (results: HealthResults) => results.suggestions.map(s => s.id);
  const statinCard = (results: HealthResults) => results.suggestions.find(s => s.id === 'med-statin')?.description;

  it('keeps the difference to 4 decimal places: 3.76 minus 2.20 is 1.56', () => {
    expect(planOf(3.76, 2.2).nonHdlCholesterol).toBe(1.56);
  });

  it.each([
    ['3.76 and 2.20 (1.56)', 3.76, 2.2, false],
    ['3.79 and 2.20 (1.59)', 3.79, 2.2, false],
    ['3.80 and 2.20 (1.60, a float a hair under it)', 3.8, 2.2, true],
    ['3.84 and 2.20 (1.64)', 3.84, 2.2, true],
  ])('mmol/L, total and HDL %s (%s, %s): at or above the target %s', (_name, total, hdlC, above) => {
    const results = planOf(total, hdlC);
    expect(ids(results).includes('med-statin')).toBe(above);
    expect(ids(results).includes('lipid-diet')).toBe(above);
    expect(ids(results).includes('fiber')).toBe(!above);
  });

  it.each([
    [90, 60, false],
    [89, 61, false],
    [88, 62, true],
  ])('mg/dL, total 150 and HDL %s (non-HDL %s): at or above the target %s', (hdlMg, _nonHdl, above) => {
    expect(ids(planOf(totalChol(150), hdl(hdlMg), 'conventional')).includes('med-statin')).toBe(above);
  });

  it('the statin card shows the value rounded, and the first value above the target', () => {
    expect(statinCard(planOf(3.84, 2.2)))
      .toMatch(/^Your non-HDL cholesterol is 1\.6 mmol\/L; the treatment target is below 1\.6 mmol\/L\. /);
    expect(statinCard(planOf(totalChol(150), hdl(88), 'conventional')))
      .toMatch(/^Your non-HDL cholesterol is 62 mg\/dL; the treatment target is below 62 mg\/dL\. /);
  });

  it.each([
    [250, true],
    [249, false],
  ])('total %s mg/dL and HDL 60 at BMI 26 with a healthy waist: the weight trigger is on %s', (total, on) => {
    const inputs: HealthInputs = { heightCm: 178, sex: 'male', weightKg: 82.4, waistCm: 81.9, totalCholesterol: totalChol(total), hdlC: hdl(60) };
    expect(weightMedicationTrigger(inputs, calculateHealthResults(inputs, 'conventional', {})))
      .toEqual(on ? { on: true, reasons: ['elevated non-HDL cholesterol'] } : { on: false, reasons: [] });
  });

  it.each([
    [160, 'Borderline', 'Above optimal'],
    [190, 'High', 'Borderline'],
    [220, 'Very High', 'High'],
  ])('mg/dL: non-HDL %s is %s, one below is %s', (line, at, below) => {
    const status = (nonHdlMg: number) => getLipidStatus(planOf(totalChol(nonHdlMg + 50), hdl(50), 'conventional').nonHdlCholesterol!, NON_HDL_THRESHOLDS);
    expect(status(line)).toBe(at);
    expect(status(line - 1)).toBe(below);
  });
});

// US-07 AC5: every "<X" statement of a lipid target prints the first value,
// at the unit's display step, that the plan grades above it. In mg/dL the LDL
// target is 55: 54 mg/dL is 1.396 mmol/L, which the plan calls optimal.
describe('lipid targets print the first value graded above them (US-07 AC5)', () => {
  const conv = (inputs: Partial<HealthInputs>, meds?: MedicationInputs) =>
    calculateHealthResults({ heightCm: 178, sex: 'male', ...inputs }, 'conventional', meds).suggestions;
  const card = (suggestions: ReturnType<typeof conv>, id: string) => suggestions.find(s => s.id === id)?.description;

  it('the statin card in mg/dL: LDL below 55', () => {
    expect(card(conv({ ldlC: ldl(116) }, {}), 'med-statin'))
      .toMatch(/^Your LDL-c is 116 mg\/dL; the treatment target is below 55 mg\/dL\. /);
  });

  it('the borderline cards in mg/dL: LDL <55, non-HDL <62, ApoB <50', () => {
    expect(card(conv({ ldlC: ldl(140) }), 'ldl-borderline')).toBe('Your LDL-c of 140 mg/dL is borderline high. Optimal is <55 mg/dL.');
    expect(card(conv({ totalCholesterol: totalChol(220), hdlC: hdl(50) }), 'non-hdl-borderline'))
      .toBe('Your non-HDL cholesterol of 170 mg/dL is borderline. Optimal is <62 mg/dL.');
    expect(card(conv({ apoB: apoB(60) }), 'apob-borderline')).toBe('Your ApoB of 60 mg/dL is borderline. Optimal is <50 mg/dL.');
  });

  it('the Lp(a) checklist in mg/dL: LDL target <55', () => {
    expect(card(conv({ ldlC: ldl(116), lpa: 200 }), 'lpa-elevated')).toContain('LDL-c: 116 mg/dL \u2014 target <55 mg/dL');
  });

  // A value off the display grid reads on the side of the target the plan grades it.
  it('LDL 1.40 mmol/L shown in mg/dL: the statin card and the checklist say 55, at the target', () => {
    const suggestions = conv({ ldlC: 1.4, lpa: 200 }, {});
    expect(card(suggestions, 'med-statin')).toMatch(/^Your LDL-c is 55 mg\/dL; the treatment target is below 55 mg\/dL\. /);
    expect(card(suggestions, 'lpa-elevated')).toContain('\u26A0\uFE0F LDL-c: 55 mg/dL \u2014 target <55 mg/dL');
  });

  it('LDL 54 mg/dL shown in mmol/L: the checklist says 1.39, below the target', () => {
    const si = calculateHealthResults({ heightCm: 178, sex: 'male', ldlC: ldl(54), lpa: 200 }, 'si', {}).suggestions;
    expect(card(si, 'lpa-elevated')).toContain('\u2705 LDL-c: 1.39 mmol/L \u2014 target <1.4 mmol/L');
  });

  it('non-HDL 1.56 (total 3.76, HDL 2.20): the checklist says 1.56, below the 1.6 target', () => {
    const si = calculateHealthResults({ heightCm: 178, sex: 'male', totalCholesterol: 3.76, hdlC: 2.2, lpa: 200 }, 'si', {}).suggestions;
    expect(card(si, 'lpa-elevated')).toContain('\u2705 non-HDL cholesterol: 1.56 mmol/L \u2014 target <1.6 mmol/L');
  });

  it('SI is unchanged: 1.4, 1.6 and 0.50', () => {
    const si = (inputs: Partial<HealthInputs>) => calculateHealthResults({ heightCm: 178, sex: 'male', ...inputs }, 'si', {}).suggestions;
    expect(card(si({ ldlC: 3 }), 'med-statin')).toMatch(/the treatment target is below 1\.4 mmol\/L\. /);
    expect(card(si({ totalCholesterol: 5, hdlC: 1.2 }), 'med-statin')).toMatch(/the treatment target is below 1\.6 mmol\/L\. /);
    expect(card(si({ apoB: 0.8 }), 'med-statin')).toMatch(/the treatment target is below 0\.50 g\/L\. /);
  });
});

// US-06 AC8 (Brad, 2026-09-28): a listed GLP-1 or statin with no dose recorded
// asks for the dose, since the next step depends on it.
describe('US-06 AC8: the dose cards', () => {
  const card = (inputs: HealthInputs, meds: MedicationInputs, id: string) =>
    calculateHealthResults(inputs, 'si', meds).suggestions.find(s => s.id === id);

  it('weight-med-glp1-dose: its title, text and evidence', () => {
    const glp1Dose = card({ heightCm: 178, sex: 'male', weightKg: 101.4 }, { glp1: { drug: 'dulaglutide', dose: null } }, 'weight-med-glp1-dose');
    expect(glp1Dose).toMatchObject({
      category: 'medication',
      priority: 'attention',
      title: 'Add your GLP-1 dose',
      description: "Your GLP-1 dose isn't recorded, and your next step depends on it. A higher dose or a switch to Tirzepatide may help. Add your current dose to see which.",
      reason: 'GLP-1 medications are started at a low dose and stepped up gradually; clinical trials used this dose escalation to improve tolerability. Which step comes next depends on the dose you take now.',
      guidelines: [],
    });
    expect(glp1Dose!.references).toEqual(card({ heightCm: 178, sex: 'male', weightKg: 101.4 },
      { glp1: { drug: 'dulaglutide', dose: 1.5 } }, 'weight-med-glp1-increase')!.references);
  });

  it('med-statin-dose: the lipid reason sentence, then its text, and its evidence', () => {
    const statinDose = card({ heightCm: 178, sex: 'male', weightKg: 70, ldlC: 3.0 },
      { statin: { drug: 'pravastatin', dose: null }, ezetimibe: 'yes', bempedoicAcid: 'not_tolerated' }, 'med-statin-dose');
    const increase = card({ heightCm: 178, sex: 'male', weightKg: 70, ldlC: 3.0 },
      { statin: { drug: 'pravastatin', dose: 20 }, ezetimibe: 'yes' }, 'med-statin-increase');
    expect(statinDose).toMatchObject({
      category: 'medication',
      priority: 'attention',
      title: 'Add your statin dose',
      description: "Your LDL-c is 3.0 mmol/L; the treatment target is below 1.4 mmol/L. Your statin dose isn't recorded, and your next step depends on it. A higher dose or a more potent statin may help. Add your current dose to see which.",
      reason: 'Statin strength depends on both the drug and the dose. Doubling a statin dose typically lowers LDL by a further 6–7% (the "rule of 6"), and rosuvastatin 40mg gives the largest reduction (~63%). Which step comes next depends on the dose you take now.',
    });
    expect(statinDose!.guidelines).toEqual(increase!.guidelines);
    expect(statinDose!.references).toEqual(increase!.references);
  });

  // Each card names only the steps its drug can take next (adversarial review,
  // 2026-09-28): rosuvastatin's highest dose and tirzepatide's move on to the
  // next medication; every other listed drug's highest dose switches.
  it('names the switch only for a drug whose highest dose switches', () => {
    const weight: HealthInputs = { heightCm: 178, sex: 'male', weightKg: 101.4 };
    const lipid: HealthInputs = { heightCm: 178, sex: 'male', weightKg: 70, ldlC: 3.0 };
    const HIGHEST = 'A higher dose may help, or you may already take the highest.';
    for (const drug of ['tirzepatide', 'semaglutide_injection', 'semaglutide_oral', 'dulaglutide']) {
      const text = card(weight, { glp1: { drug, dose: null } }, 'weight-med-glp1-dose')!.description;
      expect(text, drug).toContain(drug === 'tirzepatide' ? HIGHEST : 'A higher dose or a switch to Tirzepatide may help.');
    }
    for (const drug of ['rosuvastatin', 'atorvastatin', 'pitavastatin', 'pravastatin', 'simvastatin']) {
      const text = card(lipid, { statin: { drug, dose: null }, ezetimibe: 'yes' }, 'med-statin-dose')!.description;
      expect(text, drug).toContain(drug === 'rosuvastatin' ? HIGHEST : 'A higher dose or a more potent statin may help.');
    }
  });
});
