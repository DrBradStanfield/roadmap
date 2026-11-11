// US-17 AC15 (Brad 2026-11-05, option A): after an abnormal screening result the
// emailed reminder follows the plan's follow-up card, not the routine interval.
// Organize (status unset or not_organized): due at the last screening's month,
// which has passed, so the next daily email carries it. Scheduled: a check-in
// 3 months after the last screening, even once that has passed. Completed:
// unchanged (the post-follow-up interval). Never later than the routine date.
// Neither date depends on today, so the phone's repeat days never move.
import { describe, it, expect } from 'vitest';
import { computeNextDueDates, computeReminderSchedule, followupKinds } from './reminder-schedule';
import { getPostFollowupDueDate, type ScreeningInputs } from './types';
import { SCREENING_RULES, followupTrigger } from './screening-rules';
import type { ReminderCategory } from './reminders';
import { createEmptyFile } from './roadmap-file';

const NOW = new Date(2026, 10, 5, 12); // 5 Nov 2026, local noon
const TODAY = '2026-11-05';

function dueOf(sex: 'male' | 'female', age: number, s: ScreeningInputs, category: ReminderCategory): string | undefined {
  return computeNextDueDates({ sex, age }, s, {}, []).find((i) => i.category === category)?.dueAt;
}

// Each screening with a recent abnormal result (last done Sep 2026), so the
// routine date is well in the future and only the follow-up can bring it in.
const CASES: Array<[ReminderCategory, 'male' | 'female', number, ScreeningInputs, string]> = [
  ['screening_colorectal', 'male', 60, { colorectalMethod: 'colonoscopy_10yr', colorectalLastDate: '2026-09', colorectalResult: 'abnormal' }, '2036-09-01'],
  ['screening_colorectal', 'male', 60, { colorectalMethod: 'fit_annual', colorectalLastDate: '2026-09', colorectalResult: 'abnormal' }, '2027-09-01'],
  ['screening_breast', 'female', 55, { breastFrequency: 'biennial', breastLastDate: '2026-09', breastResult: 'abnormal' }, '2028-09-01'],
  ['screening_cervical', 'female', 40, { cervicalMethod: 'hpv_every_5yr', cervicalLastDate: '2026-09', cervicalResult: 'abnormal' }, '2031-09-01'],
  ['screening_lung', 'male', 60, { lungSmokingHistory: 'former_smoker', lungPackYears: 30, lungScreening: 'annual_ldct', lungLastDate: '2026-09', lungResult: 'abnormal' }, '2027-09-01'],
  ['screening_dexa', 'female', 60, { dexaScreening: 'dexa_scan', dexaLastDate: '2026-09', dexaResult: 'osteoporosis' }, '2028-09-01'],
];

const FOLLOWUP_KEYS: Record<string, [keyof ScreeningInputs, keyof ScreeningInputs]> = {
  screening_colorectal: ['colorectalFollowupStatus', 'colorectalFollowupDate'],
  screening_breast: ['breastFollowupStatus', 'breastFollowupDate'],
  screening_cervical: ['cervicalFollowupStatus', 'cervicalFollowupDate'],
  screening_lung: ['lungFollowupStatus', 'lungFollowupDate'],
  screening_dexa: ['dexaFollowupStatus', 'dexaFollowupDate'],
};

function withFollowup(category: ReminderCategory, s: ScreeningInputs, status?: string, date?: string): ScreeningInputs {
  const [statusKey, dateKey] = FOLLOWUP_KEYS[category];
  return { ...s, [statusKey]: status, [dateKey]: date };
}

describe('US-17 AC15: follow-up reminders follow the follow-up card', () => {
  it.each(CASES)('%s: a follow-up to organize is due at the last screening, so it is already due (unset or not_organized)', (category, sex, age, s) => {
    expect(dueOf(sex, age, s, category)).toBe('2026-09-01');
    expect(dueOf(sex, age, withFollowup(category, s, 'not_organized'), category)).toBe('2026-09-01');
    expect(dueOf(sex, age, s, category)! <= TODAY).toBe(true); // the cron sends what is due by today
  });

  it.each(CASES)('%s: a scheduled follow-up gets a check-in 3 months after the last screening', (category, sex, age, s) => {
    expect(dueOf(sex, age, withFollowup(category, s, 'scheduled', '2026-12'), category)).toBe('2026-12-01');
  });

  it.each(CASES)('%s: a scheduled check-in whose 3 months have passed keeps its date', (category, sex, age, s) => {
    const [dateKey] = Object.entries(s).find(([k]) => k.endsWith('LastDate'))!;
    const older = { ...s, [dateKey]: '2026-06' };
    expect(dueOf(sex, age, withFollowup(category, older, 'scheduled'), category)).toBe('2026-09-01');
  });

  it.each(CASES)('%s: a completed, dated follow-up keeps the post-follow-up date', (category, sex, age, s) => {
    const due = dueOf(sex, age, withFollowup(category, s, 'completed', '2026-10'), category);
    expect(due).not.toBe(TODAY);
    expect(due! > TODAY).toBe(true);
  });

  it.each(CASES)('%s: a normal result keeps the routine date', (category, sex, age, s, routine) => {
    const normal = category === 'screening_dexa'
      ? { ...s, dexaResult: 'normal' }
      : Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k.endsWith('Result') ? 'normal' : v]));
    const due = dueOf(sex, age, normal as ScreeningInputs, category);
    if (category === 'screening_dexa') expect(due).toBe('2031-09-01'); // normal DEXA: 5 years
    else expect(due).toBe(routine);
  });

  it.each(CASES)('%s: is never later than the routine date, in any follow-up state', (category, sex, age, s, routine) => {
    for (const status of [undefined, 'not_organized', 'scheduled']) {
      const due = dueOf(sex, age, withFollowup(category, s, status), category)!;
      expect(due <= routine).toBe(true);
    }
  });

  it('a completed follow-up with no date is unchanged: the routine date', () => {
    const s: ScreeningInputs = { colorectalMethod: 'colonoscopy_10yr', colorectalLastDate: '2026-09', colorectalResult: 'abnormal', colorectalFollowupStatus: 'completed' };
    expect(dueOf('male', 60, s, 'screening_colorectal')).toBe('2036-09-01');
  });

  it('lung below 20 pack-years (AC1f) and past 80 (AC1g): organize at the last CT, scheduled at 3 months, completed gives no reminder', () => {
    const lung: ScreeningInputs = { lungSmokingHistory: 'former_smoker', lungPackYears: 15, lungScreening: 'annual_ldct', lungLastDate: '2026-09', lungResult: 'abnormal' };
    for (const [age, s] of [[60, lung], [82, { ...lung, lungPackYears: 30 }]] as const) {
      expect(dueOf('male', age, s, 'screening_lung')).toBe('2026-09-01');
      expect(dueOf('male', age, { ...s, lungFollowupStatus: 'scheduled' }, 'screening_lung')).toBe('2026-12-01');
      expect(dueOf('male', age, { ...s, lungFollowupStatus: 'completed', lungFollowupDate: '2026-10' }, 'screening_lung')).toBeUndefined();
    }
  });

  it('the file path gives the same dates whatever the day, including the check-in morning', () => {
    const f = createEmptyFile({ deviceId: 'followup_test', now: '2026-10-01T00:00:00Z' });
    f.profile = { ...f.profile, birthYear: 1966, sex: 'male' };
    f.screenings = { ...f.screenings, colorectalMethod: 'colonoscopy_10yr', colorectalLastDate: '2026-09', colorectalResult: 'abnormal' } as typeof f.screenings;
    const due = (file: typeof f, now: Date) => computeReminderSchedule(file, now).find((i) => i.category === 'screening_colorectal')?.dueAt;
    expect(due(f, NOW)).toBe('2026-09-01');
    expect(due(f, new Date(2026, 10, 6, 12))).toBe('2026-09-01');
    const booked = { ...f, screenings: { ...f.screenings, colorectalFollowupStatus: 'scheduled' } } as typeof f;
    expect(due(booked, new Date(2026, 10, 30, 23))).toBe('2026-12-01');
    expect(due(booked, new Date(2026, 11, 1, 7))).toBe('2026-12-01');
  });

  // US-25 AC12: the phone's own list names the card's follow-up, keyed like the card.
  it.each([
    ['colorectal', { colorectalMethod: 'fit_annual' }, 'colonoscopy'],
    ['colorectal', { colorectalMethod: 'colonoscopy_10yr' }, 'repeat colonoscopy'],
    ['breast', { breastFrequency: 'annual' }, 'diagnostic imaging/biopsy'],
    ['cervical', { cervicalMethod: 'hpv_every_5yr' }, 'colposcopy'],
    ['lung', { lungScreening: 'annual_ldct' }, 'follow-up imaging'],
    ['dexa', { dexaScreening: 'dexa_scan' }, 'treatment review'],
  ] as const)('followupKinds names the %s card\'s follow-up (%s)', (type, method, name) => {
    const f = createEmptyFile({ deviceId: 'followup_test', now: '2026-10-01T00:00:00Z' });
    const result = type === 'dexa' ? { dexaResult: 'osteoporosis' } : { [`${type}Result`]: 'abnormal' };
    f.screenings = { ...f.screenings, ...method, ...result, [`${type}LastDate`]: '2026-09', [`${type}FollowupStatus`]: 'scheduled' } as typeof f.screenings;
    expect(followupKinds(f, NOW)[`screening_${type}`]).toEqual({ kind: 'checkin', name });
  });

  // D8 (Brad 2026-11-12): the table's follow-up option decides, never a literal 'abnormal'.
  const METHODS: Record<string, Record<string, string>> = {
    colorectal: { colorectalMethod: 'fit_annual' }, breast: { breastFrequency: 'annual' },
    cervical: { cervicalMethod: 'hpv_every_5yr' }, lung: { lungScreening: 'annual_ldct' }, dexa: { dexaScreening: 'dexa_scan' },
  };
  it.each(SCREENING_RULES.filter((r) => r.result))('$id: only the table\'s follow-up option opens the follow-up reminder', (r) => {
    expect(METHODS[r.id]).toBeDefined();
    const trigger = followupTrigger(r);
    expect(trigger).toBeDefined();
    for (const { value } of r.result!.options) {
      const f = createEmptyFile({ deviceId: 'followup_test', now: '2026-10-01T00:00:00Z' });
      f.screenings = { ...f.screenings, ...METHODS[r.id], [`${r.id}Result`]: value, [`${r.id}LastDate`]: '2026-09' } as typeof f.screenings;
      expect(followupKinds(f, NOW)[`screening_${r.id}` as ReminderCategory]?.kind).toBe(value === trigger ? 'organize' : undefined);
      expect(getPostFollowupDueDate(r.id, undefined, value, 'completed', '2026-10') !== null).toBe(value === trigger);
    }
  });
});
