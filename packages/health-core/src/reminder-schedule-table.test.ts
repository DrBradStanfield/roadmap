// US-06, US-17 (A2-1 step 5): each screening reminder's age and sex gate, hard-coded from
// health_roadmap_algorithm.md, so an edit to a row's cardAges in screening-rules.ts fails here.
// One below, at, and one above each bound, for female, male and no sex; then lung's smoking,
// pack-year and follow-up cases (US-07 AC1f, AC1g).
import { describe, expect, it } from 'vitest';
import { computeNextDueDates } from './reminder-schedule';
import type { ReminderCategory } from './reminders';
import type { ScreeningInputs } from './types';

// Every screening started, with a last date, so the gate alone decides (lung: 20 pack-years, no follow-up).
const ALL_STARTED: ScreeningInputs = {
  colorectalMethod: 'fit_annual', colorectalLastDate: '2025-01',
  breastFrequency: 'annual', breastLastDate: '2025-01',
  cervicalMethod: 'hpv_every_5yr', cervicalLastDate: '2025-01',
  lungSmokingHistory: 'former_smoker', lungPackYears: 20, lungScreening: 'annual_ldct', lungLastDate: '2025-01',
  prostateDiscussion: 'will_screen', prostateLastDate: '2025-01',
  dexaScreening: 'dexa_scan', dexaLastDate: '2025-01', dexaResult: 'normal',
};

type Sex = 'female' | 'male' | undefined;
const scheduled = (category: ReminderCategory, sex: Sex, age: number, s: ScreeningInputs = ALL_STARTED) =>
  computeNextDueDates({ sex, age }, s, {}, []).some((i) => i.category === category);

/** The gates, written out: [min, max?] for each sex that takes the reminder; a missing sex never does. */
const GATES: Array<{ category: ReminderCategory; female?: [number, number?]; male?: [number, number?]; none?: [number, number?] }> = [
  { category: 'screening_colorectal', female: [35, 75], male: [35, 75], none: [35, 75] },
  { category: 'screening_breast', female: [40] },
  { category: 'screening_cervical', female: [25, 65] },
  { category: 'screening_lung', female: [50, 80], male: [50, 80], none: [50, 80] },
  { category: 'screening_prostate', male: [45] },
  { category: 'screening_dexa', female: [50], male: [70] },
];

const SEXES = [['female', 'female'], ['male', 'male'], ['none', undefined]] as const;
const BOUNDS = [25, 35, 40, 45, 50, 65, 70, 75, 80];
const cases = GATES.flatMap((g) => SEXES.flatMap(([name, sex]) => {
  const range = g[name];
  const ages = [...new Set(BOUNDS.flatMap((b) => [b - 1, b, b + 1]))];
  return ages.map((age) => [g.category, name, age, sex, !!range && age >= range[0] && (range[1] === undefined || age <= range[1])] as const);
}));

describe('US-06, US-17: the reminder gates by age and sex', () => {
  it.each(cases)('%s, sex %s, age %i', (category, _name, age, sex, expected) => {
    expect(scheduled(category, sex, age)).toBe(expected);
  });
});

describe('US-06, US-07 AC1f, AC1g: the lung reminder by smoking, pack-years and follow-up', () => {
  const lung = (age: number, s: Partial<ScreeningInputs>) => scheduled('screening_lung', undefined, age, { ...ALL_STARTED, ...s });
  const abnormal = { lungResult: 'abnormal', lungFollowupStatus: 'scheduled' } as const;

  it.each([
    ['never_smoked', 20, false], ['former_smoker', 20, true], ['current_smoker', 20, true],
    ['former_smoker', undefined, false], ['former_smoker', 19, false], ['former_smoker', 21, true],
    ['current_smoker', undefined, false], ['current_smoker', 19, false], ['current_smoker', 21, true],
  ] as const)('age 60, %s, %s pack-years: %s', (history, py, expected) => {
    expect(lung(60, { lungSmokingHistory: history, lungPackYears: py })).toBe(expected);
  });

  it('keeps the reminder for an abnormal CT below 20 pack-years, until the follow-up is completed', () => {
    expect(lung(60, { lungPackYears: 19, ...abnormal })).toBe(true);
    expect(lung(60, { lungPackYears: undefined, ...abnormal })).toBe(true);
    expect(lung(60, { lungPackYears: 19, ...abnormal, lungFollowupStatus: 'completed' })).toBe(false);
  });

  it('keeps the reminder past 80 with a follow-up, and drops it without one', () => {
    expect(lung(81, abnormal)).toBe(true);
    expect(lung(81, {})).toBe(false);
  });

  it('never for a never-smoker or below 50, even with a follow-up', () => {
    expect(lung(60, { lungSmokingHistory: 'never_smoked', ...abnormal })).toBe(false);
    expect(lung(49, abnormal)).toBe(false);
  });
});
