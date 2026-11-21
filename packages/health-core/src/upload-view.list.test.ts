/**
 * The list the web will draw from `uploadView`, as the iPhone does (web list PR 1, owner decision 2026-11-21; US-13 AC13,
 * AC24, AC25; US-12 AC6a): the additive, inert engine half. Each row says whether Save writes it (`saves`), has a name no
 * other row has, and shows its number in the person's unit; each day source has one control keyed by source, never by
 * the day; each blocker names the control that removes it. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW } from './import-review.test-helpers';
import { NOT_SAVED_TEXT } from './import-review';
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues, type BulkRow } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { dropLostReplaces, reviewedWrites, uploadReview } from './upload-review';
import { uploadSave } from './upload-save';
import { FIX_ERRORS_TEXT, UPLOAD_TEXT } from './upload-text';
import { uploadView, type UploadView, type ValueRow } from './upload-view';
import type { CellUnit } from './cell-unit';
import type { MetricType } from './units';

type Open = Extract<UploadState, { phase: 'open' }>;
const labRead = (id: string, over: Partial<UnifiedExtractionResult>): Open['files'][number] => ({
  id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
const open = (files: Open['files'], platform: Open['platform'] = 'web'): Open => ({ phase: 'open', platform, run: 1, files, started: NOW, firstRead: NOW });
const see = (s: UploadState, record: RoadmapFile = EMPTY, unitOf?: (m: MetricType) => CellUnit) => uploadView(s, record, NOW, uploadReview(s, record, NOW), false, unitOf);
const chose = (s: UploadState, id: string, change: ChoiceChange) => transition(s, { type: 'chose', id, change, now: NOW }).state;
const rows = (view: UploadView): ValueRow[] => [...view.sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : [])), ...(view.sure?.rows ?? [])];
const held = (rows_: BulkRow[]) => bulkAppendValues(EMPTY, rows_, NOW).file;
const LDL = (value: number, recordedAt = DAY): BulkRow => ({ kind: 'measurement', metricType: 'ldl', value, recordedAt, source: 'manual' });
const keys = (view: UploadView) => view.sections.flatMap((x) => ('key' in x ? [x.key] : []));

describe('saves: whether Save writes the row (US-12 AC6a)', () => {
  it('is sent and written; a kept conflict and an unticked value do not save', () => {
    const s = chose(open([labRead('f0', { values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })], additionalValues: [extra({})] })]), 'f0', { tick: 'a0', on: false });
    const byRef = Object.fromEntries(rows(see(s, held([LDL(2.0)]))).map((r) => [r.ref, r.saves]));
    expect(byRef).toEqual({ v0: false, v1: true, a0: false });
  });

  it('while saving, only what the press promised saves: a conflict freed after the press is drawn as not saving', () => {
    const record = held([LDL(2.0)]);
    const s = open([labRead('f0', { values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]);
    const saving = transition(s, { type: 'saveStarted', reviewed: reviewedWrites(uploadReview(s, record, NOW)) }).state;
    const freed = { ...record, labValues: record.labValues.map((l) => ({ ...l, status: 'entered-in-error' as const })) };
    const byRef = Object.fromEntries(rows(see(saving, freed)).map((r) => [r.ref, r.saves]));
    expect(byRef).toEqual({ v0: false, v1: true });
  });
});

describe('name: every row its own accessible name', () => {
  it('names the test, the file and the day; a second reading of one test that day is "another reading"', () => {
    const s = open([labRead('f0', { values: [core({}), core({})] }), labRead('f1', { values: [core({})] })]);
    const names = rows(see(s, held([LDL(2.0)]))).map((r) => r.name);
    expect(names).toEqual([
      'LDL Cholesterol value from f0.pdf, 1 Nov 2026',
      'LDL Cholesterol value from f0.pdf, 1 Nov 2026, another reading',
      'LDL Cholesterol value from f1.pdf, 1 Nov 2026',
    ]);
    expect(rows(see(s, held([LDL(2.0)])))[1].copy).toBe(NOT_SAVED_TEXT.sameDay);
  });

  it('a row with no day yet is named by its file alone', () => {
    const s = open([labRead('f0', { reportDate: null, values: [core({ valueSI: 500, displayValue: 500 })] })]);
    expect(rows(see(s)).map((r) => r.name)).toEqual(['LDL Cholesterol value from f0.pdf']);
  });
});

describe('shown: the number in the person\'s unit (the web formats nothing)', () => {
  const mgdl = () => 'conventional' as const;
  it('a core value printed in mmol/L shows in mg/dL for a person who uses it, with what the commit needs', () => {
    const [row] = rows(see(open([labRead('f0', { values: [core({})] })]), EMPTY, mgdl));
    expect(row.shown).toEqual({ text: '120', number: '120', unit: 'mg/dL', current: 3.1, cell: { metric: 'ldl', unit: 'conventional' } });
    expect(row).toMatchObject({ value: '3.1', unit: 'mmol/L' }); // the printed facts stay as they were
  });

  it('a limit keeps its sign; an edit (SI) shows in the person\'s unit; a lab shows as printed', () => {
    let s: UploadState = open([labRead('f0', { values: [core({ valueSI: 0.6, displayValue: 0.6, comparator: '<' }), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })], additionalValues: [extra({})] })]);
    s = chose(s, 'f0', { edit: 'v1', value: 52 });
    const shown = rows(see(s, EMPTY, mgdl)).map((r) => [r.ref, r.shown?.text, r.shown?.unit]);
    // A limit's bound keeps the places it needs to stay true in the unit (cellNumber, US-12 AC20), as the web's cells show it.
    expect(shown).toEqual([['v0', '< 23.202', 'mg/dL'], ['v1', '6.9', '%'], ['a0', '80', 'µg/L']]);
  });

  it('is absent when no unit is given (the iPhone\'s call, unchanged)', () => {
    expect(rows(see(open([labRead('f0', { values: [core({})] })])))[0].shown).toBeUndefined();
  });
});

describe('day controls: one per source, keyed by source, never by the day', () => {
  const dated = () => labRead('f0', { values: [core({}), core({ recordedAt: '2026-10-01' })], additionalValues: [extra({ recordedAt: UNDATED_PREVIOUS })] });

  it('the web asks each dated previous column\'s day; its key holds the printed day only, and stays when a day is picked', () => {
    let s: UploadState = open([dated()]);
    expect(keys(see(s))).toEqual(['f0|previous', 'f0|printed:2026-10-01']);
    s = chose(s, 'f0', { columnDay: '2026-10-01', day: '2026-09-20' });
    s = chose(s, 'f0', { previousDay: '2026-09-01' });
    const view = see(s);
    expect(keys(view)).toEqual(['f0|previous', 'f0|printed:2026-10-01']);
    expect(view.sections.find((x) => x.kind === 'datedPrevious')).toMatchObject({ printed: '2026-10-01', day: '2026-09-20' });
    expect(view.sections.find((x) => x.kind === 'undatedPrevious')).toMatchObject({ day: '2026-09-01' });
    expect(rows(view).find((r) => r.ref === 'v1')).toMatchObject({ day: '2026-09-20' });
  });

  it('the iPhone gets no dated previous column (it never sets one)', () => {
    expect(see(open([dated()], 'phone')).sections.some((x) => x.kind === 'datedPrevious')).toBe(false);
  });

  it('an undated report\'s day is keyed by the test', () => {
    expect(keys(see(open([labRead('f0', { reportDate: null, values: [core({})] })])))).toEqual(['f0|test']);
  });
});

describe('blockers: each names the control that removes it', () => {
  it('a value to fix is its row\'s key; a day to choose is its source\'s key', () => {
    const s = open([labRead('f0', { values: [core({ valueSI: 500, displayValue: 500 })] }), labRead('f1', { reportDate: null, values: [core({})] })]);
    const { save } = see(s);
    expect(save.why).toBe(FIX_ERRORS_TEXT);
    expect(save.blockers).toEqual([{ why: FIX_ERRORS_TEXT, at: 'f0:v0' }, { why: UPLOAD_TEXT.chooseDay, at: 'f1|test' }]);
  });
});

describe('dropLostReplaces: one rule for the engine door and the web', () => {
  it('drops a Replace whose held row another writer deleted, and unticks its value; with none chosen it judges nothing', () => {
    const record = held([LDL(2.0)]);
    const s = chose(open([labRead('f0', { values: [core({})] })]), 'f0', { replace: 'v0', correctsId: record.labValues[0].id });
    const deleted = { ...record, labValues: record.labValues.map((l) => ({ ...l, status: 'entered-in-error' as const })) };
    const after = dropLostReplaces(s, deleted, NOW);
    expect(after.review).toBeUndefined();
    expect(after.state.phase === 'open' && after.state.files[0].status.s === 'read' && after.state.files[0].status.choices).toMatchObject({ ticks: { v0: false }, replace: {} });
    const kept = dropLostReplaces(s, record, NOW);
    expect(kept.state).toBe(s);
    expect(kept.review?.labFiles[0].replacing).toEqual(['v0']);
    const none = open([labRead('f0', { values: [core({})] })]);
    expect(dropLostReplaces(none, deleted, NOW)).toEqual({ state: none });
  });
});

describe('typed text held in a row (owner ruling 2026-11-21 after review; US-13 AC5, AC12; US-02 AC4)', () => {
  const type = (s: UploadState, id: string, ref: string, text: string, unit: CellUnit | null = 'si') => chose(s, id, { typed: ref, text, unit });
  const all = (view: UploadView) => [...rows(view), ...view.sections.flatMap((x) => (x.kind === 'datedPrevious' || x.kind === 'undatedPrevious' ? x.rows ?? [] : []))];
  const off = { holds: () => false, original: () => null, mimeType: () => '', write: async () => {} };

  it('stays drawn with its text and the cells\' words, never saves, and blocks Save at its row until cleared', async () => {
    const s = type(open([labRead('f0', { values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]), 'f0', 'v0', '1,234');
    const view = see(s);
    expect(rows(view).find((r) => r.ref === 'v0')).toMatchObject({ typed: '1,234', error: 'Did you mean 1234 or 1.234?', ticked: true, saves: false });
    expect(rows(view).find((r) => r.ref === 'v1')).toMatchObject({ saves: true });
    expect(view.save).toMatchObject({ enabled: false, why: FIX_ERRORS_TEXT, blockers: [{ why: FIX_ERRORS_TEXT, at: 'f0:v0' }] });
    const out = await uploadSave({ ...(s as Open), phase: 'saving', attempt: 1 }, EMPTY, NOW, false, off);
    expect(out).toMatchObject({ ok: false, reason: 'not-ready' });
    expect(see(type(s, 'f0', 'v0', '3.4')).save).toMatchObject({ enabled: true, blockers: [] });
    expect(see(chose(s, 'f0', { tick: 'v0', on: false })).save.blockers).toEqual([]);
  });

  it('a held text changes no other row: a second reading of the test that day keeps its saving', () => {
    const s = open([labRead('f0', { values: [core({}), core({})] }), labRead('f1', { values: [core({ valueSI: 2.4, displayValue: 2.4 })] })]);
    const others = (v: UploadView) => all(v).filter((r) => !(r.fileId === 'f0' && r.ref === 'v1')).map((r) => [r.fileId, r.ref, r.saves, r.copy]);
    expect(others(see(type(s, 'f0', 'v1', 'abc')))).toEqual(others(see(s)));
  });

  it('a number typed into a cleared row ticks it again; an emptied input clears it', () => {
    const cleared = chose(open([labRead('f0', { values: [core({})] })]), 'f0', { tick: 'v0', on: false });
    expect(rows(see(type(cleared, 'f0', 'v0', '3.4')))[0]).toMatchObject({ ticked: true, saves: true, value: '3.4' });
    expect(rows(see(type(cleared, 'f0', 'v0', '3.1')))[0]).toMatchObject({ ticked: true, saves: true });
    expect(rows(see(type(open([labRead('f0', { values: [core({})] })]), 'f0', 'v0', '')))[0]).toMatchObject({ ticked: false, saves: false });
  });

  it('while its report waits for a day, an out-of-range value\'s error is drawn on its row; Save asks the day first, and the row blocks after it', () => {
    const s = open([labRead('f0', { reportDate: null, values: [core({ valueSI: 500, displayValue: 500 })] })]);
    const waiting = see(s);
    expect(rows(waiting)[0]).toMatchObject({ error: 'LDL-c must be at most 12.9 mmol/L', saves: false });
    expect(waiting.save.blockers).toEqual([{ why: UPLOAD_TEXT.chooseDay, at: 'f0|test' }, { why: FIX_ERRORS_TEXT, at: 'f0:v0' }]);
    expect(see(chose(s, 'f0', { testDay: '2026-10-20' })).save.blockers).toEqual([{ why: FIX_ERRORS_TEXT, at: 'f0:v0' }]);
  });

  it('while its column waits for a day, a held text is drawn in the column and blocks at its row first; picking the day leaves it', () => {
    let s: UploadState = open([labRead('f0', { values: [core({ recordedAt: '2026-05-02' })] })]);
    s = type(s, 'f0', 'v0', '-5');
    s = chose(s, 'f0', { columnDay: '2026-05-02', day: '2026-12-01' }); // a day to come: the column waits
    const waiting = see(s);
    const column = waiting.sections.find((x) => x.kind === 'datedPrevious');
    expect(column?.kind === 'datedPrevious' && column.rows).toMatchObject([{ typed: '-5', error: 'Type one decimal number, without signs, < > or spaces', saves: false }]);
    expect(waiting.save.blockers).toEqual([{ why: FIX_ERRORS_TEXT, at: 'f0:v0' }, { why: UPLOAD_TEXT.chooseDay, at: 'f0|printed:2026-05-02' }]);
    expect(see(chose(s, 'f0', { columnDay: '2026-05-02', day: '2026-05-01' })).save.blockers).toEqual([{ why: FIX_ERRORS_TEXT, at: 'f0:v0' }]);
  });
});

describe('a waiting dated column\'s values are drawn (owner ruling 2026-11-21, adversary A2; US-13 AC24)', () => {
  it('printed 2026-05-02, its day picked as 2026-05-01, then the test day moved to 2026-04-01: its values wait in its section, a Replace kept in view', () => {
    const record = held([LDL(2.0, '2026-05-01')]);
    let s: UploadState = open([labRead('f0', { reportDate: '2026-10-01', values: [core({ recordedAt: '2026-05-02' })] })]);
    s = chose(s, 'f0', { columnDay: '2026-05-02', day: '2026-05-01' });
    s = chose(s, 'f0', { replace: 'v0', correctsId: record.labValues[0].id });
    expect(rows(see(s, record))[0]).toMatchObject({ day: '2026-05-01', replacing: true });
    s = chose(s, 'f0', { testDay: '2026-04-01' });
    const view = see(s, record);
    expect(rows(view)).toEqual([]);
    expect(view.sections.find((x) => x.kind === 'datedPrevious')).toMatchObject({ key: 'f0|printed:2026-05-02', day: null,
      rows: [{ ref: 'v0', day: null, ticked: true, saves: false, replacing: true }] });
    expect(view.save.blockers).toEqual([{ why: UPLOAD_TEXT.chooseDay, at: 'f0|printed:2026-05-02' }]);
  });
});
