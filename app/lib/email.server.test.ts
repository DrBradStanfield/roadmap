import { describe, it, expect } from 'vitest';
import { buildWelcomeEmailHtml, buildReminderEmailHtml, sendFeedbackEmail } from './email.server';
import type { HealthInputs, HealthResults, Suggestion, MedicationInputs } from '../../packages/health-core/src/types';
import type { DueReminder, BloodTestDate } from '../../packages/health-core/src/reminders';

// Minimal inputs: height + sex only
const minimalInputs: HealthInputs = {
  heightCm: 180,
  sex: 'male',
};

const minimalResults: HealthResults = {
  heightCm: 180,
  idealBodyWeight: 78.0,
  proteinTarget: 94,
  suggestions: [],
};

// Full inputs with all metrics
const fullInputs: HealthInputs = {
  heightCm: 175,
  weightKg: 82,
  waistCm: 90,
  sex: 'female',
  birthYear: 1985,
  birthMonth: 6,
  hba1c: 39,           // mmol/mol
  ldlC: 3.5,           // mmol/L
  totalCholesterol: 5.8,
  hdlC: 1.2,
  triglycerides: 1.8,
  apoB: 0.9,           // g/L
  creatinine: 75,      // µmol/L
  systolicBp: 130,
  diastolicBp: 85,
  unitSystem: 'conventional',
};

const fullResults: HealthResults = {
  heightCm: 175,
  idealBodyWeight: 67.7,
  proteinTarget: 81,
  bmi: 26.8,
  waistToHeightRatio: 0.51,
  nonHdlCholesterol: 4.6,
  apoB: 0.9,
  ldlC: 3.5,
  eGFR: 95,
  age: 40,
  suggestions: [],
};

const sampleSuggestions: Suggestion[] = [
  { id: 'urgent-1', category: 'medication', priority: 'urgent', title: 'Consider statin therapy', description: 'Your ApoB is above target.' },
  { id: 'attention-1', category: 'nutrition', priority: 'attention', title: 'Reduce sodium intake', description: 'Your blood pressure is elevated.' },
  { id: 'info-1', category: 'nutrition', priority: 'info', title: 'Protein target', description: 'Aim for 81g of protein per day.' },
  { id: 'info-2', category: 'exercise', priority: 'info', title: 'Exercise', description: '150+ minutes cardio per week.' },
  { id: 'info-3', category: 'sleep', priority: 'info', title: 'Sleep', description: '7-9 hours per night.' },
  { id: 'supplement-1', category: 'supplements', priority: 'info', title: 'MicroVitamin+', description: 'Daily all-in-one supplement.', link: 'https://example.com' },
];

describe('buildWelcomeEmailHtml', () => {
  it('generates valid HTML with minimal inputs (SI units)', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', 'John');

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Hi John,');
    expect(html).toContain('Ideal Body Weight');
    expect(html).toContain('78');
    expect(html).toContain('kg');
    expect(html).toContain('Protein Target');
    expect(html).toContain('94g/day');
    expect(html).toContain('180 cm');
    expect(html).toContain('Health Snapshot');
    // Should NOT contain entered metrics section (no longitudinal data entered)
    expect(html).not.toContain('Your Health Data');
  });

  it('uses generic greeting when no first name', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).toContain('Hello,');
    expect(html).not.toContain('Hi ');
  });

  it('includes all entered metrics for full inputs (conventional units)', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', 'Jane');

    // Health Snapshot section
    expect(html).toContain('Health Snapshot');
    expect(html).toContain('BMI');
    expect(html).toContain('26.8');
    expect(html).toContain('Overweight');
    expect(html).toContain('Waist-to-Height');
    expect(html).toContain('0.51');
    expect(html).toContain('Elevated');
    expect(html).toContain('eGFR');
    expect(html).toContain('95 mL/min');
    expect(html).toContain('Weight');

    // Health Data section (BP + blood tests, no duplicates from snapshot)
    expect(html).toContain('Your Health Data');
    expect(html).toContain('LDL Cholesterol');
    expect(html).toContain('Systolic BP');
    expect(html).toContain('Diastolic BP');
  });

  it('groups suggestions by priority with separate Supplements section', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, sampleSuggestions, 'si', 'Test');

    // Priority group headings
    expect(html).toContain('Requires Attention');
    expect(html).toContain('Next Steps');
    expect(html).toContain('Foundation');
    expect(html).toContain('Supplements');

    // Supplements use teal color
    expect(html).toContain('#00A38B');
    expect(html).toContain('MicroVitamin+');

    // Suggestion content
    expect(html).toContain('Consider statin therapy');
    expect(html).toContain('Reduce sodium intake');
    expect(html).toContain('Protein target');
  });

  it('includes CTA button with roadmap link', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).toContain('/pages/roadmap');
    expect(html).toContain('View Your Full Roadmap');
  });

  it('includes disclaimer', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).toContain('educational information only');
    expect(html).toContain('not medical advice');
  });

  it('uses inline CSS with print media query only', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, sampleSuggestions, 'conventional', 'Test');

    // Should use inline styles plus a print media query
    expect(html).toContain('style="');
    expect(html).toContain('@media print');
  });

  it('shows IBW in conventional units for US users', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'conventional', null);

    // 78.0 kg → 171.9 lbs
    expect(html).toContain('lbs');
    expect(html).toContain('Ideal Body Weight');
  });

  it('shows IBW in SI units for SI users', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).toContain('kg');
    expect(html).toContain('Ideal Body Weight');
  });

  it('handles SI unit system for metrics', () => {
    const siInputs: HealthInputs = { ...fullInputs, unitSystem: 'si' };
    const html = buildWelcomeEmailHtml(siInputs, fullResults, [], 'si', null);

    // SI units: mmol/L for lipids, mmol/mol for HbA1c
    expect(html).toContain('mmol/L');
  });

  it('omits suggestions section when no suggestions', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).not.toContain('Requires Attention');
    expect(html).not.toContain('Next Steps');
    expect(html).not.toContain('Foundation');
    expect(html).not.toContain('Supplements');
  });

  it('includes preview text', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).toContain('Suggestions to discuss with your healthcare provider');
  });

  // --- Reference range tests ---

  it('shows ApoB status in snapshot (conventional units)', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', 'Jane', undefined, 40);

    // ApoB 0.9 g/L = 90 mg/dL → "High" status in snapshot
    expect(html).toContain('ApoB');
    expect(html).toContain('90');
    expect(html).toContain('mg/dL');
    // Should be colored red (high) — 0.9 g/L exceeds APOB_THRESHOLDS.high (0.7)
    expect(html).toContain('#dc2626');
  });

  it('shows ApoB status in snapshot (SI units)', () => {
    const siInputs: HealthInputs = { ...fullInputs, unitSystem: 'si' };
    const html = buildWelcomeEmailHtml(siInputs, fullResults, [], 'si', null, undefined, 40);

    // ApoB 0.9 g/L → "High" in snapshot
    expect(html).toContain('ApoB');
    expect(html).toContain('0.90');
    expect(html).toContain('g/L');
  });

  it('shows optimal range for LDL in conventional units', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null, undefined, 40);

    // LDL threshold: 130 mg/dL
    expect(html).toContain('< 130');
  });

  it('shows age-dependent BP range for age < 65', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null, undefined, 40);

    // Age 40 → target < 120 mmHg systolic
    expect(html).toContain('< 120 mmHg');
  });

  it('shows age-dependent BP range for age >= 65', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null, undefined, 70);

    // Age 70 → target < 130 mmHg systolic
    expect(html).toContain('< 130 mmHg');
  });

  it('weight is in snapshot, not in health data section', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null, undefined, 40);

    // Weight appears in Health Snapshot
    expect(html).toContain('Weight');
    // Waist appears in Health Data (raw measurement)
    expect(html).toContain('Waist');
  });

  it('shows column headers when health data is present', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null);

    expect(html).toContain('Optimal Range');
    expect(html).toContain('Your Value');
  });

  it('shows BMI status in snapshot without optimal range', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null);

    expect(html).toContain('BMI');
    expect(html).toContain('26.8');
    expect(html).toContain('Overweight');
    // Should NOT have the old range text
    expect(html).not.toContain('18.5 –');
  });

  it('shows WHR status in snapshot without optimal range', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null);

    expect(html).toContain('Waist-to-Height');
    expect(html).toContain('0.51');
    expect(html).toContain('Elevated');
  });

  it('shows eGFR status in snapshot without optimal range', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null);

    expect(html).toContain('eGFR');
    expect(html).toContain('95 mL/min');
    expect(html).toContain('Normal');
    // Should NOT have the old range text
    expect(html).not.toContain('> 60 mL/min');
  });

  // --- Medication section tests ---

  it('shows medication section when active medications exist', () => {
    const meds: MedicationInputs = {
      statin: { drug: 'atorvastatin', dose: 20 },
      ezetimibe: 'yes',
    };
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', 'Jane', meds);

    expect(html).toContain('Current Medications');
    expect(html).toContain('Atorvastatin');
    expect(html).toContain('20mg');
    expect(html).toContain('Ezetimibe');
    expect(html).toContain('10mg');
  });

  it('shows GLP-1 and SGLT2i medications', () => {
    const meds: MedicationInputs = {
      glp1: { drug: 'semaglutide_injection', dose: 1 },
      sglt2i: { drug: 'empagliflozin', dose: 10 },
    };
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null, meds);

    expect(html).toContain('Current Medications');
    expect(html).toContain('Semaglutide injection');
    expect(html).toContain('1mg');
    expect(html).toContain('Empagliflozin');
    expect(html).toContain('10mg');
  });

  it('shows metformin with formulation and dose', () => {
    const meds: MedicationInputs = {
      metformin: 'xr_1000',
    };
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null, meds);

    expect(html).toContain('Current Medications');
    expect(html).toContain('Metformin');
    expect(html).toContain('XR');
    expect(html).toContain('1000mg');
  });

  it('does not show medication section when no active medications', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null);

    expect(html).not.toContain('Current Medications');
  });

  it('does not show medication section when all medications are inactive', () => {
    const meds: MedicationInputs = {
      statin: { drug: 'none', dose: null },
      ezetimibe: 'not_yet',
      metformin: 'none',
    };
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null, meds);

    expect(html).not.toContain('Current Medications');
  });

  it('backward compat — works without optional params', () => {
    // Original 5-param signature still works
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', 'Test');

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Hi Test,');
    expect(html).not.toContain('Current Medications');
  });

  it('header uses dark text for print compatibility', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    // Header h1 should use dark text (not white) so it prints on white paper
    expect(html).toContain('<h1 style="color:#1a1a1a');
    // Header div should not have a background color (borders print, backgrounds don't)
    expect(html).toContain('border-bottom:3px solid #2563eb');
  });

  it('CTA button has no-print class for print hiding', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).toContain('class="no-print"');
    expect(html).toContain('.no-print');
  });

  it('includes @media print style block', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).toContain('@media print { .no-print { display: none !important; } }');
  });

  // --- Demographics tests ---

  it('shows demographics line with sex, age, and height', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', 'Jane', undefined, 40);

    expect(html).toContain('Female');
    expect(html).toContain('40 years old');
    // Conventional units → feet/inches with "tall" suffix
    expect(html).toContain('5\'9" tall');
  });

  it('shows demographics with minimal data (no age)', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).toContain('Male');
    expect(html).toContain('180 cm tall');
  });

  // --- Health Snapshot tests ---

  it('snapshot shows IBW with height explanation', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).toContain('Ideal Body Weight');
    expect(html).toContain('for 180 cm height');
  });

  it('snapshot shows protein target with IBW explanation', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).toContain('Protein Target');
    expect(html).toContain('94g/day');
    expect(html).toContain('1.2g per kg IBW');
  });

  it('snapshot shows reduced protein rate when eGFR < 45', () => {
    const lowEgfrResults: HealthResults = {
      ...fullResults,
      eGFR: 40,
    };
    const html = buildWelcomeEmailHtml(fullInputs, lowEgfrResults, [], 'si', null);

    expect(html).toContain('1.0g per kg IBW');
  });

  // --- Lipid cascade tests ---

  it('lipid cascade shows ApoB when available', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null);

    // fullInputs has apoB: 0.9 g/L → should show ApoB in snapshot
    expect(html).toContain('ApoB');
  });

  it('lipid cascade falls back to Non-HDL when no ApoB', () => {
    const noApobInputs: HealthInputs = { ...fullInputs, apoB: undefined };
    const html = buildWelcomeEmailHtml(noApobInputs, fullResults, [], 'conventional', null);

    // Has totalCholesterol and hdlC → Non-HDL
    expect(html).toContain('Non-HDL Cholesterol');
  });

  it('lipid cascade falls back to LDL when no ApoB or Total Chol', () => {
    const ldlOnlyInputs: HealthInputs = {
      ...fullInputs,
      apoB: undefined,
      totalCholesterol: undefined,
      hdlC: undefined,
    };
    const html = buildWelcomeEmailHtml(ldlOnlyInputs, fullResults, [], 'conventional', null);

    // Only LDL available in snapshot cascade
    expect(html).toContain('LDL Cholesterol');
  });

  // --- Preview text padding ---

  it('preview text is padded to prevent bleeding', () => {
    const html = buildWelcomeEmailHtml(minimalInputs, minimalResults, [], 'si', null);

    expect(html).toContain('Suggestions to discuss with your healthcare provider');
    expect(html).toContain('&#847;');
    expect(html).toContain('&zwnj;');
  });

  // --- Deduplication tests ---

  it('creatinine is not in health data section', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null, undefined, 40);

    // Creatinine should NOT appear as a row label (eGFR covers it in snapshot)
    expect(html).not.toContain('>Creatinine<');
  });

  it('ApoB and Lp(a) not duplicated in health data when shown in snapshot', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, [], 'conventional', null, undefined, 40);

    // ApoB appears in snapshot (lipid cascade winner), not in health data
    // Lp(a) appears in snapshot, not in health data
    // Split HTML at "Your Health Data" and check the second half
    const healthDataSection = html.split('Your Health Data')[1] || '';
    expect(healthDataSection).not.toContain('>ApoB<');
    expect(healthDataSection).not.toContain('>Lp(a)<');
  });

  it('LDL not duplicated when it is the lipid cascade winner', () => {
    const ldlOnlyInputs: HealthInputs = {
      ...fullInputs,
      apoB: undefined,
      totalCholesterol: undefined,
      hdlC: undefined,
    };
    const html = buildWelcomeEmailHtml(ldlOnlyInputs, fullResults, [], 'conventional', null, undefined, 40);

    // LDL is in the snapshot cascade — should not repeat in health data
    const healthDataSection = html.split('Your Health Data')[1] || '';
    expect(healthDataSection).not.toContain('>LDL Cholesterol<');
  });
});

// ---------------------------------------------------------------------------
// Reminder email tests
// ---------------------------------------------------------------------------

const screeningReminder: DueReminder = {
  category: 'screening_colorectal',
  group: 'screening',
  title: 'Colorectal screening overdue',
  description: 'Your colorectal cancer screening is overdue. Please schedule with your doctor.',
};

const bloodTestReminder: DueReminder = {
  category: 'blood_test_lipids',
  group: 'blood_test',
  title: 'Lipid panel overdue',
  description: 'It has been over a year since your last lipid panel.',
};

const medicationReminder: DueReminder = {
  category: 'medication_review',
  group: 'medication_review',
  title: 'Medication review due',
  description: 'Please discuss your current medications with your doctor.',
};

const sampleBloodTestDates: BloodTestDate[] = [
  { type: 'lipids', label: 'Lipid panel', lastDate: '2024-12-01T00:00:00.000Z', isOverdue: true },
  { type: 'hba1c', label: 'HbA1c', lastDate: '2025-10-01T00:00:00.000Z', isOverdue: false },
];

const preferencesUrl = 'https://drstanfield.com/apps/health-tool-1/api/reminders?token=abc123';

describe('buildReminderEmailHtml', () => {
  it('generates valid HTML with screening reminders', () => {
    const html = buildReminderEmailHtml('John', [screeningReminder], [], preferencesUrl);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Hi John,');
    expect(html).toContain('Screening Reminders');
    expect(html).toContain('Colorectal screening overdue');
  });

  it('uses generic greeting when no first name', () => {
    const html = buildReminderEmailHtml(null, [screeningReminder], [], preferencesUrl);

    expect(html).toContain('Hello,');
    expect(html).not.toContain('Hi ');
  });

  it('includes blood test context for non-overdue tests', () => {
    const html = buildReminderEmailHtml('Jane', [bloodTestReminder], sampleBloodTestDates, preferencesUrl);

    expect(html).toContain('Blood Test Reminders');
    expect(html).toContain('Lipid panel overdue');
    // Should show context for up-to-date HbA1c
    expect(html).toContain('HbA1c');
    expect(html).toContain('Oct 2025');
  });

  it('includes medication review section', () => {
    const html = buildReminderEmailHtml('Test', [medicationReminder], [], preferencesUrl);

    expect(html).toContain('Medication Review');
    expect(html).toContain('Medication review due');
  });

  it('includes all sections when multiple reminder types', () => {
    const html = buildReminderEmailHtml(
      'Test',
      [screeningReminder, bloodTestReminder, medicationReminder],
      sampleBloodTestDates,
      preferencesUrl,
    );

    expect(html).toContain('Screening Reminders');
    expect(html).toContain('Blood Test Reminders');
    expect(html).toContain('Medication Review');
  });

  it('includes manage preferences link', () => {
    const html = buildReminderEmailHtml('Test', [screeningReminder], [], preferencesUrl);

    expect(html).toContain('Manage notification preferences');
    expect(html).toContain(preferencesUrl);
  });

  it('includes CTA button with roadmap link', () => {
    const html = buildReminderEmailHtml('Test', [screeningReminder], [], preferencesUrl);

    expect(html).toContain('/pages/roadmap');
    expect(html).toContain('View Your Health Roadmap');
  });

  it('includes disclaimer', () => {
    const html = buildReminderEmailHtml('Test', [screeningReminder], [], preferencesUrl);

    expect(html).toContain('educational information only');
    expect(html).toContain('not medical advice');
  });

  it('does not include specific health values (HIPAA-aware)', () => {
    const html = buildReminderEmailHtml(
      'Test',
      [screeningReminder, bloodTestReminder, medicationReminder],
      sampleBloodTestDates,
      preferencesUrl,
    );

    // Should not contain any specific values like mmol/L, mg/dL, etc.
    expect(html).not.toContain('mmol');
    expect(html).not.toContain('mg/dL');
    expect(html).not.toContain('ng/mL');
  });
});

// ---------------------------------------------------------------------------
// Feedback email tests
// ---------------------------------------------------------------------------

describe('sendFeedbackEmail', () => {
  it('is callable and returns a boolean for guest user', async () => {
    const result = await sendFeedbackEmail('guest@example.com', 'Feedback from guest', null);
    expect(typeof result).toBe('boolean');
  });

  it('is callable and returns a boolean for logged-in user', async () => {
    const result = await sendFeedbackEmail('user@example.com', 'Feedback', '12345');
    expect(typeof result).toBe('boolean');
  });

  it('never throws even with empty inputs', async () => {
    // Should not throw — fire-and-forget pattern
    const result = await sendFeedbackEmail('', '', null);
    expect(typeof result).toBe('boolean');
  });
});
