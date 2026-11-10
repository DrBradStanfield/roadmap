import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SCREENING_GATES, SCREENING_RULES, inAges, postFollowupIntervals, screeningFollowupInfo, screeningIntervals,
  screeningKeys, screeningMinAge, screeningReminderCategories, screeningScheduleLabels,
  type ScreeningRule,
} from './screening-rules';
import { LUNG_PACK_YEARS, POST_FOLLOWUP_INTERVALS, SCREENING_FOLLOWUP_INFO, SCREENING_INTERVALS, SCREENING_MIN_AGE } from './types';
import { SCREENING_KEYS } from './validation';
import { REMINDER_CATEGORIES } from './reminders';
import { SCHEDULE_LABELS } from './reminder-schedule';
import { SUGGESTION_EVIDENCE } from './evidence';
import { SCREENING_OPTIONS, SCREENING_TEXT, dexaEligible } from './input-form';

// TEMPORARY (A2-1 step 2): the "each view equals today's constant" block dies in the PR that turns
// those constants into views of SCREENING_RULES; from then on the golden pin is the guard.
describe('US-06, US-07: A2-1 step 2, the screening-rules views equal today\'s constants (temporary)', () => {
  it('SCREENING_INTERVALS', () => expect(screeningIntervals()).toEqual(SCREENING_INTERVALS));
  it('POST_FOLLOWUP_INTERVALS', () => expect(postFollowupIntervals()).toEqual(POST_FOLLOWUP_INTERVALS));
  it('SCREENING_FOLLOWUP_INFO', () => expect(screeningFollowupInfo()).toEqual(SCREENING_FOLLOWUP_INFO));
  it('SCREENING_MIN_AGE', () => expect(screeningMinAge()).toEqual(SCREENING_MIN_AGE));
  it('SCREENING_KEYS, in order', () => expect(screeningKeys()).toEqual([...SCREENING_KEYS]));
  it('REMINDER_CATEGORIES, the screening part, in order', () => {
    expect(screeningReminderCategories()).toEqual(REMINDER_CATEGORIES.filter((c) => c.startsWith('screening_')));
  });
  it('SCHEDULE_LABELS, the screening part', () => {
    const today = Object.fromEntries(Object.entries(SCHEDULE_LABELS).filter(([c]) => c.startsWith('screening_')));
    expect(screeningScheduleLabels()).toEqual(today);
  });
});

describe('US-06: A2-1 step 2, the screening-rules table', () => {
  it('rows are pure data: a JSON round trip changes nothing', () => {
    expect(JSON.parse(JSON.stringify(SCREENING_RULES))).toEqual(SCREENING_RULES);
  });

  it('every evidenceKey exists in evidence.ts', () => {
    for (const r of SCREENING_RULES) expect(SUGGESTION_EVIDENCE[r.evidenceKey], r.id).toBeDefined();
  });

  it('option labels are the form\'s, verbatim (Select... aside)', () => {
    const form = SCREENING_OPTIONS as Record<string, ReadonlyArray<{ value: string; label: string }>>;
    const strip = (o: ReadonlyArray<{ value: string; label: string }>) => o.filter((x) => x.value).map(({ value, label }) => ({ value, label }));
    for (const r of SCREENING_RULES) {
      expect(r.choice.options.map(({ value, label }) => ({ value, label })), r.id).toEqual(strip(form[r.choice.key]));
      if (r.result) {
        const key = r.result.key === 'dexa_result' ? 'dexa_result' : 'result';
        expect(r.result.options.map(({ value, label }) => ({ value, label })), r.id).toEqual(strip(form[key]));
      }
    }
  });

  it('notes are SCREENING_TEXT, verbatim', () => {
    const texts = SCREENING_RULES.flatMap((r) => r.notes.flatMap((n) => ('text' in n ? [n.text] : [])));
    expect(texts).toEqual([SCREENING_TEXT.colorectalEarly, SCREENING_TEXT.colorectalIndividual, SCREENING_TEXT.cervicalStop]);
  });

  it('card text appears verbatim in the golden plan cards (placeholders aside)', () => {
    const golden = JSON.parse(readFileSync(`${__dirname}/screening-rules.golden.json`, 'utf8'));
    const cards = Object.values(golden.cards as Record<string, string>).join('\n');
    for (const r of SCREENING_RULES) {
      for (const card of Object.values(r.cards)) {
        if (!card || 'ref' in card) continue;
        for (const part of [card.title, ...card.description.split(/\{due\}|\{packYears\}/)]) {
          expect(cards.includes(part), `${r.id}: ${part}`).toBe(true);
        }
      }
    }
  });

  it('a flat interval key two rows give different months throws', () => {
    const [colorectal, , cervical] = SCREENING_RULES;
    const clash: ScreeningRule = { ...cervical, choice: { ...cervical.choice, options: [{ value: 'other', label: 'Other', months: 24 }] } };
    expect(() => screeningIntervals([colorectal, clash])).toThrow('screening interval collision: other');
  });

  it('inAges reads a sexed range as dexaEligible does, at every age', () => {
    const dexa = SCREENING_RULES.find((r) => r.id === 'dexa')!;
    for (let age = 0; age <= 110; age++) {
      for (const sex of ['female', 'male', undefined]) expect(inAges(dexa.cardAges, age, sex), `${age} ${sex}`).toBe(dexaEligible(age, sex));
    }
  });

  it('inAges is inclusive at both ends', () => {
    expect([34, 35, 75, 76].map((a) => inAges([35, 75], a, undefined))).toEqual([false, true, true, false]);
    expect(inAges([40], 120, 'female')).toBe(true);
  });

  it('the named gates', () => {
    const { lungSmoker, lungPackYears } = SCREENING_GATES;
    expect([undefined, 'never_smoked', 'former_smoker', 'current_smoker'].map((h) => lungSmoker({ lungSmokingHistory: h as never })))
      .toEqual([false, false, true, true]);
    expect([undefined, LUNG_PACK_YEARS - 1, LUNG_PACK_YEARS].map((p) => lungPackYears({ lungPackYears: p }))).toEqual([false, false, true]);
  });
});
