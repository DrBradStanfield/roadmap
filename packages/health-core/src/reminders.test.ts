import { describe, it, expect } from 'vitest';
import {
  computeDueReminders,
  filterByPreferences,
  getCategoryGroup,
  formatReminderDate,
  GROUP_COOLDOWNS,
  REMINDER_CATEGORIES,
  REMINDER_CATEGORY_LABELS,
} from './reminders';
import type {
  ReminderProfile,
  MeasurementDates,
  MedicationRecord,
  ReminderCategory,
} from './reminders';
import type { ScreeningInputs } from './types';

// Helper to create a date string N months ago from a reference date
function monthsAgo(months: number, from: Date = new Date('2026-02-01')): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

// Helper to create a YYYY-MM string N months ago
function monthsAgoYYYYMM(months: number, from: Date = new Date('2026-02-01')): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() - months);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

const NOW = new Date('2026-02-01');

const maleProfile: ReminderProfile = { sex: 'male', age: 55 };
const femaleProfile: ReminderProfile = { sex: 'female', age: 55 };

describe('computeDueReminders', () => {
  describe('Screening reminders', () => {
    it('returns colorectal screening reminder when FIT is overdue (male, age 55)', () => {
      const screenings: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: monthsAgoYYYYMM(14), // 14 months ago, overdue for annual
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      const reminder = result.reminders.find(r => r.category === 'screening_colorectal');
      expect(reminder).toBeDefined();
      expect(reminder?.group).toBe('screening');
      expect(reminder?.title).toContain('Colorectal');
    });

    it('does not return colorectal reminder when FIT is up to date', () => {
      const screenings: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: monthsAgoYYYYMM(6), // 6 months ago, not overdue
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_colorectal')).toBeUndefined();
    });

    it('does not remind for colorectal if method is not_yet_started', () => {
      const screenings: ScreeningInputs = {
        colorectalMethod: 'not_yet_started',
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_colorectal')).toBeUndefined();
    });

    it('does not remind for colorectal if user is too young (age 30)', () => {
      const screenings: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: monthsAgoYYYYMM(14),
      };
      const result = computeDueReminders({ sex: 'male', age: 30 }, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_colorectal')).toBeUndefined();
    });

    it('does not remind for colorectal if user is too old (age 80)', () => {
      const screenings: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: monthsAgoYYYYMM(14),
      };
      const result = computeDueReminders({ sex: 'male', age: 80 }, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_colorectal')).toBeUndefined();
    });

    it('returns colonoscopy overdue reminder after 10+ years', () => {
      const screenings: ScreeningInputs = {
        colorectalMethod: 'colonoscopy_10yr',
        colorectalLastDate: monthsAgoYYYYMM(125), // ~10.4 years
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_colorectal')).toBeDefined();
    });

    it('does not return colonoscopy reminder within 10 years', () => {
      const screenings: ScreeningInputs = {
        colorectalMethod: 'colonoscopy_10yr',
        colorectalLastDate: monthsAgoYYYYMM(60), // 5 years
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_colorectal')).toBeUndefined();
    });

    it('returns post-follow-up reminder when abnormal + completed follow-up is overdue', () => {
      const screenings: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: monthsAgoYYYYMM(40), // original screening long ago
        colorectalResult: 'abnormal',
        colorectalFollowupStatus: 'completed',
        colorectalFollowupDate: monthsAgoYYYYMM(40), // follow-up 40 months ago (overdue for 36-month repeat)
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_colorectal')).toBeDefined();
    });

    it('returns mammogram reminder for female age 50 when overdue', () => {
      const screenings: ScreeningInputs = {
        breastFrequency: 'annual',
        breastLastDate: monthsAgoYYYYMM(14),
      };
      const result = computeDueReminders(femaleProfile, screenings, {}, [], NOW);
      const reminder = result.reminders.find(r => r.category === 'screening_breast');
      expect(reminder).toBeDefined();
      expect(reminder?.title).toContain('Mammogram');
    });

    it('does not return mammogram reminder for male', () => {
      const screenings: ScreeningInputs = {
        breastFrequency: 'annual',
        breastLastDate: monthsAgoYYYYMM(14),
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_breast')).toBeUndefined();
    });

    it('does not return mammogram reminder for female under 40', () => {
      const screenings: ScreeningInputs = {
        breastFrequency: 'annual',
        breastLastDate: monthsAgoYYYYMM(14),
      };
      const result = computeDueReminders({ sex: 'female', age: 35 }, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_breast')).toBeUndefined();
    });

    it('returns cervical screening reminder for female age 30 when overdue', () => {
      const screenings: ScreeningInputs = {
        cervicalMethod: 'hpv_every_5yr',
        cervicalLastDate: monthsAgoYYYYMM(65), // overdue for 60-month interval
      };
      const result = computeDueReminders({ sex: 'female', age: 30 }, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_cervical')).toBeDefined();
    });

    it('does not return cervical reminder for male', () => {
      const screenings: ScreeningInputs = {
        cervicalMethod: 'hpv_every_5yr',
        cervicalLastDate: monthsAgoYYYYMM(65),
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_cervical')).toBeUndefined();
    });

    it('returns lung screening reminder for eligible smoker when overdue', () => {
      const screenings: ScreeningInputs = {
        lungSmokingHistory: 'former_smoker',
        lungPackYears: 25,
        lungScreening: 'annual_ldct',
        lungLastDate: monthsAgoYYYYMM(14),
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_lung')).toBeDefined();
    });

    it('does not return lung reminder for never-smoker', () => {
      const screenings: ScreeningInputs = {
        lungSmokingHistory: 'never_smoked',
        lungScreening: 'annual_ldct',
        lungLastDate: monthsAgoYYYYMM(14),
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_lung')).toBeUndefined();
    });

    it('does not return lung reminder for smoker with < 20 pack-years', () => {
      const screenings: ScreeningInputs = {
        lungSmokingHistory: 'former_smoker',
        lungPackYears: 15,
        lungScreening: 'annual_ldct',
        lungLastDate: monthsAgoYYYYMM(14),
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_lung')).toBeUndefined();
    });

    it('returns PSA reminder for male age 50 who elected to screen and is overdue', () => {
      const screenings: ScreeningInputs = {
        prostateDiscussion: 'will_screen',
        prostateLastDate: monthsAgoYYYYMM(14),
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_prostate')).toBeDefined();
    });

    it('does not return PSA reminder for male who elected not to screen', () => {
      const screenings: ScreeningInputs = {
        prostateDiscussion: 'elected_not_to',
      };
      const result = computeDueReminders(maleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_prostate')).toBeUndefined();
    });

    it('does not return PSA reminder for female', () => {
      const screenings: ScreeningInputs = {
        prostateDiscussion: 'will_screen',
        prostateLastDate: monthsAgoYYYYMM(14),
      };
      const result = computeDueReminders(femaleProfile, screenings, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'screening_prostate')).toBeUndefined();
    });

    it('returns no screening reminders when screenings is undefined', () => {
      const result = computeDueReminders(maleProfile, undefined, {}, [], NOW);
      const screeningReminders = result.reminders.filter(r => r.group === 'screening');
      expect(screeningReminders).toHaveLength(0);
    });
  });

  describe('Blood test reminders', () => {
    it('returns lipid reminder when lipid panel is over 12 months old', () => {
      const dates: MeasurementDates = {
        ldl: monthsAgo(14),
      };
      const result = computeDueReminders(maleProfile, undefined, dates, [], NOW);
      const reminder = result.reminders.find(r => r.category === 'blood_test_lipids');
      expect(reminder).toBeDefined();
      expect(reminder?.title).toContain('Lipid');
    });

    it('does not return lipid reminder when lipid panel is recent', () => {
      const dates: MeasurementDates = {
        ldl: monthsAgo(6),
        hdl: monthsAgo(6),
      };
      const result = computeDueReminders(maleProfile, undefined, dates, [], NOW);
      expect(result.reminders.find(r => r.category === 'blood_test_lipids')).toBeUndefined();
    });

    it('uses the most recent lipid metric date (not the oldest)', () => {
      const dates: MeasurementDates = {
        ldl: monthsAgo(14), // old
        hdl: monthsAgo(6),  // recent
      };
      const result = computeDueReminders(maleProfile, undefined, dates, [], NOW);
      // Most recent lipid is 6 months ago, not overdue
      expect(result.reminders.find(r => r.category === 'blood_test_lipids')).toBeUndefined();
    });

    it('does not return lipid reminder when user has never tracked lipids', () => {
      const result = computeDueReminders(maleProfile, undefined, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'blood_test_lipids')).toBeUndefined();
    });

    it('returns HbA1c reminder when overdue', () => {
      const dates: MeasurementDates = {
        hba1c: monthsAgo(14),
      };
      const result = computeDueReminders(maleProfile, undefined, dates, [], NOW);
      expect(result.reminders.find(r => r.category === 'blood_test_hba1c')).toBeDefined();
    });

    it('does not return HbA1c reminder when recent', () => {
      const dates: MeasurementDates = {
        hba1c: monthsAgo(6),
      };
      const result = computeDueReminders(maleProfile, undefined, dates, [], NOW);
      expect(result.reminders.find(r => r.category === 'blood_test_hba1c')).toBeUndefined();
    });

    it('returns creatinine reminder when overdue', () => {
      const dates: MeasurementDates = {
        creatinine: monthsAgo(14),
      };
      const result = computeDueReminders(maleProfile, undefined, dates, [], NOW);
      expect(result.reminders.find(r => r.category === 'blood_test_creatinine')).toBeDefined();
    });

    it('includes blood test dates context for all tracked tests', () => {
      const dates: MeasurementDates = {
        ldl: monthsAgo(14), // overdue
        hba1c: monthsAgo(6), // recent
      };
      const result = computeDueReminders(maleProfile, undefined, dates, [], NOW);
      expect(result.bloodTestDates).toHaveLength(2);

      const lipids = result.bloodTestDates.find(d => d.type === 'lipids');
      expect(lipids?.isOverdue).toBe(true);

      const hba1c = result.bloodTestDates.find(d => d.type === 'hba1c');
      expect(hba1c?.isOverdue).toBe(false);
    });
  });

  describe('Medication review reminders', () => {
    it('returns medication review reminder when active medication is stale', () => {
      const medications: MedicationRecord[] = [
        { medicationKey: 'statin', drugName: 'atorvastatin', updatedAt: monthsAgo(14) },
      ];
      const result = computeDueReminders(maleProfile, undefined, {}, medications, NOW);
      const reminder = result.reminders.find(r => r.category === 'medication_review');
      expect(reminder).toBeDefined();
      expect(reminder?.title).toContain('Medication review');
    });

    it('does not return medication review when medication is recently updated', () => {
      const medications: MedicationRecord[] = [
        { medicationKey: 'statin', drugName: 'atorvastatin', updatedAt: monthsAgo(6) },
      ];
      const result = computeDueReminders(maleProfile, undefined, {}, medications, NOW);
      expect(result.reminders.find(r => r.category === 'medication_review')).toBeUndefined();
    });

    it('does not return medication review for inactive medications (none/not_yet/not_tolerated)', () => {
      const medications: MedicationRecord[] = [
        { medicationKey: 'statin', drugName: 'none', updatedAt: monthsAgo(14) },
        { medicationKey: 'ezetimibe', drugName: 'not_yet', updatedAt: monthsAgo(14) },
        { medicationKey: 'pcsk9i', drugName: 'not_tolerated', updatedAt: monthsAgo(14) },
        { medicationKey: 'glp1', drugName: 'no', updatedAt: monthsAgo(14) },
      ];
      const result = computeDueReminders(maleProfile, undefined, {}, medications, NOW);
      expect(result.reminders.find(r => r.category === 'medication_review')).toBeUndefined();
    });

    it('does not return medication review when no medications', () => {
      const result = computeDueReminders(maleProfile, undefined, {}, [], NOW);
      expect(result.reminders.find(r => r.category === 'medication_review')).toBeUndefined();
    });
  });

  describe('Combined reminders', () => {
    it('returns multiple reminders across groups', () => {
      const screenings: ScreeningInputs = {
        colorectalMethod: 'fit_annual',
        colorectalLastDate: monthsAgoYYYYMM(14),
      };
      const dates: MeasurementDates = {
        ldl: monthsAgo(14),
      };
      const medications: MedicationRecord[] = [
        { medicationKey: 'statin', drugName: 'atorvastatin', updatedAt: monthsAgo(14) },
      ];
      const result = computeDueReminders(maleProfile, screenings, dates, medications, NOW);

      expect(result.reminders.find(r => r.group === 'screening')).toBeDefined();
      expect(result.reminders.find(r => r.group === 'blood_test')).toBeDefined();
      expect(result.reminders.find(r => r.group === 'medication_review')).toBeDefined();
    });
  });
});

describe('filterByPreferences', () => {
  it('filters out disabled categories', () => {
    const reminders = [
      { category: 'screening_colorectal' as ReminderCategory, group: 'screening' as const, title: '', description: '' },
      { category: 'screening_breast' as ReminderCategory, group: 'screening' as const, title: '', description: '' },
      { category: 'blood_test_lipids' as ReminderCategory, group: 'blood_test' as const, title: '', description: '' },
    ];
    const disabled = new Set<ReminderCategory>(['screening_breast']);
    const filtered = filterByPreferences(reminders, disabled);
    expect(filtered).toHaveLength(2);
    expect(filtered.find(r => r.category === 'screening_breast')).toBeUndefined();
  });

  it('returns all reminders when no categories are disabled', () => {
    const reminders = [
      { category: 'screening_colorectal' as ReminderCategory, group: 'screening' as const, title: '', description: '' },
    ];
    const filtered = filterByPreferences(reminders, new Set());
    expect(filtered).toHaveLength(1);
  });
});

describe('getCategoryGroup', () => {
  it('maps screening categories to screening group', () => {
    expect(getCategoryGroup('screening_colorectal')).toBe('screening');
    expect(getCategoryGroup('screening_breast')).toBe('screening');
    expect(getCategoryGroup('screening_prostate')).toBe('screening');
  });

  it('maps blood test categories to blood_test group', () => {
    expect(getCategoryGroup('blood_test_lipids')).toBe('blood_test');
    expect(getCategoryGroup('blood_test_hba1c')).toBe('blood_test');
  });

  it('maps medication_review to medication_review group', () => {
    expect(getCategoryGroup('medication_review')).toBe('medication_review');
  });
});

describe('formatReminderDate', () => {
  it('formats ISO date to Mon YYYY', () => {
    expect(formatReminderDate('2025-01-15T00:00:00.000Z')).toBe('Jan 2025');
    expect(formatReminderDate('2024-12-01T00:00:00.000Z')).toBe('Dec 2024');
  });
});

describe('Constants', () => {
  it('has labels for all reminder categories', () => {
    for (const cat of REMINDER_CATEGORIES) {
      expect(REMINDER_CATEGORY_LABELS[cat]).toBeDefined();
      expect(REMINDER_CATEGORY_LABELS[cat].length).toBeGreaterThan(0);
    }
  });

  it('has cooldowns for all groups', () => {
    expect(GROUP_COOLDOWNS.screening).toBe(90);
    expect(GROUP_COOLDOWNS.blood_test).toBe(180);
    expect(GROUP_COOLDOWNS.medication_review).toBe(365);
  });
});
