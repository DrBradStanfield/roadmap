import { describe, it, expect } from 'vitest';
import { buildPlanReadyEmailHtml } from './email.server';

/**
 * US-22 AC1 — the plan-ready email must carry NO health data.
 *
 * This is the AC the whole design rests on: the email exists so a bounce can
 * prove an address is dead, NOT to deliver health information. If someone later
 * "improves" it by dropping in the user's LDL or their next due date, the
 * local-first promise ("never on our servers") quietly becomes false, because
 * the server would then have to know those values to render them. This test is
 * the tripwire.
 */
describe('US-22 AC1 — plan-ready email carries no health data', () => {
  const html = buildPlanReadyEmailHtml('https://health-tool-app.fly.dev/roadmap/open');

  it('renders with only the CTA url interpolated', () => {
    expect(html).toContain('https://health-tool-app.fly.dev/roadmap/open');
    expect(html).toContain('Open my Health Roadmap');
  });

  it('takes no arguments that could carry health data', () => {
    // A single-parameter signature is the structural guarantee: there is no
    // channel through which a value could reach this template.
    expect(buildPlanReadyEmailHtml.length).toBe(1);
  });

  // Assert against the text a RECIPIENT sees, not the raw markup: styling
  // legitimately contains both digits (padding, font sizes) and letter runs
  // that trip naive substring matching ("background" contains "kg").
  const visibleText = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  it('mentions no metric, lab value, medication, or screening vocabulary', () => {
    const forbidden = [
      'ldl', 'hdl', 'apob', 'lp(a)', 'hba1c', 'cholesterol', 'triglyceride',
      'blood pressure', 'systolic', 'diastolic', 'waist', 'bmi', 'weight',
      'colonoscopy', 'mammogram', 'statin', 'mmol', 'mg/dl', 'kg',
    ];
    const lower = visibleText.toLowerCase();
    for (const term of forbidden) {
      expect(lower, `plan-ready email must not mention "${term}"`).not.toContain(term);
    }
  });

  it('shows the reader no digits at all — no dates, no readings, no counts', () => {
    expect(visibleText, `visible copy was: ${visibleText}`).not.toMatch(/\d/);
  });

  it('states the local-first promise (the reason it is thin)', () => {
    expect(html.toLowerCase()).toContain('your own cloud storage');
  });

  it('sets expectations about reminders and their unsubscribe', () => {
    const lower = html.toLowerCase();
    expect(lower).toContain('comes due');
    expect(lower).toContain('unsubscribe');
  });
});
