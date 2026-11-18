/**
 * US-23 AC6c on the iPhone: the engine's plan (planJson) and its reminders (remindersJson) run
 * health-core's computePlan and computeReminderSchedule, so a screening card and its reminder read
 * one age, at the UTC month, whatever the phone's zone. The phone passes its wall-clock time with
 * no zone; the zone is set per test (vitest.config runs every file in its own `forks` child).
 * Synthetic records only.
 */
process.env.TZ = 'UTC';

import { afterEach, describe, expect, it } from 'vitest';
import { planJson, remindersJson, screenJson } from './entry';
import { newRecord } from './my-data';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

afterEach(() => { process.env.TZ = 'UTC'; });

function record(now: string, birthMonth: number): string {
  const file = newRecord(now, 'phone', 'en-NZ', 'UTC');
  return JSON.stringify({
    ...file,
    profile: { ...file.profile, sex: 'female', heightCm: 165, birthYear: 1976, birthMonth },
    screenings: { ...file.screenings, dexaScreening: 'dexa_scan', dexaLastDate: '2019-01', dexaResult: 'normal' },
  } satisfies RoadmapFile);
}

/** The engine's plan age, its DEXA cards, and whether the phone's reminders list DEXA. */
function dexa(json: string, now: string) {
  const plan = JSON.parse(planJson(json, now, 'phone')) as { results: { age?: number; suggestions: Array<{ id: string }> } };
  const reminders = JSON.parse(remindersJson(json, now, 'phone')) as { upcoming: Array<{ category: string }> };
  return {
    age: plan.results.age,
    cards: plan.results.suggestions.filter((s) => s.id.startsWith('screening-dexa')).map((s) => s.id),
    reminder: reminders.upcoming.some((i) => i.category === 'screening_dexa'),
  };
}

describe('the iPhone engine\'s screening cards and reminders read one age (US-23 AC6c)', () => {
  it('a phone in New York at 20:00 on 30 Nov (1 Dec in UTC), born Dec 1976: card and reminder', () => {
    process.env.TZ = 'America/New_York';
    const now = '2026-11-30T20:00:00.000';
    expect(dexa(record(now, 12), now)).toEqual({ age: 49, cards: ['screening-dexa-overdue'], reminder: true });
  });

  it('a phone in Auckland at 01:00 on 1 Oct (30 Sep in UTC), born Oct 1976: neither', () => {
    process.env.TZ = 'Pacific/Auckland';
    const now = '2026-10-01T01:00:00.000';
    expect(dexa(record(now, 10), now)).toEqual({ age: 50, cards: [], reminder: false });
  });

  it('stated limit: the phone\'s screening questions still follow the age shown, in both directions', () => {
    // myData.screenings is screeningForm's sections, built from the plan's shown age (my-data-forms.ts basisOf).
    const sections = (json: string, now: string) =>
      (JSON.parse(screenJson(json, now, 'phone')) as { myData: { screenings: Array<{ id: string }> } }).myData.screenings.map((s) => s.id);
    process.env.TZ = 'America/New_York'; // the DEXA card shows (above), the questions read 49
    expect(sections(record('2026-11-30T20:00:00.000', 12), '2026-11-30T20:00:00.000')).not.toContain('bone-density');
    process.env.TZ = 'Pacific/Auckland'; // no DEXA card (above), the questions read 50
    expect(sections(record('2026-10-01T01:00:00.000', 10), '2026-10-01T01:00:00.000')).toContain('bone-density');
  });
});
