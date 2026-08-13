import { describe, it, expect } from 'vitest';
import { buildPlanReadyEmailHtml, buildReminderV2EmailHtml, googleCalendarUrl } from './email.server';

/**
 * US-22 AC1 (as amended 2026-08-14 by US-23/US-24) — the plan-ready email
 * carries no measurement, lab value, medication, or screening RESULT.
 *
 * The original tripwire said "no health data at all"; the constitution then
 * drew the line precisely: reminder labels + due dates are the PERMITTED
 * footprint ("we keep your calendar, never your chart"), and once a capture
 * enrols reminders this email carries that calendar — deliberately, because
 * for a typed-lane user it may become the only durable copy. What must still
 * never appear, in either variant, is a VALUE: an LDL, a blood pressure, a
 * dose, a result. These tests hold that line for both variants.
 */
describe('US-22 AC1 — plan-ready email (unenrolled variant) carries no health data', () => {
  const html = buildPlanReadyEmailHtml('https://health-tool-app.fly.dev/roadmap/open');

  it('renders with only the CTA url interpolated', () => {
    expect(html).toContain('https://health-tool-app.fly.dev/roadmap/open');
    expect(html).toContain('Open my Health Roadmap');
  });

  it('has exactly one required argument — options carry only calendar fields', () => {
    // The options parameter is defaulted, so .length stays 1: nothing REQUIRED
    // beyond the CTA url, and the optional channel is typed to labels + dates.
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

// US-23 AC3/AC5 + US-24 — the ENROLLED variant: calendar in, values still out.
describe('plan-ready email (enrolled variant) carries the calendar and nothing else', () => {
  const schedule = [
    { label: 'Colonoscopy', dueAt: '2034-03-01' },
    { label: 'Lipid panel blood test', dueAt: '2027-05-12' },
  ];
  const unsubscribeUrl = 'https://health-tool-app.fly.dev/reminders-v2/unsubscribe?token=tok123';
  const html = buildPlanReadyEmailHtml('https://health-tool-app.fly.dev/roadmap/open', { schedule, unsubscribeUrl });

  it('renders every schedule item as label + human date', () => {
    expect(html).toContain('Colonoscopy');
    expect(html).toContain('Mar 2034');
    expect(html).toContain('Lipid panel blood test');
    expect(html).toContain('May 2027');
  });

  it('gives each item an add-to-calendar link (US-24: plain Google URL, no attachment)', () => {
    expect(html).toContain('https://calendar.google.com/calendar/render?action=TEMPLATE');
    expect(html).toContain('dates=20340301%2F20340302'); // all-day: end date exclusive
  });

  it('carries the prominent one-click unsubscribe in the body (US-23 AC5)', () => {
    expect(html).toContain(unsubscribeUrl);
    expect(html.toLowerCase()).toContain('one click');
  });

  it('still shows no VALUE — a label and a date are the entire footprint', () => {
    const visible = html.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').toLowerCase();
    for (const term of ['mmol', 'mg/dl', 'mmhg', 'ldl 3', 'result', 'reading']) {
      expect(visible, `enrolled plan-ready email must not mention "${term}"`).not.toContain(term);
    }
  });
});

describe('US-24 — googleCalendarUrl', () => {
  it('builds an all-day TEMPLATE link with the label, exclusive end date, and re-entry pointer', () => {
    const url = googleCalendarUrl('DEXA bone density scan', '2027-12-31');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(parsed.searchParams.get('action')).toBe('TEMPLATE');
    expect(parsed.searchParams.get('text')).toBe('DEXA bone density scan');
    expect(parsed.searchParams.get('dates')).toBe('20271231/20280101'); // year rollover handled
    expect(parsed.searchParams.get('details')).toContain('/roadmap/open');
  });
});

// US-23 AC3/AC5 — the reminder email itself: full schedule + typed prominence.
describe('reminder email carries the full calendar (US-23 AC3) and typed prominence (AC5)', () => {
  const due = [{ label: 'Lipid panel blood test', dueAt: '2026-08-01' }];
  const full = [
    ...due,
    { label: 'Colonoscopy', dueAt: '2034-03-01' },
  ];
  const unsubscribeUrl = 'https://health-tool-app.fly.dev/reminders-v2/unsubscribe?token=tok456';

  it('lists upcoming (not-yet-due) items alongside the due ones', () => {
    const html = buildReminderV2EmailHtml(due, unsubscribeUrl, { fullSchedule: full });
    expect(html).toContain('Your full check-up calendar');
    expect(html).toContain('Colonoscopy');
    expect(html).toContain('Mar 2034');
    expect(html).toContain('https://calendar.google.com/calendar/render?action=TEMPLATE');
  });

  it('adds the prominent in-body unsubscribe ONLY for typed recipients', () => {
    const typed = buildReminderV2EmailHtml(due, unsubscribeUrl, { fullSchedule: full, prominentUnsubscribe: true });
    const cloud = buildReminderV2EmailHtml(due, unsubscribeUrl, { fullSchedule: full });
    expect(typed).toContain('Stop them with one click');
    expect(cloud).not.toContain('Stop them with one click');
    // The footer unsubscribe stays in BOTH (RFC 8058 posture unchanged).
    expect(cloud).toContain(unsubscribeUrl);
  });

  it('without options renders exactly the legacy shape (cloud lane unaffected)', () => {
    const html = buildReminderV2EmailHtml(due, unsubscribeUrl);
    expect(html).not.toContain('Your full check-up calendar');
    expect(html).not.toContain('Stop them with one click');
    expect(html).toContain('Lipid panel blood test');
  });
});
