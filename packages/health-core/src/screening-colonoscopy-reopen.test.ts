// US-07 AC1j (Brad 2026-11-12): "The new abnormal result starts the follow-up again. The old follow-up
// answers are cleared, the existing urgent 'Organize colonoscopy' card shows, and the person works through
// the follow-up questions afresh. No new words." Colorectal only. While the last screening's month is later
// than the follow-up's, the form asks the result again (shownColorectalResult: blank, follow-up hidden).
// Writing abnormal then clears the follow-up status, date and time (screeningWrites, web and iPhone), always,
// so the stamped nulls win a merge. A date write never clears; the plan reads the stored answers as they are.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screeningForm, screeningWrites } from './input-form';
import { shownColorectalResult } from './colonoscopy-schedule';
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

/** The old follow-up, with a newer last screening (2026-07) written over it: the form asks the result again. */
const newer = (method: Method, extra: ScreeningInputs = {}): ScreeningInputs => old(method, { colorectalLastDate: '2026-07', ...extra });
const colorectalFields = (scr: ScreeningInputs) => screeningForm(60, 'male', scr)[0].groups.find((g) => g.id === 'colorectal')!.fields
  .flatMap((f) => ('key' in f && f.key.startsWith('colorectal_') ? [[f.key, 'value' in f ? f.value : undefined]] : []));

describe('US-07 AC1j: the abnormal result written for a newer last screening starts the follow-up again (Brad 2026-11-12)', () => {
  it.each(METHODS)('%s: the result write clears the follow-up; the urgent Organize card and its reminder', (method) => {
    expect(screeningWrites(newer(method), 'colorectal_result', 'abnormal')).toEqual([['colorectal_result', 'abnormal'], [S, ''], [D, ''], [I, '']]);
    const file = answer(fileWith(newer(method)), 'colorectal_result', 'abnormal');
    expect(followup(file)).toEqual([null, null, null]);
    expect(cards(file)).toEqual(organize(method));
    expect(reminder(file)).toBe('2026-07-01');
    expect(shownColorectalResult(derivePlanInputs(file, NOW).screenings)).toBe('abnormal');
  });

  it.each(METHODS)('%s: the clears are stamped even when this device holds no follow-up time', (method) => {
    expect(screeningWrites(newer(method, { colorectalFollowupIntervalYears: undefined }), 'colorectal_result', 'abnormal').slice(1))
      .toEqual([[S, ''], [D, ''], [I, '']]);
  });

  it('an unanswered result (an older engine or a merge left it blank), answered abnormal, clears too', () => {
    const file = answer(fileWith(newer('fit_annual', { colorectalResult: undefined })), 'colorectal_result', 'abnormal');
    expect(followup(file)).toEqual([null, null, null]);
    expect(cards(file)).toEqual(organize('fit_annual'));
  });

  it('the person works through the follow-up afresh: completed, then a date, gives the schedule again', () => {
    let file = answer(fileWith(newer('colonoscopy_10yr')), 'colorectal_result', 'abnormal');
    file = answer(file, S, 'completed');
    file = answer(file, D, '2026-09');
    expect(followup(file)).toEqual(['completed', '2026-09', null]);
    expect(cards(file)).toEqual([{ id: 'screening-colorectal-followup', priority: 'info', title: 'Colorectal screening up to date', description: B_TEXT.replace('{due}', 'Sep 2029') }]);
    expect(reminder(file)).toBe('2029-09-01');
  });

  it('a full date (YYYY-MM-DD) compares by its month', () => {
    expect(screeningWrites(old('fit_annual', { colorectalLastDate: '2020-01-25', colorectalFollowupDate: '2020-01-20' }), 'colorectal_result', 'abnormal').slice(1)).toEqual([]);
    expect(screeningWrites(old('fit_annual', { colorectalLastDate: '2020-02-01', colorectalFollowupDate: '2020-01-20' }), 'colorectal_result', 'abnormal').slice(1)).toEqual([[S, ''], [D, ''], [I, '']]);
  });

  it('the same month, an earlier one, or a follow-up with no date: the stored result shows and abnormal clears nothing', () => {
    for (const scr of [old('fit_annual', { colorectalLastDate: '2020-01' }), old('fit_annual'), newer('fit_annual', { colorectalFollowupDate: undefined })]) {
      expect(shownColorectalResult(scr), JSON.stringify(scr)).toBe('abnormal');
      expect(screeningWrites(scr, 'colorectal_result', 'abnormal').slice(1), JSON.stringify(scr)).toEqual([]);
    }
  });

  it('a normal result clears the chain, as before (pin)', () => {
    expect(screeningWrites(newer('fit_annual'), 'colorectal_result', 'normal')).toEqual([['colorectal_result', 'normal'], [S, ''], [D, ''], [I, '']]);
    expect(followup(answer(fileWith(newer('fit_annual')), 'colorectal_result', 'normal'))).toEqual([null, null, null]);
  });
});

describe('US-07 AC1j: a date write never clears anything', () => {
  it.each(METHODS)('%s: a new last date over the old follow-up writes the date alone', (method) => {
    expect(screeningWrites(old(method), 'colorectal_last_date', '2026-07')).toEqual([['colorectal_last_date', '2026-07']]);
    expect(followup(answer(fileWith(old(method)), 'colorectal_last_date', '2026-07'))).toEqual(['completed', '2020-01', 5]);
  });

  it('the December-first half-edit (2025-12, then 2024-12) keeps every follow-up answer', () => {
    let file = fileWith(old('fit_annual', { colorectalLastDate: '2025-03', colorectalFollowupDate: '2025-06' }));
    file = answer(file, 'colorectal_last_date', '2025-12');
    file = answer(file, 'colorectal_last_date', '2024-12');
    expect(followup(file)).toEqual(['completed', '2025-06', 5]);
    expect(shownColorectalResult(derivePlanInputs(file, NOW).screenings)).toBe('abnormal');
  });

  it('a typo fix on a newer last date (2026-07 to 2026-08) keeps every follow-up answer', () => {
    const file = answer(fileWith(newer('other')), 'colorectal_last_date', '2026-08');
    expect(followup(file)).toEqual(['completed', '2020-01', 5]);
  });
});

describe('US-07 AC1j: the form asks the result again for a newer last screening', () => {
  it('the result shows blank and the follow-up questions hide; the stored answers stay', () => {
    expect(shownColorectalResult(newer('fit_annual'))).toBe('');
    expect(colorectalFields(newer('fit_annual'))).toEqual([['colorectal_method', 'fit_annual'], ['colorectal_last_date', '2026-07'], ['colorectal_result', '']]);
    expect(colorectalFields(old('fit_annual')).map(([k]) => k)).toContain(S);
  });

  it('a result other than abnormal shows as stored', () => {
    expect(shownColorectalResult(newer('fit_annual', { colorectalResult: 'normal' }))).toBe('normal');
    expect(shownColorectalResult({})).toBe('');
  });
});

describe('US-07 AC1j: while the result shows blank, the plan does not move (it reads the stored answers)', () => {
  it.each(METHODS)('%s: the same cards and reminder as the stored answers give, never Organize', (method) => {
    const file = fileWith(newer(method));
    expect(shownColorectalResult(derivePlanInputs(file, NOW).screenings)).toBe('');
    expect(followup(file)).toEqual(['completed', '2020-01', 5]);
    expect(cards(file)).toEqual(cards(fileWith(old(method))));
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
    breastFrequency: 'annual', breastLastDate: '2026-03', breastResult: 'abnormal', breastFollowupStatus: 'completed', breastFollowupDate: '2024-01',
    cervicalMethod: 'hpv_every_5yr', cervicalLastDate: '2026-03', cervicalResult: 'abnormal', cervicalFollowupStatus: 'completed', cervicalFollowupDate: '2024-01',
  };

  it('an abnormal result or a date over a newer last date clears nothing, and the result shows as stored', () => {
    for (const t of ['breast', 'cervical']) {
      expect(screeningWrites(stored, `${t}_result`, 'abnormal').slice(1), t).toEqual([]);
      expect(screeningWrites(stored, `${t}_last_date`, '2026-04').slice(1), t).toEqual([]);
    }
    const fields = screeningForm(50, 'female', stored)[0].groups.flatMap((g) => g.fields);
    expect(fields.filter((f) => 'key' in f && /^(breast|cervical)_result$/.test(f.key)).map((f) => 'value' in f && f.value)).toEqual(['abnormal', 'abnormal']);
    expect(fields.filter((f) => 'key' in f && /^(breast|cervical)_followup_status$/.test(f.key))).toHaveLength(2);
  });

  it('the file shows the same cards as before, never Organize', () => {
    expect(other(female(stored))).toEqual(['Breast screening overdue', 'Cervical screening overdue']);
  });
});

describe('US-07 AC1j: the reopen\'s clears are always written, so they win the merge', () => {
  const base = fileWith(old('fit_annual', { colorectalLastDate: '2026-07', colorectalFollowupDate: '2025-06', colorectalFollowupIntervalYears: undefined }), 'dev_base', '2026-10-01T00:00:00Z');

  it('A answers abnormal for the newer screening, B (earlier, unsynced) gave a 10-year time: merged both ways, the follow-up starts again', () => {
    const b = setScreening(base, I, '10', '2026-11-01T09:00:00Z');
    const a = answer(base, 'colorectal_result', 'abnormal', '2026-11-02T09:00:00Z');
    for (const merged of [mergeFiles(a, b, { deviceId: 'm', now: '2026-11-04T00:00:00Z' }), mergeFiles(b, a, { deviceId: 'm', now: '2026-11-04T00:00:00Z' })]) {
      expect(followup(merged)).toEqual([null, null, null]);
      expect(cards(merged)).toEqual(organize('fit_annual'));
      expect(reminder(merged)).toBe('2026-07-01');
    }
  });
});
