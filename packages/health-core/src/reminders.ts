/**
 * Health reminder logic for scheduled email notifications.
 *
 * Pure functions that determine which reminders are due based on
 * screening dates, blood test dates, and medication status.
 * No database dependencies — designed for unit testing.
 */
import type { ScreeningInputs, MedicationInputs } from './types';
import { SCREENING_INTERVALS, POST_FOLLOWUP_INTERVALS } from './types';

// ===== Types =====

export type ReminderGroup = 'screening' | 'blood_test' | 'medication_review';

export type ReminderCategory =
  | 'screening_colorectal' | 'screening_breast' | 'screening_cervical'
  | 'screening_lung' | 'screening_prostate' | 'screening_dexa'
  | 'blood_test_lipids' | 'blood_test_hba1c' | 'blood_test_creatinine'
  | 'medication_review';

export const REMINDER_CATEGORIES: ReminderCategory[] = [
  'screening_colorectal', 'screening_breast', 'screening_cervical',
  'screening_lung', 'screening_prostate', 'screening_dexa',
  'blood_test_lipids', 'blood_test_hba1c', 'blood_test_creatinine',
  'medication_review',
];

export interface DueReminder {
  category: ReminderCategory;
  group: ReminderGroup;
  title: string;
  description: string;
}

/** Blood test date info for context in emails. */
export interface BloodTestDate {
  type: 'lipids' | 'hba1c' | 'creatinine';
  label: string;
  lastDate: string | null; // ISO date or null if never tested
  isOverdue: boolean;
}

/** Group cooldowns in days. */
export const GROUP_COOLDOWNS: Record<ReminderGroup, number> = {
  screening: 90,
  blood_test: 180,
  medication_review: 365,
};

/** Blood test staleness threshold in months. */
const BLOOD_TEST_STALE_MONTHS = 12;

/** Medication review staleness threshold in months. */
const MEDICATION_REVIEW_STALE_MONTHS = 12;

// Lipid metric types that count as "lipids" for blood_test_lipids reminders
const LIPID_METRICS = ['ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'apob'];

// ===== Profile info needed for reminder eligibility =====

export interface ReminderProfile {
  sex: 'male' | 'female';
  age: number;
}

/** Latest measurement dates keyed by metric_type. */
export type MeasurementDates = Record<string, string>; // metric_type → ISO date string

/** Medication records with updated_at dates. */
export interface MedicationRecord {
  medicationKey: string;
  drugName: string;
  updatedAt: string; // ISO date string
}

// ===== Core Logic =====

/**
 * Check if a date is more than N months ago.
 */
function isOlderThanMonths(dateStr: string, months: number, now: Date = new Date()): boolean {
  const date = new Date(dateStr);
  const threshold = new Date(date);
  threshold.setMonth(threshold.getMonth() + months);
  return now > threshold;
}

/**
 * Check if a screening is overdue given its last date and method's interval.
 * Reuses the same logic as screeningStatus() in suggestions.ts.
 */
function isScreeningOverdue(lastDate: string | undefined, method: string | undefined, now: Date = new Date()): boolean {
  if (!lastDate || !method) return false;
  const intervalMonths = SCREENING_INTERVALS[method] ?? 12;
  const [year, month] = lastDate.split('-').map(Number);
  if (!year || !month) return false;
  const nextDue = new Date(year, month - 1 + intervalMonths);
  return now > nextDue;
}

/**
 * Check if a screening has a completed follow-up and is overdue for repeat.
 */
function isPostFollowupOverdue(
  type: string,
  method: string | undefined,
  result: string | undefined,
  followupStatus: string | undefined,
  followupDate: string | undefined,
  now: Date = new Date(),
): boolean {
  if (result !== 'abnormal' || followupStatus !== 'completed' || !followupDate) return false;
  const methodKey = method ? `${type}_${method}` : `${type}_other`;
  const postInterval = POST_FOLLOWUP_INTERVALS[methodKey] ?? POST_FOLLOWUP_INTERVALS[`${type}_other`] ?? 12;
  const [year, month] = followupDate.split('-').map(Number);
  if (!year || !month) return false;
  const nextDue = new Date(year, month - 1 + postInterval);
  return now > nextDue;
}

/**
 * Compute all due screening reminders for a user.
 */
function computeScreeningReminders(
  profile: ReminderProfile,
  screenings: ScreeningInputs | undefined,
  now: Date = new Date(),
): DueReminder[] {
  const reminders: DueReminder[] = [];
  if (!screenings) return reminders;

  const { age, sex } = profile;

  // Colorectal (age 35-75)
  if (age >= 35 && age <= 75) {
    const method = screenings.colorectalMethod;
    if (method && method !== 'not_yet_started') {
      const overdue = isScreeningOverdue(screenings.colorectalLastDate, method, now)
        || isPostFollowupOverdue('colorectal', method, screenings.colorectalResult, screenings.colorectalFollowupStatus, screenings.colorectalFollowupDate, now);
      if (overdue) {
        reminders.push({
          category: 'screening_colorectal',
          group: 'screening',
          title: 'Colorectal screening overdue',
          description: 'Your colorectal cancer screening is overdue. Please schedule with your doctor.',
        });
      }
    }
  }

  // Breast (female, age 40+)
  if (sex === 'female' && age >= 40) {
    const method = screenings.breastFrequency;
    if (method && method !== 'not_yet_started') {
      const overdue = isScreeningOverdue(screenings.breastLastDate, method, now)
        || isPostFollowupOverdue('breast', method, screenings.breastResult, screenings.breastFollowupStatus, screenings.breastFollowupDate, now);
      if (overdue) {
        reminders.push({
          category: 'screening_breast',
          group: 'screening',
          title: 'Mammogram overdue',
          description: 'Your mammogram is overdue. Please schedule your screening.',
        });
      }
    }
  }

  // Cervical (female, age 25-65)
  if (sex === 'female' && age >= 25 && age <= 65) {
    const method = screenings.cervicalMethod;
    if (method && method !== 'not_yet_started') {
      const overdue = isScreeningOverdue(screenings.cervicalLastDate, method, now)
        || isPostFollowupOverdue('cervical', method, screenings.cervicalResult, screenings.cervicalFollowupStatus, screenings.cervicalFollowupDate, now);
      if (overdue) {
        reminders.push({
          category: 'screening_cervical',
          group: 'screening',
          title: 'Cervical screening overdue',
          description: 'Your cervical screening is overdue. Please schedule with your doctor.',
        });
      }
    }
  }

  // Lung (age 50-80, smoker with 15+ pack-years — USPSTF 2021)
  if (age >= 50 && age <= 80 &&
      (screenings.lungSmokingHistory === 'former_smoker' || screenings.lungSmokingHistory === 'current_smoker') &&
      screenings.lungPackYears !== undefined && screenings.lungPackYears >= 15) {
    const method = screenings.lungScreening;
    if (method && method !== 'not_yet_started') {
      const overdue = isScreeningOverdue(screenings.lungLastDate, method, now)
        || isPostFollowupOverdue('lung', method, screenings.lungResult, screenings.lungFollowupStatus, screenings.lungFollowupDate, now);
      if (overdue) {
        reminders.push({
          category: 'screening_lung',
          group: 'screening',
          title: 'Lung screening overdue',
          description: 'Your low-dose CT lung screening is overdue. Please schedule your screening.',
        });
      }
    }
  }

  // Prostate (male, age 45+, elected to screen)
  if (sex === 'male' && age >= 45) {
    if (screenings.prostateDiscussion === 'will_screen' && screenings.prostateLastDate) {
      if (isScreeningOverdue(screenings.prostateLastDate, 'will_screen', now)) {
        reminders.push({
          category: 'screening_prostate',
          group: 'screening',
          title: 'PSA test overdue',
          description: 'Your PSA test is overdue. Please schedule with your doctor.',
        });
      }
    }
  }

  // DEXA bone density (female ≥50, male ≥70)
  if ((sex === 'female' && age >= 50) || (sex === 'male' && age >= 70)) {
    if (screenings.dexaScreening && screenings.dexaScreening !== 'not_yet_started' && screenings.dexaLastDate) {
      // Result-based interval: osteopenia → 2yr, normal → 5yr, osteoporosis → post-followup pattern
      if (screenings.dexaResult === 'osteoporosis') {
        // If followup completed, check only followup date; otherwise check original scan date
        const hasCompletedFollowup = screenings.dexaFollowupStatus === 'completed' && screenings.dexaFollowupDate;
        const overdue = hasCompletedFollowup
          ? isPostFollowupOverdue('dexa', 'dexa_scan', 'abnormal', screenings.dexaFollowupStatus, screenings.dexaFollowupDate, now)
          : isScreeningOverdue(screenings.dexaLastDate, 'dexa_scan', now);
        if (overdue) {
          reminders.push({
            category: 'screening_dexa',
            group: 'screening',
            title: 'DEXA bone density scan overdue',
            description: 'Your DEXA bone density scan is overdue. Please schedule with your doctor.',
          });
        }
      } else if (screenings.dexaResult !== 'awaiting') {
        const intervalKey = screenings.dexaResult === 'osteopenia' ? 'dexa_osteopenia' : 'dexa_normal';
        if (isScreeningOverdue(screenings.dexaLastDate, intervalKey, now)) {
          reminders.push({
            category: 'screening_dexa',
            group: 'screening',
            title: 'DEXA bone density scan overdue',
            description: 'Your DEXA bone density scan is overdue. Please schedule with your doctor.',
          });
        }
      }
    }
  }

  return reminders;
}

/**
 * Compute blood test reminders and context dates.
 * Only reminds for metrics the user has previously tracked.
 */
function computeBloodTestReminders(
  measurementDates: MeasurementDates,
  now: Date = new Date(),
): { reminders: DueReminder[]; bloodTestDates: BloodTestDate[] } {
  const reminders: DueReminder[] = [];
  const bloodTestDates: BloodTestDate[] = [];

  // Lipids - check if ANY lipid metric was ever recorded
  const latestLipidDate = LIPID_METRICS
    .map(m => measurementDates[m])
    .filter(Boolean)
    .sort()
    .pop(); // most recent lipid date

  if (latestLipidDate) {
    const isOverdue = isOlderThanMonths(latestLipidDate, BLOOD_TEST_STALE_MONTHS, now);
    bloodTestDates.push({
      type: 'lipids',
      label: 'Lipid panel',
      lastDate: latestLipidDate,
      isOverdue,
    });
    if (isOverdue) {
      reminders.push({
        category: 'blood_test_lipids',
        group: 'blood_test',
        title: 'Lipid panel overdue',
        description: 'It has been over a year since your last lipid panel. Consider scheduling blood work with your doctor.',
      });
    }
  }

  // HbA1c
  const hba1cDate = measurementDates['hba1c'];
  if (hba1cDate) {
    const isOverdue = isOlderThanMonths(hba1cDate, BLOOD_TEST_STALE_MONTHS, now);
    bloodTestDates.push({
      type: 'hba1c',
      label: 'HbA1c',
      lastDate: hba1cDate,
      isOverdue,
    });
    if (isOverdue) {
      reminders.push({
        category: 'blood_test_hba1c',
        group: 'blood_test',
        title: 'HbA1c test overdue',
        description: 'It has been over a year since your last HbA1c test. Consider scheduling blood work with your doctor.',
      });
    }
  }

  // Creatinine
  const creatinineDate = measurementDates['creatinine'];
  if (creatinineDate) {
    const isOverdue = isOlderThanMonths(creatinineDate, BLOOD_TEST_STALE_MONTHS, now);
    bloodTestDates.push({
      type: 'creatinine',
      label: 'Creatinine',
      lastDate: creatinineDate,
      isOverdue,
    });
    if (isOverdue) {
      reminders.push({
        category: 'blood_test_creatinine',
        group: 'blood_test',
        title: 'Creatinine test overdue',
        description: 'It has been over a year since your last creatinine test. Consider scheduling blood work with your doctor.',
      });
    }
  }

  return { reminders, bloodTestDates };
}

/**
 * Compute medication review reminders.
 * Triggers if any active medication hasn't been reviewed in 12+ months.
 */
function computeMedicationReminders(
  medications: MedicationRecord[],
  now: Date = new Date(),
): DueReminder[] {
  // Active medications = those with a real drug (not 'none', 'not_yet', 'not_tolerated')
  const activeMeds = medications.filter(m =>
    m.drugName && !['none', 'not_yet', 'not_tolerated', 'no'].includes(m.drugName)
  );

  if (activeMeds.length === 0) return [];

  // Check if any active medication hasn't been updated in 12+ months
  const hasStale = activeMeds.some(m =>
    isOlderThanMonths(m.updatedAt, MEDICATION_REVIEW_STALE_MONTHS, now)
  );

  if (!hasStale) return [];

  return [{
    category: 'medication_review',
    group: 'medication_review',
    title: 'Medication review due',
    description: 'It has been over a year since your medications were last reviewed. Please discuss your current medications with your doctor.',
  }];
}

// ===== Main Export =====

export interface ComputeRemindersResult {
  reminders: DueReminder[];
  bloodTestDates: BloodTestDate[];
}

/**
 * Compute all due health reminders for a user.
 *
 * Returns reminders grouped by type, plus blood test context dates
 * for inclusion in the email.
 */
export function computeDueReminders(
  profile: ReminderProfile,
  screenings: ScreeningInputs | undefined,
  measurementDates: MeasurementDates,
  medications: MedicationRecord[],
  now: Date = new Date(),
): ComputeRemindersResult {
  const screeningReminders = computeScreeningReminders(profile, screenings, now);
  const { reminders: bloodTestReminders, bloodTestDates } = computeBloodTestReminders(measurementDates, now);
  const medicationReminders = computeMedicationReminders(medications, now);

  return {
    reminders: [...screeningReminders, ...bloodTestReminders, ...medicationReminders],
    bloodTestDates,
  };
}

/**
 * Filter reminders by user preferences (opted-out categories).
 */
export function filterByPreferences(
  reminders: DueReminder[],
  disabledCategories: Set<ReminderCategory>,
): DueReminder[] {
  return reminders.filter(r => !disabledCategories.has(r.category));
}

/**
 * Get the category-to-group mapping.
 */
export function getCategoryGroup(category: ReminderCategory): ReminderGroup {
  if (category.startsWith('screening_')) return 'screening';
  if (category.startsWith('blood_test_')) return 'blood_test';
  return 'medication_review';
}

/**
 * Human-readable labels for reminder categories (used in UI and email preferences page).
 */
export const REMINDER_CATEGORY_LABELS: Record<ReminderCategory, string> = {
  screening_colorectal: 'Colorectal screening reminders',
  screening_breast: 'Mammogram reminders',
  screening_cervical: 'Cervical screening reminders',
  screening_lung: 'Lung screening reminders',
  screening_prostate: 'PSA test reminders',
  screening_dexa: 'Bone density (DEXA) reminders',
  blood_test_lipids: 'Lipid panel reminders',
  blood_test_hba1c: 'HbA1c test reminders',
  blood_test_creatinine: 'Creatinine test reminders',
  medication_review: 'Medication review reminders',
};

/**
 * Format a date as "Mon YYYY" for email display.
 */
export function formatReminderDate(dateStr: string): string {
  const date = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getFullYear()}`;
}
