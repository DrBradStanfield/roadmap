// US-07 AC1j (Brad 2026-11-12): "The new abnormal result starts the follow-up again. The old follow-up
// answers are cleared, the existing urgent 'Organize colonoscopy' card shows, and the person works through
// the follow-up questions afresh. No new words." Colorectal only. A new last screening (its month later than
// the follow-up's) with an abnormal result clears the follow-up status, date and time when the answer is
// written (screeningWrites, web and iPhone), always, so the stamped nulls win a merge. The plan and reminders
// read stored answers as they are: an older engine's or a merge's leftovers are not reopened on read.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screeningWrites } from './input-form';
import { computeNextDueDates, followupKinds } from './reminder-schedule';
import { mergeFiles } from './merge';
import { computePlan, derivePlanInputs } from './plan';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';
import { setScreening } from './state-edits';
import type { ScreeningInputs } from './types';

const NOW = new Date('2026-11-12T12:00:00Z');
const AT = '2026-11-12T00:00:00Z';
const METHODS = ['fit_annual', 'colonoscopy_10yr', 'other'] as const;
type Method = (typeof METHODS)[number];
const NAME = { fit_annual: 'colonoscopy', colonoscopy_10yr: 'repeat colonoscopy', other: 'follow-up investigation' } as const;
const MEANS = { fit_annual: 'positive FIT test', colonoscopy_10yr: 'polyps found on colonoscopy', other: 'abnormal result' } as const;
const S = 'colorectal_followup_status';
const D = 'colorectal_followup_date';
const I = 'colorectal_followup_interval_years';

// Card B's words, read from the approved 2b spec (never reworded here).
const SPEC = readFileSync(join(__dirname, '../../../docs/drafts/screening-change-2b-words-2026-11-12.md'), 'utf8').split('\n').map((l) => l.trim());
const B_TEXT = [...SPEC.slice(SPEC.findIndex((l) => l.startsWith('## Cards'))).find((l) => l.startsWith('- B,'))!.matchAll(/"([^"]*)"/g)][1][1];

function fileWith(scr: ScreeningInputs, deviceId = 'reopen_test', now = '2026-10-01T00:00:00Z'): RoadmapFile {
  const f = createEmptyFile({ deviceId, now });
  return {
    ...f,
    profile: { ...f.profile, sex: 'male', heightCm: 175, birthYear: 1966, birthMonth: 1 } as RoadmapFile['profile'],
    screenings: { ...f.screenings, ...scr } as RoadmapFile['screenings'],
  };
}
/** One answer as the form writes it: screeningWrites on the record's inputs, each write through setScreening. */
const answer = (file: RoadmapFile, key: string, value: string, now = AT): RoadmapFile =>
  screeningWrites(derivePlanInputs(file, NOW).screenings, key, value).reduce((f, [k, v]) => setScreening(f, k, v, now), file);
const cards = (file: RoadmapFile) => computePlan(file, NOW).results.suggestions
  .filter((s) => s.id.startsWith('screening-colorectal')).map(({ id, priority, title, description }) => ({ id, priority, title, description }));
const reminder = (file: RoadmapFile) =>
  computeNextDueDates({ sex: 'male', age: 60 }, derivePlanInputs(file, NOW).screenings, {}, []).find((i) => i.category === 'screening_colorectal')?.dueAt;
const followup = (file: RoadmapFile) => {
  const s = derivePlanInputs(file, NOW).screenings;
  return [s.colorectalFollowupStatus ?? null, s.colorectalFollowupDate ?? null, s.colorectalFollowupIntervalYears ?? null];
};
const organize = (method: Method) => [{
  id: 'screening-colorectal-followup', priority: 'urgent', title: `Organize ${NAME[method]}`,
  description: `Your screening showed a ${MEANS[method]}. Please organize a ${NAME[method]} with your doctor.`,
}];
/** The old screening: abnormal in 2019, its follow-up colonoscopy completed 2020-01 with a 5-year time. */
const old = (method: Method, extra: ScreeningInputs = {}): ScreeningInputs => ({
  colorectalMethod: method, colorectalLastDate: '2019-06', colorectalResult: 'abnormal',
  colorectalFollowupStatus: 'completed', colorectalFollowupDate: '2020-01', colorectalFollowupIntervalYears: 5, ...extra,
});

describe('US-07 AC1j: a new abnormal last screening starts the follow-up again (Brad 2026-11-12)', () => {
  it.each(METHODS)('%s: result already abnormal, a new last date 2026-07 clears the follow-up; the urgent Organize card and its reminder', (method) => {
    const writes = screeningWrites(old(method), 'colorectal_last_date', '2026-07');
    expect(writes).toEqual([['colorectal_last_date', '2026-07'], [S, ''], [D, ''], [I, '']]);
    const file = answer(fileWith(old(method)), 'colorectal_last_date', '2026-07');
    expect(followup(file)).toEqual([null, null, null]);
    expect(cards(file)).toEqual(organize(method));
    expect(reminder(file)).toBe('2026-07-01');
  });

  it.each(METHODS)('%s: date then result: the date is written over an unanswered result, then abnormal clears', (method) => {
    // An older engine or a merge left the follow-up answers with no result.
    let file = setScreening(fileWith(old(method)), 'colorectal_result', '', '2026-11-01T00:00:00Z');
    file = answer(file, 'colorectal_last_date', '2026-07');
    expect(followup(file)).toEqual(['completed', '2020-01', 5]);
    expect(screeningWrites(derivePlanInputs(file, NOW).screenings, 'colorectal_result', 'abnormal').slice(1)).toEqual([[S, ''], [D, ''], [I, '']]);
    file = answer(file, 'colorectal_result', 'abnormal');
    expect(followup(file)).toEqual([null, null, null]);
    expect(cards(file)).toEqual(organize(method));
    expect(reminder(file)).toBe('2026-07-01');
  });

  it('the person works through the follow-up afresh: completed, then a date, gives the schedule again', () => {
    let file = answer(fileWith(old('colonoscopy_10yr')), 'colorectal_last_date', '2026-07');
    file = answer(file, S, 'completed');
    file = answer(file, D, '2026-09');
    expect(followup(file)).toEqual(['completed', '2026-09', null]);
    expect(cards(file)).toEqual([{ id: 'screening-colorectal-followup', priority: 'info', title: 'Colorectal screening up to date', description: B_TEXT.replace('{due}', 'Sep 2029') }]);
    expect(reminder(file)).toBe('2029-09-01');
  });

  it('a full date (YYYY-MM-DD) compares by its month', () => {
    const on = old('fit_annual', { colorectalFollowupDate: '2020-01-20' });
    expect(screeningWrites(on, 'colorectal_last_date', '2020-01-05').slice(1)).toEqual([]);
    expect(screeningWrites(on, 'colorectal_last_date', '2020-02-01').slice(1)).toEqual([[S, ''], [D, ''], [I, '']]);
  });

  it('the same month, or an earlier one, clears nothing and keeps the schedule', () => {
    for (const date of ['2020-01', '2019-12']) {
      expect(screeningWrites(old('fit_annual'), 'colorectal_last_date', date).slice(1), date).toEqual([]);
      expect(screeningWrites(old('fit_annual', { colorectalLastDate: date, colorectalResult: undefined }), 'colorectal_result', 'abnormal').slice(1), date).toEqual([]);
      const file = answer(fileWith(old('fit_annual')), 'colorectal_last_date', date);
      expect(followup(file), date).toEqual(['completed', '2020-01', 5]);
      expect(cards(file)[0].title, date).toBe('Colonoscopy overdue');
    }
  });

  it('a new last date with a normal result clears the chain, as before (pin)', () => {
    let file = answer(fileWith(old('fit_annual')), 'colorectal_last_date', '2026-07');
    file = answer(file, 'colorectal_result', 'normal');
    expect(followup(file)).toEqual([null, null, null]);
    expect(screeningWrites(old('fit_annual', { colorectalLastDate: '2026-07' }), 'colorectal_result', 'normal').slice(1)).toEqual([[S, ''], [D, ''], [I, '']]);
  });

  it('a follow-up with no date is left alone (open question, not decided here)', () => {
    const on = old('fit_annual', { colorectalFollowupDate: undefined });
    expect(screeningWrites(on, 'colorectal_last_date', '2026-07').slice(1)).toEqual([]);
    expect(cards(fileWith({ ...on, colorectalLastDate: '2026-07' }))[0].title).toBe('Add your colonoscopy date');
  });
});

describe('US-07 AC1j: the rule fires only when the answer is written (stated limit: stored answers are read as they are)', () => {
  it.each(METHODS)('%s: a file left with last 2026-07 over a follow-up completed 2020-01 keeps that schedule, never Organize', (method) => {
    const file = fileWith(old(method, { colorectalLastDate: '2026-07' }));
    expect(followup(file)).toEqual(['completed', '2020-01', 5]);
    expect(cards(file)[0].title).toBe('Colonoscopy overdue');
    expect(reminder(file)).toBe('2025-01-01');
    expect(followupKinds(file, NOW).screening_colorectal?.kind).not.toBe('organize');
  });
});

describe('US-07 AC1j: colorectal only: breast and cervical keep their follow-up (pin)', () => {
  const female = (scr: ScreeningInputs) => {
    const f = fileWith(scr);
    return { ...f, profile: { ...f.profile, sex: 'female', heightCm: 165, birthYear: 1976 } as RoadmapFile['profile'] };
  };
  const other = (file: RoadmapFile) => computePlan(file, NOW).results.suggestions.filter((s) => /^screening-(breast|cervical)/.test(s.id)).map((s) => s.title);
  const stored: ScreeningInputs = {
    breastFrequency: 'annual', breastLastDate: '2023-03', breastResult: 'abnormal', breastFollowupStatus: 'completed', breastFollowupDate: '2024-01',
    cervicalMethod: 'hpv_every_5yr', cervicalLastDate: '2023-03', cervicalResult: 'abnormal', cervicalFollowupStatus: 'completed', cervicalFollowupDate: '2024-01',
  };

  it('a newer last date over an abnormal result clears nothing', () => {
    expect(screeningWrites(stored, 'breast_last_date', '2026-03').slice(1)).toEqual([]);
    expect(screeningWrites(stored, 'cervical_last_date', '2026-03').slice(1)).toEqual([]);
    expect(screeningWrites({ ...stored, breastLastDate: '2026-03', breastResult: undefined }, 'breast_result', 'abnormal').slice(1)).toEqual([]);
  });

  it('the file with newer last dates shows the same cards as before, never Organize', () => {
    const file = female({ ...stored, breastLastDate: '2026-03', cervicalLastDate: '2026-03' });
    expect(other(file)).toEqual(['Breast screening overdue', 'Cervical screening overdue']);
  });
});

describe('US-07 AC1j: the reopen\'s clears are always written, so they win the merge', () => {
  const base = fileWith(old('fit_annual', { colorectalLastDate: '2025-01', colorectalFollowupDate: '2025-06', colorectalFollowupIntervalYears: undefined }), 'dev_base', '2026-10-01T00:00:00Z');

  it('written even when this device holds no follow-up time', () => {
    expect(screeningWrites(derivePlanInputs(base, NOW).screenings, 'colorectal_last_date', '2026-07').slice(1)).toEqual([[S, ''], [D, ''], [I, '']]);
  });

  it('A writes a new last date, B (earlier, unsynced) gave a 10-year time: merged both ways, the follow-up starts again', () => {
    const b = setScreening(base, I, '10', '2026-11-01T09:00:00Z');
    const a = answer(base, 'colorectal_last_date', '2026-07', '2026-11-02T09:00:00Z');
    for (const merged of [mergeFiles(a, b, { deviceId: 'm', now: '2026-11-04T00:00:00Z' }), mergeFiles(b, a, { deviceId: 'm', now: '2026-11-04T00:00:00Z' })]) {
      expect(followup(merged)).toEqual([null, null, null]);
      expect(cards(merged)).toEqual(organize('fit_annual'));
      expect(reminder(merged)).toBe('2026-07-01');
    }
  });
});
