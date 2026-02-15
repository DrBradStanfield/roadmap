import { describe, it, expect } from 'vitest';
import { buildWelcomeEmailHtml, buildReminderEmailHtml } from './email.server';
import type { HealthInputs, HealthResults, Suggestion } from '../../packages/health-core/src/types';
import type { DueReminder, BloodTestDate } from '../../packages/health-core/src/reminders';

// Minimal inputs: height + sex only
const minimalInputs: HealthInputs = {
  heightCm: 180,
  sex: 'male',
};

const minimalResults: HealthResults = {
  heightCm: 180,
  idealBodyWeight: 75.1,
  proteinTarget: 90,
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
  idealBodyWeight: 66.1,
  proteinTarget: 79,
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
  { id: 'info-1', category: 'nutrition', priority: 'info', title: 'Protein target', description: 'Aim for 79g of protein per day.' },
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
    expect(html).toContain('75.1 kg');
    expect(html).toContain('Daily Protein Target');
    expect(html).toContain('90g');
    expect(html).toContain('180 cm');
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

    // Calculated results
    expect(html).toContain('BMI');
    expect(html).toContain('26.8');
    expect(html).toContain('Overweight');
    expect(html).toContain('Waist-to-Height Ratio');
    expect(html).toContain('0.51');
    expect(html).toContain('Elevated');
    expect(html).toContain('eGFR');
    expect(html).toContain('95 mL/min');

    // Entered metrics section should exist
    expect(html).toContain('Your Health Data');
    expect(html).toContain('Weight');
    expect(html).toContain('LDL Cholesterol');
    expect(html).toContain('ApoB');
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

  it('uses inline CSS (no style tags)', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, sampleSuggestions, 'conventional', 'Test');

    // Should use inline styles, not style blocks
    expect(html).not.toContain('<style>');
    expect(html).toContain('style="');
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
