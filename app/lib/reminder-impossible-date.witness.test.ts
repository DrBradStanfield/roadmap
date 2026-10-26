/**
 * Parked-lead witness (cand-b, review-218): reminders/date-parse-normalizes-impossible-day.
 *
 * Lead under test: scheduleSchema (app/lib/reminder-v2.server.ts) accepts
 * '2026-02-30' — the regex passes the shape and the refine only checks
 * !Number.isNaN(Date.parse(d)), which NORMALIZES an impossible day instead of
 * rejecting it. The value is stored as written; the close-when requires the
 * predicate AND its downstream consumers to be executed with a stored
 * 2026-02-30 before deciding, because month arithmetic alone does not
 * establish a wrong user-visible outcome.
 *
 * Downstream consumers executed here (all real, no mocks needed):
 *   - buildReminderV2EmailHtml (app/lib/email.server.ts) — the due-item line
 *     and the full-calendar row both display formatReminderDate(dueAt);
 *   - googleCalendarUrl — the "Add to calendar" link built from the raw day.
 */
import { describe, it, expect } from 'vitest';
import { scheduleSchema } from './reminder-v2.server';
import { buildReminderV2EmailHtml, googleCalendarUrl } from './email.server';

const ITEM = (dueAt: string) => ({
  category: 'blood_test_lipids' as const,
  label: 'Lipid panel blood test',
  dueAt,
});

describe('parked lead: impossible days normalize through the schedule schema (cand-b)', () => {
  it('intended-safe: the schema rejects a date whose UTC year/month/day differ from the submitted YYYY-MM-DD', () => {
    // Intended-safe per the close-when: 2026-02-30 and 2026-04-31 are not real
    // days, so a schedule push naming them must be refused...
    // AC: US-23 AC4 (docs/user-stories.md) — the typed lane's "real-date
    // validation", named as one of US-23's three bounds in its residual-risk
    // line; the in-tree suite's heading says it plainly: "US-23 AC4 — dueAt
    // must be a real calendar date" (app/lib/reminder-v2-typed.test.ts).
    expect(scheduleSchema.safeParse([ITEM('2026-02-30')]).success, '2026-02-30').toBe(false);
    expect(scheduleSchema.safeParse([ITEM('2026-04-31')]).success, '2026-04-31').toBe(false);
    // ...while a real date still passes.
    expect(scheduleSchema.safeParse([ITEM('2026-10-23')]).success).toBe(true);
    expect(scheduleSchema.safeParse([ITEM('2027-12-31')]).success).toBe(true);
  });

  it('observed user-visible outcome with a stored 2026-02-30: the email month normalizes to March while the calendar link keeps the impossible day', () => {
    const due = [{ label: 'Lipid panel blood test', dueAt: '2026-02-30' }];
    const html = buildReminderV2EmailHtml(
      due,
      'https://example.test/reminders-v2/unsubscribe?token=synthetic',
      { fullSchedule: due },
    );
    // The displayed month is NORMALIZED: the reader is told the item is due in March.
    expect(html).toContain('Lipid panel blood test, due Mar 2026');
    expect(html).toContain('Mar 2026');
    // The calendar link is built from the RAW stored day: its start is Feb 30
    // (a day no calendar accepts) while its computed end is Mar 3 — the same
    // email names two different months for one item.
    const link = googleCalendarUrl('Lipid panel blood test', '2026-02-30');
    expect(link).toContain('dates=20260230%2F20260303');
    expect(html).toContain(link);
  });
});
