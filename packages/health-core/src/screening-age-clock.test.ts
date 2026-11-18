/**
 * US-23 AC6c: the plan's screening cards read the age the reminder schedule reads (AC6b): whole
 * years at the UTC month. One record at one instant gets the same screening gate in the plan and
 * in the schedule, in every zone. The age the plan shows (results.age) stays the local month.
 *
 * The zone is set per test: vitest.config runs every file in its own `forks` child, which re-reads
 * `process.env.TZ` on the next Date call (as reminder-utc.test.ts does). Synthetic records only.
 */
process.env.TZ = 'UTC';

import { afterEach, describe, expect, it } from 'vitest';
import { computePlan } from './plan';
import { computeReminderSchedule } from './reminder-schedule';
import { generateSuggestions } from './suggestions';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

afterEach(() => { process.env.TZ = 'UTC'; });

function record(profile: Partial<RoadmapFile['profile']>, screenings: Record<string, unknown>): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'age_clock', now: '2026-01-01T00:00:00Z' });
  return {
    ...f,
    profile: { ...f.profile, heightCm: 165, ...profile },
    screenings: { ...f.screenings, ...screenings, updatedAt: '2026-01-01T00:00:00Z' } as RoadmapFile['screenings'],
  };
}

/** The plan's age, its cards for one screening, and the schedule's item for it, at one instant. */
function view(file: RoadmapFile, now: Date, card: string, category: string) {
  const plan = computePlan(file, now);
  return {
    age: plan.results.age,
    cards: plan.results.suggestions.filter((s) => s.id.startsWith(card)).map((s) => s.id),
    reminder: computeReminderSchedule(file, now).some((i) => i.category === category),
  };
}

const DEXA = { dexaScreening: 'dexa_scan', dexaLastDate: '2019-01', dexaResult: 'normal' };
const dexa = (file: RoadmapFile, now: Date) => view(file, now, 'screening-dexa', 'screening_dexa');

describe('the plan\'s screening cards and the reminders read one age (US-23 AC6c)', () => {
  it('New York, 30 Nov 20:00 (1 Dec 01:00 UTC), a woman born Dec 1976: the card shows with its reminder', () => {
    process.env.TZ = 'America/New_York';
    const now = new Date('2026-12-01T01:00:00Z');
    expect(now.getDate()).toBe(30); // still 30 Nov here
    // 50 at the UTC month, so DEXA (from 50) applies on both sides. The age shown is still 49.
    expect(dexa(record({ sex: 'female', birthYear: 1976, birthMonth: 12 }, DEXA), now))
      .toEqual({ age: 49, cards: ['screening-dexa-overdue'], reminder: true });
  });

  it('Auckland, 1 Oct 01:00 (30 Sep 12:00 UTC), a woman born Oct 1976: no card and no reminder', () => {
    process.env.TZ = 'Pacific/Auckland';
    const now = new Date('2026-09-30T12:00:00Z');
    expect(now.getDate()).toBe(1); // already 1 Oct here
    // 49 at the UTC month, so neither side has DEXA yet. The age shown is already 50.
    expect(dexa(record({ sex: 'female', birthYear: 1976, birthMonth: 10 }, DEXA), now))
      .toEqual({ age: 50, cards: [], reminder: false });
  });

  it('at the turn of the UTC month, both sides move together', () => {
    process.env.TZ = 'Pacific/Auckland';
    const file = record({ sex: 'female', birthYear: 1976, birthMonth: 10 }, DEXA);
    expect(dexa(file, new Date('2026-10-01T00:00:00Z'))).toEqual({ age: 50, cards: ['screening-dexa-overdue'], reminder: true });
    expect(dexa(file, new Date('2026-09-30T23:59:59Z'))).toEqual({ age: 50, cards: [], reminder: false });
  });

  it('a man at 70 (DEXA from 70) and a lung screen ending at 80 follow the same clock', () => {
    process.env.TZ = 'America/Los_Angeles';
    const now = new Date('2026-12-01T03:00:00Z'); // 30 Nov 19:00 in Los Angeles
    const man = record({ sex: 'male', birthYear: 1956, birthMonth: 12 }, DEXA);
    expect(dexa(man, now)).toEqual({ age: 69, cards: ['screening-dexa-overdue'], reminder: true });
    // Lung cards and reminders stop at 80 (cardAges [50, 80]): 81 at the UTC month on both sides.
    const smoker = record({ sex: 'male', birthYear: 1945, birthMonth: 12 }, {
      lungSmokingHistory: 'former_smoker', lungPackYears: 30, lungScreening: 'annual_ldct', lungLastDate: '2024-01', lungResult: 'normal',
    });
    expect(view(smoker, now, 'screening-lung', 'screening_lung')).toEqual({ age: 80, cards: [], reminder: false });
  });

  it('with no birth month (read as January), the year turns at the UTC new year on both sides', () => {
    process.env.TZ = 'Pacific/Auckland';
    const file = record({ sex: 'female', birthYear: 1977 }, DEXA);
    // 1 Jan 2027 01:00 in Auckland, 31 Dec 2026 in UTC: 49 at the UTC month.
    expect(dexa(file, new Date('2026-12-31T12:00:00Z'))).toEqual({ age: 50, cards: [], reminder: false });
    expect(dexa(file, new Date('2027-01-01T00:00:00Z'))).toEqual({ age: 50, cards: ['screening-dexa-overdue'], reminder: true });
  });

  it('control: in UTC the plan, its age and the schedule agree as before', () => {
    const now = new Date('2026-12-01T01:00:00Z');
    expect(dexa(record({ sex: 'female', birthYear: 1976, birthMonth: 12 }, DEXA), now))
      .toEqual({ age: 50, cards: ['screening-dexa-overdue'], reminder: true });
    expect(dexa(record({ sex: 'female', birthYear: 1976, birthMonth: 11 }, DEXA), new Date('2026-10-31T23:00:00Z')))
      .toEqual({ age: 49, cards: [], reminder: false });
  });

  it('with no birth year the schedule has no age, so nothing but the annual floor, as before', () => {
    const f = record({ sex: 'female' }, DEXA);
    const withLdl = { ...f, measurements: [{ id: 'm1', metricType: 'ldl', value: 3, recordedAt: '2026-01-15T00:00:00.000Z', createdAt: '2026-01-15T00:00:00.000Z', status: 'active' }] } as RoadmapFile;
    expect(computeReminderSchedule(withLdl, new Date('2026-12-01T01:00:00Z')).map((i) => i.category)).toEqual(['annual_checkin']);
    // Control: the same record with a birth year has its own items.
    const aged = { ...withLdl, profile: { ...withLdl.profile, birthYear: 1976, birthMonth: 12 } };
    expect(computeReminderSchedule(aged, new Date('2026-12-01T01:00:00Z')).map((i) => i.category)).not.toEqual(['annual_checkin']);
  });

  it('a caller that gives an age and no birth year (generateSuggestions alone) is read at that age', () => {
    process.env.TZ = 'America/New_York';
    const cards = (age: number) => generateSuggestions({ heightCm: 165, sex: 'female' }, { heightCm: 165, age, suggestions: [] },
      'si', undefined, { dexaScreening: 'dexa_scan', dexaLastDate: '2019-01', dexaResult: 'normal' }, undefined, new Date('2026-12-01T01:00:00Z'))
      .filter((s) => s.id.startsWith('screening-dexa')).map((s) => s.id);
    expect(cards(50)).toEqual(['screening-dexa-overdue']);
    expect(cards(49)).toEqual([]);
  });
});
