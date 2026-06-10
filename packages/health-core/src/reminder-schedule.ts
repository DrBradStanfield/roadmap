/**
 * v2 reminder schedule — the client-side half of the §10 reminders model.
 *
 * The browser computes the user's full forward schedule (next due DATE per
 * reminder category, not just "overdue now") and pushes it to Brad's server,
 * which acts as a dumb scheduler: it stores only each item's label + due date
 * and emails when the date arrives — even if the user never reopens the app.
 *
 * Contrast with `reminders.ts` (v1): that answers "what is overdue right now"
 * for the server-side cron that re-computes daily from Supabase. The v2 server
 * cannot re-compute anything (it has no health data), so this function must
 * emit future dates. Eligibility rules and intervals are kept 1:1 with v1:
 * an item is overdue in v1 exactly when its earliest candidate due date here
 * is in the past.
 *
 * Privacy invariant: `label` + `dueAt` are EVERYTHING the server learns about
 * the user's health. Labels name the procedure ("Colonoscopy") — personalised
 * and specific is the point — but never carry results, values, or reasoning.
 */
import type { ScreeningInputs } from './types';
import { POST_FOLLOWUP_INTERVALS, getScreeningNextDueDate } from './types';
import type {
  MeasurementDates,
  MedicationRecord,
  ReminderCategory,
  ReminderGroup,
  ReminderProfile,
} from './reminders';
import { getCategoryGroup } from './reminders';
import type { RoadmapFile } from './roadmap-file';

// ===== Types =====

export interface ReminderScheduleItem {
  category: ReminderCategory;
  group: ReminderGroup;
  /** Email-facing text, e.g. "Colonoscopy". This + dueAt is all the server stores. */
  label: string;
  /** YYYY-MM-DD. May be in the past (overdue) — the cron sends on its next run. */
  dueAt: string;
}

// ===== Date helpers (mirror v1's month-granularity arithmetic) =====

function toYmd(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

function addMonths(dateStr: string, months: number): Date {
  const date = new Date(dateStr);
  date.setMonth(date.getMonth() + months);
  return date;
}

/** Post-follow-up repeat date (abnormal result + completed follow-up), or null. */
function postFollowupDue(
  type: string,
  method: string | undefined,
  result: string | undefined,
  followupStatus: string | undefined,
  followupDate: string | undefined,
): Date | null {
  if (result !== 'abnormal' || followupStatus !== 'completed' || !followupDate) return null;
  const methodKey = method ? `${type}_${method}` : `${type}_other`;
  const months = POST_FOLLOWUP_INTERVALS[methodKey] ?? POST_FOLLOWUP_INTERVALS[`${type}_other`] ?? 12;
  const [year, month] = followupDate.split('-').map(Number);
  if (!year || !month) return null;
  return new Date(year, month - 1 + months);
}

/** Earliest non-null date — matches v1's "overdue if EITHER candidate has passed". */
function earliest(...dates: Array<Date | null>): Date | null {
  let min: Date | null = null;
  for (const d of dates) if (d && (!min || d < min)) min = d;
  return min;
}

// ===== Per-category next-due computation (eligibility rules mirror v1) =====

function screeningSchedule(
  profile: ReminderProfile,
  s: ScreeningInputs | undefined,
  items: ReminderScheduleItem[],
): void {
  if (!s) return;
  const { age, sex } = profile;

  const push = (category: ReminderCategory, label: string, due: Date | null): void => {
    if (due) items.push({ category, group: getCategoryGroup(category), label, dueAt: toYmd(due) });
  };

  // Colorectal (age 35-75)
  if (age >= 35 && age <= 75 && s.colorectalMethod && s.colorectalMethod !== 'not_yet_started') {
    const label = s.colorectalMethod === 'colonoscopy_10yr' ? 'Colonoscopy' : 'Colorectal screening';
    push('screening_colorectal', label, earliest(
      getScreeningNextDueDate(s.colorectalLastDate, s.colorectalMethod),
      postFollowupDue('colorectal', s.colorectalMethod, s.colorectalResult, s.colorectalFollowupStatus, s.colorectalFollowupDate),
    ));
  }

  // Breast (female, age 40+)
  if (sex === 'female' && age >= 40 && s.breastFrequency && s.breastFrequency !== 'not_yet_started') {
    push('screening_breast', 'Mammogram', earliest(
      getScreeningNextDueDate(s.breastLastDate, s.breastFrequency),
      postFollowupDue('breast', s.breastFrequency, s.breastResult, s.breastFollowupStatus, s.breastFollowupDate),
    ));
  }

  // Cervical (female, age 25-65)
  if (sex === 'female' && age >= 25 && age <= 65 && s.cervicalMethod && s.cervicalMethod !== 'not_yet_started') {
    push('screening_cervical', 'Cervical screening', earliest(
      getScreeningNextDueDate(s.cervicalLastDate, s.cervicalMethod),
      postFollowupDue('cervical', s.cervicalMethod, s.cervicalResult, s.cervicalFollowupStatus, s.cervicalFollowupDate),
    ));
  }

  // Lung (age 50-80, smoker with 15+ pack-years — USPSTF 2021)
  if (
    age >= 50 && age <= 80 &&
    (s.lungSmokingHistory === 'former_smoker' || s.lungSmokingHistory === 'current_smoker') &&
    s.lungPackYears !== undefined && s.lungPackYears >= 15 &&
    s.lungScreening && s.lungScreening !== 'not_yet_started'
  ) {
    push('screening_lung', 'Lung screening (low-dose CT)', earliest(
      getScreeningNextDueDate(s.lungLastDate, s.lungScreening),
      postFollowupDue('lung', s.lungScreening, s.lungResult, s.lungFollowupStatus, s.lungFollowupDate),
    ));
  }

  // Prostate (male, age 45+, elected to screen)
  if (sex === 'male' && age >= 45 && s.prostateDiscussion === 'will_screen' && s.prostateLastDate) {
    push('screening_prostate', 'PSA test', getScreeningNextDueDate(s.prostateLastDate, 'will_screen'));
  }

  // DEXA bone density (female ≥50, male ≥70); result-based interval
  if (
    ((sex === 'female' && age >= 50) || (sex === 'male' && age >= 70)) &&
    s.dexaScreening && s.dexaScreening !== 'not_yet_started' && s.dexaLastDate &&
    s.dexaResult !== 'awaiting'
  ) {
    let due: Date | null;
    if (s.dexaResult === 'osteoporosis') {
      const hasCompletedFollowup = s.dexaFollowupStatus === 'completed' && s.dexaFollowupDate;
      due = hasCompletedFollowup
        ? postFollowupDue('dexa', 'dexa_scan', 'abnormal', s.dexaFollowupStatus, s.dexaFollowupDate)
        : getScreeningNextDueDate(s.dexaLastDate, 'dexa_scan');
    } else {
      due = getScreeningNextDueDate(s.dexaLastDate, s.dexaResult === 'osteopenia' ? 'dexa_osteopenia' : 'dexa_normal');
    }
    push('screening_dexa', 'DEXA bone density scan', due);
  }
}

const BLOOD_TEST_REPEAT_MONTHS = 12;
const MEDICATION_REVIEW_MONTHS = 12;

// Lipid metric types that count as "lipids" (mirrors v1)
const LIPID_METRICS = ['ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'apob'];

function bloodTestSchedule(measurementDates: MeasurementDates, items: ReminderScheduleItem[]): void {
  const tests: Array<{ category: ReminderCategory; label: string; lastDate: string | undefined }> = [
    {
      category: 'blood_test_lipids',
      label: 'Lipid panel blood test',
      lastDate: LIPID_METRICS.map((m) => measurementDates[m]).filter(Boolean).sort().pop(),
    },
    { category: 'blood_test_hba1c', label: 'HbA1c blood test', lastDate: measurementDates['hba1c'] },
    { category: 'blood_test_creatinine', label: 'Creatinine blood test', lastDate: measurementDates['creatinine'] },
  ];
  for (const t of tests) {
    if (!t.lastDate) continue; // only remind for tests the user has actually tracked
    items.push({
      category: t.category,
      group: 'blood_test',
      label: t.label,
      dueAt: toYmd(addMonths(t.lastDate, BLOOD_TEST_REPEAT_MONTHS)),
    });
  }
}

function medicationSchedule(medications: MedicationRecord[], items: ReminderScheduleItem[]): void {
  const active = medications.filter(
    (m) => m.drugName && !['none', 'not_yet', 'not_tolerated', 'no'].includes(m.drugName),
  );
  if (active.length === 0) return;
  // Review is due 12 months after the LEAST recently updated active medication
  const oldest = active.map((m) => m.updatedAt).sort()[0];
  items.push({
    category: 'medication_review',
    group: 'medication_review',
    label: 'Medication review',
    dueAt: toYmd(addMonths(oldest, MEDICATION_REVIEW_MONTHS)),
  });
}

// ===== Main exports =====

/**
 * Compute the forward reminder schedule from raw inputs (file-shape independent).
 * Pure date arithmetic — "is it due yet" comparisons happen at the consumer
 * (the server cron). Age-based eligibility uses profile.age, which the caller
 * evaluates as of today (a 34-year-old gets no colorectal item yet; the
 * schedule refreshes on every app visit, so it appears at 35).
 */
export function computeNextDueDates(
  profile: ReminderProfile,
  screenings: ScreeningInputs | undefined,
  measurementDates: MeasurementDates,
  medications: MedicationRecord[],
): ReminderScheduleItem[] {
  const items: ReminderScheduleItem[] = [];
  screeningSchedule(profile, screenings, items);
  bloodTestSchedule(measurementDates, items);
  medicationSchedule(medications, items);
  return items;
}

/**
 * Compute the schedule straight from a RoadmapFile, honouring the file's
 * per-category reminder preferences. Returns [] when demographics are missing
 * (no sex/birth year → no eligibility rules can run).
 */
export function computeReminderSchedule(file: RoadmapFile, now: Date): ReminderScheduleItem[] {
  const { sex, birthYear, birthMonth } = file.profile;
  if (!sex || !birthYear) return [];
  let age = now.getFullYear() - birthYear;
  if (birthMonth && now.getMonth() + 1 < birthMonth) age -= 1;

  const measurementDates: MeasurementDates = {};
  for (const m of file.measurements) {
    if (m.status !== 'active') continue;
    const day = m.recordedAt.slice(0, 10);
    const prev = measurementDates[m.metricType];
    if (!prev || day > prev) measurementDates[m.metricType] = day;
  }

  const medications: MedicationRecord[] = file.medications.map((m) => ({
    medicationKey: m.medicationKey,
    drugName: m.drugName,
    updatedAt: m.updatedAt,
  }));

  const disabled = new Set(
    file.reminderPreferences.filter((p) => !p.enabled).map((p) => p.category),
  );

  return computeNextDueDates({ sex, age }, file.screenings, measurementDates, medications)
    .filter((item) => !disabled.has(item.category));
}
