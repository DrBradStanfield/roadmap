/**
 * The one screening-rules table (audit A2-1 step 2). NOTHING READS IT YET: today
 * the rules live in five copies, and each later PR moves one copy onto this table,
 * with screening-rules.golden.test.ts proving nothing changed.
 *   S  plan cards     suggestions.ts (cancer screening and DEXA)
 *   F  form data      input-form.ts screeningForm, screeningWrites
 *   Q  web JSX        ScreeningQuestions.tsx, BoneDensity.tsx
 *   R  reminders      reminder-schedule.ts screeningSchedule
 *   M  upload gate    types.ts SCREENING_MIN_AGE, isScreeningEligible
 *
 * Rows are pure, JSON-serializable data: no functions. A gate that is not an age
 * or a sex is named (`extraGates`) and its predicate lives in SCREENING_GATES below.
 * Rules that are logic, not data, stay as named branches in code: the lung
 * follow-up past 80 or below 20 pack-years, the raised-PSA card and its "up to
 * date" suppression, the DEXA result branches, and the endometrial bleeding card.
 * Age-dependent prose (breastByAge, prostateByAge, the 40-44 breast start card)
 * stays in code too; a row names it with a `ref`.
 *
 * Ages: [min, max?], inclusive; a sexed rule gives one range per sex.
 *   cardAges   S and R: when the plan card and the reminder apply.
 *   askAges    F and Q: when the questions are asked.
 *   groupAges  F and Q: when the group shows at all (outside askAges, a note only).
 *   uploadMinAge  M: the permissive "save this screening" gate (with uploadSex).
 *
 * "Data present, so ask" (lungGroupShown and lungScreeningAsked show a lung
 * question past 80 or below 20 pack-years once it has an answer) is NOT here.
 * It will live in the derived ask predicate, as one rule for every row, in the PR
 * that moves F and Q onto this table; it changes behaviour only where today's
 * rows differ, and that PR must show the golden unchanged or name the change.
 *
 * The three-file check, by row (evidenceKey -> roadmap_text.html section):
 *   colorectal  screening-colorectal  #cancer-screening, "Colorectal Cancer"
 *   breast      screening-breast      #cancer-screening, "Breast Cancer"
 *   cervical    screening-cervical    #cancer-screening, "Cervical Cancer"
 *   lung        screening-lung        #cancer-screening, "Lung Cancer"
 *   prostate    screening-prostate    #cancer-screening, "Prostate Cancer"
 *   endometrial screening-endometrial #cancer-screening, "Endometrial Cancer"
 *   dexa        screening-dexa        #other-health-screening, "Osteoporosis Screening"
 *
 * Imports: health-core only. Server code that reads this later deep-imports it
 * (../../packages/health-core/src/screening-rules), never @roadmap/health-core.
 * When types.ts turns its constants into views, LUNG_PACK_YEARS must move here
 * first, or types.ts and this file import each other.
 */
import type { ReminderCategory } from './reminders';
import type { ScreeningInputs } from './types';
import { LUNG_PACK_YEARS } from './types';

export type ScreeningId = 'colorectal' | 'breast' | 'cervical' | 'lung' | 'prostate' | 'endometrial' | 'dexa';
export type AgeRange = readonly [min: number, max?: number];
export type Ages = AgeRange | { readonly female: AgeRange; readonly male: AgeRange };

/** A choice option. `months` is its screening interval; `postMonths` and `followup`
 *  apply after an abnormal result whose follow-up is completed. The post-follow-up
 *  interval varies by method (breast: 12 or 24), so it lives on the method, not the result. */
export interface ScreeningOption {
  readonly value: string;
  readonly label: string;
  readonly months?: number;
  readonly postMonths?: number;
  readonly followup?: { readonly name: string; readonly abnormalMeans: string };
  /** The reminder's label when this method is chosen, if not the row's default. */
  readonly reminderLabel?: string;
}

/** A result option. `followup` true opens the follow-up questions and card;
 *  `months` is a result-based interval (DEXA), keyed `${id}_${value}` in SCREENING_INTERVALS. */
export interface ResultOption {
  readonly value: string;
  readonly label: string;
  readonly followup?: true;
  readonly months?: number;
}

/** Card text, verbatim. `{due}` is the next-due month ("Mar 2027"); `{packYears}` the answer. */
export interface CardText { readonly title: string; readonly description: string }

export type Note = { readonly below?: number; readonly above?: number; readonly text: string } | { readonly ref: 'breastByAge' | 'prostateByAge' };

export type GateName = 'lungSmoker' | 'lungPackYears';

export interface ScreeningRule {
  readonly id: ScreeningId;
  readonly section: 'cancer-screening' | 'bone-density';
  readonly title: string;
  readonly sex?: 'female' | 'male';
  readonly cardAges: Ages;
  readonly askAges: Ages;
  readonly groupAges: Ages;
  readonly uploadMinAge?: number;
  readonly uploadSex?: 'female' | 'male';
  readonly extraGates?: readonly GateName[];
  readonly choice: { readonly key: string; readonly options: readonly ScreeningOption[] };
  readonly notStarted: string;
  /** Answers asked beside the choice, in SCREENING_KEYS order: before it, or after it (before the date). */
  readonly otherKeys?: { readonly before?: readonly string[]; readonly afterChoice?: readonly string[] };
  readonly dateKey?: string;
  readonly result?: { readonly key: string; readonly options: readonly ResultOption[] };
  /** Lung keeps its follow-up past the upper age (US-07 AC1g); the pack-years gate is waived too, in code. */
  readonly followupIgnoresUpperAge: boolean;
  readonly reminder?: { readonly category: ReminderCategory; readonly label: string };
  readonly evidenceKey: string;
  readonly notes: readonly Note[];
  readonly cards: {
    readonly start: CardText | { readonly ref: 'breastStart' };
    readonly overdue?: CardText;
    readonly upToDate?: CardText;
  };
}

const RESULTS: readonly ResultOption[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'abnormal', label: 'Abnormal', followup: true },
  { value: 'awaiting', label: 'Awaiting results' },
];
const NOT_YET_STARTED = { value: 'not_yet_started', label: 'Not yet started' } as const;
const resultOf = (id: string) => ({ key: `${id}_result`, options: RESULTS });

export const SCREENING_RULES: readonly ScreeningRule[] = [
  {
    id: 'colorectal', section: 'cancer-screening', title: 'Colorectal',
    cardAges: [35, 75], askAges: [35, 75], groupAges: [35, 85], uploadMinAge: 35,
    choice: { key: 'colorectal_method', options: [
      { value: 'fit_annual', label: 'FIT test (annual)', months: 12, postMonths: 36,
        followup: { name: 'colonoscopy', abnormalMeans: 'positive FIT test' } },
      { value: 'colonoscopy_10yr', label: 'Colonoscopy (every 10 years)', months: 120, postMonths: 36,
        followup: { name: 'repeat colonoscopy', abnormalMeans: 'polyps found on colonoscopy' }, reminderLabel: 'Colonoscopy' },
      { value: 'other', label: 'Other method', months: 12, postMonths: 36,
        followup: { name: 'follow-up investigation', abnormalMeans: 'abnormal result' } },
      NOT_YET_STARTED,
    ] },
    notStarted: 'not_yet_started', dateKey: 'colorectal_last_date', result: resultOf('colorectal'),
    followupIgnoresUpperAge: false,
    reminder: { category: 'screening_colorectal', label: 'Colorectal screening' },
    evidenceKey: 'screening-colorectal',
    notes: [
      { below: 45, text: 'Note: ACS guidelines recommend starting colorectal screening at age 45. Given rising rates of colorectal cancer in younger adults, some clinicians consider starting earlier, around age 35. Discuss timing with your doctor.' },
      { above: 75, text: 'Screening is individualized at your age. Discuss with your doctor whether continued screening is appropriate.' },
    ],
    cards: {
      start: { title: 'Start colorectal cancer screening', description: 'Colorectal screening is recommended. Options include annual FIT testing or colonoscopy every 10 years. Discuss with your doctor.' },
      overdue: { title: 'Colorectal screening overdue', description: 'Your next colorectal screening was due {due}. Please schedule your screening.' },
      upToDate: { title: 'Colorectal screening up to date', description: 'Next screening due {due}.' },
    },
  },
  {
    id: 'breast', section: 'cancer-screening', title: 'Breast', sex: 'female',
    cardAges: [40], askAges: [40], groupAges: [40], uploadMinAge: 40, uploadSex: 'female',
    choice: { key: 'breast_frequency', options: [
      { value: 'annual', label: 'Annual', months: 12, postMonths: 12,
        followup: { name: 'diagnostic imaging/biopsy', abnormalMeans: 'abnormal mammogram' } },
      { value: 'biennial', label: 'Every 2 years', months: 24, postMonths: 24,
        followup: { name: 'diagnostic imaging/biopsy', abnormalMeans: 'abnormal mammogram' } },
      NOT_YET_STARTED,
    ] },
    notStarted: 'not_yet_started', dateKey: 'breast_last_date', result: resultOf('breast'),
    followupIgnoresUpperAge: false,
    reminder: { category: 'screening_breast', label: 'Mammogram' },
    evidenceKey: 'screening-breast',
    notes: [{ ref: 'breastByAge' }],
    cards: {
      start: { ref: 'breastStart' },
      overdue: { title: 'Mammogram overdue', description: 'Your next mammogram was due {due}. Please schedule your screening.' },
      upToDate: { title: 'Mammogram up to date', description: 'Next mammogram due {due}.' },
    },
  },
  {
    id: 'cervical', section: 'cancer-screening', title: 'Cervical', sex: 'female',
    cardAges: [25, 65], askAges: [25, 65], groupAges: [25], uploadMinAge: 25, uploadSex: 'female',
    choice: { key: 'cervical_method', options: [
      { value: 'hpv_every_5yr', label: 'HPV test every 5 years (preferred)', months: 60, postMonths: 12,
        followup: { name: 'colposcopy', abnormalMeans: 'HPV positive result' } },
      { value: 'pap_every_3yr', label: 'Pap test every 3 years', months: 36, postMonths: 12,
        followup: { name: 'colposcopy', abnormalMeans: 'abnormal Pap test' } },
      { value: 'other', label: 'Other method', months: 12, postMonths: 12,
        followup: { name: 'colposcopy', abnormalMeans: 'abnormal result' } },
      NOT_YET_STARTED,
    ] },
    notStarted: 'not_yet_started', dateKey: 'cervical_last_date', result: resultOf('cervical'),
    followupIgnoresUpperAge: false,
    reminder: { category: 'screening_cervical', label: 'Cervical screening' },
    evidenceKey: 'screening-cervical',
    notes: [{ above: 65, text: 'Routine cervical screening typically stops at age 65 if you have no history of abnormal results. Discuss with your doctor.' }],
    cards: {
      start: { title: 'Start cervical cancer screening', description: 'HPV testing every 5 years (preferred) or Pap test every 3 years is recommended. Discuss with your doctor.' },
      overdue: { title: 'Cervical screening overdue', description: 'Your next cervical screening was due {due}. Please schedule your screening.' },
      upToDate: { title: 'Cervical screening up to date', description: 'Next screening due {due}.' },
    },
  },
  {
    id: 'lung', section: 'cancer-screening', title: 'Lung',
    cardAges: [50, 80], askAges: [50, 80], groupAges: [50, 80], uploadMinAge: 50,
    extraGates: ['lungSmoker', 'lungPackYears'],
    choice: { key: 'lung_screening', options: [
      { value: 'annual_ldct', label: 'Annual low-dose CT', months: 12, postMonths: 12,
        followup: { name: 'follow-up imaging', abnormalMeans: 'abnormal LDCT result' } },
      NOT_YET_STARTED,
    ] },
    notStarted: 'not_yet_started', otherKeys: { before: ['lung_smoking_history', 'lung_pack_years'] },
    dateKey: 'lung_last_date', result: resultOf('lung'),
    followupIgnoresUpperAge: true,
    reminder: { category: 'screening_lung', label: 'Lung screening (low-dose CT)' },
    evidenceKey: 'screening-lung',
    notes: [],
    cards: {
      start: { title: 'Start lung cancer screening', description: 'With {packYears} pack-years of smoking history, annual low-dose CT screening is recommended. Discuss with your doctor.' },
      overdue: { title: 'Lung screening overdue', description: 'Your next low-dose CT was due {due}. Please schedule your screening.' },
      upToDate: { title: 'Lung screening up to date', description: 'Next low-dose CT due {due}.' },
    },
  },
  {
    id: 'prostate', section: 'cancer-screening', title: 'Prostate', sex: 'male',
    cardAges: [45], askAges: [45], groupAges: [45], uploadMinAge: 45, uploadSex: 'male',
    choice: { key: 'prostate_discussion', options: [
      { value: 'not_yet', label: 'Not yet' },
      { value: 'elected_not_to', label: "Yes, and I've elected not to screen" },
      { value: 'will_screen', label: 'Yes, and I will screen', months: 12 },
    ] },
    notStarted: 'not_yet', otherKeys: { afterChoice: ['prostate_psa_value'] }, dateKey: 'prostate_last_date',
    followupIgnoresUpperAge: false,
    reminder: { category: 'screening_prostate', label: 'PSA test' },
    evidenceKey: 'screening-prostate',
    notes: [{ ref: 'prostateByAge' }],
    cards: {
      start: { title: 'Discuss prostate cancer screening', description: 'PSA testing is an option after an informed discussion with your doctor. Benefits and risks vary by individual.' },
      overdue: { title: 'PSA test overdue', description: 'Your next PSA test was due {due}. Please schedule your test.' },
      upToDate: { title: 'PSA test up to date', description: 'Next PSA test due {due}.' },
    },
  },
  {
    id: 'endometrial', section: 'cancer-screening', title: 'Endometrial', sex: 'female',
    cardAges: [45], askAges: [45], groupAges: [45],
    choice: { key: 'endometrial_discussion', options: [
      { value: 'not_yet', label: 'Not yet' },
      { value: 'discussed', label: 'Yes, discussed' },
    ] },
    notStarted: 'not_yet', otherKeys: { afterChoice: ['endometrial_abnormal_bleeding'] },
    followupIgnoresUpperAge: false,
    evidenceKey: 'screening-endometrial',
    notes: [],
    cards: {
      start: { title: 'Discuss endometrial cancer awareness', description: 'Women at menopause should be informed about the risks and symptoms of endometrial cancer. Discuss with your doctor.' },
    },
  },
  {
    id: 'dexa', section: 'bone-density', title: '',
    cardAges: { female: [50], male: [70] }, askAges: { female: [50], male: [70] }, groupAges: { female: [50], male: [70] },
    uploadMinAge: 50,
    choice: { key: 'dexa_screening', options: [
      { value: 'dexa_scan', label: 'Had a DEXA scan', months: 24, postMonths: 12,
        followup: { name: 'treatment review', abnormalMeans: 'osteoporosis diagnosed — treatment and monitoring required' } },
      NOT_YET_STARTED,
    ] },
    notStarted: 'not_yet_started', dateKey: 'dexa_last_date',
    result: { key: 'dexa_result', options: [
      { value: 'normal', label: 'Normal', months: 60 },
      { value: 'osteopenia', label: 'Osteopenia', months: 24 },
      { value: 'osteoporosis', label: 'Osteoporosis', followup: true },
      { value: 'awaiting', label: 'Awaiting results' },
    ] },
    followupIgnoresUpperAge: false,
    reminder: { category: 'screening_dexa', label: 'DEXA bone density scan' },
    evidenceKey: 'screening-dexa',
    notes: [],
    cards: {
      start: { title: 'Consider a DEXA bone density scan', description: 'A DEXA scan measures bone mineral density and can detect osteoporosis before a fracture occurs. Discuss with your doctor.' },
      overdue: { title: 'Bone density scan overdue', description: 'Your next DEXA scan was due {due}. Please schedule your scan.' },
      upToDate: { title: 'Bone density scan up to date', description: 'Next DEXA scan due around {due}.' },
    },
  },
];

/** The named gates' predicates: the one place each lives. */
export const SCREENING_GATES: Readonly<Record<GateName, (s: ScreeningInputs) => boolean>> = {
  lungSmoker: (s) => s.lungSmokingHistory === 'former_smoker' || s.lungSmokingHistory === 'current_smoker',
  lungPackYears: (s) => s.lungPackYears !== undefined && s.lungPackYears >= LUNG_PACK_YEARS,
};

/** Whether `age` (and `sex`) fall in a row's ages. A sexed range needs a sex. */
export function inAges(ages: Ages, age: number, sex: string | undefined): boolean {
  const range = 'female' in ages ? (sex === 'female' || sex === 'male' ? ages[sex] : undefined) : ages;
  if (!range) return false;
  const [min, max] = range;
  return age >= min && (max === undefined || age <= max);
}

// ---------------------------------------------------------------------------
// Views: today's shared constants, derived from the table. Nothing reads them
// yet; screening-rules.test.ts proves each deep-equals the constant it replaces.
// ---------------------------------------------------------------------------

/** SCREENING_INTERVALS: keyed by the bare option value, as today. 'other' is both
 *  colorectal's and cervical's (12 months each), so the flat map holds it once; a
 *  value two rows give DIFFERENT months throws, since the flat key could not hold both.
 *  DEXA's result intervals are keyed `dexa_${result}` (dexa_normal, dexa_osteopenia). */
export function screeningIntervals(rules: readonly ScreeningRule[] = SCREENING_RULES): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (key: string, months: number) => {
    if (key in out && out[key] !== months) throw new Error(`screening interval collision: ${key}`);
    out[key] = months;
  };
  for (const r of rules) {
    for (const o of r.choice.options) if (o.months !== undefined) put(o.value, o.months);
    for (const o of r.result?.options ?? []) if (o.months !== undefined) put(`${r.id}_${o.value}`, o.months);
  }
  return out;
}

/** POST_FOLLOWUP_INTERVALS, keyed `${id}_${method}`. */
export function postFollowupIntervals(rules: readonly ScreeningRule[] = SCREENING_RULES): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rules) for (const o of r.choice.options) if (o.postMonths !== undefined) out[`${r.id}_${o.value}`] = o.postMonths;
  return out;
}

/** SCREENING_FOLLOWUP_INFO, keyed `${id}_${method}`. */
export function screeningFollowupInfo(rules: readonly ScreeningRule[] = SCREENING_RULES): Record<string, { followupName: string; abnormalMeans: string }> {
  const out: Record<string, { followupName: string; abnormalMeans: string }> = {};
  for (const r of rules) {
    for (const o of r.choice.options) {
      if (o.followup) out[`${r.id}_${o.value}`] = { followupName: o.followup.name, abnormalMeans: o.followup.abnormalMeans };
    }
  }
  return out;
}

/** SCREENING_MIN_AGE: the rows with an upload gate. */
export function screeningMinAge(rules: readonly ScreeningRule[] = SCREENING_RULES): Record<string, { age: number; sex?: 'male' | 'female' }> {
  const out: Record<string, { age: number; sex?: 'male' | 'female' }> = {};
  for (const r of rules) {
    if (r.uploadMinAge !== undefined) out[r.id] = r.uploadSex ? { age: r.uploadMinAge, sex: r.uploadSex } : { age: r.uploadMinAge };
  }
  return out;
}

/** SCREENING_KEYS: other keys before, the choice, other keys after, the date, then the result chain. */
export function screeningKeys(rules: readonly ScreeningRule[] = SCREENING_RULES): string[] {
  return rules.flatMap((r) => [
    ...(r.otherKeys?.before ?? []),
    r.choice.key,
    ...(r.otherKeys?.afterChoice ?? []),
    ...(r.dateKey ? [r.dateKey] : []),
    ...(r.result ? [r.result.key, `${r.id}_followup_status`, `${r.id}_followup_date`] : []),
  ]);
}

/** REMINDER_CATEGORIES, the screening part, in row order. */
export function screeningReminderCategories(rules: readonly ScreeningRule[] = SCREENING_RULES): ReminderCategory[] {
  return rules.flatMap((r) => (r.reminder ? [r.reminder.category] : []));
}

/** SCHEDULE_LABELS, the screening part: each method's own label, then the row's default. */
export function screeningScheduleLabels(rules: readonly ScreeningRule[] = SCREENING_RULES): Partial<Record<ReminderCategory, string[]>> {
  const out: Partial<Record<ReminderCategory, string[]>> = {};
  for (const r of rules) {
    if (!r.reminder) continue;
    const own = r.choice.options.flatMap((o) => (o.reminderLabel ? [o.reminderLabel] : []));
    out[r.reminder.category] = [...new Set([...own, r.reminder.label])];
  }
  return out;
}
