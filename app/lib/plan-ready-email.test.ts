import { describe, it, expect } from 'vitest';
import { APP_BASE_URL, buildPlanReadyEmailHtml, buildReminderV2EmailHtml, googleCalendarUrl, type PlanLane } from './email.server';

/** The text a RECIPIENT sees, not the raw markup: styling legitimately contains
 *  both digits (padding, font sizes) and letter runs that trip naive substring
 *  matching ("background" contains "kg"). */
const visible = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The button's one target in both emails (US-22 AC5, US-23 AC10). */
const OPEN_URL = `${APP_BASE_URL}/roadmap/open`;
const LANES: PlanLane[] = ['guest', 'cloud'];

/**
 * US-22 AC1 (as amended 2026-08-14 by US-23/US-24) — the plan-ready email
 * carries no measurement, lab value, medication, or screening RESULT.
 *
 * The original tripwire said "no health data at all"; the constitution then
 * drew the line precisely: reminder labels + due dates are the PERMITTED
 * footprint ("we keep your calendar, never your chart"), and once a capture
 * enrols reminders this email carries that calendar — deliberately, because
 * for a typed-lane user it may become the only durable copy. What must still
 * never appear, in either variant or either lane, is a VALUE: an LDL, a blood
 * pressure, a dose, a result. These tests hold that line.
 */
describe.each(LANES)('US-22 AC1 — plan-ready email (unenrolled variant, %s lane) carries no health data', (lane) => {
  const html = buildPlanReadyEmailHtml(lane);
  const visibleText = visible(html);

  it('links its one button through /roadmap/open', () => {
    expect(html).toContain(`href="${OPEN_URL}"`);
    expect(html).toContain('Open the Health Roadmap');
  });

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

  it('says what the server keeps, and that the plan is not there', () => {
    expect(visibleText).toContain("Dr Brad's server keeps your reminder calendar and this email address.");
    expect(visibleText).toContain('Your plan is not stored there.');
  });

  it('sets expectations about reminders and their unsubscribe', () => {
    const lower = html.toLowerCase();
    expect(lower).toContain('comes due');
    expect(lower).toContain('unsubscribe');
  });
});

it('the lane is the one required argument, so no send site can default into the wrong storage claim (US-22 AC12)', () => {
  // Options stay defaulted and typed to labels + dates only: nothing else is
  // required beyond the lane.
  expect(buildPlanReadyEmailHtml.length).toBe(1);
});

/**
 * US-22 AC12 — the email tells each reader where THEIR plan lives. The old copy
 * ("Your plan reloads from your own device or your own cloud storage") promised
 * every guest a way back that only worked in the browser they made the plan
 * in; Safari clears that after a week without a visit (Darren, 2026-09-24).
 */
describe('US-22 AC12 — the storage sentence is true for the lane it goes to', () => {
  it('guest: the browser it was made in, the PDF, the Safari limit, and the cloud as the way to carry it', () => {
    const text = visible(buildPlanReadyEmailHtml('guest'));
    expect(text).toContain('Your plan is saved in the browser you made it in, and in the PDF if you saved one.');
    expect(text).toContain('On another phone, computer or browser, the tool starts empty.');
    expect(text).toContain('Safari can also clear a saved plan after a week without a visit.');
    expect(text).toContain('open the tool in the browser you made it in and connect Google Drive or Dropbox');
    expect(text).not.toContain('reloads');
    expect(text).not.toContain('your own cloud storage');
  });

  it('cloud: the plan is in their own storage and loads on any device that connects the same account', () => {
    const text = visible(buildPlanReadyEmailHtml('cloud'));
    expect(text).toContain('Your plan is saved in your own cloud storage.');
    expect(text).toContain('open the tool and connect the same account, and your plan loads');
    // A cloud user may never have made a PDF, and their plan is not tied to one browser.
    expect(text).not.toContain('PDF');
    expect(text).not.toContain('browser you made it in');
  });

  it.each(LANES)('%s: no em dash anywhere in the email (docs/writing-style.md)', (lane) => {
    const html = buildPlanReadyEmailHtml(lane, {
      schedule: [{ label: 'Colonoscopy', dueAt: '2034-03-01' }],
      unsubscribeUrl: 'https://health-tool-app.fly.dev/reminders-v2/unsubscribe?token=t',
    });
    expect(html).not.toMatch(/—|&mdash;/);
  });
});

// US-23 AC3/AC5 + US-24 — the ENROLLED variant: calendar in, values still out.
describe('plan-ready email (enrolled variant) carries the calendar and nothing else', () => {
  const schedule = [
    { label: 'Colonoscopy', dueAt: '2034-03-01' },
    { label: 'Lipid panel blood test', dueAt: '2027-05-12' },
  ];
  const unsubscribeUrl = 'https://health-tool-app.fly.dev/reminders-v2/unsubscribe?token=tok123';
  const html = buildPlanReadyEmailHtml('guest', { schedule, unsubscribeUrl });

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
    const shown = visible(html).toLowerCase();
    for (const term of ['mmol', 'mg/dl', 'mmhg', 'ldl 3', 'result', 'reading']) {
      expect(shown, `enrolled plan-ready email must not mention "${term}"`).not.toContain(term);
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
    // The details string is VISIBLE text in the saved event (calendar
    // descriptions don't hide hrefs behind labels) — it must show the
    // canonical storefront page, bare, never a fly.dev backend host and never
    // the redirect's email flag.
    expect(parsed.searchParams.get('details')).toBe(
      'From your Health Roadmap. Reopen your plan: https://drstanfield.com/pages/roadmap',
    );
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

  it('carries the prominent in-body unsubscribe for EVERY recipient (US-17 AC8: no lane proves the inbox owner asked)', () => {
    const html = buildReminderV2EmailHtml(due, unsubscribeUrl, { fullSchedule: full });
    expect(html).toContain('Stop them with one click');
    // The footer unsubscribe stays too (RFC 8058 posture unchanged).
    expect(html).toContain(unsubscribeUrl);
  });

  it('without options omits the calendar section only', () => {
    const html = buildReminderV2EmailHtml(due, unsubscribeUrl);
    expect(html).not.toContain('Your full check-up calendar');
    expect(html).toContain('Stop them with one click');
    expect(html).toContain('Lipid panel blood test');
  });
});

/**
 * US-23 AC10 — the reminder button pointed at the GitHub Pages build
 * (drbradstanfield.github.io), a different site from the one every reminder
 * reader made their plan on, and 404 on the day it was found. It now goes
 * through the same counted redirect as the plan-ready email, marked so its
 * clicks are counted apart. The footer claimed "Your health data lives only in
 * your own cloud storage", false for the typed lane, which is 169 of 183 rows.
 */
describe('US-23 AC10 — the reminder button and footer', () => {
  const html = buildReminderV2EmailHtml(
    [{ label: 'Lipid panel blood test', dueAt: '2026-08-01' }],
    'https://health-tool-app.fly.dev/reminders-v2/unsubscribe?token=tok789',
    { fullSchedule: [{ label: 'Colonoscopy', dueAt: '2034-03-01' }] },
  );

  it('links the button through /roadmap/open with the reminder counter, never the Pages site', () => {
    expect(html).toContain(`href="${OPEN_URL}?src=reminder"`);
    expect(html).toContain('Open the Health Roadmap');
    expect(html).not.toContain('github.io');
  });

  it('makes no storage claim that is false for a typed-lane reader', () => {
    const text = visible(html);
    expect(text).not.toContain('lives only in your own cloud storage');
    expect(text).toContain("Dr Brad's server keeps your reminder calendar and this email address.");
    expect(text).toContain('Your plan is not stored there.');
  });

  it('has no em dash anywhere (docs/writing-style.md)', () => {
    expect(html).not.toMatch(/—|&mdash;/);
    expect(visible(html)).toContain('Lipid panel blood test, due Aug 2026');
  });
});
