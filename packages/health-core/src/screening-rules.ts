/**
 * The one screening-rules table (audit A2-1). The rules lived in five copies; each
 * PR moves one copy onto this table, with screening-rules.golden.test.ts proving
 * nothing changed. F and S read it (steps 3 and 4); Q, R and M still keep their own copies.
 *   S  plan cards     suggestions.ts (cancer screening and DEXA)
 *   F  form data      input-form.ts screeningForm, screeningWrites
 *   Q  web JSX        ScreeningQuestions.tsx, BoneDensity.tsx
 *   R  reminders      reminder-schedule.ts screeningSchedule
 *   M  upload gate    types.ts SCREENING_MIN_AGE, isScreeningEligible
 *
 * Rows are pure, JSON-serializable data: no functions. What a row names but cannot
 * hold as data lives once in SCREENING_REFS below: a gate that is not an age or a
 * sex (`extraGates`), and age-dependent prose (breastByAge, prostateByAge, the
 * 40-44 breast start card), which a row names with a `ref`.
 * Rules that are logic, not data, stay as named branches in code: the lung
 * follow-up past 80 or below 20 pack-years, the raised-PSA card and its "up to
 * date" suppression, the DEXA result branches, and the endometrial bleeding card.
 *
 * Ages: [min, max?], inclusive; a sexed rule gives one range per sex.
 *   cardAges   S and R: when the plan card and the reminder apply.
 *   askAges    F and Q: when the questions are asked.
 *   groupAges  F and Q: when the group shows at all (outside askAges, a note only).
 *   uploadMinAge  M: the permissive "save this screening" gate (with uploadSex).
 *
 * "Data present, so ask" (lungGroupShown and lungScreeningAsked show a lung
 * question past 80 or below 20 pack-years once it has an answer) stays lung's own
 * named branch in input-form.ts: as one rule for every row it would open colorectal
 * past 75, which the golden forbids. The cancer section's own gate is a named
 * carve-out too, CANCER_SECTION_MIN_AGE below.
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

/** A follow-up's name and what the abnormal result means, as the follow-up card says them. */
export interface Followup { readonly name: string; readonly abnormalMeans: string }

interface Option { readonly value: string; readonly label: string }
/** A choice option (a method). `months` is its screening interval. */
interface Method extends Option {
  readonly months?: number;
  /** The reminder's label when this method is chosen, if not the row's default. */
  readonly reminderLabel?: string;
  readonly postMonths?: never;
  readonly followup?: never;
}
/** A method that carries its follow-up: `postMonths` applies after an abnormal result whose
 *  follow-up is completed (breast: 12 or 24, so it lives on the method). */
type MethodWithFollowup = Omit<Method, 'postMonths' | 'followup'> & { readonly postMonths: number; readonly followup: Followup };
/** A result option. `followup` true opens the follow-up questions and card. */
interface Result extends Option { readonly followup?: true; readonly postMonths?: never }
/** A result of a rule whose follow-up is keyed by result: a result-based interval (`months`, keyed
 *  `${id}_${value}` in SCREENING_INTERVALS), or the result that opens the follow-up and carries it. */
type KeyedResult =
  | (Result & { readonly months?: number })
  | (Option & { readonly followup: Followup; readonly postMonths: number; readonly months?: never });

/** Card text, verbatim. `{due}` is the next-due month ("Mar 2027"); `{packYears}` the answer. */
export interface CardText { readonly title: string; readonly description: string }

export type GateName = 'lungSmoker' | 'lungPackYears';
export type NoteRef = 'breastByAge' | 'prostateByAge';
export type Note = { readonly below?: number; readonly above?: number; readonly text: string } | { readonly ref: NoteRef };

interface RuleBase {
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
  readonly notStarted: string;
  /** Answers asked beside the choice, in SCREENING_KEYS order: before it, or after it (before the date). */
  readonly otherKeys?: { readonly before?: readonly string[]; readonly afterChoice?: readonly string[] };
  readonly dateKey?: string;
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

/** The post-follow-up interval and names have one home per rule, and the type says which:
 *  `followupBy: 'choice'` puts them on the methods, `'result'` (DEXA) on the result that opens
 *  the follow-up, keyed by every started method. A row cannot state both. */
export type ScreeningRule = RuleBase & (
  | {
    readonly followupBy: 'choice';
    readonly choice: { readonly key: string; readonly options: readonly (Method | MethodWithFollowup)[] };
    readonly result?: { readonly key: string; readonly options: readonly Result[] };
  }
  | {
    readonly followupBy: 'result';
    readonly choice: { readonly key: string; readonly options: readonly Method[] };
    readonly result: { readonly key: string; readonly options: readonly KeyedResult[] };
  }
);

const RESULTS: readonly Result[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'abnormal', label: 'Abnormal', followup: true },
  { value: 'awaiting', label: 'Awaiting results' },
];
const NOT_YET_STARTED = { value: 'not_yet_started', label: 'Not yet started' } as const;
const resultOf = (id: string) => ({ key: `${id}_result`, options: RESULTS });

export const SCREENING_RULES: readonly ScreeningRule[] = [
  {
    id: 'colorectal', section: 'cancer-screening', followupBy: 'choice', title: 'Colorectal',
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
    id: 'breast', section: 'cancer-screening', followupBy: 'choice', title: 'Breast', sex: 'female',
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
    id: 'cervical', section: 'cancer-screening', followupBy: 'choice', title: 'Cervical', sex: 'female',
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
    id: 'lung', section: 'cancer-screening', followupBy: 'choice', title: 'Lung',
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
    id: 'prostate', section: 'cancer-screening', followupBy: 'choice', title: 'Prostate', sex: 'male',
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
    id: 'endometrial', section: 'cancer-screening', followupBy: 'choice', title: 'Endometrial', sex: 'female',
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
    id: 'dexa', section: 'bone-density', followupBy: 'result', title: '',
    cardAges: { female: [50], male: [70] }, askAges: { female: [50], male: [70] }, groupAges: { female: [50], male: [70] },
    uploadMinAge: 50,
    choice: { key: 'dexa_screening', options: [
      { value: 'dexa_scan', label: 'Had a DEXA scan', months: 24 },
      NOT_YET_STARTED,
    ] },
    notStarted: 'not_yet_started', dateKey: 'dexa_last_date',
    result: { key: 'dexa_result', options: [
      { value: 'normal', label: 'Normal', months: 60 },
      { value: 'osteopenia', label: 'Osteopenia', months: 24 },
      { value: 'osteoporosis', label: 'Osteoporosis', postMonths: 12,
        followup: { name: 'treatment review', abnormalMeans: 'osteoporosis diagnosed — treatment and monitoring required' } },
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

/** Everything a row names but cannot hold as data, each in one place: the gates (`extraGates`)
 *  and the age-dependent prose (a note's or a card's `ref`). screening-rules.test.ts checks the
 *  gates; the golden pin guards the prose. */
export const SCREENING_REFS: { readonly [K in GateName]: (s: ScreeningInputs) => boolean }
  & { readonly [K in NoteRef]: (age: number) => string } & { readonly breastStart: (age: number) => CardText } = {
  lungSmoker: (s) => s.lungSmokingHistory === 'former_smoker' || s.lungSmokingHistory === 'current_smoker',
  lungPackYears: (s) => s.lungPackYears !== undefined && s.lungPackYears >= LUNG_PACK_YEARS,
  breastByAge: (age) => age <= 44
    ? 'Annual mammograms are optional at your age (40–44).'
    : age <= 54
      ? 'Annual mammograms are recommended at your age (45–54).'
      : 'Annual or biennial mammograms are recommended at your age (55+).',
  prostateByAge: (age) => age < 50
    ? 'Screening typically starts at 50, but consider at 45 if you are at higher risk (African American or family history).'
    : 'PSA testing is an option after an informed discussion with your doctor.',
  breastStart: (age) => ({
    title: 'Start breast cancer screening',
    description: age >= 45
      ? 'Mammography is recommended at your age. Discuss with your doctor.'
      : 'Mammography is optional at your age (40\u201344). Discuss with your doctor.',
  }),
};

/** The cancer section opens from 35 for anyone, with no upper bound (input-form.ts
 *  anyScreeningEligible). The union of groupAges cannot build it: colorectal's group stops
 *  at 85, so past 85 with no sex the section shows its intro and no group. Today's behaviour,
 *  kept by name. */
export const CANCER_SECTION_MIN_AGE = 35;

/** The row with this id. */
export const ruleOf = (id: ScreeningId): ScreeningRule => SCREENING_RULES.find((r) => r.id === id)!;

/** Whether `age` (and `sex`) fall in a row's ages. A sexed range needs a sex. `ignoreUpper`
 *  drops the upper age (lung's group past 80 while it holds an answer). */
export function inAges(ages: Ages, age: number, sex: string | undefined, ignoreUpper = false): boolean {
  const range = 'female' in ages ? (sex === 'female' || sex === 'male' ? ages[sex] : undefined) : ages;
  if (!range) return false;
  const [min, max] = range;
  return age >= min && (ignoreUpper || max === undefined || age <= max);
}

/** Whether a row's ages, with the row's own sex, take this person. */
export const ruleTakes = (r: ScreeningRule, ages: Ages, age: number, sex: string | undefined): boolean =>
  (!r.sex || r.sex === sex) && inAges(ages, age, sex);

/** A row's notes at this age: each fixed note below or above its age, and the by-age prose. */
export const ruleNotes = (r: ScreeningRule, age: number): string[] => r.notes.flatMap((n) => {
  if ('ref' in n) return [SCREENING_REFS[n.ref](age)];
  return (n.below !== undefined && age < n.below) || (n.above !== undefined && age > n.above) ? [n.text] : [];
});

/** A row's result answer that opens its follow-up (abnormal; DEXA's osteoporosis). */
export const followupTrigger = (r: ScreeningRule): string | undefined => r.result?.options.find((o) => o.followup)?.value;

/** A row's result chain keys: the result, then the follow-up's status and date. */
export const chainKeys = (r: ScreeningRule): string[] => (r.result ? [r.result.key, `${r.id}_followup_status`, `${r.id}_followup_date`] : []);

// ---------------------------------------------------------------------------
// Views: today's shared constants, derived from the table. Only F and S read one yet
// (screeningFollowupInfo); screening-rules.test.ts proves each deep-equals the constant it replaces.
// ---------------------------------------------------------------------------

type Entry = readonly [key: string, months: number];
const intervalsOf = (options: readonly (Option & { readonly months?: number })[], key = (v: string) => v): Entry[] =>
  options.flatMap((o) => (o.months === undefined ? [] : [[key(o.value), o.months] as const]));

/** SCREENING_INTERVALS, keyed by the bare method value, in today's key order: each method's own
 *  interval in row order, then a value several rows share ('other': colorectal's and cervical's),
 *  then the result-keyed rows (DEXA: dexa_normal, dexa_osteopenia, then dexa_scan, the interval
 *  before a result). This ordering rule is fitted to today's data, not a principle: a new row or
 *  method can need a new rule, and the golden test's key-order check is what catches it.
 *  A shared value takes its first row's months and never throws: a throw at load
 *  blanks the tool. screening-rules.test.ts checks no two rows give one value different months. */
export function screeningIntervals(rules: readonly ScreeningRule[] = SCREENING_RULES): Record<string, number> {
  const methods = rules.flatMap((r) => (r.followupBy === 'choice' ? r.choice.options : []));
  const shared = (v: string) => methods.filter((o) => o.value === v).length > 1;
  const entries = [
    ...intervalsOf(methods.filter((o) => !shared(o.value))),
    ...intervalsOf(methods.filter((o) => shared(o.value))),
    ...rules.flatMap((r) => (r.followupBy === 'result'
      ? [...intervalsOf(r.result.options, (v) => `${r.id}_${v}`), ...intervalsOf(r.choice.options)] : [])),
  ];
  const out: Record<string, number> = {};
  for (const [key, months] of entries) if (!(key in out)) out[key] = months;
  return out;
}

/** Each rule's follow-up, keyed `${id}_${method}`: from its methods, or from its result for every started method. */
function followups(r: ScreeningRule): Array<readonly [string, { readonly postMonths: number; readonly followup: Followup }]> {
  if (r.followupBy === 'choice') return r.choice.options.flatMap((o) => (o.followup ? [[`${r.id}_${o.value}`, o] as const] : []));
  const started = r.choice.options.filter((o) => o.value !== r.notStarted);
  return r.result.options.flatMap((res) => (res.postMonths === undefined ? [] : started.map((m) => [`${r.id}_${m.value}`, res] as const)));
}

/** POST_FOLLOWUP_INTERVALS, keyed `${id}_${method}`, in row order. */
export function postFollowupIntervals(rules: readonly ScreeningRule[] = SCREENING_RULES): Record<string, number> {
  return Object.fromEntries(rules.flatMap(followups).map(([key, f]) => [key, f.postMonths]));
}

/** SCREENING_FOLLOWUP_INFO, keyed `${id}_${method}`, in row order. */
export function screeningFollowupInfo(rules: readonly ScreeningRule[] = SCREENING_RULES): Record<string, { followupName: string; abnormalMeans: string }> {
  return Object.fromEntries(rules.flatMap(followups).map(([key, f]) => [key, { followupName: f.followup.name, abnormalMeans: f.followup.abnormalMeans }]));
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
    ...chainKeys(r),
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
