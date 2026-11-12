/**
 * v2 reminder schedule — the client-side half of the §10 reminders model.
 *
 * The browser computes the user's full forward schedule (next due DATE per
 * reminder category, not just "overdue now") and pushes it to Brad's server,
 * which acts as a dumb scheduler: it stores only each item's label + due date
 * and emails when the date arrives — even if the user never reopens the app.
 *
 * The server cannot re-compute anything (it has no health data), so this
 * function must emit future dates: an item is overdue exactly when its
 * earliest candidate due date is in the past.
 *
 * Privacy invariant: `label` + `dueAt` are EVERYTHING the server learns about
 * the user's health. Labels name the procedure ("Colonoscopy") — personalised
 * and specific is the point — but never carry results, values, or reasoning.
 */
import type { ScreeningInputs } from './types';
import { getPostFollowupDueDate, getScreeningNextDueDate, isSex, SCREENING_FOLLOWUP_INFO } from './types';
import { SCREENING_REFS, inAges, opensFollowup, ruleOf, ruleTakes, screeningScheduleLabels, type ScreeningId, type ScreeningRule } from './screening-rules';
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
import { knownMinorOf } from './calculations';
import { dayOf, localDay } from './merge';
import { ISO_DATE, isCalendarDay, newestUsablePsa } from './measurement-history';
import type { RoadmapFile } from './roadmap-file';
import { currentValueRows } from './blood-tests';
import { screeningsToInputs, withPsaMeasurement } from './mappings';
import { fileScreeningRows } from './file-inputs';
import { liveColorectal, nextColonoscopyDue, onColonoscopySchedule } from './colonoscopy-schedule';

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
 * listed here (a health-core test enforces it). The screening labels are the
 * screening table's (screening-rules.ts reminder.label and a method's reminderLabel).
 */
export const SCHEDULE_LABELS: Record<ReminderCategory, readonly string[]> = {
  // The cast hides a missing category from tsc; reminder-schedule.test.ts (every category has labels)
  // and screening-rules.test.ts (the SCHEDULE_LABELS literal pin) catch one at test time.
  ...(screeningScheduleLabels() as Record<Extract<ReminderCategory, `screening_${string}`>, string[]>),
  blood_test_lipids: ['Lipid panel blood test'],
  blood_test_hba1c: ['HbA1c blood test'],
  blood_test_creatinine: ['Creatinine blood test'],
  medication_review: ['Medication review'],
  annual_checkin: [ANNUAL_CHECKIN_LABEL],
};

// ===== Date helpers (mirror v1's month-granularity arithmetic) =====

/**
 * Add whole months to a STORED calendar day (YYYY-MM-DD), returning one.
 *
 * The arithmetic is UTC on both ends. `new Date('2026-05-12')` is UTC
 * midnight, so reading the result back through the local clock hands every
 * caller west of Greenwich the previous day — an item due tomorrow reads
 * overdue today. Month overflow is Date#setUTCMonth's (31 Jan + 1 → 3 Mar),
 * unchanged; an unparseable day still comes back 'NaN-NaN-NaN' for the ISO_DATE
 * filter in computeReminderSchedule to drop.
 */
function addMonths(day: string, months: number): string {
  const date = new Date(day);
  date.setUTCMonth(date.getUTCMonth() + months);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Earliest non-null date — matches v1's "overdue if EITHER candidate has passed". */
function earliest(...dates: Array<Date | null>): Date | null {
  let min: Date | null = null;
  for (const d of dates) if (d && (!min || d < min)) min = d;
  return min;
}

/** US-17 AC15: a scheduled follow-up's check-in, months after the last screening. */
const FOLLOWUP_CHECKIN_MONTHS = 3;

/** Which follow-up card a result that opens one shows: to organize, or scheduled (a check-in). */
export type FollowupKind = 'organize' | 'checkin';

function followupKindOf(r: ScreeningRule, result: string | undefined, status: string | undefined, lastDate: string | undefined): FollowupKind | null {
  if (!opensFollowup(r, result) || !lastDate) return null;
  if (!status || status === 'not_organized') return 'organize';
  return status === 'scheduled' ? 'checkin' : null;
}

/**
 * The reminder an abnormal result's follow-up card asks for (US-17 AC15, Brad
 * 2026-11-05): organize (no status, or not_organized) is due at the last
 * screening's month, which has passed, so the next email carries it; scheduled
 * gets a check-in 3 months after the last screening, even once that has passed.
 * Neither reads today: the phone counts its 90-day repeats from the due day, and
 * a date that moved with the clock would move them. Completed, or no last date
 * (no card), is null: the routine and post-follow-up dates decide. Callers take
 * the earliest, so it is never later than the routine date.
 */
function followupDueDate(r: ScreeningRule, result: string | undefined, status: string | undefined, lastDate: string | undefined): Date | null {
  const kind = followupKindOf(r, result, status, lastDate);
  if (!kind) return null;
  const [year, month] = lastDate!.split('-').map(Number);
  if (!year || !month) return null;
  return new Date(year, month - 1 + (kind === 'organize' ? 0 : FOLLOWUP_CHECKIN_MONTHS));
}

// ===== Per-category next-due computation (eligibility rules mirror v1) =====

function screeningSchedule(
  profile: ReminderProfile,
  s: ScreeningInputs | undefined,
  items: ReminderScheduleItem[],
): void {
  if (!s) return;
  const { age, sex } = profile;

  // Each reminder's age and sex gate is its row's cardAges (screening-rules.ts), the plan card's.
  const [COLORECTAL, BREAST, CERVICAL, LUNG, PROSTATE, DEXA] =
    (['colorectal', 'breast', 'cervical', 'lung', 'prostate', 'dexa'] as const).map(ruleOf);
  // The row's reminder: its category, and the chosen method's label, else the row's.
  const push = (r: ScreeningRule, method: string | undefined, due: Date | null): void => {
    const { category, label } = r.reminder!;
    const own = r.choice.options.find((o) => o.value === method)?.reminderLabel;
    if (due) items.push({ category, group: getCategoryGroup(category), label: own ?? label, dueAt: localDay(due) });
  };
  const takes = (r: ScreeningRule) => ruleTakes(r, r.cardAges, age, sex);

  // On the colonoscopy schedule (US-07 AC1j) only its date counts, and an undated colonoscopy has none.
  // A newer abnormal screening reopens the follow-up: the plan's live answers, its organise reminder.
  const c = liveColorectal(s);
  if (takes(COLORECTAL) && c.colorectalMethod && c.colorectalMethod !== 'not_yet_started') {
    push(COLORECTAL, c.colorectalMethod, onColonoscopySchedule(c) ? nextColonoscopyDue(c) : earliest(
      getScreeningNextDueDate(c.colorectalLastDate, c.colorectalMethod),
      followupDueDate(COLORECTAL, c.colorectalResult, c.colorectalFollowupStatus, c.colorectalLastDate),
    ));
  }

  if (takes(BREAST) && s.breastFrequency && s.breastFrequency !== 'not_yet_started') {
    push(BREAST, s.breastFrequency, earliest(
      getScreeningNextDueDate(s.breastLastDate, s.breastFrequency),
      getPostFollowupDueDate('breast', s.breastFrequency, s.breastResult, s.breastFollowupStatus, s.breastFollowupDate),
      followupDueDate(BREAST, s.breastResult, s.breastFollowupStatus, s.breastLastDate),
    ));
  }

  if (takes(CERVICAL) && s.cervicalMethod && s.cervicalMethod !== 'not_yet_started') {
    push(CERVICAL, s.cervicalMethod, earliest(
      getScreeningNextDueDate(s.cervicalLastDate, s.cervicalMethod),
      getPostFollowupDueDate('cervical', s.cervicalMethod, s.cervicalResult, s.cervicalFollowupStatus, s.cervicalFollowupDate),
      followupDueDate(CERVICAL, s.cervicalResult, s.cervicalFollowupStatus, s.cervicalLastDate),
    ));
  }

  // Lung (smoker with 20+ pack-years — ACS 2023). Below 20 or past 80, an abnormal CT
  // keeps its reminder exactly while the plan shows its follow-up card (US-07 AC1f, AC1g): a last
  // date, until the follow-up is completed.
  const lungFollowupCard = opensFollowup(LUNG, s.lungResult) && !!s.lungLastDate && s.lungFollowupStatus !== 'completed';
  if (
    inAges(LUNG.cardAges, age, sex, LUNG.followupIgnoresUpperAge) && SCREENING_REFS.lungSmoker(s) &&
    ((inAges(LUNG.cardAges, age, sex) && SCREENING_REFS.lungPackYears(s)) || lungFollowupCard) &&
    s.lungScreening && s.lungScreening !== 'not_yet_started'
  ) {
    push(LUNG, s.lungScreening, earliest(
      getScreeningNextDueDate(s.lungLastDate, s.lungScreening),
      getPostFollowupDueDate('lung', s.lungScreening, s.lungResult, s.lungFollowupStatus, s.lungFollowupDate),
      followupDueDate(LUNG, s.lungResult, s.lungFollowupStatus, s.lungLastDate),
    ));
  }

  // Prostate (elected to screen)
  if (takes(PROSTATE) && s.prostateDiscussion === 'will_screen' && s.prostateLastDate) {
    push(PROSTATE, s.prostateDiscussion, getScreeningNextDueDate(s.prostateLastDate, 'will_screen'));
  }

  // DEXA bone density; result-based interval
  if (
    takes(DEXA) &&
    s.dexaScreening && s.dexaScreening !== 'not_yet_started' && s.dexaLastDate &&
    s.dexaResult !== 'awaiting'
  ) {
    let due: Date | null;
    if (opensFollowup(DEXA, s.dexaResult)) {
      const hasCompletedFollowup = s.dexaFollowupStatus === 'completed' && s.dexaFollowupDate;
      due = hasCompletedFollowup
        ? getPostFollowupDueDate('dexa', 'dexa_scan', s.dexaResult, s.dexaFollowupStatus, s.dexaFollowupDate)
        : earliest(
          getScreeningNextDueDate(s.dexaLastDate, 'dexa_scan'),
          followupDueDate(DEXA, s.dexaResult, s.dexaFollowupStatus, s.dexaLastDate),
        );
    } else {
      due = getScreeningNextDueDate(s.dexaLastDate, s.dexaResult === 'osteopenia' ? 'dexa_osteopenia' : 'dexa_normal');
    }
    push(DEXA, s.dexaScreening, due);
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
      dueAt: addMonths(t.lastDate, BLOOD_TEST_STALE_MONTHS),
    });
  }
}

function medicationSchedule(medications: MedicationRecord[], items: ReminderScheduleItem[]): void {
  const active = medications.filter(isActiveMedication);
  if (active.length === 0) return;
  // Review is due 12 months after the oldest usable active review day.
  // Unknown dates contribute no candidate; never infer or persist a review.
  const oldest = active.map((m) => typeof m.updatedAt === 'string' ? dayOf(m.updatedAt) : '')
    .filter(isCalendarDay).sort()[0];
  if (!oldest) return;
  items.push({
    category: 'medication_review',
    group: 'medication_review',
    label: 'Medication review',
    dueAt: addMonths(oldest, MEDICATION_REVIEW_STALE_MONTHS),
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
 * is due within the next 12 months — including the no-birth-year case,
 * where no eligibility rule can run at all — the schedule is floored with one
 * "Annual health check-in" item 12 months out. A colonoscopy-every-10-years
 * user must not get a decade of silence; every enrolled person gets at least
 * one touch a year. The schedule is recomputed on every visit/capture, so the
 * floor date slides forward from whenever we last saw them.
 *
 * The one exception is a known minor (US-07 AC6): the plan is built for
 * adults, so nothing is due, not even the floor.
 */
export function computeReminderSchedule(file: RoadmapFile, now: Date): ReminderScheduleItem[] {
  if (knownMinorOf(file.profile, now)) return [];
  const disabled = disabledCategories(file);
  const items = computeItemsFromFile(file, now).filter((item) => !disabled.has(item.category));
  // Last gate before the server: an unparseable date anywhere upstream (a
  // medication's updatedAt, a screening date) reaches here as 'NaN-NaN-NaN',
  // and scheduleSchema rejects the whole push. One bad row costs its own item.
  const valid = items.filter((item) => ISO_DATE.test(item.dueAt));

  const horizon = addMonths(dayOf(now.toISOString()), 12);
  if (!valid.some((item) => item.dueAt <= horizon)) {
    valid.push({
      category: 'annual_checkin',
      group: 'annual',
      label: ANNUAL_CHECKIN_LABEL,
      dueAt: horizon,
    });
  }
  return valid;
}

function computeItemsFromFile(file: RoadmapFile, now: Date): ReminderScheduleItem[] {
  const { birthYear, birthMonth } = file.profile;
  if (!birthYear) return []; // no age → no eligibility rules can run
  // No sex (or one that is not male or female) drops only the sexed screenings (US-07 AC8).
  const sex = isSex(file.profile.sex) ? file.profile.sex : undefined;
  let age = now.getUTCFullYear() - birthYear;
  if (birthMonth && now.getUTCMonth() + 1 < birthMonth) age -= 1;

  const measurementDates: MeasurementDates = {};
  // Vitals from `measurements`, blood tests from their core rows (US-66 AC7).
  for (const m of currentValueRows(file)) {
    // No usable clinical date → drop the row, as buildMeasurementHistory does.
    // Coercing is worse than dropping: '2026-13-45' has the ISO shape, wins
    // `day > prev`, and produces dueAt 'NaN-NaN-NaN' — which the server's
    // scheduleSchema rejects, failing the user's ENTIRE schedule push.
    const day = (m.recordedAt || '').slice(0, 10);
    if (!isCalendarDay(day)) continue;
    const prev = measurementDates[m.metricType];
    if (!prev || day > prev) measurementDates[m.metricType] = day;
  }

  // A name that is not a string is unanswered, as medicationsToInputs reads it.
  const medications: MedicationRecord[] = file.medications.filter((m) => typeof m.drugName === 'string').map((m) => ({
    medicationKey: m.medicationKey,
    drugName: m.drugName,
    updatedAt: m.updatedAt,
  }));

  // The screenings the plan reads (US-06/US-15 AC11): a date that is not a
  // real calendar date, or a "last done" date after this month, is dropped.
  // The PSA reminder dates from the newest saved PSA, as the plan's card does (US-06 AC14).
  return computeNextDueDates({ sex, age }, fileScreenings(file, now), measurementDates, medications);
}

function fileScreenings(file: RoadmapFile, now: Date): ScreeningInputs {
  return withPsaMeasurement(screeningsToInputs(fileScreeningRows(file.screenings), now),
    newestUsablePsa(currentValueRows(file), now));
}

/**
 * Which screening reminders are a follow-up (US-17 AC15), and the card's name for
 * it (SCREENING_FOLLOWUP_INFO, keyed as the card keys it), for the iPhone's own
 * list and notification days only (US-25 AC12): the phone holds the record, so
 * it may say so. Never part of the pushed schedule, whose label + date is all
 * the server learns.
 */
export function followupKinds(file: RoadmapFile, now: Date): Partial<Record<ReminderCategory, { kind: FollowupKind; name: string }>> {
  const s = fileScreenings(file, now);
  const kinds: Partial<Record<ReminderCategory, { kind: FollowupKind; name: string }>> = {};
  const rows: Array<[ScreeningId, string | undefined, string | undefined, string | undefined, string | undefined]> = [
    ['colorectal', s.colorectalMethod, s.colorectalResult, liveColorectal(s).colorectalFollowupStatus, s.colorectalLastDate], // reopened: organise (US-07 AC1j)
    ['breast', s.breastFrequency, s.breastResult, s.breastFollowupStatus, s.breastLastDate],
    ['cervical', s.cervicalMethod, s.cervicalResult, s.cervicalFollowupStatus, s.cervicalLastDate],
    ['lung', s.lungScreening, s.lungResult, s.lungFollowupStatus, s.lungLastDate],
    ['dexa', 'dexa_scan', s.dexaResult, s.dexaFollowupStatus, s.dexaLastDate],
  ];
  for (const [type, method, result, status, lastDate] of rows) {
    const kind = followupKindOf(ruleOf(type), result, status, lastDate);
    // The card's lookup and fallback (suggestions.ts screeningFollowup).
    const info = SCREENING_FOLLOWUP_INFO[method ? `${type}_${method}` : `${type}_other`];
    if (kind) kinds[`screening_${type}` as ReminderCategory] = { kind, name: info?.followupName ?? 'follow-up' };
  }
  return kinds;
}

function disabledCategories(file: RoadmapFile): Set<string> {
  return new Set(file.reminderPreferences.filter((p) => !p.enabled).map((p) => p.category));
}
