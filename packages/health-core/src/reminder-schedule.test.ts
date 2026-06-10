import { describe, it, expect } from 'vitest';
import { computeReminderSchedule, computeNextDueDates } from './reminder-schedule';
import { computeDueReminders, type ReminderProfile } from './reminders';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';
import type { ScreeningInputs } from './types';

// Fixed "today" for determinism: 15 June 2026
const NOW = new Date(2026, 5, 15);

const MALE_60: ReminderProfile = { sex: 'male', age: 60 };
const FEMALE_55: ReminderProfile = { sex: 'female', age: 55 };

function file(overrides: Partial<RoadmapFile> = {}): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'dev_test', now: '2026-01-01T00:00:00Z' });
  return { ...f, ...overrides };
}

describe('computeNextDueDates — screenings', () => {
  it('schedules a colonoscopy 10 years out (future date, not just overdue)', () => {
    const screenings: ScreeningInputs = {
      colorectalMethod: 'colonoscopy_10yr',
      colorectalLastDate: '2024-03',
      updatedAt: '2026-01-01T00:00:00Z',
    } as ScreeningInputs;
    const items = computeNextDueDates(MALE_60, screenings, {}, []);
    const item = items.find((i) => i.category === 'screening_colorectal');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Colonoscopy');
    expect(item!.dueAt).toBe('2034-03-01'); // 2024-03 + 120 months
  });

  it('uses the post-followup interval after an abnormal result + completed followup', () => {
    const screenings = {
      colorectalMethod: 'fit_annual',
      colorectalLastDate: '2025-01',
      colorectalResult: 'abnormal',
      colorectalFollowupStatus: 'completed',
      colorectalFollowupDate: '2025-06',
      updatedAt: '2026-01-01T00:00:00Z',
    } as unknown as ScreeningInputs;
    const items = computeNextDueDates(MALE_60, screenings, {}, []);
    const item = items.find((i) => i.category === 'screening_colorectal')!;
    // earliest of: 2025-01 + 12mo = 2026-01 (annual FIT) vs 2025-06 + 36mo = 2028-06
    expect(item.dueAt).toBe('2026-01-01');
  });

  it('respects sex/age eligibility (no mammogram item for a male)', () => {
    const screenings = {
      breastFrequency: 'biennial',
      breastLastDate: '2024-01',
      updatedAt: '2026-01-01T00:00:00Z',
    } as unknown as ScreeningInputs;
    expect(computeNextDueDates(MALE_60, screenings, {}, [])).toHaveLength(0);
    const items = computeNextDueDates(FEMALE_55, screenings, {}, []);
    expect(items[0]).toMatchObject({ category: 'screening_breast', label: 'Mammogram', dueAt: '2026-01-01' });
  });

  it('DEXA: osteopenia uses the 2-year interval; awaiting result emits nothing', () => {
    const base = {
      dexaScreening: 'dexa_scan',
      dexaLastDate: '2025-02',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const osteopenia = { ...base, dexaResult: 'osteopenia' } as unknown as ScreeningInputs;
    const awaiting = { ...base, dexaResult: 'awaiting' } as unknown as ScreeningInputs;
    expect(computeNextDueDates(FEMALE_55, osteopenia, {}, [])[0].dueAt).toBe('2027-02-01');
    expect(computeNextDueDates(FEMALE_55, awaiting, {}, [])).toHaveLength(0);
  });

  it('prostate: only when elected to screen with a last date', () => {
    const screenings = {
      prostateDiscussion: 'will_screen',
      prostateLastDate: '2025-09',
      updatedAt: '2026-01-01T00:00:00Z',
    } as unknown as ScreeningInputs;
    const items = computeNextDueDates(MALE_60, screenings, {}, []);
    expect(items[0]).toMatchObject({ category: 'screening_prostate', label: 'PSA test', dueAt: '2026-09-01' });
  });
});

describe('computeNextDueDates — blood tests & medication review', () => {
  it('schedules tracked blood tests 12 months after the latest result', () => {
    const items = computeNextDueDates(MALE_60, undefined, { ldl: '2025-10-01', hba1c: '2024-02-10' }, []);
    expect(items.find((i) => i.category === 'blood_test_lipids')!.dueAt).toBe('2026-10-01');
    expect(items.find((i) => i.category === 'blood_test_hba1c')!.dueAt).toBe('2025-02-10');
    expect(items.find((i) => i.category === 'blood_test_creatinine')).toBeUndefined(); // never tracked
  });

  it('medication review keys off the least recently updated ACTIVE medication', () => {
    const items = computeNextDueDates(MALE_60, undefined, {}, [
      { medicationKey: 'statin', drugName: 'atorvastatin', updatedAt: '2025-01-15T00:00:00Z' },
      { medicationKey: 'glp1', drugName: 'not_yet', updatedAt: '2020-01-01T00:00:00Z' }, // inactive — ignored
    ]);
    expect(items.find((i) => i.category === 'medication_review')!.dueAt).toBe('2026-01-15');
  });

  it('no medication item when nothing is active', () => {
    const items = computeNextDueDates(MALE_60, undefined, {}, [
      { medicationKey: 'statin', drugName: 'none', updatedAt: '2020-01-01T00:00:00Z' },
    ]);
    expect(items).toHaveLength(0);
  });
});

describe('v1 parity — overdue in v1 ⟺ dueAt in the past here', () => {
  it('matches computeDueReminders on a mixed overdue/upcoming case', () => {
    const screenings = {
      colorectalMethod: 'fit_annual',
      colorectalLastDate: '2024-01', // overdue (due 2025-01)
      prostateDiscussion: 'will_screen',
      prostateLastDate: '2026-01', // not due until 2027-01
      updatedAt: '2026-01-01T00:00:00Z',
    } as unknown as ScreeningInputs;
    const measurementDates = { hba1c: '2024-06-01' }; // overdue
    const schedule = computeNextDueDates(MALE_60, screenings, measurementDates, []);
    const v1 = computeDueReminders(MALE_60, screenings, measurementDates, [], NOW);
    const overdueCategories = schedule.filter((i) => new Date(i.dueAt) <= NOW).map((i) => i.category).sort();
    expect(overdueCategories).toEqual(v1.reminders.map((r) => r.category).sort());
    // and the schedule ALSO carries the future item v1 cannot see
    expect(schedule.find((i) => i.category === 'screening_prostate')!.dueAt).toBe('2027-01-01');
  });
});

describe('computeReminderSchedule — RoadmapFile adapter', () => {
  it('returns [] without demographics', () => {
    expect(computeReminderSchedule(file(), NOW)).toEqual([]);
  });

  it('derives age from birth year/month (pre-birthday)', () => {
    // Born Nov 1986 → 39 in June 2026 → colorectal eligible (35+)
    const f = file({
      profile: { sex: 'male', birthYear: 1986, birthMonth: 11, updatedAt: '2026-01-01T00:00:00Z', lamport: 1 },
      screenings: {
        colorectalMethod: 'colonoscopy_10yr',
        colorectalLastDate: '2020-01',
        updatedAt: '2026-01-01T00:00:00Z',
        lamport: 1,
      } as RoadmapFile['screenings'],
    });
    const items = computeReminderSchedule(f, NOW);
    expect(items.map((i) => i.category)).toEqual(['screening_colorectal']);
  });

  it('uses latest ACTIVE measurement per metric and honours disabled preferences', () => {
    const f = file({
      profile: { sex: 'female', birthYear: 1970, updatedAt: '2026-01-01T00:00:00Z', lamport: 1 },
      measurements: [
        createMeasurement({ id: 'm1', metricType: 'ldl', value: 3.0, recordedAt: '2024-05-01T08:00:00Z', createdAt: '2024-05-01T08:00:00Z' }),
        createMeasurement({ id: 'm2', metricType: 'ldl', value: 2.5, recordedAt: '2025-05-01T08:00:00Z', createdAt: '2025-05-01T08:00:00Z' }),
        createMeasurement({ id: 'm3', metricType: 'hba1c', value: 41, recordedAt: '2024-01-01T08:00:00Z', createdAt: '2024-01-01T08:00:00Z', status: 'entered-in-error' }),
      ],
      reminderPreferences: [
        { category: 'blood_test_lipids', enabled: true, updatedAt: '2026-01-01T00:00:00Z', lamport: 1 },
      ],
    });
    let items = computeReminderSchedule(f, NOW);
    // hba1c row is entered-in-error → ignored; lipids uses the NEWER ldl date
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'blood_test_lipids', dueAt: '2026-05-01' });

    // disable the category → empty schedule
    f.reminderPreferences[0].enabled = false;
    items = computeReminderSchedule(f, NOW);
    expect(items).toHaveLength(0);
  });
});
