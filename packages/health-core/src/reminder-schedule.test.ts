import { describe, it, expect } from 'vitest';
import { computeReminderSchedule, computeNextDueDates, SCHEDULE_LABELS } from './reminder-schedule';
import { computeDueReminders, REMINDER_CATEGORIES, type ReminderProfile } from './reminders';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';
import type { ScreeningInputs } from './types';

/** The shape the server's scheduleSchema accepts — a NaN date fails the push. */
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

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
  it('emits no ELIGIBILITY items without demographics (only the annual floor)', () => {
    // Pre-floor this returned [] outright; since US-23 AC6 a schedule is never
    // empty — but no screening/blood/med rule may fire without sex + birth year.
    const items = computeReminderSchedule(file(), NOW);
    expect(items.map((i) => i.category)).toEqual(['annual_checkin']);
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
    // Colonoscopy is ~4 years out (nothing within 12 months) → the annual
    // floor (US-23 AC6) appends a check-in alongside it.
    expect(items.map((i) => i.category)).toEqual(['screening_colorectal', 'annual_checkin']);
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

    // disable the category → nothing left within 12 months → only the floor
    f.reminderPreferences[0].enabled = false;
    items = computeReminderSchedule(f, NOW);
    expect(items.map((i) => i.category)).toEqual(['annual_checkin']);
  });

  it('drops a measurement row whose recordedAt is missing or unusable, instead of throwing or shadowing', () => {
    // A hand-edited or half-written record can carry a row with no usable
    // clinical date. Dropping it follows buildMeasurementHistory
    // (measurement-history.ts:40 — "records without a valid recordedAt are
    // dropped"). Coercing instead was rejected: '2026-13-45' passes the ISO
    // shape, wins `day > prev`, and yields dueAt 'NaN-NaN-NaN', which the
    // server's scheduleSchema rejects — failing the user's ENTIRE schedule
    // push. (A dropped row cannot surface a spurious reminder either way:
    // bloodTestSchedule skips a test with no lastDate.)
    const profile = { sex: 'female', birthYear: 1970, updatedAt: '2026-01-01T00:00:00Z', lamport: 1 } as RoadmapFile['profile'];
    const dated = createMeasurement({ id: 'm1', metricType: 'ldl', value: 2.5, recordedAt: '2025-05-01T08:00:00Z', createdAt: '2025-05-01T08:00:00Z' });
    const valid = computeReminderSchedule(file({ profile, measurements: [dated] }), NOW);
    expect(valid.find((i) => i.category === 'blood_test_lipids')).toMatchObject({ dueAt: '2026-05-01' });

    for (const bad of [undefined, '', 'soon', '2026-13-45']) {
      const junk = { ...createMeasurement({ id: 'm2', metricType: 'ldl', value: 9, recordedAt: '2026-06-01T08:00:00Z', createdAt: '2026-06-01T08:00:00Z' }), recordedAt: bad as unknown as string };
      expect(computeReminderSchedule(file({ profile, measurements: [dated, junk] }), NOW)).toEqual(valid);
    }
  });

  it('never emits a NaN dueAt from a garbage medication updatedAt, and still floors the schedule', () => {
    // The same whole-push failure from the output side: medicationSchedule does
    // date maths on whatever the file says, and an unparseable updatedAt yields
    // dueAt 'NaN-NaN-NaN' — which the server's scheduleSchema rejects, taking
    // every other reminder down with it. One bad row costs its own item only.
    const f = file({
      profile: { sex: 'male', birthYear: 1986, birthMonth: 11, updatedAt: '2026-01-01T00:00:00Z', lamport: 1 } as RoadmapFile['profile'],
      screenings: {
        colorectalMethod: 'colonoscopy_10yr',
        colorectalLastDate: '2020-01',
        updatedAt: '2026-01-01T00:00:00Z',
        lamport: 1,
      } as RoadmapFile['screenings'],
      medications: [
        { id: 'med1', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', updatedAt: 'garbage', lamport: 1 },
      ] as RoadmapFile['medications'],
    });
    const items = computeReminderSchedule(f, NOW);

    expect(items.every((i) => ISO_DATE_SHAPE.test(i.dueAt))).toBe(true);
    // The colonoscopy is years out, so the annual floor (US-23 AC6) still fires.
    expect(items.map((i) => i.category)).toEqual(['screening_colorectal', 'annual_checkin']);
    expect(items[0]).toMatchObject({ dueAt: '2030-01-01' });
  });

});

// US-23 AC6 — the annual floor (Brad, 2026-08-14): every enrolled person gets
// at least one touch a year; a schedule is never empty.
describe('computeReminderSchedule — annual floor', () => {
  it('seeds one check-in 12 months out when the file has no demographics at all', () => {
    const items = computeReminderSchedule(file(), NOW);
    expect(items).toEqual([
      { category: 'annual_checkin', group: 'annual', label: 'Annual health check-in', dueAt: '2027-06-15' },
    ]);
  });

  it('does NOT add the floor when something is already due within 12 months', () => {
    const f = file({
      profile: { sex: 'female', birthYear: 1970, updatedAt: '2026-01-01T00:00:00Z', lamport: 1 },
      measurements: [
        createMeasurement({ id: 'm1', metricType: 'hba1c', value: 40, recordedAt: '2026-01-10T08:00:00Z', createdAt: '2026-01-10T08:00:00Z' }),
      ],
    });
    const items = computeReminderSchedule(f, NOW); // hba1c due 2027-01-10 < 12mo away
    expect(items.some((i) => i.category === 'annual_checkin')).toBe(false);
  });

  it('adds the floor when every real item is more than 12 months out', () => {
    const f = file({
      profile: { sex: 'male', birthYear: 1966, updatedAt: '2026-01-01T00:00:00Z', lamport: 1 },
      screenings: {
        colorectalMethod: 'colonoscopy_10yr',
        colorectalLastDate: '2025-01',
        updatedAt: '2026-01-01T00:00:00Z',
        lamport: 1,
      } as RoadmapFile['screenings'],
    });
    const items = computeReminderSchedule(f, NOW); // colonoscopy due 2035
    expect(items.map((i) => i.category).sort()).toEqual(['annual_checkin', 'screening_colorectal']);
    expect(items.find((i) => i.category === 'annual_checkin')!.dueAt).toBe('2027-06-15');
  });
});

// US-23 AC4/AC8 — the label allow-list: every label a schedule builder can emit
// must be declared in SCHEDULE_LABELS, or the server would reject a legitimate
// push (and an undeclared label would mean free text can reach an inbox).
describe('SCHEDULE_LABELS covers every emitted label', () => {
  it('declares every category and matches the labels the builders emit', () => {
    expect(Object.keys(SCHEDULE_LABELS).sort()).toEqual([...REMINDER_CATEGORIES].sort());

    // Exercise the builders across both sexes and every screening variant that
    // switches a label, and assert each emitted label is allow-listed.
    const screenings = {
      colorectalMethod: 'colonoscopy_10yr', colorectalLastDate: '2024-03',
      breastFrequency: 'biennial', breastLastDate: '2024-01',
      cervicalMethod: 'hpv_5yr', cervicalLastDate: '2024-01',
      lungSmokingHistory: 'former_smoker', lungPackYears: 20, lungScreening: 'annual_ldct', lungLastDate: '2025-01',
      prostateDiscussion: 'will_screen', prostateLastDate: '2025-01',
      dexaScreening: 'dexa_scan', dexaLastDate: '2024-01', dexaResult: 'normal',
      updatedAt: '2026-01-01T00:00:00Z',
    } as unknown as ScreeningInputs;
    const fitScreenings = { ...screenings, colorectalMethod: 'fit_annual' } as unknown as ScreeningInputs;
    const dates = { ldl: '2025-05-01', hba1c: '2025-05-01', creatinine: '2025-05-01' };
    const meds = [{ medicationKey: 'statin', drugName: 'atorvastatin', updatedAt: '2025-01-01' }];

    const emitted = [
      ...computeNextDueDates(MALE_60, screenings, dates, meds),
      ...computeNextDueDates(MALE_60, fitScreenings, {}, []),
      ...computeNextDueDates(FEMALE_55, screenings, {}, []),
    ];
    for (const item of emitted) {
      expect(SCHEDULE_LABELS[item.category]).toContain(item.label);
    }
    // Both colorectal variants actually exercised (the one category with two labels).
    const colorectalLabels = emitted.filter((i) => i.category === 'screening_colorectal').map((i) => i.label);
    expect(new Set(colorectalLabels)).toEqual(new Set(['Colonoscopy', 'Colorectal screening']));
  });
});
