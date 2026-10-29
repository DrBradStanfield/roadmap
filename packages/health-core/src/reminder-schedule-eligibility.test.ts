// US-06: screening nudges follow health_roadmap_algorithm.md. This pins the
// emailed reminder schedule (US-17, US-23 AC1) to that doc's "Eligibility by Age &
// Sex" table at every age, sex and pack-year boundary. The schedule is the
// only reminder someone gets if they never reopen the app, so an off-by-one
// here silently drops or adds an email.
import { describe, it, expect } from 'vitest';
import { computeNextDueDates } from './reminder-schedule';
import type { ScreeningInputs } from './types';
import type { ReminderCategory } from './reminders';

// Every screening started, with a last date, so eligibility alone decides.
const ALL_STARTED: ScreeningInputs = {
  colorectalMethod: 'fit_annual',
  colorectalLastDate: '2025-01',
  breastFrequency: 'annual',
  breastLastDate: '2025-01',
  cervicalMethod: 'hpv_every_5yr',
  cervicalLastDate: '2025-01',
  lungSmokingHistory: 'former_smoker',
  lungPackYears: 15,
  lungScreening: 'annual_ldct',
  lungLastDate: '2025-01',
  prostateDiscussion: 'will_screen',
  prostateLastDate: '2025-01',
  dexaScreening: 'dexa_scan',
  dexaLastDate: '2025-01',
  dexaResult: 'normal',
};

function scheduled(sex: 'male' | 'female', age: number, screenings: ScreeningInputs = ALL_STARTED): Set<ReminderCategory> {
  return new Set(computeNextDueDates({ sex, age }, screenings, {}, []).map((i) => i.category));
}

describe('screening reminder eligibility (US-06, algorithm doc table)', () => {
  it.each([
    ['screening_colorectal', 'male', 34, false],
    ['screening_colorectal', 'male', 35, true],
    ['screening_colorectal', 'male', 75, true],
    ['screening_colorectal', 'male', 76, false],
    ['screening_colorectal', 'female', 35, true],
    ['screening_breast', 'female', 39, false],
    ['screening_breast', 'female', 40, true],
    ['screening_breast', 'male', 60, false],
    ['screening_cervical', 'female', 24, false],
    ['screening_cervical', 'female', 25, true],
    ['screening_cervical', 'female', 65, true],
    ['screening_cervical', 'female', 66, false],
    ['screening_cervical', 'male', 40, false],
    ['screening_lung', 'male', 49, false],
    ['screening_lung', 'male', 50, true],
    ['screening_lung', 'male', 80, true],
    ['screening_lung', 'male', 81, false],
    ['screening_lung', 'female', 50, true],
    ['screening_prostate', 'male', 44, false],
    ['screening_prostate', 'male', 45, true],
    ['screening_prostate', 'female', 60, false],
    ['screening_dexa', 'female', 49, false],
    ['screening_dexa', 'female', 50, true],
    ['screening_dexa', 'male', 69, false],
    ['screening_dexa', 'male', 70, true],
  ] as const)('%s, %s aged %i: scheduled is %s', (category, sex, age, expected) => {
    expect(scheduled(sex, age).has(category)).toBe(expected);
  });

  it('lung needs a smoking history and at least 15 pack-years', () => {
    expect(scheduled('male', 60, { ...ALL_STARTED, lungPackYears: 14 }).has('screening_lung')).toBe(false);
    expect(scheduled('male', 60, { ...ALL_STARTED, lungPackYears: undefined }).has('screening_lung')).toBe(false);
    expect(scheduled('male', 60, { ...ALL_STARTED, lungSmokingHistory: 'never_smoked' }).has('screening_lung')).toBe(false);
    expect(scheduled('male', 60, { ...ALL_STARTED, lungSmokingHistory: 'current_smoker' }).has('screening_lung')).toBe(true);
  });

  it('a screening not yet started schedules nothing', () => {
    const notStarted: ScreeningInputs = {
      ...ALL_STARTED,
      colorectalMethod: 'not_yet_started',
      breastFrequency: 'not_yet_started',
      cervicalMethod: 'not_yet_started',
      lungScreening: 'not_yet_started',
      dexaScreening: 'not_yet_started',
    };
    const items = scheduled('female', 60, notStarted);
    for (const category of ['screening_colorectal', 'screening_breast', 'screening_cervical', 'screening_lung', 'screening_dexa'] as const) {
      expect(items.has(category)).toBe(false);
    }
  });

  it('prostate needs an elected screen and a last date', () => {
    expect(scheduled('male', 60, { ...ALL_STARTED, prostateDiscussion: 'not_yet' }).has('screening_prostate')).toBe(false);
    expect(scheduled('male', 60, { ...ALL_STARTED, prostateLastDate: undefined }).has('screening_prostate')).toBe(false);
  });

  it('a DEXA awaiting its result schedules nothing', () => {
    expect(scheduled('female', 60, { ...ALL_STARTED, dexaResult: 'awaiting' }).has('screening_dexa')).toBe(false);
  });
});
