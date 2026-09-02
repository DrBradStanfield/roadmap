/**
 * US-30 — the plan has ONE "today", and it is the user's local calendar day.
 *
 * `dueSplit` read the day off `generatedAt`, a UTC instant, so at 11am in
 * Auckland a screening due TODAY was printed as "upcoming" — the reader was
 * told to wait a day for something already due. The timezone is pinned per-file
 * rather than suite-wide, so it cannot hide UTC-only assumptions elsewhere — and
 * vitest.config runs the whole suite in the `forks` pool, because only a real
 * child process picks up a `process.env.TZ` assignment (a worker thread inherits
 * a copy of the environment and never re-reads the zone).
 */
process.env.TZ = 'Pacific/Auckland';

import { describe, it, expect } from 'vitest';
import { createEmptyFile } from './roadmap-file';
import { computePlan, dueSplit, renderJson, type Plan } from './plan';
import type { ReminderScheduleItem } from './reminder-schedule';

const NOW = new Date('2026-09-01T23:00:00.000Z'); // 2026-09-02 11:00 in Auckland

function planAt(now: Date): Plan {
  const file = createEmptyFile({ deviceId: 'plan_local_day', now: now.toISOString() });
  Object.assign(file.profile, { sex: 'male', heightCm: 180, dateOfBirth: '1980-01-01' });
  return computePlan(file, now);
}

const dueToday: ReminderScheduleItem = {
  category: 'annual_checkin',
  group: 'annual',
  label: 'Annual check-in',
  dueAt: '2026-09-02',
};

describe('the plan’s today', () => {
  it('is the local calendar day, not the UTC day of generatedAt', () => {
    const plan = planAt(NOW);
    expect(plan.generatedAt.slice(0, 10)).toBe('2026-09-01');
    expect(plan.today).toBe('2026-09-02');
  });

  it('puts an item due today in overdue, never upcoming', () => {
    const plan = { ...planAt(NOW), due: [dueToday] };
    const { overdue, upcoming } = dueSplit(plan);
    expect(overdue.map((i) => i.dueAt)).toEqual(['2026-09-02']);
    expect(upcoming).toEqual([]);
  });

  it('carries today into the agent-facing JSON, beside generatedAt', () => {
    const json = JSON.parse(renderJson({ ...planAt(NOW), due: [dueToday] })) as {
      today: string;
      due: { overdue: ReminderScheduleItem[]; upcoming: ReminderScheduleItem[] };
    };
    expect(json.today).toBe('2026-09-02');
    expect(json.due.overdue).toHaveLength(1);
    expect(json.due.upcoming).toHaveLength(0);
  });
});
