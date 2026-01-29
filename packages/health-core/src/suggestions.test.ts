import { describe, it, expect } from 'vitest';
import { generateSuggestions } from './suggestions';
import type { HealthInputs, HealthResults } from './types';

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
    it('generates underweight suggestion for BMI < 18.5', () => {
      const { inputs, results } = createTestData({}, { bmi: 17.5 });
      const suggestions = generateSuggestions(inputs, results);

      const bmiSuggestion = suggestions.find(s => s.id === 'bmi-underweight');
      expect(bmiSuggestion).toBeDefined();
      expect(bmiSuggestion?.priority).toBe('attention');
      expect(bmiSuggestion?.discussWithDoctor).toBe(true);
    });

    it('generates overweight suggestion for BMI 25-29.9', () => {
      const { inputs, results } = createTestData({}, { bmi: 27.5 });
      const suggestions = generateSuggestions(inputs, results);

      const bmiSuggestion = suggestions.find(s => s.id === 'bmi-overweight');
      expect(bmiSuggestion).toBeDefined();
      expect(bmiSuggestion?.priority).toBe('info');
      expect(bmiSuggestion?.discussWithDoctor).toBe(false);
    });

    it('generates obese suggestion for BMI >= 30', () => {
      const { inputs, results } = createTestData({}, { bmi: 32 });
      const suggestions = generateSuggestions(inputs, results);

      const bmiSuggestion = suggestions.find(s => s.id === 'bmi-obese');
      expect(bmiSuggestion).toBeDefined();
      expect(bmiSuggestion?.priority).toBe('attention');
      expect(bmiSuggestion?.discussWithDoctor).toBe(true);
    });

    it('does not generate BMI suggestion for normal BMI', () => {
      const { inputs, results } = createTestData({}, { bmi: 22 });
      const suggestions = generateSuggestions(inputs, results);

      const bmiSuggestions = suggestions.filter(s => s.id.startsWith('bmi-'));
      expect(bmiSuggestions.length).toBe(0);
    });
  });

  describe('Waist-to-height ratio suggestions', () => {
    it('generates suggestion for ratio > 0.5', () => {
      const { inputs, results } = createTestData({}, { waistToHeightRatio: 0.55 });
      const suggestions = generateSuggestions(inputs, results);

      const waistSuggestion = suggestions.find(s => s.id === 'waist-height-elevated');
      expect(waistSuggestion).toBeDefined();
      expect(waistSuggestion?.priority).toBe('attention');
      expect(waistSuggestion?.discussWithDoctor).toBe(true);
    });

    it('does not generate suggestion for ratio <= 0.5', () => {
      const { inputs, results } = createTestData({}, { waistToHeightRatio: 0.48 });
      const suggestions = generateSuggestions(inputs, results);

      const waistSuggestion = suggestions.find(s => s.id === 'waist-height-elevated');
      expect(waistSuggestion).toBeUndefined();
    });
  });

  describe('HbA1c suggestions', () => {
    it('generates diabetic suggestion for HbA1c >= 6.5', () => {
      const { inputs, results } = createTestData({ hba1c: 7.2 });
      const suggestions = generateSuggestions(inputs, results);

      const hba1cSuggestion = suggestions.find(s => s.id === 'hba1c-diabetic');
      expect(hba1cSuggestion).toBeDefined();
      expect(hba1cSuggestion?.priority).toBe('urgent');
      expect(hba1cSuggestion?.discussWithDoctor).toBe(true);
    });

    it('generates prediabetic suggestion for HbA1c 5.7-6.4', () => {
      const { inputs, results } = createTestData({ hba1c: 6.0 });
      const suggestions = generateSuggestions(inputs, results);

      const hba1cSuggestion = suggestions.find(s => s.id === 'hba1c-prediabetic');
      expect(hba1cSuggestion).toBeDefined();
      expect(hba1cSuggestion?.priority).toBe('attention');
    });

    it('generates normal suggestion for HbA1c < 5.7', () => {
      const { inputs, results } = createTestData({ hba1c: 5.2 });
      const suggestions = generateSuggestions(inputs, results);

      const hba1cSuggestion = suggestions.find(s => s.id === 'hba1c-normal');
      expect(hba1cSuggestion).toBeDefined();
      expect(hba1cSuggestion?.priority).toBe('info');
      expect(hba1cSuggestion?.discussWithDoctor).toBe(false);
    });
  });

  describe('LDL cholesterol suggestions', () => {
    it('generates very high suggestion for LDL >= 190', () => {
      const { inputs, results } = createTestData({ ldlC: 200 });
      const suggestions = generateSuggestions(inputs, results);

      const ldlSuggestion = suggestions.find(s => s.id === 'ldl-very-high');
      expect(ldlSuggestion).toBeDefined();
      expect(ldlSuggestion?.priority).toBe('urgent');
    });

    it('generates high suggestion for LDL 160-189', () => {
      const { inputs, results } = createTestData({ ldlC: 175 });
      const suggestions = generateSuggestions(inputs, results);

      const ldlSuggestion = suggestions.find(s => s.id === 'ldl-high');
      expect(ldlSuggestion).toBeDefined();
      expect(ldlSuggestion?.priority).toBe('attention');
    });

    it('generates borderline suggestion for LDL 130-159', () => {
      const { inputs, results } = createTestData({ ldlC: 140 });
      const suggestions = generateSuggestions(inputs, results);

      const ldlSuggestion = suggestions.find(s => s.id === 'ldl-borderline');
      expect(ldlSuggestion).toBeDefined();
      expect(ldlSuggestion?.priority).toBe('info');
    });

    it('does not generate suggestion for optimal LDL < 130', () => {
      const { inputs, results } = createTestData({ ldlC: 90 });
      const suggestions = generateSuggestions(inputs, results);

      const ldlSuggestions = suggestions.filter(s => s.id.startsWith('ldl-'));
      expect(ldlSuggestions.length).toBe(0);
    });
  });

  describe('HDL cholesterol suggestions', () => {
    it('generates low HDL suggestion for males with HDL < 40', () => {
      const { inputs, results } = createTestData({ hdlC: 35, sex: 'male' });
      const suggestions = generateSuggestions(inputs, results);

      const hdlSuggestion = suggestions.find(s => s.id === 'hdl-low');
      expect(hdlSuggestion).toBeDefined();
      expect(hdlSuggestion?.description).toContain('40');
    });

    it('generates low HDL suggestion for females with HDL < 50', () => {
      const { inputs, results } = createTestData({ hdlC: 45, sex: 'female' });
      const suggestions = generateSuggestions(inputs, results);

      const hdlSuggestion = suggestions.find(s => s.id === 'hdl-low');
      expect(hdlSuggestion).toBeDefined();
      expect(hdlSuggestion?.description).toContain('50');
    });

    it('does not generate suggestion for normal HDL', () => {
      const { inputs, results } = createTestData({ hdlC: 55, sex: 'male' });
      const suggestions = generateSuggestions(inputs, results);

      const hdlSuggestion = suggestions.find(s => s.id === 'hdl-low');
      expect(hdlSuggestion).toBeUndefined();
    });
  });

  describe('Triglycerides suggestions', () => {
    it('generates very high suggestion for triglycerides >= 500', () => {
      const { inputs, results } = createTestData({ triglycerides: 550 });
      const suggestions = generateSuggestions(inputs, results);

      const trigSuggestion = suggestions.find(s => s.id === 'trig-very-high');
      expect(trigSuggestion).toBeDefined();
      expect(trigSuggestion?.priority).toBe('urgent');
    });

    it('generates high suggestion for triglycerides 200-499', () => {
      const { inputs, results } = createTestData({ triglycerides: 300 });
      const suggestions = generateSuggestions(inputs, results);

      const trigSuggestion = suggestions.find(s => s.id === 'trig-high');
      expect(trigSuggestion).toBeDefined();
      expect(trigSuggestion?.priority).toBe('attention');
    });

    it('generates borderline suggestion for triglycerides 150-199', () => {
      const { inputs, results } = createTestData({ triglycerides: 175 });
      const suggestions = generateSuggestions(inputs, results);

      const trigSuggestion = suggestions.find(s => s.id === 'trig-borderline');
      expect(trigSuggestion).toBeDefined();
      expect(trigSuggestion?.priority).toBe('info');
    });
  });

  describe('Fasting glucose suggestions', () => {
    it('generates diabetic suggestion for glucose >= 126', () => {
      const { inputs, results } = createTestData({ fastingGlucose: 140 });
      const suggestions = generateSuggestions(inputs, results);

      const glucoseSuggestion = suggestions.find(s => s.id === 'glucose-diabetic');
      expect(glucoseSuggestion).toBeDefined();
      expect(glucoseSuggestion?.priority).toBe('urgent');
    });

    it('generates prediabetic suggestion for glucose 100-125', () => {
      const { inputs, results } = createTestData({ fastingGlucose: 110 });
      const suggestions = generateSuggestions(inputs, results);

      const glucoseSuggestion = suggestions.find(s => s.id === 'glucose-prediabetic');
      expect(glucoseSuggestion).toBeDefined();
      expect(glucoseSuggestion?.priority).toBe('attention');
    });

    it('does not generate suggestion for normal glucose < 100', () => {
      const { inputs, results } = createTestData({ fastingGlucose: 90 });
      const suggestions = generateSuggestions(inputs, results);

      const glucoseSuggestions = suggestions.filter(s => s.id.startsWith('glucose-'));
      expect(glucoseSuggestions.length).toBe(0);
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

    it('generates elevated suggestion for BP 120-129/<80', () => {
      const { inputs, results } = createTestData({ systolicBp: 125, diastolicBp: 75 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestion = suggestions.find(s => s.id === 'bp-elevated');
      expect(bpSuggestion).toBeDefined();
      expect(bpSuggestion?.priority).toBe('info');
    });

    it('does not generate suggestion for normal BP < 120/80', () => {
      const { inputs, results } = createTestData({ systolicBp: 115, diastolicBp: 75 });
      const suggestions = generateSuggestions(inputs, results);

      const bpSuggestions = suggestions.filter(s => s.id.startsWith('bp-'));
      expect(bpSuggestions.length).toBe(0);
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
  });

  describe('Multiple suggestions', () => {
    it('generates multiple suggestions for complex case', () => {
      const { inputs, results } = createTestData(
        {
          hba1c: 6.8,
          ldlC: 180,
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
});
