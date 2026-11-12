/**
 * Test-only: the cases A2-1's golden pin runs before the screening rules move
 * into one table. Each case is a record (age, sex, screening answers) and its
 * output from today's five copies: the plan's screening cards (suggestions.ts),
 * the reminder schedule's screening items and follow-up kinds
 * (reminder-schedule.ts), the form (input-form.ts screeningForm), the clears
 * each answer writes (screeningWrites) and the upload gate (types.ts
 * isScreeningEligible). The server cron's 90-day cooldown is not here: it is
 * server-side; only GROUP_COOLDOWNS, the constant health-core exports, is.
 * Synthetic data only.
 *
 * The set is pruned but boundary-complete:
 *  A. every age edge × sex × a probe per screening state that gates a card;
 *  B. every answer fixture at one or two ages where its screening applies;
 *  C. a last date at, one month before and one month after every interval;
 *  D. birthday-month and clock-edge cases (the plan's age is local, the
 *     schedule's UTC).
 */
import { migrateFile } from './migrate';
import { computePlan } from './plan';
import { computeReminderSchedule, followupKinds } from './reminder-schedule';
import { GROUP_COOLDOWNS } from './reminders';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';
import {
  isScreeningEligible, LUNG_PACK_YEARS, POST_FOLLOWUP_INTERVALS, SCREENING_FOLLOWUP_INFO, SCREENING_INTERVALS,
  SCREENING_MIN_AGE, type ScreeningInputs,
} from './types';
import { SCREENING_LABELS, SCREENING_OPTIONS, screeningForm, screeningWrites, type FormField, type FormSection } from './input-form';

/** The clock every golden run uses (the blood table's). In Pacific/Auckland it is 2 Oct 2026, 01:00. */
export const GOLDEN_NOW = new Date('2026-10-01T12:00:00Z');
/** The clock edge: 1 Oct 2026 in Auckland, still 30 Sep in UTC. */
export const EDGE_NOW = new Date('2026-09-30T12:00:00Z');

/** Both edges of every age range the five copies use, plus 20 and 95. */
export const AGES = [20, 24, 25, 34, 35, 39, 40, 44, 45, 49, 50, 54, 55, 64, 65, 66, 69, 70, 74, 75, 76, 79, 80, 81, 84, 85, 86, 95];
type Sex = 'male' | 'female' | undefined;
const SEXES: Array<[string, Sex]> = [['m', 'male'], ['f', 'female'], ['x', undefined]];

/** YYYY-MM, n months before October 2026 (negative: after). */
export function monthsAgo(n: number): string {
  const t = 2026 * 12 + 9 - n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
const RECENT = monthsAgo(6);
const SOON = monthsAgo(-2);
const FU_DONE = monthsAgo(3);

interface Fixture { name: string; s: ScreeningInputs; psaRow?: number }
const fx = (name: string, s: ScreeningInputs, psaRow?: number): Fixture => ({ name, s, ...(psaRow === undefined ? {} : { psaRow }) });

/** The field names of one screening type's chain, camelCase. */
const F = (type: string) => ({ last: `${type}LastDate`, result: `${type}Result`, status: `${type}FollowupStatus`, date: `${type}FollowupDate` });

/** Every result and follow-up state after a dated screening, for one method. */
function resultStates(type: string, base: Record<string, unknown>, tag: string): Fixture[] {
  const f = F(type);
  const dated = { ...base, [f.last]: RECENT };
  const ab = { ...dated, [f.result]: 'abnormal' };
  return [
    fx(`${tag},no-date`, base as ScreeningInputs),
    fx(`${tag},last=${RECENT}`, dated as ScreeningInputs),
    ...(['normal', 'awaiting', 'abnormal'] as const).map((r) => fx(`${tag},last=${RECENT},${r}`, { ...dated, [f.result]: r } as ScreeningInputs)),
    fx(`${tag},last=${RECENT},abnormal,fu=not_organized`, { ...ab, [f.status]: 'not_organized' } as ScreeningInputs),
    fx(`${tag},last=${RECENT},abnormal,fu=scheduled`, { ...ab, [f.status]: 'scheduled' } as ScreeningInputs),
    fx(`${tag},last=${RECENT},abnormal,fu=scheduled@${SOON}`, { ...ab, [f.status]: 'scheduled', [f.date]: SOON } as ScreeningInputs),
    fx(`${tag},last=${RECENT},abnormal,fu=completed`, { ...ab, [f.status]: 'completed' } as ScreeningInputs),
    fx(`${tag},last=${RECENT},abnormal,fu=completed@${FU_DONE}`, { ...ab, [f.status]: 'completed', [f.date]: FU_DONE } as ScreeningInputs),
  ];
}

/** Colorectal, breast and cervical: not started, a leftover date, no method, then each method's states. */
function chainFixtures(type: string, methodField: string, methods: string[]): Fixture[] {
  const f = F(type);
  return [
    fx(`${type}:not_yet_started`, { [methodField]: 'not_yet_started' } as ScreeningInputs),
    fx(`${type}:not_yet_started,stale last+abnormal`, { [methodField]: 'not_yet_started', [f.last]: RECENT, [f.result]: 'abnormal' } as ScreeningInputs),
    fx(`${type}:no-method,last=${RECENT}`, { [f.last]: RECENT } as ScreeningInputs),
    ...methods.flatMap((m) => resultStates(type, { [methodField]: m }, `${type}:${m}`)),
  ];
}

function lungFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const [h, packs] of [[undefined, [undefined, 25]], ['never_smoked', [undefined, 25]]] as const) {
    for (const p of packs) {
      const base = { lungSmokingHistory: h, lungPackYears: p };
      out.push(fx(`lung:${h ?? 'no-history'},py=${p ?? '-'}`, base));
      out.push(fx(`lung:${h ?? 'no-history'},py=${p ?? '-'},annual_ldct,last=${RECENT},abnormal`, { ...base, lungScreening: 'annual_ldct', lungLastDate: RECENT, lungResult: 'abnormal' }));
    }
  }
  for (const h of ['former_smoker', 'current_smoker'] as const) {
    for (const p of [undefined, 19, LUNG_PACK_YEARS, 21]) {
      const base: ScreeningInputs = p === undefined ? { lungSmokingHistory: h } : { lungSmokingHistory: h, lungPackYears: p };
      const tag = `lung:${h},py=${p ?? '-'}`;
      out.push(fx(tag, base));
      out.push(fx(`${tag},not_yet_started`, { ...base, lungScreening: 'not_yet_started' }));
      out.push(...resultStates('lung', { ...base, lungScreening: 'annual_ldct' }, `${tag},annual_ldct`));
    }
  }
  return out;
}

function prostateFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const d of [undefined, 'not_yet', 'elected_not_to', 'will_screen'] as const) {
    for (const last of [undefined, RECENT]) {
      for (const psa of [undefined, 3.9, 4.0, 4.1]) {
        const s: ScreeningInputs = {};
        if (d) s.prostateDiscussion = d;
        if (last) s.prostateLastDate = last;
        if (psa !== undefined) s.prostatePsaValue = psa;
        out.push(fx(`prostate:${d ?? 'no-discussion'},last=${last ?? '-'},psa=${psa ?? '-'}`, s));
      }
    }
  }
  // The newest saved PSA measurement overrides the answers (US-06 AC14).
  for (const psa of [3.9, 4.0, 4.1]) {
    out.push(fx(`prostate:will_screen,psa-row=${psa}@2026-04-10`, { prostateDiscussion: 'will_screen' }, psa));
    out.push(fx(`prostate:no-discussion,psa-row=${psa}@2026-04-10`, {}, psa));
  }
  return out;
}

function endometrialFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const d of [undefined, 'not_yet', 'discussed'] as const) {
    for (const b of [undefined, 'no', 'yes_reported', 'yes_need_to_report'] as const) {
      const s: ScreeningInputs = {};
      if (d) s.endometrialDiscussion = d;
      if (b) s.endometrialAbnormalBleeding = b;
      out.push(fx(`endometrial:${d ?? '-'},bleeding=${b ?? '-'}`, s));
    }
  }
  return out;
}

function dexaFixtures(): Fixture[] {
  const dated: ScreeningInputs = { dexaScreening: 'dexa_scan', dexaLastDate: RECENT };
  const op: ScreeningInputs = { ...dated, dexaResult: 'osteoporosis' };
  return [
    fx('dexa:not_yet_started', { dexaScreening: 'not_yet_started' }),
    fx('dexa:not_yet_started,stale last+osteoporosis', { dexaScreening: 'not_yet_started', dexaLastDate: RECENT, dexaResult: 'osteoporosis' }),
    fx(`dexa:no-status,last=${RECENT},normal`, { dexaLastDate: RECENT, dexaResult: 'normal' }),
    fx('dexa:dexa_scan,no-date', { dexaScreening: 'dexa_scan' }),
    fx(`dexa:dexa_scan,last=${RECENT}`, dated),
    ...(['normal', 'osteopenia', 'awaiting', 'osteoporosis'] as const).map((r) => fx(`dexa:dexa_scan,last=${RECENT},${r}`, { ...dated, dexaResult: r })),
    fx(`dexa:dexa_scan,last=${RECENT},osteoporosis,fu=not_organized`, { ...op, dexaFollowupStatus: 'not_organized' }),
    fx(`dexa:dexa_scan,last=${RECENT},osteoporosis,fu=scheduled`, { ...op, dexaFollowupStatus: 'scheduled' }),
    fx(`dexa:dexa_scan,last=${RECENT},osteoporosis,fu=scheduled@${SOON}`, { ...op, dexaFollowupStatus: 'scheduled', dexaFollowupDate: SOON }),
    fx(`dexa:dexa_scan,last=${RECENT},osteoporosis,fu=completed`, { ...op, dexaFollowupStatus: 'completed' }),
    fx(`dexa:dexa_scan,last=${RECENT},osteoporosis,fu=completed@${FU_DONE}`, { ...op, dexaFollowupStatus: 'completed', dexaFollowupDate: FU_DONE }),
  ];
}

/** Change 2b (US-07 AC1j): the colonoscopy schedule after an abnormal result whose follow-up is completed,
 *  on every method: undated; dated, not yet due, without and with the report's years; overdue, without and with. */
function colonoscopyFixtures(): Fixture[] {
  const OVERDUE = monthsAgo(40);
  return (['fit_annual', 'colonoscopy_10yr', 'other'] as const).flatMap((m) => {
    const done = (last: string): ScreeningInputs => ({ colorectalMethod: m, colorectalLastDate: last, colorectalResult: 'abnormal', colorectalFollowupStatus: 'completed' });
    const tag = (last: string) => `colonoscopy:${m},last=${last},abnormal,fu=completed`;
    return [
      fx(`${tag(RECENT)},undated`, done(RECENT)),
      fx(`${tag(RECENT)}@${FU_DONE}`, { ...done(RECENT), colorectalFollowupDate: FU_DONE }),
      fx(`${tag(RECENT)}@${FU_DONE},years=5`, { ...done(RECENT), colorectalFollowupDate: FU_DONE, colorectalFollowupIntervalYears: 5 }),
      fx(`${tag(monthsAgo(41))}@${OVERDUE}`, { ...done(monthsAgo(41)), colorectalFollowupDate: OVERDUE }),
      fx(`${tag(monthsAgo(41))}@${OVERDUE},years=2`, { ...done(monthsAgo(41)), colorectalFollowupDate: OVERDUE, colorectalFollowupIntervalYears: 2 }),
    ];
  }).concat(
    // A newer abnormal last screening starts the follow-up again (US-07 AC1j, Brad 2026-11-12) when the answer is
    // written: the writes table shows the clears; the cards read the stored answers as they are. The same month never.
    fx(`colonoscopy:colonoscopy_10yr,last=${RECENT},abnormal,fu=completed@${OVERDUE},years=5,newer-last`,
      { colorectalMethod: 'colonoscopy_10yr', colorectalLastDate: RECENT, colorectalResult: 'abnormal', colorectalFollowupStatus: 'completed', colorectalFollowupDate: OVERDUE, colorectalFollowupIntervalYears: 5 }),
    fx(`colonoscopy:fit_annual,last=${RECENT},abnormal,fu=scheduled@${OVERDUE},newer-last`,
      { colorectalMethod: 'fit_annual', colorectalLastDate: RECENT, colorectalResult: 'abnormal', colorectalFollowupStatus: 'scheduled', colorectalFollowupDate: OVERDUE }),
    fx(`colonoscopy:other,last=${FU_DONE},abnormal,fu=completed@${FU_DONE},same-month`,
      { colorectalMethod: 'other', colorectalLastDate: FU_DONE, colorectalResult: 'abnormal', colorectalFollowupStatus: 'completed', colorectalFollowupDate: FU_DONE }),
  );
}

/** Every answer fixture, by screening type. */
export const FIXTURES: Record<string, Fixture[]> = {
  colorectal: chainFixtures('colorectal', 'colorectalMethod', ['fit_annual', 'colonoscopy_10yr', 'other']),
  breast: chainFixtures('breast', 'breastFrequency', ['annual', 'biennial']),
  cervical: chainFixtures('cervical', 'cervicalMethod', ['hpv_every_5yr', 'pap_every_3yr', 'other']),
  lung: lungFixtures(),
  prostate: prostateFixtures(),
  endometrial: endometrialFixtures(),
  dexa: dexaFixtures(),
  colonoscopy: colonoscopyFixtures(),
};

/** Where each type's fixtures run in section B: ages where it applies, and past its edge where that matters. */
const B_PROFILES: Record<string, string[]> = {
  colorectal: ['m50'], breast: ['f50'], cervical: ['f30'], lung: ['m60', 'm81'],
  prostate: ['m55'], endometrial: ['f50'], dexa: ['f60', 'm70'], colonoscopy: ['m60'],
};

const byName = (name: string): Fixture => {
  for (const list of Object.values(FIXTURES)) for (const f of list) if (f.name === name) return f;
  throw new Error(`no fixture ${name}`);
};

/** Every answer at once, so the order of the cards and items is pinned too. */
const ALL_ANSWERED: Fixture = fx('all-answered', {
  colorectalMethod: 'fit_annual', colorectalLastDate: monthsAgo(13), colorectalResult: 'normal',
  breastFrequency: 'biennial', breastLastDate: RECENT, breastResult: 'abnormal', breastFollowupStatus: 'scheduled', breastFollowupDate: SOON,
  cervicalMethod: 'hpv_every_5yr', cervicalLastDate: monthsAgo(40), cervicalResult: 'normal',
  lungSmokingHistory: 'former_smoker', lungPackYears: 30, lungScreening: 'annual_ldct', lungLastDate: RECENT, lungResult: 'abnormal', lungFollowupStatus: 'completed', lungFollowupDate: FU_DONE,
  prostateDiscussion: 'will_screen', prostateLastDate: monthsAgo(14), prostatePsaValue: 4.1,
  endometrialDiscussion: 'not_yet', endometrialAbnormalBleeding: 'yes_need_to_report',
  dexaScreening: 'dexa_scan', dexaLastDate: monthsAgo(30), dexaResult: 'osteopenia',
});

/** The probes section A runs at every age and sex: one per state that gates a card or an item. */
const PROBES: Fixture[] = [
  fx('blank', {}),
  ...[
    'colorectal:not_yet_started', `colorectal:fit_annual,last=${RECENT},normal`, `colorectal:fit_annual,last=${RECENT},abnormal,fu=not_organized`,
    'breast:not_yet_started', `breast:annual,last=${RECENT},normal`, `breast:annual,last=${RECENT},abnormal,fu=scheduled@${SOON}`,
    'cervical:not_yet_started', `cervical:hpv_every_5yr,last=${RECENT},normal`, `cervical:hpv_every_5yr,last=${RECENT},abnormal,fu=completed@${FU_DONE}`,
    'lung:former_smoker,py=20', `lung:former_smoker,py=20,annual_ldct,last=${RECENT},normal`,
    `lung:former_smoker,py=19,annual_ldct,last=${RECENT},abnormal,fu=not_organized`, `lung:current_smoker,py=21,annual_ldct,last=${RECENT},abnormal,fu=completed@${FU_DONE}`,
    `prostate:will_screen,last=${RECENT},psa=4.1`,
    'endometrial:-,bleeding=yes_need_to_report',
    'dexa:not_yet_started', `dexa:dexa_scan,last=${RECENT},osteoporosis`, `dexa:dexa_scan,last=${RECENT},normal`,
  ].map(byName),
  ALL_ANSWERED,
];

/** Section C: a last date at, one month before and one month after each interval. */
function boundaryCases(): Array<[string, string, Fixture]> {
  const out: Array<[string, string, Fixture]> = [];
  const around = (months: number) => [months - 1, months, months + 1];
  const routine: Array<[string, string, (last: string) => ScreeningInputs]> = [
    ['fit_annual', 'm50', (l) => ({ colorectalMethod: 'fit_annual', colorectalLastDate: l, colorectalResult: 'normal' })],
    ['colonoscopy_10yr', 'm50', (l) => ({ colorectalMethod: 'colonoscopy_10yr', colorectalLastDate: l, colorectalResult: 'normal' })],
    ['other', 'm50', (l) => ({ colorectalMethod: 'other', colorectalLastDate: l, colorectalResult: 'normal' })],
    ['annual', 'f50', (l) => ({ breastFrequency: 'annual', breastLastDate: l, breastResult: 'normal' })],
    ['biennial', 'f50', (l) => ({ breastFrequency: 'biennial', breastLastDate: l, breastResult: 'normal' })],
    ['hpv_every_5yr', 'f30', (l) => ({ cervicalMethod: 'hpv_every_5yr', cervicalLastDate: l, cervicalResult: 'normal' })],
    ['pap_every_3yr', 'f30', (l) => ({ cervicalMethod: 'pap_every_3yr', cervicalLastDate: l, cervicalResult: 'normal' })],
    ['other', 'f30', (l) => ({ cervicalMethod: 'other', cervicalLastDate: l, cervicalResult: 'normal' })],
    ['annual_ldct', 'm60', (l) => ({ lungSmokingHistory: 'former_smoker', lungPackYears: 25, lungScreening: 'annual_ldct', lungLastDate: l, lungResult: 'normal' })],
    ['will_screen', 'm55', (l) => ({ prostateDiscussion: 'will_screen', prostateLastDate: l })],
    ['dexa_normal', 'f60', (l) => ({ dexaScreening: 'dexa_scan', dexaLastDate: l, dexaResult: 'normal' })],
    ['dexa_osteopenia', 'f60', (l) => ({ dexaScreening: 'dexa_scan', dexaLastDate: l, dexaResult: 'osteopenia' })],
    ['dexa_scan', 'f60', (l) => ({ dexaScreening: 'dexa_scan', dexaLastDate: l, dexaResult: 'osteoporosis' })],
    ['dexa_scan (no result)', 'f60', (l) => ({ dexaScreening: 'dexa_scan', dexaLastDate: l })],
  ];
  for (const [key, profile, make] of routine) {
    const interval = SCREENING_INTERVALS[key.split(' ')[0]];
    for (const n of around(interval)) out.push([`C interval ${key}=${interval}mo ${profile} last=${monthsAgo(n)} (${n}mo ago)`, profile, fx(key, make(monthsAgo(n)))]);
  }
  const post: Record<string, [string, (fu: string) => ScreeningInputs]> = {
    colorectal_fit_annual: ['m50', (d) => ({ colorectalMethod: 'fit_annual', colorectalLastDate: d, colorectalResult: 'abnormal', colorectalFollowupStatus: 'completed', colorectalFollowupDate: d })],
    colorectal_colonoscopy_10yr: ['m50', (d) => ({ colorectalMethod: 'colonoscopy_10yr', colorectalLastDate: d, colorectalResult: 'abnormal', colorectalFollowupStatus: 'completed', colorectalFollowupDate: d })],
    colorectal_other: ['m50', (d) => ({ colorectalMethod: 'other', colorectalLastDate: d, colorectalResult: 'abnormal', colorectalFollowupStatus: 'completed', colorectalFollowupDate: d })],
    breast_annual: ['f50', (d) => ({ breastFrequency: 'annual', breastLastDate: d, breastResult: 'abnormal', breastFollowupStatus: 'completed', breastFollowupDate: d })],
    breast_biennial: ['f50', (d) => ({ breastFrequency: 'biennial', breastLastDate: d, breastResult: 'abnormal', breastFollowupStatus: 'completed', breastFollowupDate: d })],
    cervical_hpv_every_5yr: ['f30', (d) => ({ cervicalMethod: 'hpv_every_5yr', cervicalLastDate: d, cervicalResult: 'abnormal', cervicalFollowupStatus: 'completed', cervicalFollowupDate: d })],
    cervical_pap_every_3yr: ['f30', (d) => ({ cervicalMethod: 'pap_every_3yr', cervicalLastDate: d, cervicalResult: 'abnormal', cervicalFollowupStatus: 'completed', cervicalFollowupDate: d })],
    cervical_other: ['f30', (d) => ({ cervicalMethod: 'other', cervicalLastDate: d, cervicalResult: 'abnormal', cervicalFollowupStatus: 'completed', cervicalFollowupDate: d })],
    lung_annual_ldct: ['m60', (d) => ({ lungSmokingHistory: 'former_smoker', lungPackYears: 25, lungScreening: 'annual_ldct', lungLastDate: d, lungResult: 'abnormal', lungFollowupStatus: 'completed', lungFollowupDate: d })],
    dexa_dexa_scan: ['f60', (d) => ({ dexaScreening: 'dexa_scan', dexaLastDate: d, dexaResult: 'osteoporosis', dexaFollowupStatus: 'completed', dexaFollowupDate: d })],
  };
  for (const [key, interval] of Object.entries(POST_FOLLOWUP_INTERVALS)) {
    const [profile, make] = post[key];
    for (const n of around(interval)) out.push([`C post-followup ${key}=${interval}mo ${profile} fu=${monthsAgo(n)} (${n}mo ago)`, profile, fx(key, make(monthsAgo(n)))]);
  }
  // The follow-up reminders (US-17 AC15): organize is due at the last screening's month, a scheduled one 3 months on.
  for (const n of [-1, 0, 1, 2, 3, 4]) {
    const l = monthsAgo(n);
    out.push([`C followup organize m50 last=${l} (${n}mo ago)`, 'm50', fx('organize', { colorectalMethod: 'fit_annual', colorectalLastDate: l, colorectalResult: 'abnormal' })]);
    out.push([`C followup check-in m50 last=${l} (${n}mo ago)`, 'm50', fx('check-in', { colorectalMethod: 'fit_annual', colorectalLastDate: l, colorectalResult: 'abnormal', colorectalFollowupStatus: 'scheduled' })]);
    out.push([`C followup dexa check-in f60 last=${l} (${n}mo ago)`, 'f60', fx('dexa check-in', { dexaScreening: 'dexa_scan', dexaLastDate: l, dexaResult: 'osteoporosis', dexaFollowupStatus: 'scheduled' })]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running a case
// ---------------------------------------------------------------------------

interface Profile { sex: Sex; birthYear?: number; birthMonth?: number }

function profileOf(code: string): Profile {
  const sex = SEXES.find(([c]) => c === code[0])![1];
  return { sex, birthYear: 2026 - Number(code.slice(1)), birthMonth: 1 };
}

function recordOf(p: Profile, f: Fixture): unknown {
  const file: RoadmapFile = createEmptyFile({ deviceId: 'golden', now: '2026-09-01T00:00:00Z' });
  file.profile = { ...file.profile, heightCm: 170, unitSystem: 'si', ...(p.sex ? { sex: p.sex } : {}), ...(p.birthYear ? { birthYear: p.birthYear, birthMonth: p.birthMonth } : {}) };
  file.screenings = { ...file.screenings, ...f.s };
  if (f.psaRow !== undefined) {
    file.measurements = [createMeasurement({ id: 'psa', metricType: 'psa', value: f.psaRow, recordedAt: '2026-04-10', createdAt: '2026-04-10T08:00:00Z' })];
  }
  return JSON.parse(JSON.stringify(file));
}

/** One field as JSON, its options named when they are one of SCREENING_OPTIONS' lists. */
function fieldLine(field: FormField): string {
  if (field.kind !== 'choice') return JSON.stringify(field);
  const name = Object.entries(SCREENING_OPTIONS).find(([, opts]) => JSON.stringify(opts) === JSON.stringify(field.options))?.[0];
  return JSON.stringify({ ...field, options: name ? `SCREENING_OPTIONS.${name}` : field.options });
}

/** A form as lines: each section's header, then its groups by reference (a group is its header, notes and fields). */
function formLines(sections: FormSection[], groupRef: (lines: string[]) => string): string[] {
  const lines: string[] = [];
  for (const s of sections) {
    lines.push(`## ${s.id} | ${s.title} | ${s.intro}`);
    for (const g of s.groups) lines.push(groupRef([`# ${g.id} | ${g.title}`, ...g.notes.map((n) => `note: ${n}`), ...g.fields.map(fieldLine)]));
  }
  return lines;
}

/** A table that stores each distinct value once, under a short id in first-seen order. */
function interner<T>(prefix: string) {
  const table: Record<string, T> = {};
  const ids = new Map<string, string>();
  const ref = (value: T): string => {
    const key = JSON.stringify(value);
    let id = ids.get(key);
    if (!id) {
      id = `${prefix}${String(ids.size + 1).padStart(3, '0')}`;
      ids.set(key, id);
      table[id] = value;
    }
    return id;
  };
  return { table, ref };
}

/** A case's cards and form are ids into the golden's `cards` and `forms` tables (a form's groups into `groups`). */
interface CaseOut { age: number | null; cards: string[]; due: string[]; followups?: string[]; form: string }

/** The golden itself. `setNow` moves the faked clock (`Date.now`, `new Date()`). */
export function screeningGolden(setNow: (d: Date) => void) {
  const cardTable = interner<string>('C');
  const groupTable = interner<string[]>('G');
  const formTable = interner<string[]>('F');

  const run = (p: Profile, f: Fixture, now: Date): CaseOut => {
    setNow(now);
    const file = migrateFile(recordOf(p, f), { deviceId: 'golden', now: now.toISOString() });
    const plan = computePlan(file, now);
    const cards = plan.results.suggestions.filter((s) => s.category === 'screening')
      .map((s) => cardTable.ref(`${s.id} [${s.priority}] ${s.title} :: ${s.description}`));
    const due = computeReminderSchedule(file, now).map((i) => `${i.category} (${i.group}) ${i.label} ${i.dueAt}`);
    const kinds = Object.entries(followupKinds(file, now)).map(([c, k]) => `${c} ${k!.kind} ${k!.name}`);
    const age = plan.results.age ?? null;
    return { age, cards, due, ...(kinds.length ? { followups: kinds } : {}), form: formTable.ref(formLines(screeningForm(plan.results.age, p.sex, f.s), groupTable.ref)) };
  };

  const cases: Record<string, CaseOut> = {};
  const add = (name: string, p: Profile, f: Fixture, now = GOLDEN_NOW) => {
    if (name in cases) throw new Error(`duplicate case ${name}`);
    cases[name] = run(p, f, now);
  };

  // A. Every age edge × sex × probe; and no birth year at all.
  for (const age of AGES) for (const [c] of SEXES) for (const f of PROBES) add(`A ${c}${age} ${f.name}`, profileOf(`${c}${age}`), f);
  for (const [c, sex] of SEXES) for (const f of PROBES) add(`A ${c}-no-birth-year ${f.name}`, { sex }, f);
  // B. Every fixture where its screening applies.
  for (const [type, list] of Object.entries(FIXTURES)) {
    for (const code of B_PROFILES[type]) for (const f of list) add(`B ${code} ${f.name}`, profileOf(code), f);
  }
  // C. Interval boundaries.
  for (const [name, code, f] of boundaryCases()) add(name, profileOf(code), f);
  // D. The birthday month, at both clocks: the plan counts age in local time, the schedule in UTC.
  for (const [c] of SEXES.slice(0, 2)) {
    for (const age of [25, 35, 40, 45, 50, 66, 70, 76, 81]) {
      for (const birthMonth of [9, 10, 11]) {
        const p = { ...profileOf(`${c}${age}`), birthMonth };
        add(`D ${c}${age} born ${2026 - age}-${birthMonth} all-answered`, p, ALL_ANSWERED);
        add(`D edge-clock ${c}${age} born ${2026 - age}-${birthMonth} all-answered`, p, ALL_ANSWERED, EDGE_NOW);
      }
    }
  }
  for (const n of [11, 12, 13]) {
    add(`D edge-clock m50 fit_annual last=${monthsAgo(n)} (${n}mo ago)`, profileOf('m50'),
      fx('edge', { colorectalMethod: 'fit_annual', colorectalLastDate: monthsAgo(n), colorectalResult: 'normal' }), EDGE_NOW);
  }
  // A last date this month and next month: the mapping drops a "last done" date after this month.
  for (const n of [0, -1]) {
    add(`D m50 fit_annual last=${monthsAgo(n)} (${n}mo ago)`, profileOf('m50'), fx('future', { colorectalMethod: 'fit_annual', colorectalLastDate: monthsAgo(n) }));
  }
  setNow(GOLDEN_NOW);

  return {
    meta: { now: GOLDEN_NOW.toISOString(), edgeNow: EDGE_NOW.toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, cases: Object.keys(cases).length },
    constants: {
      SCREENING_MIN_AGE, SCREENING_INTERVALS, POST_FOLLOWUP_INTERVALS, SCREENING_FOLLOWUP_INFO, LUNG_PACK_YEARS,
      GROUP_COOLDOWNS, SCREENING_OPTIONS, SCREENING_LABELS,
    },
    eligibility: eligibilityGrid(),
    writes: writesTable(),
    cards: cardTable.table,
    groups: groupTable.table,
    forms: formTable.table,
    cases,
  };
}

/** isScreeningEligible over every age edge, both sexes and none: the ages it says yes to. */
function eligibilityGrid(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const type of [...Object.keys(SCREENING_MIN_AGE), 'unknown-type']) {
    out[type] = {};
    for (const [c, sex] of SEXES) {
      const yes = [undefined, ...AGES].filter((age) => isScreeningEligible(type, age, sex)).map((a) => a ?? 'no-age');
      out[type][c] = yes.join(' ');
    }
  }
  return out;
}

/** The answers each type's form asks, with every value they can take. */
const WRITE_KEYS: Record<string, Array<[string, string[]]>> = (() => {
  const vals = (opts: Array<{ value: string }>) => opts.map((o) => o.value);
  const O = SCREENING_OPTIONS;
  const chain = (type: string, methodKey: string, methods: string[], result = vals(O.result)): Array<[string, string[]]> => [
    [methodKey, methods], [`${type}_last_date`, ['', RECENT]], [`${type}_result`, result],
    [`${type}_followup_status`, vals(O.followup_status)], [`${type}_followup_date`, ['', FU_DONE]],
  ];
  return {
    colorectal: chain('colorectal', 'colorectal_method', vals(O.colorectal_method)),
    breast: chain('breast', 'breast_frequency', vals(O.breast_frequency)),
    cervical: chain('cervical', 'cervical_method', vals(O.cervical_method)),
    lung: [['lung_smoking_history', vals(O.lung_smoking_history)], ['lung_pack_years', ['', '19', '20']], ...chain('lung', 'lung_screening', vals(O.lung_screening))],
    prostate: [['prostate_discussion', vals(O.prostate_discussion)], ['prostate_last_date', ['', RECENT]]],
    endometrial: [['endometrial_discussion', vals(O.endometrial_discussion)], ['endometrial_abnormal_bleeding', vals(O.endometrial_abnormal_bleeding)]],
    dexa: chain('dexa', 'dexa_screening', vals(O.dexa_screening), vals(O.dexa_result)),
    colonoscopy: [...chain('colorectal', 'colorectal_method', vals(O.colorectal_method)), ['colorectal_followup_interval_years', ['', '3']]],
  };
})();

/**
 * screeningWrites for every fixture × its type's answers × every value. Only
 * the changes that write more than the answer itself are listed, as
 * "clear k1 k2"; an absent change writes the answer alone.
 */
function writesTable(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [type, list] of Object.entries(FIXTURES)) {
    for (const f of [fx('blank', {}), ...list, ALL_ANSWERED]) {
      const row: Record<string, string> = {};
      for (const [key, values] of WRITE_KEYS[type]) {
        for (const value of values) {
          const writes = screeningWrites(f.s, key, value);
          const [first, ...rest] = writes;
          const plain = first[0] === key && first[1] === value && rest.every(([, v]) => v === '');
          if (!plain) row[`${key}=${value}`] = JSON.stringify(writes);
          else if (rest.length) row[`${key}=${value}`] = `clear ${rest.map(([k]) => k).join(' ')}`;
        }
      }
      if (Object.keys(row).length) out[`${type} | ${f.name}`] = row;
    }
  }
  return out;
}
