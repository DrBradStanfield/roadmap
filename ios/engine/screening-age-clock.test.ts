/** US-23 AC6c on the iPhone: planJson, remindersJson and screenJson's questions read one age, at the UTC month, whatever the
 *  phone's zone. The phone passes wall-clock time with no zone; the zone is set per test (own `forks` child). Synthetic records only. */
process.env.TZ = 'UTC';

import { afterEach, describe, expect, it } from 'vitest';
import { planJson, remindersJson, screenJson } from './entry';
import { newRecord } from './my-data';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

afterEach(() => { process.env.TZ = 'UTC'; });

function record(now: string, birthMonth: number, noHeight = false): string {
  const file = newRecord(now, 'phone', 'en-NZ', 'UTC');
  return JSON.stringify({
    ...file,
    profile: { ...file.profile, sex: 'female', heightCm: noHeight ? undefined : 165, birthYear: 1976, birthMonth },
    screenings: { ...file.screenings, dexaScreening: 'dexa_scan', dexaLastDate: '2019-01', dexaResult: 'normal' },
  } satisfies RoadmapFile);
}

const myDataOf = (json: string, now: string) =>
  (JSON.parse(screenJson(json, now, 'phone')) as { myData: { screenings: Array<{ id: string }>; screeningNote: string | null } }).myData;

/** The engine's plan age, its DEXA cards, whether the reminders list DEXA, and whether the questions show Bone Density. */
function dexa(json: string, now: string) {
  const plan = JSON.parse(planJson(json, now, 'phone')) as { results: { age?: number; suggestions: Array<{ id: string }> } };
  const reminders = JSON.parse(remindersJson(json, now, 'phone')) as { upcoming: Array<{ category: string }> };
  return {
    age: plan.results.age,
    cards: plan.results.suggestions.filter((s) => s.id.startsWith('screening-dexa')).map((s) => s.id),
    reminder: reminders.upcoming.some((i) => i.category === 'screening_dexa'),
    questions: myDataOf(json, now).screenings.some((s) => s.id === 'bone-density'),
  };
}

describe('the iPhone engine\'s screening cards, questions and reminders read one age (US-23 AC6c)', () => {
  it.each([
    ['New York at 20:00 on 30 Nov (1 Dec in UTC), born Dec 1976: card, questions and reminder', 'America/New_York', '2026-11-30T20:00:00.000', 12, { age: 49, cards: ['screening-dexa-overdue'], reminder: true, questions: true }],
    ['Auckland at 01:00 on 1 Oct (30 Sep in UTC), born Oct 1976: none of them', 'Pacific/Auckland', '2026-10-01T01:00:00.000', 10, { age: 50, cards: [], reminder: false, questions: false }],
  ])('a phone in %s', (_name, tz, now, birthMonth, expected) => {
    process.env.TZ = tz;
    expect(dexa(record(now, birthMonth), now)).toEqual(expected);
  });

  it('with no plan (no height) the phone asks no screening question, as before', () => {
    const now = '2026-11-30T20:00:00.000';
    const { screenings, screeningNote } = myDataOf(record(now, 12, true), now);
    expect([screenings, screeningNote]).toEqual([[], expect.stringMatching(/sex, birth year and height/)]);
  });
});
