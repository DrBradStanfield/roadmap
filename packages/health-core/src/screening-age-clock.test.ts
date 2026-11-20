/** US-23 AC6c: the plan's screening cards read the reminders' age (AC6b), whole years at the UTC month, in every zone;
 *  the age the plan shows stays the local month. The zone is set per test (each file runs in its own `forks` child,
 *  as reminder-utc.test.ts). Synthetic records only. */
process.env.TZ = 'UTC';

import { afterEach, describe, expect, it } from 'vitest';
import { computePlan } from './plan';
import { computeReminderSchedule } from './reminder-schedule';
import { generateSuggestions } from './suggestions';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

afterEach(() => { process.env.TZ = 'UTC'; });

const DEXA = { dexaScreening: 'dexa_scan', dexaLastDate: '2019-01', dexaResult: 'normal' } as const;
const LUNG = { lungSmokingHistory: 'former_smoker', lungPackYears: 30, lungScreening: 'annual_ldct', lungLastDate: '2024-01', lungResult: 'normal' };
function record(profile: Partial<RoadmapFile['profile']>, screenings: Record<string, unknown> = DEXA): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'age_clock', now: '2026-01-01T00:00:00Z' });
  return { ...f, profile: { ...f.profile, heightCm: 165, ...profile }, screenings: { ...f.screenings, ...screenings, updatedAt: '2026-01-01T00:00:00Z' } as RoadmapFile['screenings'] };
}

/** The plan's age, its cards for one screening, and whether the schedule has that screening, at one instant. */
function view(file: RoadmapFile, now: Date, id: 'dexa' | 'lung') {
  const plan = computePlan(file, now);
  return {
    age: plan.results.age,
    cards: plan.results.suggestions.filter((s) => s.id.startsWith(`screening-${id}`)).map((s) => s.id),
    reminder: computeReminderSchedule(file, now).some((i) => i.category === `screening_${id}`),
  };
}
const both = (age: number) => ({ age, cards: ['screening-dexa-overdue'], reminder: true }), neither = (age: number) => ({ age, cards: [], reminder: false });

describe('the plan\'s screening cards and the reminders read one age (US-23 AC6c)', () => {
  // A normal DEXA scan in 2019 (overdue now), unless the row says lung.
  it.each([
    ['New York, 30 Nov 20:00, a woman born Dec 1976: 50 at the UTC month, the card with its reminder', 'America/New_York', '2026-12-01T01:00:00Z', { sex: 'female', birthMonth: 12 }, both(49)],
    ['Auckland, 1 Oct 01:00, a woman born Oct 1976: 49 at the UTC month, no card and no reminder', 'Pacific/Auckland', '2026-09-30T12:00:00Z', { sex: 'female', birthMonth: 10 }, neither(50)],
    ['Auckland, the last second of September in UTC: still neither', 'Pacific/Auckland', '2026-09-30T23:59:59Z', { sex: 'female', birthMonth: 10 }, neither(50)],
    ['Auckland, the turn of the UTC month: both together', 'Pacific/Auckland', '2026-10-01T00:00:00Z', { sex: 'female', birthMonth: 10 }, both(50)],
    ['Los Angeles, 30 Nov 19:00, a man born Dec 1956 (DEXA from 70)', 'America/Los_Angeles', '2026-12-01T03:00:00Z', { sex: 'male', birthYear: 1956, birthMonth: 12 }, both(69)],
    ['Los Angeles, a smoker born Dec 1945: lung stops at 80, 81 at the UTC month on both sides', 'America/Los_Angeles', '2026-12-01T03:00:00Z', { sex: 'male', birthYear: 1945, birthMonth: 12, lung: true }, { age: 80, cards: [], reminder: false }],
    ['Auckland, no birth month (January): 1 Jan 01:00 is still 31 Dec in UTC', 'Pacific/Auckland', '2026-12-31T12:00:00Z', { sex: 'female', birthYear: 1977 }, neither(50)],
    ['Auckland, no birth month: the UTC new year', 'Pacific/Auckland', '2027-01-01T00:00:00Z', { sex: 'female', birthYear: 1977 }, both(50)],
    ['control: in UTC, the plan, its age and the schedule agree as before', 'UTC', '2026-12-01T01:00:00Z', { sex: 'female', birthMonth: 12 }, both(50)],
    ['control: in UTC, a month before the birth month', 'UTC', '2026-10-31T23:00:00Z', { sex: 'female', birthMonth: 11 }, neither(49)],
  ] as const)('%s', (_name, tz, at, { lung, ...profile }: { lung?: boolean; sex: 'female' | 'male'; birthYear?: number; birthMonth?: number }, expected) => {
    process.env.TZ = tz;
    expect(view(record({ birthYear: 1976, ...profile }, lung ? LUNG : DEXA), new Date(at), lung ? 'lung' : 'dexa')).toEqual(expected);
  });

  it('with no birth year the schedule has no age, so nothing but the annual floor, as before', () => {
    const f = record({ sex: 'female' });
    const withLdl = { ...f, measurements: [{ id: 'm1', metricType: 'ldl', value: 3, recordedAt: '2026-01-15T00:00:00.000Z', createdAt: '2026-01-15T00:00:00.000Z', status: 'active' }] } as RoadmapFile;
    const items = (file: RoadmapFile) => computeReminderSchedule(file, new Date('2026-12-01T01:00:00Z')).map((i) => i.category);
    expect(items(withLdl)).toEqual(['annual_checkin']);
    expect(items({ ...withLdl, profile: { ...withLdl.profile, birthYear: 1976, birthMonth: 12 } })).not.toEqual(['annual_checkin']); // control
  });

  it('a caller that gives an age and no birth year (generateSuggestions alone) is read at that age', () => {
    process.env.TZ = 'America/New_York';
    const cards = (age: number) => generateSuggestions({ heightCm: 165, sex: 'female' }, { heightCm: 165, age, suggestions: [] },
      'si', undefined, DEXA, undefined, new Date('2026-12-01T01:00:00Z')).filter((s) => s.id.startsWith('screening-dexa')).map((s) => s.id);
    expect([cards(50), cards(49)]).toEqual([['screening-dexa-overdue'], []]);
  });
});
