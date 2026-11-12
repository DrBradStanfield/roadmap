// US-07 AC1j (screening Change 2b, Brad 2026-11-12): after an abnormal colorectal result, once the
// colonoscopy is done, the person is on a colonoscopy schedule. The next is due at the follow-up time
// the colonoscopy report gave (whole years, 1 to 10, once), counted from the colonoscopy date, else
// 3 years (Dr Brad's recommendation). Completed with no usable date: a card asks for it, and no reminder.
//
// The expected words are read from the approved spec, docs/drafts/screening-change-2b-words-2026-11-12.md.
// A mismatch goes back to Brad; the words are never reworded here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSuggestions } from './suggestions';
import { SUGGESTION_EVIDENCE } from './evidence';
import { screeningForm, screeningWrites } from './input-form';
import { computeNextDueDates } from './reminder-schedule';
import { screeningsToInputs } from './mappings';
import { mergeFiles } from './merge';
import { computePlan, derivePlanInputs } from './plan';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';
import { setScreening } from './state-edits';
import { SCREENING_KEYS } from './validation';
import type { HealthResults, ScreeningInputs } from './types';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SPEC = read('docs/drafts/screening-change-2b-words-2026-11-12.md').split('\n').map((l) => l.trim());
const HTML = read('roadmap_text.html');
const ALGO = read('health_roadmap_algorithm.md');

/** The first line starting with `prefix` at or after the line starting with `header`. */
function specLine(header: string, prefix: string): string {
  const from = SPEC.findIndex((l) => l.startsWith(header));
  const line = from < 0 ? undefined : SPEC.slice(from).find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`spec line not found: ${header} / ${prefix}`);
  return line;
}
const quotes = (line: string) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);

const [A_TITLE, A_TEXT] = quotes(specLine('## Cards', '- A,'));
const [B_TITLE, B_TEXT] = quotes(specLine('## Cards', '- B,'));
const [C_TITLE, C_TEXT] = quotes(specLine('## Cards', '- C and E,'));
const [D_TITLE, D_TEXT] = quotes(specLine('## Cards', '- D,'));
const QUESTION = quotes(specLine('## Form', '- Question'))[0];
// The labels the line lists, before its "Stored value" sentence.
const ANSWERS = quotes(specLine('## The other texts', '1. **Answer labels:**').split('Stored value')[0]);
const ITEM = (prefix: string) => quotes(specLine('## The other texts', prefix));

const NOW = new Date('2026-11-12T12:00:00Z');
const METHODS = ['fit_annual', 'colonoscopy_10yr', 'other'] as const;
type Method = (typeof METHODS)[number];

function plan(scr: ScreeningInputs, age = 60) {
  const results: HealthResults = { heightCm: 175, idealBodyWeight: 73.8, proteinTarget: 89, age, suggestions: [] };
  return generateSuggestions({ heightCm: 175, sex: 'male' }, results, 'si', {}, scr, undefined, NOW)
    .filter((s) => s.id.startsWith('screening-colorectal'));
}
const due = (scr: ScreeningInputs, age = 60) =>
  computeNextDueDates({ sex: 'male', age }, scr, {}, []).find((i) => i.category === 'screening_colorectal');

/** An abnormal result on this method, its follow-up completed (with the given date and interval). */
const done = (method: Method, date?: string, years?: number): ScreeningInputs => ({
  colorectalMethod: method, colorectalLastDate: '2025-01', colorectalResult: 'abnormal', colorectalFollowupStatus: 'completed',
  ...(date === undefined ? {} : { colorectalFollowupDate: date }), ...(years === undefined ? {} : { colorectalFollowupIntervalYears: years }),
});
/** The same, its abnormal screening in 2019, before a colonoscopy dated earlier than done()'s 2025-01: a last screening
 *  later than the colonoscopy starts the follow-up again (US-07 AC1j, Brad 2026-11-12; screening-colonoscopy-reopen.test.ts). */
const doneEarly = (method: Method, date?: string, years?: number): ScreeningInputs => ({ ...done(method, date, years), colorectalLastDate: '2019-06' });
const card = (title: string, priority: string, description: string) =>
  [expect.objectContaining({ id: 'screening-colorectal-followup', category: 'screening', priority, title, description })];

describe('US-07 AC1j: the spec words this file checks are read (guard: a parse miss would pass vacuously)', () => {
  it('reads each card, the question and the answer labels', () => {
    expect([A_TITLE, B_TITLE, C_TITLE, D_TITLE]).toEqual(['Add your colonoscopy date', 'Colorectal screening up to date', 'Colonoscopy overdue', 'Colorectal screening up to date']);
    for (const t of [A_TEXT, B_TEXT, C_TEXT, D_TEXT]) expect(t.length).toBeGreaterThan(40);
    expect(QUESTION).toBe('Did the colonoscopy report give a follow-up time?');
    expect(ANSWERS).toEqual(['Not given', '1 year', '2 years', '3 years', '10 years']);
  });
});

describe('US-07 AC1j: the trigger table, row by row, on every colorectal method at 60', () => {
  it.each(METHODS)('%s: not organised and scheduled are unchanged', (method) => {
    const name = { fit_annual: 'colonoscopy', colonoscopy_10yr: 'repeat colonoscopy', other: 'follow-up investigation' }[method];
    const base = { ...done(method), colorectalFollowupStatus: undefined };
    expect(plan({ ...base, colorectalFollowupStatus: 'not_organized' })).toEqual(card(`Organize ${name}`, 'urgent', expect.stringContaining(`Please organize a ${name} with your doctor.`)));
    expect(plan({ ...base, colorectalFollowupStatus: 'scheduled', colorectalFollowupDate: '2027-02' }))
      .toEqual(card('Colorectal follow-up scheduled', 'info', `Your ${name} is scheduled. Keep your appointment.`));
  });

  it.each(METHODS)('%s: A, completed with no usable date, asks for it (attention), never the routine card', (method) => {
    for (const date of [undefined, '', '2026', 'soon']) {
      expect(plan(done(method, date)), String(date)).toEqual(card(A_TITLE, 'attention', A_TEXT));
    }
  });

  it.each(METHODS)('%s: B, dated with no follow-up time, not yet due: 3 years on, at info', (method) => {
    expect(plan(done(method, '2025-06'))).toEqual(card(B_TITLE, 'info', B_TEXT.replace('{due}', 'Jun 2028')));
  });

  it.each(METHODS)('%s: C, dated with no follow-up time, overdue (attention)', (method) => {
    expect(plan(doneEarly(method, '2023-01'))).toEqual(card(C_TITLE, 'attention', C_TEXT.replace('{due}', 'Jan 2026')));
  });

  it.each(METHODS)('%s: D, the report\'s follow-up time, not yet due: 1, 3 and 10 years on (info)', (method) => {
    expect(plan(done(method, '2026-06', 1))).toEqual(card(D_TITLE, 'info', D_TEXT.replace('{due}', 'Jun 2027')));
    expect(plan(done(method, '2025-06', 3))).toEqual(card(D_TITLE, 'info', D_TEXT.replace('{due}', 'Jun 2028')));
    expect(plan(done(method, '2025-06', 10))).toEqual(card(D_TITLE, 'info', D_TEXT.replace('{due}', 'Jun 2035')));
  });

  it.each(METHODS)('%s: E, the report\'s follow-up time, overdue (attention), counted once from the colonoscopy', (method) => {
    expect(plan(done(method, '2025-06', 1))).toEqual(card(C_TITLE, 'attention', C_TEXT.replace('{due}', 'Jun 2026')));
    expect(plan(doneEarly(method, '2020-01', 5))).toEqual(card(C_TITLE, 'attention', C_TEXT.replace('{due}', 'Jan 2025')));
  });

  it('due this month is overdue, as the other follow-up cards count it', () => {
    expect(plan(doneEarly('fit_annual', '2023-11'))).toEqual(card(C_TITLE, 'attention', C_TEXT.replace('{due}', 'Nov 2026')));
    expect(plan(doneEarly('fit_annual', '2023-12'))).toEqual(card(B_TITLE, 'info', B_TEXT.replace('{due}', 'Dec 2026')));
  });

  it('a leftover follow-up time is ignored while the parent gate is closed (an older engine never cleared it)', () => {
    const left = done('fit_annual', '2026-06', 1);
    expect(plan({ ...left, colorectalFollowupStatus: 'scheduled' })[0].title).toBe('Colorectal follow-up scheduled');
    expect(plan({ ...left, colorectalFollowupStatus: 'not_organized' })[0].title).toBe('Organize colonoscopy');
    // A normal result: the routine FIT card, a year from the last screening.
    expect(plan({ ...left, colorectalResult: 'normal' })).toEqual([expect.objectContaining({ id: 'screening-colorectal-overdue', title: 'Colorectal screening overdue' })]);
    expect(due({ ...left, colorectalResult: 'normal' })?.dueAt).toBe('2026-01-01');
    expect(due({ ...left, colorectalFollowupStatus: 'scheduled' })?.dueAt).toBe('2025-04-01');
  });

  it('no card without a last screening date, as before', () => {
    expect(plan({ ...done('fit_annual', '2025-06', 3), colorectalLastDate: undefined })).toEqual([]);
  });

  it.each(METHODS)('%s: A takes every completed case with no usable date at 35, 60 and 75, alone among the colorectal cards', (method) => {
    for (const age of [35, 60, 75]) {
      for (const date of [undefined, '', '2026', 'soon']) {
        const cards = plan(done(method, date), age);
        expect(cards.map((c) => `${c.id} ${c.title}`), `${age} ${String(date)}`).toEqual([`screening-colorectal-followup ${A_TITLE}`]);
        expect(cards, `${age} ${String(date)}`).toEqual(card(A_TITLE, 'attention', A_TEXT));
      }
    }
  });

  it('abnormal, completed, no colonoscopy date and no last screening date: never the routine card', () => {
    const scr = { ...done('fit_annual'), colorectalLastDate: undefined };
    const viaRecord = computePlan(fileWith(scr), NOW).results.suggestions.filter((s) => s.id.startsWith('screening-colorectal'));
    for (const cards of [plan(scr), viaRecord]) {
      expect(cards.map((c) => c.id)).not.toContain('screening-colorectal-upcoming');
      expect(cards.map((c) => c.id)).not.toContain('screening-colorectal-overdue');
      for (const c of cards) expect(c.description).not.toMatch(/Next screening due/);
    }
  });

  it.todo('age 80: the schedule past 75 (Q5) — waits on the orchestrator: the colorectal card, reminder and questions stop at 75 today');
});

describe('US-07 AC1j: colorectal only; the other screenings\' follow-ups do not move', () => {
  it('breast and cervical, completed with no date, still fall back to their routine card', () => {
    const results: HealthResults = { heightCm: 165, idealBodyWeight: 60, proteinTarget: 80, age: 50, suggestions: [] };
    const cards = generateSuggestions({ heightCm: 165, sex: 'female' }, results, 'si', {}, {
      breastFrequency: 'annual', breastLastDate: '2026-03', breastResult: 'abnormal', breastFollowupStatus: 'completed',
      cervicalMethod: 'hpv_every_5yr', cervicalLastDate: '2024-03', cervicalResult: 'abnormal', cervicalFollowupStatus: 'completed',
    }, undefined, NOW).filter((s) => /^screening-(breast|cervical)/.test(s.id)).map((s) => `${s.id} ${s.title}`);
    expect(cards).toEqual(['screening-breast-upcoming Mammogram up to date', 'screening-cervical-upcoming Cervical screening up to date']);
  });

  it('a completed, dated breast follow-up keeps its own words and interval', () => {
    const results: HealthResults = { heightCm: 165, idealBodyWeight: 60, proteinTarget: 80, age: 50, suggestions: [] };
    const [c] = generateSuggestions({ heightCm: 165, sex: 'female' }, results, 'si', {}, {
      breastFrequency: 'annual', breastLastDate: '2026-03', breastResult: 'abnormal', breastFollowupStatus: 'completed', breastFollowupDate: '2026-04',
    }, undefined, NOW).filter((s) => s.id.startsWith('screening-breast'));
    expect(c.description).toBe('Following your abnormal mammogram, next screening due Apr 2027.');
  });
});

describe('US-07 AC1j: reminders', () => {
  it.each(METHODS)('%s: no reminder while the colonoscopy date is missing', (method) => {
    for (const date of [undefined, '', '2026']) expect(due(done(method, date)), String(date)).toBeUndefined();
  });

  it.each(METHODS)('%s: the colonoscopy date + the report\'s years, else + 3 years; never the routine date', (method) => {
    expect(due(done(method, '2025-06'))?.dueAt).toBe('2028-06-01');
    expect(due(done(method, '2026-06', 1))?.dueAt).toBe('2027-06-01');
    expect(due(done(method, '2025-06', 3))?.dueAt).toBe('2028-06-01');
    expect(due(done(method, '2025-06', 10))?.dueAt).toBe('2035-06-01');
    expect(due(doneEarly(method, '2020-01', 5))?.dueAt).toBe('2025-01-01');
  });
});

describe('US-07 AC1j: the form question (shared by the web and the iPhone)', () => {
  const colorectal = (scr: ScreeningInputs) =>
    screeningForm(60, 'male', scr).flatMap((s) => s.groups).find((g) => g.id === 'colorectal')!.fields;
  const keys = (scr: ScreeningInputs) => colorectal(scr).map((f) => ('key' in f ? f.key : ''));

  it('shows only while the result is abnormal and the follow-up completed, after the date, with the approved words', () => {
    const fields = colorectal(done('fit_annual'));
    expect(keys(done('fit_annual')).slice(-2)).toEqual(['colorectal_followup_date', 'colorectal_followup_interval_years']);
    const q = fields.at(-1)!;
    expect(q).toMatchObject({ kind: 'choice', label: QUESTION, value: '' });
    if (q.kind !== 'choice') throw new Error('not a choice');
    expect(q.options).toEqual([
      { value: '', label: 'Not given' },
      ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: i === 0 ? '1 year' : `${i + 1} years` })),
    ]);
    expect(q.options.filter((o) => ANSWERS.includes(o.label)).map((o) => o.label)).toEqual(ANSWERS);
    expect(colorectal(done('colonoscopy_10yr', '2025-06', 4)).at(-1)).toMatchObject({ value: '4' });
    for (const s of [
      { ...done('fit_annual'), colorectalFollowupStatus: 'scheduled' as const },
      { ...done('fit_annual'), colorectalFollowupStatus: 'not_organized' as const },
      { ...done('fit_annual'), colorectalResult: 'normal' as const },
    ]) expect(keys(s), JSON.stringify(s)).not.toContain('colorectal_followup_interval_years');
  });

  it('the key is a screening key, after the follow-up date (the result chain)', () => {
    const i = SCREENING_KEYS.indexOf('colorectal_followup_interval_years');
    expect(SCREENING_KEYS[i - 1]).toBe('colorectal_followup_date');
  });
});

describe('US-07 AC1j: the clears (the new engine clears what an older one kept)', () => {
  const on = done('fit_annual', '2025-06', 5);
  const clears = (key: string, value: string) => screeningWrites(on, key, value).slice(1).map(([k]) => k);
  const I = 'colorectal_followup_interval_years';

  it('a result that is not abnormal clears it', () => {
    for (const v of ['normal', 'awaiting', '']) expect(clears('colorectal_result', v), v).toContain(I);
    expect(clears('colorectal_result', 'abnormal')).toEqual([]);
  });

  it('a status that is not completed clears it; completed keeps it', () => {
    for (const v of ['scheduled', 'not_organized', '']) expect(clears('colorectal_followup_status', v), v).toContain(I);
    expect(clears('colorectal_followup_status', 'scheduled')).toEqual([I]);
    expect(clears('colorectal_followup_status', 'completed')).toEqual([]);
  });

  it('a new method clears it; the same method does not; not yet started clears the whole chain', () => {
    expect(clears('colorectal_method', 'colonoscopy_10yr')).toEqual([I]);
    expect(clears('colorectal_method', 'other')).toEqual([I]);
    expect(clears('colorectal_method', 'fit_annual')).toEqual([]);
    expect(clears('colorectal_method', 'not_yet_started')).toEqual(['colorectal_last_date', 'colorectal_result', 'colorectal_followup_status', 'colorectal_followup_date', I]);
  });

  it('a new colonoscopy date keeps it', () => {
    expect(clears('colorectal_followup_date', '2025-08')).toEqual([]);
  });

  it('applied to the file, a clear leaves the field null and the plan reads none', () => {
    let file = fileWith(on);
    for (const [k, v] of screeningWrites(on, 'colorectal_followup_status', 'scheduled')) file = setScreening(file, k, v, '2026-11-12T00:00:00Z');
    expect(file.screenings.colorectalFollowupIntervalYears ?? null).toBeNull();
  });
});

function fileWith(scr: ScreeningInputs, deviceId = 'c2b_test', now = '2026-11-01T00:00:00Z'): RoadmapFile {
  const f = createEmptyFile({ deviceId, now });
  return {
    ...f,
    profile: { ...f.profile, sex: 'male', heightCm: 175, birthYear: 1966, birthMonth: 1 } as RoadmapFile['profile'],
    screenings: { ...f.screenings, ...scr } as RoadmapFile['screenings'],
  };
}

describe('US-07 AC1j: the stored value is a whole number of years, 1 to 10', () => {
  const read = (value: string) => screeningsToInputs([{ screeningKey: 'colorectal_followup_interval_years', value }]).colorectalFollowupIntervalYears;

  it('reads 1 to 10 as numbers', () => {
    for (let n = 1; n <= 10; n++) expect(read(String(n))).toBe(n);
  });

  it('drops 0, 11, 2.5, negative, text and blanks', () => {
    for (const v of ['0', '11', '2.5', '-3', '3 years', 'three', '', ' ', '1e1', '0x3', '03.0']) expect(read(v), v).toBeUndefined();
  });

  it('setScreening stores the answer as a number, and "Not given" (blank) as null', () => {
    const file = setScreening(fileWith(done('fit_annual', '2025-06')), 'colorectal_followup_interval_years', '3', '2026-11-12T00:00:00Z');
    expect(file.screenings.colorectalFollowupIntervalYears).toBe(3);
    const cleared = setScreening(file, 'colorectal_followup_interval_years', '', '2026-11-12T01:00:00Z');
    expect(cleared.screenings.colorectalFollowupIntervalYears).toBeNull();
    expect(derivePlanInputs(cleared).screenings.colorectalFollowupIntervalYears).toBeUndefined();
  });

  it('a stored 0, 11 or 2.5 is dropped when the record is read: the plan gives the 3-year card', () => {
    for (const bad of [0, 11, 2.5]) {
      const file = fileWith(done('fit_annual', '2025-06', bad));
      const cards = computePlan(file, NOW).results.suggestions.filter((s) => s.id === 'screening-colorectal-followup');
      expect(cards.map((c) => c.description), String(bad)).toEqual([B_TEXT.replace('{due}', 'Jun 2028')]);
    }
  });

  const recordCards = (stored: unknown) => {
    const file = fileWith(done('fit_annual', '2025-06'));
    file.screenings.colorectalFollowupIntervalYears = stored as any;
    return computePlan(file, NOW).results.suggestions.filter((s) => s.id.startsWith('screening-colorectal')).map((c) => c.description);
  };

  it('a stored string "3" is read through the record: card D, due 3 years on', () => {
    expect(recordCards('3')).toEqual([D_TEXT.replace('{due}', 'Jun 2028')]);
  });

  it.each([0, 11, 2.5, '3 years'])('a stored %j is dropped through the record: card B, the 3-year default', (bad) => {
    expect(recordCards(bad), String(bad)).toEqual([B_TEXT.replace('{due}', 'Jun 2028')]);
  });

  it('the record path reads a stored 5 into the plan and the reminder', () => {
    const file = fileWith(done('colonoscopy_10yr', '2025-06', 5));
    const cards = computePlan(file, NOW).results.suggestions.filter((s) => s.id === 'screening-colorectal-followup');
    expect(cards.map((c) => c.description)).toEqual([D_TEXT.replace('{due}', 'Jun 2030')]);
  });
});

describe('US-07 AC1j, US-10 AC6: two devices merge the new field field by field (LWW by fieldStamps)', () => {
  const base = fileWith(done('fit_annual', '2025-06'), 'dev_base', '2026-10-01T00:00:00Z');
  // Device A (this engine) answers the follow-up time; device B later answers another screening question.
  const a = setScreening(base, 'colorectal_followup_interval_years', '5', '2026-11-01T09:00:00Z');
  const b = setScreening(base, 'lung_smoking_history', 'never_smoked', '2026-11-02T09:00:00Z');

  it.each([['A then B', a, b], ['B then A', b, a]] as const)('%s: both answers are kept', (_, x, y) => {
    const merged = mergeFiles(x, y, { deviceId: 'dev_merge', now: '2026-11-03T00:00:00Z' });
    expect(merged.screenings.colorectalFollowupIntervalYears).toBe(5);
    expect(merged.screenings.lungSmokingHistory).toBe('never_smoked');
    expect(derivePlanInputs(merged).screenings.colorectalFollowupIntervalYears).toBe(5);
  });

  it('the later change to the same field wins, both ways', () => {
    const later = setScreening(a, 'colorectal_followup_interval_years', '2', '2026-11-04T09:00:00Z');
    for (const merged of [mergeFiles(later, a, { deviceId: 'm', now: '2026-11-05T00:00:00Z' }), mergeFiles(a, later, { deviceId: 'm', now: '2026-11-05T00:00:00Z' })]) {
      expect(merged.screenings.colorectalFollowupIntervalYears).toBe(2);
    }
  });
});

describe('US-07 AC1j: a stale follow-up time never survives the gate reopening (review R1)', () => {
  const I = 'colorectal_followup_interval_years';
  /** One answer as the form writes it: screeningWrites on the record's inputs, each write through setScreening. */
  const answer = (file: RoadmapFile, key: string, value: string, now: string): RoadmapFile =>
    screeningWrites(derivePlanInputs(file).screenings, key, value).reduce((f, [k, v]) => setScreening(f, k, v, now), file);
  const answers = (file: RoadmapFile, writes: Array<[string, string]>, now: string) =>
    writes.reduce((f, [k, v]) => answer(f, k, v, now), file);
  const followupCards = (file: RoadmapFile) =>
    computePlan(file, NOW).results.suggestions.filter((s) => s.id === 'screening-colorectal-followup').map((c) => c.description);
  const reminder = (file: RoadmapFile) =>
    computeNextDueDates({ sex: 'male', age: 60 }, derivePlanInputs(file).screenings, {}, []).find((i) => i.category === 'screening_colorectal')?.dueAt;
  const reopen: Array<[string, string]> = [['colorectal_result', 'abnormal'], ['colorectal_followup_status', 'completed'], ['colorectal_followup_date', '2028-09']];

  it('writing completed from another status clears a leftover time; completed again keeps it', () => {
    const on = done('fit_annual', '2025-06', 10);
    for (const status of ['scheduled', 'not_organized', undefined] as const) {
      const writes = screeningWrites({ ...on, colorectalFollowupStatus: status }, 'colorectal_followup_status', 'completed');
      expect(writes.slice(1).map(([k]) => k), String(status)).toEqual([I]);
    }
    expect(screeningWrites(on, 'colorectal_followup_status', 'completed').slice(1)).toEqual([]);
    const again = answer(fileWith(on), 'colorectal_followup_status', 'completed', '2026-11-12T00:00:00Z');
    expect(again.screenings.colorectalFollowupIntervalYears).toBe(10);
  });

  it('path 1: an older engine left the time behind; reopening the gate gives card B, not D', () => {
    let file = fileWith(done('fit_annual', '2025-06', 10));
    // An older engine sets the result to normal and clears only the status and the date.
    file = setScreening(file, 'colorectal_result', 'normal', '2026-11-02T00:00:00Z');
    file = setScreening(file, 'colorectal_followup_status', '', '2026-11-02T00:00:00Z');
    file = setScreening(file, 'colorectal_followup_date', '', '2026-11-02T00:00:00Z');
    expect(file.screenings.colorectalFollowupIntervalYears).toBe(10);
    file = answers(file, reopen, '2026-11-12T00:00:00Z');
    expect(file.screenings.colorectalFollowupIntervalYears ?? null).toBeNull();
    expect(followupCards(file)).toEqual([B_TEXT.replace('{due}', 'Sep 2031')]);
    expect(reminder(file)).toBe('2031-09-01');
  });

  it('path 2: scheduled on one device, a time on another, merged both ways; completing again clears the time', () => {
    const base = fileWith(done('fit_annual', '2025-06', 5), 'dev_base', '2026-10-01T00:00:00Z');
    const a = answer(base, 'colorectal_followup_status', 'scheduled', '2026-11-01T09:00:00Z');
    expect(a.screenings.colorectalFollowupIntervalYears ?? null).toBeNull();
    const b = setScreening(base, I, '10', '2026-11-02T09:00:00Z');
    for (const merged of [mergeFiles(a, b, { deviceId: 'm', now: '2026-11-03T00:00:00Z' }), mergeFiles(b, a, { deviceId: 'm', now: '2026-11-03T00:00:00Z' })]) {
      expect(merged.screenings.colorectalFollowupStatus).toBe('scheduled');
      expect(merged.screenings.colorectalFollowupIntervalYears).toBe(10);
      const done2 = answers(merged, reopen.slice(1), '2026-11-12T00:00:00Z');
      expect(done2.screenings.colorectalFollowupIntervalYears ?? null).toBeNull();
      expect(followupCards(done2)).toEqual([B_TEXT.replace('{due}', 'Sep 2031')]);
    }
  });

  it('the same sitting: completed, a date, then the report\'s 5 years keeps the 5 (card D)', () => {
    const file = answers(fileWith({ ...done('fit_annual'), colorectalFollowupStatus: 'scheduled' }),
      [...reopen.slice(1), [I, '5']], '2026-11-12T00:00:00Z');
    expect(file.screenings.colorectalFollowupIntervalYears).toBe(5);
    expect(followupCards(file)).toEqual([D_TEXT.replace('{due}', 'Sep 2033')]);
  });

  it('leaving completed clears the time: status scheduled, result normal or awaiting', () => {
    for (const [k, v] of [['colorectal_followup_status', 'scheduled'], ['colorectal_result', 'normal'], ['colorectal_result', 'awaiting']]) {
      const file = answer(fileWith(done('fit_annual', '2025-06', 5)), k, v, '2026-11-12T00:00:00Z');
      expect(file.screenings.colorectalFollowupIntervalYears ?? null, `${k}=${v}`).toBeNull();
    }
  });
});

describe('US-07 AC1j: the evidence, the algorithm doc and the page carry the approved words', () => {
  it('the screening-colorectal reason ends with the approved sentence; no new reference', () => {
    const sentence = ITEM('3. **evidence-screening.ts')[0];
    const e = SUGGESTION_EVIDENCE['screening-colorectal'];
    expect(e.reason.endsWith(` ${sentence}`)).toBe(true);
    expect(e.references).toHaveLength(3);
    // The follow-up cards carry it by prefix.
    expect(plan(done('fit_annual', '2025-06'))[0].reason).toBe(e.reason);
  });

  it('the algorithm doc: one colorectal row, the Follow-up Logic item, the reminders sentence and the section-8 sentence', () => {
    const [row] = ITEM('- The Post-Follow-up table:').filter((q) => q.startsWith('|'));
    expect(ALGO).toContain(`\n${row}\n`);
    for (const old of ['| `colorectal_fit_annual` | 36 |', '| `colorectal_colonoscopy_10yr` | 36 |', '| `colorectal_other` | 36 |']) expect(ALGO).not.toContain(old);
    const logic = ITEM('- Follow-up Logic, a new item:')[0];
    const section = ALGO.slice(ALGO.indexOf('### Follow-up Logic'), ALGO.indexOf('### Overdue Calculation'));
    expect(section).toContain(logic);
    const [anchor, tail] = ITEM('- Reminders (:1311)');
    expect(ALGO).toContain(`${anchor}${tail}`);
    const s8 = ITEM('- The colorectal paragraph')[0];
    expect(ALGO.slice(ALGO.indexOf('Colorectal method by age'), ALGO.indexOf('Lung: the plan does not ask'))).toContain(s8);
  });

  it('N1: PSA\'s plan line reads "PSA\'s line is 4.0." with no parenthetical', () => {
    expect(ALGO).toContain('creatinine has none; PSA\'s line is 4.0. The label lines');
    expect(ALGO).not.toContain('(lab-limits, Change 3)');
  });

  it('roadmap_text.html: the bullet after the 55-75 bullets, before 76-85; no new reference', () => {
    const bullet = ITEM('- A new bullet in the colorectal section')[0];
    const from = HTML.indexOf('Age 55-75:');
    const between = HTML.slice(HTML.indexOf('</ul>', from), HTML.indexOf('Age 76-85:'));
    expect(between).toContain(`<li data-mce-fragment="1">${bullet}</li>`);
    const refs = HTML.slice(HTML.indexOf('<h2 id="references">'), HTML.indexOf('<h2 id="changelog">')).match(/^<li>.*$/gm) ?? [];
    expect(refs).toHaveLength(159);
  });

  it('the Changelog line comes after Change 3\'s PSA line, dated 12 November 2026', () => {
    const line = ITEM('5. **Changelog line:**')[0];
    const items = HTML.slice(HTML.indexOf('<h2 id="changelog">')).match(/<li>[^\n]*/g)!;
    const psa = items.findIndex((l) => l.includes('Prostate screening: a PSA of 4.0 or higher'));
    expect(items[psa + 1]).toBe(`<li>12<sup>th</sup> November 2026: ${line}</li>`);
  });

  it('docs/agent-access.md and the guideline carry their approved sentences', () => {
    expect(read('docs/agent-access.md')).toContain(ITEM('6. **docs/agent-access.md**')[0]);
    const [now, proposed] = [ITEM('- Now:')[0], ITEM('- Proposed:')[0]];
    const guide = read('docs/guideline/cancer-screening.md');
    expect(guide).toContain(proposed);
    expect(guide).not.toContain(now);
  });
});
