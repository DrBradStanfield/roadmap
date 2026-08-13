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
 *
 * TODO (convergence, once v2 is proven in prod): re-express v1's
 * computeDueReminders as computeNextDueDates(...).filter(dueAt <= today) so
 * the eligibility rules live ONCE — the v1-parity test is the gate for that
 * refactor. Until then any guideline change must be applied to BOTH files.
 */
import type { ScreeningInputs } from './types';
import { getPostFollowupDueDate, getScreeningNextDueDate } from './types';
import type {
  MeasurementDates,
  MedicationRecord,
  ReminderCategory,
  ReminderGroup,
  ReminderProfile,
} from './reminders';
import {
  BLOOD_TEST_STALE_MONTHS,
  LIPID_METRICS,
  MEDICATION_REVIEW_STALE_MONTHS,
  getCategoryGroup,
  isActiveMedication,
} from './reminders';
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

/** US-23 AC6 — the annual floor's label, shared by SCHEDULE_LABELS and the seeder. */
export const ANNUAL_CHECKIN_LABEL = 'Annual health check-in';

/**
 * The complete set of labels this module can emit, per category — the server
 * validates pushed labels against THIS map (US-23 AC4/AC8). Labels became an
 * allow-list the day the typed lane opened: a cloud opt-in can only email its
 * own verified address, but a typed enrolment names someone else's inbox, so a
 * free-text label field would let an attacker put an arbitrary 80-char string
 * into a victim's email. Every label the schedule builders below use MUST be
 * listed here (a health-core test enforces it).
 */
export const SCHEDULE_LABELS: Record<ReminderCategory, readonly string[]> = {
  screening_colorectal: ['Colonoscopy', 'Colorectal screening'],
  screening_breast: ['Mammogram'],
  screening_cervical: ['Cervical screening'],
  screening_lung: ['Lung screening (low-dose CT)'],
  screening_prostate: ['PSA test'],
  screening_dexa: ['DEXA bone density scan'],
  blood_test_lipids: ['Lipid panel blood test'],
  blood_test_hba1c: ['HbA1c blood test'],
  blood_test_creatinine: ['Creatinine blood test'],
  medication_review: ['Medication review'],
  annual_checkin: [ANNUAL_CHECKIN_LABEL],
};

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
      getPostFollowupDueDate('colorectal', s.colorectalMethod, s.colorectalResult, s.colorectalFollowupStatus, s.colorectalFollowupDate),
    ));
  }

  // Breast (female, age 40+)
  if (sex === 'female' && age >= 40 && s.breastFrequency && s.breastFrequency !== 'not_yet_started') {
    push('screening_breast', 'Mammogram', earliest(
      getScreeningNextDueDate(s.breastLastDate, s.breastFrequency),
      getPostFollowupDueDate('breast', s.breastFrequency, s.breastResult, s.breastFollowupStatus, s.breastFollowupDate),
    ));
  }

  // Cervical (female, age 25-65)
  if (sex === 'female' && age >= 25 && age <= 65 && s.cervicalMethod && s.cervicalMethod !== 'not_yet_started') {
    push('screening_cervical', 'Cervical screening', earliest(
      getScreeningNextDueDate(s.cervicalLastDate, s.cervicalMethod),
      getPostFollowupDueDate('cervical', s.cervicalMethod, s.cervicalResult, s.cervicalFollowupStatus, s.cervicalFollowupDate),
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
      getPostFollowupDueDate('lung', s.lungScreening, s.lungResult, s.lungFollowupStatus, s.lungFollowupDate),
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
        ? getPostFollowupDueDate('dexa', 'dexa_scan', 'abnormal', s.dexaFollowupStatus, s.dexaFollowupDate)
        : getScreeningNextDueDate(s.dexaLastDate, 'dexa_scan');
    } else {
      due = getScreeningNextDueDate(s.dexaLastDate, s.dexaResult === 'osteopenia' ? 'dexa_osteopenia' : 'dexa_normal');
    }
    push('screening_dexa', 'DEXA bone density scan', due);
  }
}

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
      dueAt: toYmd(addMonths(t.lastDate, BLOOD_TEST_STALE_MONTHS)),
    });
  }
}

function medicationSchedule(medications: MedicationRecord[], items: ReminderScheduleItem[]): void {
  const active = medications.filter(isActiveMedication);
  if (active.length === 0) return;
  // Review is due 12 months after the LEAST recently updated active medication
  const oldest = active.map((m) => m.updatedAt).sort()[0];
  items.push({
    category: 'medication_review',
    group: 'medication_review',
    label: 'Medication review',
    dueAt: toYmd(addMonths(oldest, MEDICATION_REVIEW_STALE_MONTHS)),
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
 * per-category reminder preferences.
 *
 * Never returns an empty schedule (US-23 AC6, Brad 2026-08-14): when nothing
 * is due within the next 12 months — including the missing-demographics case,
 * where no eligibility rule can run at all — the schedule is floored with one
 * "Annual health check-in" item 12 months out. A colonoscopy-every-10-years
 * user must not get a decade of silence; every enrolled person gets at least
 * one touch a year. The schedule is recomputed on every visit/capture, so the
 * floor date slides forward from whenever we last saw them.
 */
export function computeReminderSchedule(file: RoadmapFile, now: Date): ReminderScheduleItem[] {
  const disabled = disabledCategories(file);
  const items = computeItemsFromFile(file, now).filter((item) => !disabled.has(item.category));

  const horizon = toYmd(addMonths(toYmd(now), 12));
  if (!items.some((item) => item.dueAt <= horizon)) {
    items.push({
      category: 'annual_checkin',
      group: 'annual',
      label: ANNUAL_CHECKIN_LABEL,
      dueAt: horizon,
    });
  }
  return items;
}

function computeItemsFromFile(file: RoadmapFile, now: Date): ReminderScheduleItem[] {
  const { sex, birthYear, birthMonth } = file.profile;
  if (!sex || !birthYear) return []; // no demographics → no eligibility rules can run
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

  return computeNextDueDates({ sex, age }, file.screenings, measurementDates, medications);
}

function disabledCategories(file: RoadmapFile): Set<string> {
  return new Set(file.reminderPreferences.filter((p) => !p.enabled).map((p) => p.category));
}
