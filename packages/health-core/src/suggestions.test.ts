import { describe, it, expect } from 'vitest';
import { generateSuggestions } from './suggestions';
import type { HealthInputs, HealthResults, MedicationInputs, ScreeningInputs } from './types';
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

  describe('Non-HDL cholesterol suggestions', () => {
    it('generates very high suggestion for non-HDL >= 190 mg/dL', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(280), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(280) - hdl(50) }
      );
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'non-hdl-very-high')).toBeDefined();
      expect(suggestions.find(s => s.id === 'non-hdl-very-high')?.priority).toBe('urgent');
    });

    it('generates high suggestion for non-HDL 160-189 mg/dL', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(220), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(220) - hdl(50) }
      );
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'non-hdl-high')).toBeDefined();
      expect(suggestions.find(s => s.id === 'non-hdl-high')?.priority).toBe('attention');
    });

    it('generates borderline suggestion for non-HDL 130-159 mg/dL', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(190), hdlC: hdl(50) },
        { nonHdlCholesterol: totalChol(190) - hdl(50) }
      );
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'non-hdl-borderline')).toBeDefined();
      expect(suggestions.find(s => s.id === 'non-hdl-borderline')?.priority).toBe('info');
    });

    it('does not generate suggestion for optimal non-HDL < 130 mg/dL', () => {
      const { inputs, results } = createTestData(
        { totalCholesterol: totalChol(170), hdlC: hdl(60) },
        { nonHdlCholesterol: totalChol(170) - hdl(60) }
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
    it('generates very high suggestion for triglycerides >= 500 mg/dL (≥5.64 mmol/L)', () => {
      const { inputs, results } = createTestData({ triglycerides: trig(550) });
      const suggestions = generateSuggestions(inputs, results);

      const trigSuggestion = suggestions.find(s => s.id === 'trig-very-high');
      expect(trigSuggestion).toBeDefined();
      expect(trigSuggestion?.priority).toBe('urgent');
    });

    it('generates high suggestion for triglycerides 200-499 mg/dL (2.26-5.64 mmol/L)', () => {
      const { inputs, results } = createTestData({ triglycerides: trig(300) });
      const suggestions = generateSuggestions(inputs, results);

      const trigSuggestion = suggestions.find(s => s.id === 'trig-high');
      expect(trigSuggestion).toBeDefined();
      expect(trigSuggestion?.priority).toBe('attention');
    });

    it('generates borderline suggestion for triglycerides 150-199 mg/dL (1.69-2.26 mmol/L)', () => {
      const { inputs, results } = createTestData({ triglycerides: trig(175) });
      const suggestions = generateSuggestions(inputs, results);

      const trigSuggestion = suggestions.find(s => s.id === 'trig-borderline');
      expect(trigSuggestion).toBeDefined();
      expect(trigSuggestion?.priority).toBe('info');
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

    it('shows low salt when SBP >= 116', () => {
      const { inputs, results } = createTestData({ systolicBp: 120, diastolicBp: 75 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'low-salt')).toBeDefined();
    });

    it('hides low salt when SBP < 116', () => {
      const { inputs, results } = createTestData({ systolicBp: 110, diastolicBp: 70 });
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
    it('suggests GLP-1 when BMI > 27', () => {
      const { inputs, results } = createTestData({}, { bmi: 28 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeDefined();
      expect(suggestions.find(s => s.id === 'weight-glp1')?.category).toBe('medication');
    });

    it('does not suggest GLP-1 when BMI <= 25', () => {
      const { inputs, results } = createTestData({}, { bmi: 24 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeUndefined();
    });

    it('suggests GLP-1 when BMI 25-27 and waist-to-height >= 0.5', () => {
      const { inputs, results } = createTestData({}, { bmi: 26, waistToHeightRatio: 0.52 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeDefined();
    });

    it('does not suggest GLP-1 when BMI 25-27 and waist-to-height < 0.5', () => {
      const { inputs, results } = createTestData({}, { bmi: 26, waistToHeightRatio: 0.45 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeUndefined();
    });

    it('suggests GLP-1 when BMI 25-27 and no waist data', () => {
      const { inputs, results } = createTestData({}, { bmi: 26 });
      const suggestions = generateSuggestions(inputs, results);
      expect(suggestions.find(s => s.id === 'weight-glp1')).toBeDefined();
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

    it('does not suggest medications when lipids below targets', () => {
      const { inputs, results } = createTestData({ apoB: apoB(30) }); // below 50
      const meds: MedicationInputs = {};
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id?.startsWith('med-'))).toBeUndefined();
    });

    it('suggests ezetimibe when on statin but lipids still elevated', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = { statin: 'tier_1' };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-ezetimibe')).toBeDefined();
      expect(suggestions.find(s => s.id === 'med-statin')).toBeUndefined();
    });

    it('suggests statin dose increase when on statin + ezetimibe, not max tier', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = { statin: 'tier_1', ezetimibe: 'yes' };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin-increase')).toBeDefined();
    });

    it('skips statin dose increase when already on max tier', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = { statin: 'tier_4', ezetimibe: 'yes' };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin-increase')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'med-pcsk9i')).toBeDefined();
    });

    it('skips statin dose increase when statin not tolerated', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = { statin: 'not_tolerated', ezetimibe: 'yes' };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-statin-increase')).toBeUndefined();
      expect(suggestions.find(s => s.id === 'med-pcsk9i')).toBeDefined();
    });

    it('suggests PCSK9i when statin increase not tolerated', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = {
        statin: 'tier_1',
        ezetimibe: 'yes',
        statinIncrease: 'not_tolerated',
      };
      const suggestions = generateSuggestions(inputs, results, 'si', meds);
      expect(suggestions.find(s => s.id === 'med-pcsk9i')).toBeDefined();
    });

    it('no medication suggestions when all cascade steps completed', () => {
      const { inputs, results } = createTestData(elevatedLipids);
      const meds: MedicationInputs = {
        statin: 'tier_4',
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
    it('suggests lung screening for smoker 50+ with 20+ pack-years', () => {
      const { inputs, results } = createTestData({ birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { lungSmokingHistory: 'current_smoker', lungPackYears: 25 };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-lung')).toBeDefined();
    });

    it('does not suggest lung screening for never smoker', () => {
      const { inputs, results } = createTestData({ birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { lungSmokingHistory: 'never_smoked' };
      const suggestions = generateSuggestions(inputs, results, 'si', undefined, scr);
      expect(suggestions.find(s => s.id === 'screening-lung')).toBeUndefined();
    });

    it('does not suggest lung screening for smoker with <20 pack-years', () => {
      const { inputs, results } = createTestData({ birthYear: 1970, birthMonth: 1 }, { age: 56 });
      const scr: ScreeningInputs = { lungSmokingHistory: 'former_smoker', lungPackYears: 15 };
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
});
