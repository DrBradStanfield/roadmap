/**
 * US-23 AC6b — reminder date maths is UTC, so one file at one instant gives the
 * same schedule in every timezone (Brad, 2026-10-21: "we always need to use
 * international time, so that everything is standard and timezones don't
 * break").
 *
 * Pinned to Pacific/Auckland, where the local day runs ahead of the UTC day,
 * so a local getter or setter in the reminder path shows up here even when the
 * suite runs in UTC. Per-file pin: vitest.config runs every file in its own
 * `forks` child, the only kind that picks up a `process.env.TZ` assignment.
 */
process.env.TZ = 'Pacific/Auckland';

import { describe, it, expect } from 'vitest';
import { computeReminderSchedule, computeNextDueDates } from './reminder-schedule';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

function fileWith(profile: Partial<RoadmapFile['profile']>, screenings: Record<string, unknown> = {}): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'utc_test', now: '2026-01-01T00:00:00Z' });
  return {
    ...f,
    profile: { ...f.profile, ...profile },
    screenings: { ...f.screenings, ...screenings } as RoadmapFile['screenings'],
  };
}

describe('reminder dates are UTC calendar arithmetic (US-23 AC6b)', () => {
  it('runs in Auckland, ahead of UTC', () => {
    expect(new Date('2026-06-15T12:00:00Z').getDate()).toBe(16);
  });

  it('dates the annual floor 12 months from the UTC day', () => {
    // 2026-06-15T12:00Z is already 16 June in Auckland.
    const items = computeReminderSchedule(fileWith({}), new Date('2026-06-15T12:00:00Z'));
    expect(items).toEqual([
      { category: 'annual_checkin', group: 'annual', label: 'Annual health check-in', dueAt: '2027-06-15' },
    ]);
  });

  it('reads age at the UTC month, so a birthday month starts on the UTC calendar', () => {
    // 2026-02-28T12:00Z is 1 March in Auckland. Born March 1981: 44 in UTC
    // (PSA from 45), 45 by the Auckland calendar.
    const f = fileWith(
      { sex: 'male', birthYear: 1981, birthMonth: 3 },
      { prostateDiscussion: 'will_screen', prostateLastDate: '2025-09', updatedAt: '2026-01-01T00:00:00Z' },
    );
    const before = computeReminderSchedule(f, new Date('2026-02-28T12:00:00Z'));
    expect(before.map((i) => i.category)).not.toContain('screening_prostate');
    const after = computeReminderSchedule(f, new Date('2026-03-01T00:00:00Z'));
    expect(after.find((i) => i.category === 'screening_prostate')?.dueAt).toBe('2026-09-01');
  });

  it('dates a medication review on the UTC day twelve months on', () => {
    // 2024-02-29T12:00Z is 1 March in Auckland; twelve local months on would be
    // 2025-02-28T12:00Z, a day early.
    const meds = [{ medicationKey: 'statin', drugName: 'atorvastatin', updatedAt: '2024-02-29T12:00:00Z' }];
    const male = { sex: 'male' as const, age: 60 };
    expect(computeNextDueDates(male, undefined, {}, meds)[0].dueAt).toBe('2025-03-01');
  });

  it('dates a screening on its due month, in every zone', () => {
    const screenings = { prostateDiscussion: 'will_screen' as const, prostateLastDate: '2025-09' };
    const male = { sex: 'male' as const, age: 60 };
    try {
      for (const zone of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
        process.env.TZ = zone; // a forks child re-reads it on the next Date call
        expect(computeNextDueDates(male, screenings, {}, [])[0].dueAt, zone).toBe('2026-09-01');
      }
    } finally {
      process.env.TZ = 'Pacific/Auckland';
    }
  });
});
