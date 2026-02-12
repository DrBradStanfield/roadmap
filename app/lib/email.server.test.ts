import { describe, it, expect } from 'vitest';
import { buildWelcomeEmailHtml } from './email.server';
import type { HealthInputs, HealthResults, Suggestion } from '../../packages/health-core/src/types';

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

  it('groups suggestions by priority', () => {
    const html = buildWelcomeEmailHtml(fullInputs, fullResults, sampleSuggestions, 'si', 'Test');

    // Priority group headings
    expect(html).toContain('Requires Attention');
    expect(html).toContain('Next Steps');
    expect(html).toContain('Foundation');

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
  });
});
