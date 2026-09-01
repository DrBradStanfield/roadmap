/**
 * US-23 — a due date computed from a STORED date keeps that date's day.
 *
 * The schedule's month arithmetic parsed `2026-05-12` (UTC midnight) and then
 * read the result back through the local clock, so west of Greenwich every
 * due date landed a day early: an item due tomorrow reads overdue today in the
 * Americas, and the server emails on the wrong day. Stored dates get UTC
 * arithmetic; only `now`, a real instant, is read locally.
 *
 * The timezone is pinned per-file, never suite-wide; vitest.config routes
 * `*-local-day.test.ts` to the `forks` pool, because only a real child process
 * picks up a `process.env.TZ` assignment (a worker thread inherits a copy of
 * the environment and never re-reads the zone).
 */
process.env.TZ = 'America/New_York';

import { describe, it, expect } from 'vitest';
import { computeNextDueDates, computeReminderSchedule, ANNUAL_CHECKIN_LABEL } from './reminder-schedule';
import { createEmptyFile } from './roadmap-file';

describe('reminder schedule — west of Greenwich', () => {
  it('puts a blood test recorded 2026-05-12 due on 2027-05-12, not the 11th', () => {
    const items = computeNextDueDates(
      { sex: 'male', age: 45 },
      undefined,
      { hba1c: '2026-05-12' },
      [],
    );
    expect(items.find((i) => i.category === 'blood_test_hba1c')?.dueAt).toBe('2027-05-12');
  });

  it('keeps a medication review 12 months after the day the medication was stamped', () => {
    const items = computeNextDueDates(
      { sex: 'male', age: 45 },
      undefined,
      {},
      [{ medicationKey: 'statin', drugName: 'Atorvastatin', updatedAt: '2026-05-12T15:00:00.000Z' }],
    );
    expect(items.find((i) => i.category === 'medication_review')?.dueAt).toBe('2027-05-12');
  });

  it('floors an empty schedule exactly 12 months out from today', () => {
    const now = new Date('2026-09-02T16:00:00.000Z'); // noon in New York
    const file = createEmptyFile({ deviceId: 'reminder_local_day', now: now.toISOString() });
    const floor = computeReminderSchedule(file, now).find((i) => i.label === ANNUAL_CHECKIN_LABEL);
    expect(floor?.dueAt).toBe('2027-09-02');
  });
});
