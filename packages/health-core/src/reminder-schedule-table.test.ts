// US-06, US-17 (A2-1 step 5): each screening reminder's age and sex gate is its row's cardAges in
// screening-rules.ts. For every row with a reminder, at one below, at, and one above each bound,
// for each sex and none, the reminder is scheduled exactly when the table takes the person.
import { describe, expect, it } from 'vitest';
import { computeNextDueDates } from './reminder-schedule';
import { SCREENING_RULES, ruleTakes, type AgeRange } from './screening-rules';
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

const SEXES = ['female', 'male', undefined] as const;
const cases = SCREENING_RULES.flatMap((r) => {
  if (!r.reminder) return [];
  const ranges: AgeRange[] = 'female' in r.cardAges ? [r.cardAges.female, r.cardAges.male] : [r.cardAges];
  const ages = [...new Set(ranges.flatMap(([min, max]) => [min - 1, min, min + 1, ...(max === undefined ? [] : [max - 1, max, max + 1])]))];
  return SEXES.flatMap((sex) => ages.map((age) => [r.id, sex ?? 'none', age, r.reminder!.category, ruleTakes(r, r.cardAges, age, sex)] as const));
});

describe('US-06, US-17: the reminder gate is the screening table\'s cardAges', () => {
  it('covers every row with a reminder', () => {
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(['colorectal', 'breast', 'cervical', 'lung', 'prostate', 'dexa']));
  });

  it.each(cases)('%s, sex %s, age %i: scheduled = table takes', (_id, sex, age, category, expected) => {
    const items = computeNextDueDates({ sex: sex === 'none' ? undefined : sex, age }, ALL_STARTED, {}, []);
    expect(items.some((i) => i.category === category)).toBe(expected);
  });
});
