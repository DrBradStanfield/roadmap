import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SCREENING_REFS, SCREENING_RULES, inAges, postFollowupIntervals, screeningFollowupInfo, screeningIntervals,
  screeningKeys, screeningReminderCategories, BREAST_ANNUAL_OR_BIENNIAL_FROM, BREAST_RECOMMENDED_FROM,
  type Ages, type CardText, type ScreeningId, type ScreeningRule,
} from './screening-rules';
import { LUNG_PACK_YEARS, POST_FOLLOWUP_INTERVALS, SCREENING_FOLLOWUP_INFO, SCREENING_INTERVALS, SCREENING_MIN_AGE, type ScreeningInputs } from './types';
import { SCREENING_KEYS } from './validation';
import { REMINDER_CATEGORIES } from './reminders';
import { SCHEDULE_LABELS, computeReminderSchedule } from './reminder-schedule';
import { SUGGESTION_EVIDENCE } from './evidence';
import { SCREENING_TEXT, screeningForm } from './input-form';
import { generateSuggestions } from './suggestions';
import { createEmptyFile } from './roadmap-file';

// TEMPORARY (A2-1 step 2): the "each view equals today's constant" block dies in the PR that turns
// those constants into views of SCREENING_RULES; from then on the golden pin is the guard.
// Key order is behaviour: the golden's fixtures iterate POST_FOLLOWUP_INTERVALS and SCREENING_MIN_AGE
// (case order and ids) and serialize all four maps, so each view must keep today's order.
describe('US-06, US-07: A2-1 step 2, the screening-rules views equal today\'s constants (temporary)', () => {
  const same = (view: Record<string, unknown>, today: Record<string, unknown>) => {
    expect(view).toEqual(today);
    expect(Object.keys(view)).toEqual(Object.keys(today));
  };
  it('SCREENING_INTERVALS, in key order', () => same(screeningIntervals(), SCREENING_INTERVALS));
  it('SCREENING_FOLLOWUP_INFO, in key order', () => same(screeningFollowupInfo(), SCREENING_FOLLOWUP_INFO));
  it('SCREENING_KEYS, in order', () => expect(screeningKeys()).toEqual([...SCREENING_KEYS]));
  it('REMINDER_CATEGORIES, the screening part, in order', () => {
    expect(screeningReminderCategories()).toEqual(REMINDER_CATEGORIES.filter((c) => c.startsWith('screening_')));
  });
});

// A2-1 step 6: SCREENING_MIN_AGE (types.ts) and SCHEDULE_LABELS' screening part (reminder-schedule.ts)
// are views of the table now, so their old equality checks would compare the table with itself.
// These pins hold today's values, written out, in key order.
describe('US-06, US-23: the table\'s upload gate and reminder labels keep today\'s values', () => {
  it('SCREENING_MIN_AGE, in key order', () => {
    const today = {
      colorectal: { age: 35 },
      breast: { age: 40, sex: 'female' },
      cervical: { age: 25, sex: 'female' },
      lung: { age: 50 },
      prostate: { age: 45, sex: 'male' },
      dexa: { age: 50 },
    };
    expect(SCREENING_MIN_AGE).toEqual(today);
    expect(Object.keys(SCREENING_MIN_AGE)).toEqual(Object.keys(today));
  });
  // Change 2b made POST_FOLLOWUP_INTERVALS (types.ts) a view of the table too. Colorectal's 36 is now the
  // months used when the colonoscopy report gave no follow-up time (US-07 AC1j).
  it('POST_FOLLOWUP_INTERVALS, in key order', () => {
    const today = {
      colorectal_fit_annual: 36, colorectal_colonoscopy_10yr: 36, colorectal_other: 36,
      breast_annual: 12, breast_biennial: 24,
      cervical_hpv_every_5yr: 12, cervical_pap_every_3yr: 12, cervical_other: 12,
      lung_annual_ldct: 12, dexa_dexa_scan: 12,
    };
    expect(postFollowupIntervals()).toEqual(today);
    expect(Object.keys(POST_FOLLOWUP_INTERVALS)).toEqual(Object.keys(today));
    expect(POST_FOLLOWUP_INTERVALS).toEqual(today);
  });
  it('SCHEDULE_LABELS, in key order', () => {
    const today = {
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
      annual_checkin: ['Annual health check-in'],
    };
    expect(SCHEDULE_LABELS).toEqual(today);
    expect(Object.keys(SCHEDULE_LABELS)).toEqual(Object.keys(today));
  });
});

// A2-1 step 6: the breast 45 and 55 boundaries are named consts; the strings are today's, written out.
describe('US-06: breast screening\'s by-age text and start-card priority', () => {
  const OPTIONAL_CARD = 'Mammography is optional at your age (40\u201344). Discuss with your doctor.';
  const RECOMMENDED_CARD = 'Mammography is recommended at your age. Discuss with your doctor.';
  const NOTE_40 = 'Annual mammograms are optional at your age (40\u201344).';
  const NOTE_45 = 'Annual mammograms are recommended at your age (45\u201354).';
  const NOTE_55 = 'Annual or biennial mammograms are recommended at your age (55+).';
  it.each([
    [40, 'info', OPTIONAL_CARD, NOTE_40],
    [44, 'info', OPTIONAL_CARD, NOTE_40],
    [45, 'attention', RECOMMENDED_CARD, NOTE_45],
    [54, 'attention', RECOMMENDED_CARD, NOTE_45],
    [55, 'attention', RECOMMENDED_CARD, NOTE_55],
    [70, 'attention', RECOMMENDED_CARD, NOTE_55],
  ] as const)('at %i: priority %s, today\'s card and note text', (age, priority, description, note) => {
    expect(SCREENING_REFS.breastStart(age)).toEqual({ title: 'Start breast cancer screening', priority, description });
    expect(SCREENING_REFS.breastByAge(age)).toBe(note);
  });
  it('the plan\'s not-started breast card takes that priority, 44 then 45', () => {
    const card = (age: number) => generateSuggestions({ sex: 'female' } as never, { age } as never, 'si', undefined, {})
      .find((c) => c.id === 'screening-breast');
    expect([card(44)?.priority, card(45)?.priority]).toEqual(['info', 'attention']);
    expect([card(44)?.description, card(45)?.description]).toEqual([OPTIONAL_CARD, RECOMMENDED_CARD]);
    expect([BREAST_RECOMMENDED_FROM, BREAST_ANNUAL_OR_BIENNIAL_FROM]).toEqual([45, 55]);
  });
});

const rule = (id: ScreeningId) => SCREENING_RULES.find((r) => r.id === id)!;
const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const SEXES = ['male', 'female', undefined] as const;
const AGES = Array.from({ length: 111 }, (_, i) => i);
/** Whether a row's ages, with its sex, take this person. */
const takes = (r: ScreeningRule, ages: Ages, age: number, sex: string | undefined) => (!r.sex || r.sex === sex) && inAges(ages, age, sex);
const gatesPass = (r: ScreeningRule, s: ScreeningInputs) => (r.extraGates ?? []).every((g) => SCREENING_REFS[g](s));
/** The plan's screening card ids (suggestions.ts), for one person. */
const cardIds = (age: number, sex: string | undefined, s: ScreeningInputs) =>
  generateSuggestions({ sex } as never, { age } as never, 'si', undefined, s).map((c) => c.id).filter((id) => id.startsWith('screening-'));
/** The reminder schedule's categories (reminder-schedule.ts), for one person on 1 Oct 2026. */
const REMINDER_NOW = new Date('2026-10-01T12:00:00Z');
const reminderCategories = (age: number, sex: 'male' | 'female' | undefined, s: ScreeningInputs) => {
  const file = createEmptyFile({ deviceId: 'rules-test', now: '2026-09-01T00:00:00Z' });
  file.profile = { ...file.profile, birthYear: 2026 - age, birthMonth: 1, ...(sex ? { sex } : {}) };
  file.screenings = { ...file.screenings, ...s };
  return computeReminderSchedule(file, REMINDER_NOW).map((i) => i.category);
};
/** The first option that is not "not started": a method with an interval when the row has one. */
const startedValue = (r: ScreeningRule) =>
  (r.choice.options.find((o) => o.months !== undefined) ?? r.choice.options.find((o) => o.value !== r.notStarted))!.value;
/** Every row started a long time ago (so a reminder is due), its date set. */
const ALL_STARTED: ScreeningInputs = Object.assign({}, ...SCREENING_RULES.map((r) => ({
  [camel(r.choice.key)]: startedValue(r), ...(r.dateKey ? { [camel(r.dateKey)]: '2015-01' } : {}),
})));
/** The lung gate inputs, every combination that matters. */
const LUNG_GATES: ScreeningInputs[] = [undefined, 'never_smoked', 'former_smoker', 'current_smoker'].flatMap((h) =>
  [undefined, LUNG_PACK_YEARS - 1, LUNG_PACK_YEARS].map((p) => ({ lungSmokingHistory: h as never, lungPackYears: p })));
const PASSING: ScreeningInputs = { lungSmokingHistory: 'former_smoker', lungPackYears: 25 };

describe('US-06, US-07: A2-1 step 2, every row\'s ages, sex and gates match the code', () => {
  it('groupAges and section: the form shows the group exactly there (input-form.ts screeningForm)', () => {
    for (const age of AGES) for (const sex of SEXES) {
      const groups = screeningForm(age, sex, {}).flatMap((sec) => sec.groups.map((g) => ({ section: sec.id, ...g })));
      for (const r of SCREENING_RULES) {
        const g = groups.find((x) => x.id === r.id);
        expect(!!g, `${r.id} ${age} ${sex}`).toBe(takes(r, r.groupAges, age, sex));
        if (g) expect(g.section, r.id).toBe(r.section);
      }
    }
  });

  it('askAges: the group asks questions exactly there (screeningForm, no answers yet)', () => {
    for (const age of AGES) for (const sex of SEXES) {
      const groups = screeningForm(age, sex, {}).flatMap((sec) => sec.groups);
      for (const r of SCREENING_RULES) {
        const asked = (groups.find((x) => x.id === r.id)?.fields.length ?? 0) > 0;
        expect(asked, `${r.id} ${age} ${sex}`).toBe(takes(r, r.askAges, age, sex));
      }
    }
  });

  it('cardAges, sex and extraGates: the plan\'s start card shows exactly there (suggestions.ts)', () => {
    for (const age of AGES) for (const sex of SEXES) for (const s of LUNG_GATES) {
      const ids = cardIds(age, sex, s);
      for (const r of SCREENING_RULES) {
        expect(ids.includes(`screening-${r.id}`), `${r.id} ${age} ${sex} ${JSON.stringify(s)}`).toBe(takes(r, r.cardAges, age, sex) && gatesPass(r, s));
      }
    }
  });

  it('cardAges, sex and extraGates: the overdue card and the reminder apply exactly there (suggestions.ts, reminder-schedule.ts)', () => {
    for (const age of AGES) for (const sex of SEXES) for (const gates of [PASSING, { lungSmokingHistory: 'never_smoked' as const, lungPackYears: 25 }, { lungSmokingHistory: 'current_smoker' as const, lungPackYears: LUNG_PACK_YEARS - 1 }]) {
      const s = { ...ALL_STARTED, ...gates };
      const ids = cardIds(age, sex, s);
      const reminders = reminderCategories(age, sex, s);
      for (const r of SCREENING_RULES) {
        const want = takes(r, r.cardAges, age, sex) && gatesPass(r, s);
        const at = `${r.id} ${age} ${sex} ${JSON.stringify(gates)}`;
        if (r.cards.overdue) expect(ids.includes(`screening-${r.id}-overdue`), at).toBe(want);
        if (r.reminder) expect(reminders.includes(r.reminder.category), at).toBe(want);
      }
    }
  });

  it('followupIgnoresUpperAge: past the upper age, an open follow-up keeps its card and reminder only where set', () => {
    for (const r of SCREENING_RULES) {
      const range = 'female' in r.cardAges ? undefined : r.cardAges;
      if (!range || range[1] === undefined || !r.result || !r.dateKey) {
        expect(r.followupIgnoresUpperAge, `${r.id}: the flag needs an upper age`).toBe(false);
        continue;
      }
      const abnormal = r.result.options.find((o) => o.followup)!.value;
      const s = { ...PASSING, lungPackYears: 5, [camel(r.choice.key)]: startedValue(r), [camel(r.dateKey)]: '2026-04', [camel(r.result.key)]: abnormal, [`${r.id}FollowupStatus`]: 'not_organized' };
      // Inside the range the card shows for every row, so a fixture that never opens it fails here.
      expect(cardIds(range[1], r.sex, s).includes(`screening-${r.id}-followup`), `${r.id} ${range[1]}: inside the range`).toBe(true);
      for (const age of [range[1] + 1, range[1] + 10]) {
        expect(cardIds(age, r.sex, s).includes(`screening-${r.id}-followup`), `${r.id} ${age}`).toBe(r.followupIgnoresUpperAge);
        if (r.reminder) expect(reminderCategories(age, r.sex, s).includes(r.reminder.category), `${r.id} ${age}`).toBe(r.followupIgnoresUpperAge);
      }
    }
  });

  it('notStarted: that answer gets the start card and no reminder; the first started answer does not', () => {
    for (const r of SCREENING_RULES) {
      const range = 'female' in r.cardAges ? r.cardAges.female : r.cardAges;
      const sex = r.sex ?? ('female' in r.cardAges ? 'female' : undefined);
      const age = range[0];
      const with_ = (value: string) => ({ ...PASSING, [camel(r.choice.key)]: value, ...(r.dateKey ? { [camel(r.dateKey)]: '2015-01' } : {}) });
      expect(cardIds(age, sex, with_(r.notStarted)), r.id).toContain(`screening-${r.id}`);
      expect(cardIds(age, sex, with_(startedValue(r))), r.id).not.toContain(`screening-${r.id}`);
      if (r.reminder) expect(reminderCategories(age, sex, with_(r.notStarted)), r.id).not.toContain(r.reminder.category);
    }
  });

  it('each row\'s evidenceKey, by name (a swap fails)', () => {
    expect(Object.fromEntries(SCREENING_RULES.map((r) => [r.id, r.evidenceKey]))).toEqual({
      colorectal: 'screening-colorectal', breast: 'screening-breast', cervical: 'screening-cervical', lung: 'screening-lung',
      prostate: 'screening-prostate', endometrial: 'screening-endometrial', dexa: 'screening-dexa',
    });
    for (const r of SCREENING_RULES) expect(SUGGESTION_EVIDENCE[r.evidenceKey], r.id).toBeDefined();
  });
});

describe('US-06: A2-1 step 2, the screening-rules table', () => {
  it('rows are pure data: a JSON round trip changes nothing', () => {
    expect(JSON.parse(JSON.stringify(SCREENING_RULES))).toEqual(SCREENING_RULES);
  });

  // The option labels and the fixed notes have no second copy since step 3: SCREENING_OPTIONS and
  // SCREENING_TEXT read them from the table. The golden pin (screening-rules.golden.json: constants
  // and forms, every option and note) is their guard.

  it('every fixed note has text (input-form.ts noteText gives \'\' for a missing note)', () => {
    for (const t of Object.values(SCREENING_TEXT)) if (typeof t === 'string') expect(t.trim(), 'SCREENING_TEXT note').not.toBe('');
    expect(Object.values(SCREENING_TEXT).filter((t) => typeof t === 'string').length).toBeGreaterThan(0);
  });

  /** A routine card, and colorectal's with the FIT line from 55 (US-07 AC1h). */
  const withFitLine = (r: ScreeningRule, c: CardText) => (r.id === 'colorectal' ? [c, SCREENING_REFS.colorectalStatus(c, 55, 'fit_annual')] : [c]);

  it('each row\'s whole card template matches that row\'s golden cards, title and description', () => {
    const golden = Object.values(JSON.parse(readFileSync(`${__dirname}/screening-rules.golden.json`, 'utf8')).cards as Record<string, string>);
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = (c: CardText) => esc(`${c.title} :: ${c.description}`).replace(/\\\{due\\\}/g, '[A-Z][a-z]{2} \\d{4}').replace(/\\\{packYears\\\}/g, '\\d+');
    for (const r of SCREENING_RULES) {
      const kinds: Array<[string, readonly CardText[]]> = [
        ['', 'ref' in r.cards.start ? [35, 45, 55].map(SCREENING_REFS[r.cards.start.ref]) : [r.cards.start]],
        ['-overdue', r.cards.overdue ? withFitLine(r, r.cards.overdue) : []],
        ['-upcoming', r.cards.upToDate ? withFitLine(r, r.cards.upToDate) : []],
      ];
      for (const [suffix, texts] of kinds) {
        const id = `screening-${r.id}${suffix}`;
        const lines = golden.filter((l) => l.startsWith(`${id} [`));
        expect(lines.length > 0, `${id}: in the golden`).toBe(texts.length > 0);
        const re = new RegExp(`^${esc(id)} \\[\\w+\\] (${texts.map(pattern).join('|')})$`);
        for (const l of lines) expect(l, id).toMatch(re);
      }
    }
  });

  it('no two rows give one flat interval key different months (the view itself never throws)', () => {
    const seen = new Map<string, number>();
    for (const r of SCREENING_RULES) {
      for (const o of r.choice.options) {
        if (o.months === undefined) continue;
        expect(seen.get(o.value) ?? o.months, `${r.id} ${o.value}`).toBe(o.months);
        seen.set(o.value, o.months);
      }
    }
    const [colorectal, , cervical] = SCREENING_RULES;
    if (cervical.followupBy !== 'choice') throw new Error('cervical keys its follow-up by method');
    const clash: ScreeningRule = { ...cervical, choice: { ...cervical.choice, options: [{ value: 'other', label: 'Other', months: 24 }] } };
    expect(screeningIntervals([colorectal, clash]).other).toBe(12);
  });

  it('a row states its follow-up one way only (the type refuses both)', () => {
    const dexa = rule('dexa');
    const colorectal = rule('colorectal');
    if (dexa.followupBy !== 'result' || colorectal.followupBy !== 'choice') throw new Error('DEXA keys by result, colorectal by method');
    const fu = { name: 'n', abnormalMeans: 'm' };
    // @ts-expect-error a result-keyed row's methods carry no follow-up
    const a: ScreeningRule = { ...dexa, choice: { key: 'k', options: [{ value: 'v', label: 'V', postMonths: 12, followup: fu }] } };
    // @ts-expect-error a method-keyed row's results carry no follow-up interval
    const b: ScreeningRule = { ...colorectal, result: { key: 'k', options: [{ value: 'abnormal', label: 'A', followup: true, postMonths: 12 }] } };
    // @ts-expect-error a method's follow-up comes with its interval
    const c: ScreeningRule = { ...colorectal, choice: { key: 'k', options: [{ value: 'v', label: 'V', followup: fu }] } };
    expect([a, b, c]).toHaveLength(3);
  });

  it('inAges is inclusive at both ends, and a sexed range needs a sex', () => {
    expect([34, 35, 75, 76].map((a) => inAges([35, 75], a, undefined))).toEqual([false, true, true, false]);
    expect(inAges([40], 120, 'female')).toBe(true);
    expect(inAges({ female: [50], male: [70] }, 90, undefined)).toBe(false);
  });
});

describe('US-06: A2-1 step 2, SCREENING_REFS match the code they name', () => {
  it('the gates', () => {
    const { lungSmoker, lungPackYears } = SCREENING_REFS;
    expect([undefined, 'never_smoked', 'former_smoker', 'current_smoker'].map((h) => lungSmoker({ lungSmokingHistory: h as never })))
      .toEqual([false, false, true, true]);
    expect([undefined, LUNG_PACK_YEARS - 1, LUNG_PACK_YEARS].map((p) => lungPackYears({ lungPackYears: p }))).toEqual([false, false, true]);
  });

  // breastByAge, prostateByAge (the form, step 3) and breastStart (the plan card, step 4) have no
  // second copy left to compare with: SCREENING_TEXT and suggestions.ts read them from here. The
  // golden pin (screening-rules.golden.json: forms, groups, cards) is their guard.
});
