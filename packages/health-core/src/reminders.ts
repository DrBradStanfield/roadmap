/**
 * Reminder categories, groups, cooldowns and shared thresholds. The schedule
 * itself (what is due, and when) is `reminder-schedule.ts`.
 */
import { isTakingDrug } from './history-change';
import { isEscalationKey } from './validation';

// ===== Types =====

export type ReminderGroup = 'screening' | 'blood_test' | 'medication_review' | 'annual';

export type ReminderCategory =
  | 'screening_colorectal' | 'screening_breast' | 'screening_cervical'
  | 'screening_lung' | 'screening_prostate' | 'screening_dexa'
  | 'blood_test_lipids' | 'blood_test_hba1c' | 'blood_test_creatinine'
  | 'medication_review' | 'annual_checkin';

export const REMINDER_CATEGORIES: ReminderCategory[] = [
  'screening_colorectal', 'screening_breast', 'screening_cervical',
  'screening_lung', 'screening_prostate', 'screening_dexa',
  'blood_test_lipids', 'blood_test_hba1c', 'blood_test_creatinine',
  'medication_review', 'annual_checkin',
];

/** Group cooldowns in days. */
export const GROUP_COOLDOWNS: Record<ReminderGroup, number> = {
  screening: 90,
  blood_test: 180,
  medication_review: 365,
  annual: 365,
};

/** Blood test staleness threshold in months (read by the schedule). */
export const BLOOD_TEST_STALE_MONTHS = 12;

/** Medication review staleness threshold in months (read by the schedule). */
export const MEDICATION_REVIEW_STALE_MONTHS = 12;

/** Lipid metric types that count as "lipids" for blood_test_lipids reminders. */
export const LIPID_METRICS = ['ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'apob'];

/** Active = a real drug, not a "no/none/not yet" sentinel, and not an
 *  escalation answer (US-06 AC11). */
export function isActiveMedication(m: { medicationKey: string; drugName: string }): boolean {
  return !isEscalationKey(m.medicationKey) && isTakingDrug(m.drugName);
}

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

/**
 * Get the category-to-group mapping.
 */
export function getCategoryGroup(category: ReminderCategory): ReminderGroup {
  if (category.startsWith('screening_')) return 'screening';
  if (category.startsWith('blood_test_')) return 'blood_test';
  if (category === 'annual_checkin') return 'annual';
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
  annual_checkin: 'Annual health check-in reminders',
};

/**
 * Format a date as "Mon YYYY" for email display.
 */
export function formatReminderDate(dateStr: string): string {
  const date = new Date(dateStr);
  // Date-only inputs name a calendar month, not an instant in the local zone.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
  const month = dateOnly ? date.getUTCMonth() : date.getMonth();
  const year = dateOnly ? date.getUTCFullYear() : date.getFullYear();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[month]} ${year}`;
}
