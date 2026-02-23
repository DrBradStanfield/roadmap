import { describe, it, expect } from 'vitest';
import { generateSuggestions } from './suggestions';
import type { HealthInputs, HealthResults, MedicationInputs, ScreeningInputs } from './types';
import { canIncreaseGlp1Dose, shouldSuggestGlp1Switch, isOnMaxGlp1Potency, getGlp1EscalationType } from './types';
import { toCanonicalValue } from './units';

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
    idealBodyWeight: 70.6,
    proteinTarget: 85,
    suggestions: [],
    ...resultOverrides,
  };

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
      expect(proteinSuggestion?.title).toContain('85g');
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
      expect(bpSuggestion?.description).toContain('reduce sodium intake (<2,300mg/day)');
    });

    it('stage 2 mentions sodium reduction', () => {
      const { inputs, results } = createTestData({ systolicBp: 145, diastolicBp: 95 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage2');
      expect(bpSuggestion?.description).toContain('reduce sodium intake (<2,300mg/day)');
    });

    it('stage 1 mentions weight loss and GLP-1 when BMI >= 25', () => {
      const { inputs, results } = createTestData({ systolicBp: 135, diastolicBp: 85 }, { bmi: 27 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-stage1');
      expect(bpSuggestion?.description).toContain('Weight loss is one of the most effective ways to lower blood pressure');
      expect(bpSuggestion?.description).toContain('GLP-1 medications');
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
      const meds: MedicationInputs = {};
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
    it('always includes fiber suggestion', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'fiber')).toBeDefined();
      expect(suggestions.find(s => s.id === 'fiber')?.category).toBe('nutrition');
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

    it('suggests GLP-1 when BMI 25-28 and no waist data', () => {
      const { inputs, results } = createTestData({}, { bmi: 26 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeDefined();
    });

    it('suggests GLP-1 when BMI 25-28 and elevated triglycerides, even with normal waist', () => {
      const { inputs, results } = createTestData(
        { triglycerides: trig(160) },  // borderline elevated
        { bmi: 26, waistToHeightRatio: 0.45 }  // normal waist
      );
      const suggestions = generateSuggestions(inputs, results);
      const glp1 = suggestions.find(s => s.id === 'weight-glp1');
      expect(glp1).toBeDefined();
      expect(glp1?.description).toContain('triglycerides');
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
      const scr: ScreeningInputs = {
        cervicalMethod: 'hpv_every_5yr',
        cervicalLastDate: '2025-01',
        cervicalResult: 'abnormal',
        cervicalFollowupStatus: 'completed',
        cervicalFollowupDate: '2025-06',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      const followup = suggestions.find(s => s.id === 'screening-cervical-followup');
      expect(followup).toBeDefined();
      expect(followup?.priority).toBe('info');
      expect(followup?.description).toContain('Jun 2026');
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
    // Trigger: BMI > 28 (unconditional) OR BMI 25-28 with (HbA1c prediabetic OR trigs >= 150 OR SBP >= 130 OR WHR >= 0.5)
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
        { systolicBp: 135 },
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

    it('shows standalone weight-glp1 when BMI 25-28 and no secondary criteria (no cascade)', () => {
      const { inputs, results } = createTestData(
        {},
        { bmi: 27 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      // No cascade (BMI 25-28 without secondary criteria), but standalone should appear
      expect(suggestions.find(s => s.id === 'weight-med-glp1')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeDefined();
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
        { systolicBp: 140 },
        { bmi: 26 },
      );
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      const glp1 = suggestions.find(s => s.id === 'weight-med-glp1');
      expect(glp1?.description).toContain('blood pressure');
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

    it('isOnMaxGlp1Potency returns true only for tirzepatide max dose', () => {
      expect(isOnMaxGlp1Potency('tirzepatide', 15)).toBe(true);
      expect(isOnMaxGlp1Potency('tirzepatide', 5)).toBe(false);
      expect(isOnMaxGlp1Potency('semaglutide_injection', 2.4)).toBe(false);
    });

    it('getGlp1EscalationType returns correct type', () => {
      expect(getGlp1EscalationType('semaglutide_injection', 1)).toBe('increase_dose');
      expect(getGlp1EscalationType('semaglutide_injection', 2.4)).toBe('switch_glp1');
      expect(getGlp1EscalationType('tirzepatide', 5)).toBe('increase_dose');
      expect(getGlp1EscalationType('tirzepatide', 15)).toBe('none');
      expect(getGlp1EscalationType('other', null)).toBe('switch_glp1');
      expect(getGlp1EscalationType('none', null)).toBe('none');
      expect(getGlp1EscalationType('not_tolerated', null)).toBe('none');
    });
  });

  describe('Supplement suggestions', () => {
    it('always includes three supplement suggestions', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);

      const supplements = suggestions.filter(s => s.category === 'supplements');
      expect(supplements).toHaveLength(3);
      expect(supplements.map(s => s.id)).toEqual([
        'supplement-microvitamin',
        'supplement-omega3',
        'supplement-sleep',
      ]);
    });

    it('all supplement suggestions have links', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);

      const supplements = suggestions.filter(s => s.category === 'supplements');
      expect(supplements.every(s => s.link)).toBe(true);
    });

    it('supplement suggestions have info priority', () => {
      const { inputs, results } = createTestData();
      const suggestions = generateSuggestions(inputs, results);

      const supplements = suggestions.filter(s => s.category === 'supplements');
      expect(supplements.every(s => s.priority === 'info')).toBe(true);
    });

  });

  describe('Protein target CKD adjustment', () => {
    it('shows standard 1.2g/kg protein when eGFR is normal', () => {
      const { inputs, results } = createTestData({}, { eGFR: 90, proteinTarget: 85 });
      const suggestions = generateSuggestions(inputs, results);
      const protein = suggestions.find(s => s.id === 'protein-target');
      expect(protein?.description).not.toContain('kidney function');
    });

    it('shows CKD-adjusted text when eGFR < 45', () => {
      // CKD Stage 3b: eGFR < 45 → 1.0g/kg
      const { inputs, results } = createTestData({}, { eGFR: 40, proteinTarget: 71 });
      const suggestions = generateSuggestions(inputs, results);
      const protein = suggestions.find(s => s.id === 'protein-target');
      expect(protein?.description).toContain('kidney function');
      expect(protein?.description).toContain('1.0g per kg');
    });

    it('shows standard text when eGFR is exactly 45', () => {
      const { inputs, results } = createTestData({}, { eGFR: 45, proteinTarget: 85 });
      const suggestions = generateSuggestions(inputs, results);
      const protein = suggestions.find(s => s.id === 'protein-target');
      expect(protein?.description).not.toContain('kidney function');
    });
  });

  describe('Alcohol reduction suggestion', () => {
    it('shows alcohol reduction when BMI > 25', () => {
      const { inputs, results } = createTestData({}, { bmi: 27 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'reduce-alcohol')).toBeDefined();
      expect(suggestions.find(s => s.id === 'reduce-alcohol')?.priority).toBe('attention');
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
      expect(lpaSuggestion?.description).toContain('LDL');
      expect(lpaSuggestion?.description).not.toContain('ApoB');
    });

    it('uses non-HDL when ApoB unavailable but total + HDL provided', () => {
      const { inputs, results } = createTestData(
        { lpa: 200, totalCholesterol: totalChol(250), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(250) - hdl(50) }
      );
      const suggestions = generateSuggestions(inputs, results, 'conventional');
      const lpaSuggestion = suggestions.find(s => s.id === 'lpa-elevated');
      expect(lpaSuggestion?.description).toContain('Non-HDL');
      expect(lpaSuggestion?.description).not.toContain('ApoB');
      expect(lpaSuggestion?.description).not.toContain('LDL');
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
  });
});
