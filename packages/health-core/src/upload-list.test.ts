/**
 * The web upload ledger (web list PR 1b; US-13 AC5, AC12, AC24, AC26; owner rulings 2026-11-21, Brad 2026-11-21): every
 * offered value a row in every state; held text blocks Save; the three cases that refuted PR 1937, as table tests.
 * Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW } from './import-review.test-helpers';
import { IMPORT_REVIEW_TEXT, NOT_SAVED_TEXT } from './import-review';
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues, type BulkRow } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { ENTER_A_NUMBER, NUMERIC_SYNTAX_GUIDANCE } from './cell-input';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadList } from './upload-list';
import { reviewedWrites, uploadReview } from './upload-review';
import { uploadSave } from './upload-save';
import { FIX_ERRORS_TEXT, REVIEW_CELL_TEXT, UPLOAD_TEXT } from './upload-text';
import { uploadView } from './upload-view';

type Open = Extract<UploadState, { phase: 'open' }>;
const labRead = (id: string, over: Partial<UnifiedExtractionResult>): Open['files'][number] => ({
  id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
const open = (files: Open['files']): Open => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: NOW });
const si = () => 'si' as const;
const see = (s: UploadState, record: RoadmapFile) => {
  const review = uploadReview(s, record, NOW);
  return { review, list: uploadList(s, record, NOW, review, si), view: uploadView(s, record, NOW, review, false, si) };
};
const chose = (s: UploadState, id: string, change: ChoiceChange) => transition(s, { type: 'chose', id, change, now: NOW }).state;
const held = (rows: BulkRow[]) => bulkAppendValues(EMPTY, rows, NOW).file;
const LDL = (value: number, recordedAt = DAY): BulkRow => ({ kind: 'measurement', metricType: 'ldl', value, recordedAt, source: 'manual' });
const off = { stopped: () => false, holds: () => false, original: () => null, mimeType: () => '', write: async () => {}, now: () => NOW };
const saveRefused = async (s: UploadState, record: RoadmapFile) => {
  const saving = transition(s, { type: 'saveStarted', reviewed: reviewedWrites(uploadReview(s, record, NOW)) }).state;
  const out = await uploadSave(saving, record, NOW, false, off);
  return out.ok ? null : out.message;
};

describe('the three cases that refuted PR 1937', () => {
  it('(a) held text in a dated column the person moves onto a day the record holds: the row stays, its text stays, Save is blocked', async () => {
    const SEP = '2026-09-01';
    const OCT = '2026-10-01';
    const record = held([LDL(3.1, SEP)]);
    let s: UploadState = open([labRead('f0', { values: [core({ recordedAt: OCT })] })]);
    s = chose(s, 'f0', { typed: 'v0', text: 'abc', unit: 'si' });
    s = chose(s, 'f0', { columnDay: OCT, day: SEP });
    const { list, view } = see(s, record);
    expect(list.rows).toMatchObject([{ key: 'f0:v0', section: `f0|printed:${OCT}`, ticked: true, typed: { text: 'abc', unit: 'si' }, error: NUMERIC_SYNTAX_GUIDANCE, status: { kind: 'error' }, saves: false }]);
    expect(list.days).toMatchObject([{ key: `f0|printed:${OCT}`, source: 'column', printed: OCT, chosen: SEP, day: SEP }]);
    expect(view.save).toMatchObject({ enabled: false, why: FIX_ERRORS_TEXT, blockers: [{ why: FIX_ERRORS_TEXT, at: 'f0:v0' }] });
    expect(await saveRefused(s, record)).toBe(FIX_ERRORS_TEXT);
  });

  it('(b) two LDLs on one day, the second cleared then typed into: its row keeps its text, then its edit and caption; Save never writes over it silently', () => {
    let s: UploadState = open([labRead('f0', { values: [core({}), core({ valueSI: 3.5, displayValue: 3.5 })] })]);
    s = chose(s, 'f0', { tick: 'v1', on: false });
    s = chose(s, 'f0', { typed: 'v1', text: '3..5', unit: 'si' });
    let { list, view, review } = see(s, EMPTY);
    expect(list.rows.map((r) => r.key)).toEqual(['f0:v0', 'f0:v1']);
    expect(list.rows[1]).toMatchObject({ ticked: true, typed: { text: '3..5' }, error: ENTER_A_NUMBER, status: { kind: 'error' }, saves: false, attention: true });
    expect(view.save).toMatchObject({ enabled: false, why: FIX_ERRORS_TEXT });
    expect(review.classification.rows.map((r) => r.value)).toEqual([3.1]); // the held text is never written
    s = chose(s, 'f0', { typed: 'v1', text: '3.6', unit: 'si' });
    ({ list, view, review } = see(s, EMPTY));
    // Owner's ruling A: both rows drawn; the loser stays ticked and editable, says why it is not saved, offers no Replace.
    expect(list.rows[1]).toMatchObject({ ticked: true, typed: null, error: null, shown: { current: 3.6, number: '3.6' },
      status: { kind: 'sameDay' }, caption: NOT_SAVED_TEXT.sameDay, saves: false, replaces: null });
    expect(list.rows[0]).toMatchObject({ status: { kind: 'saves' }, saves: true, shown: { current: 3.1 } });
    expect(view.save).toMatchObject({ enabled: true, label: IMPORT_REVIEW_TEXT.save(1) });
    expect(reviewedWrites(review)).toEqual([{ file: 'f0', ref: 'v0', lab: false }]);
  });

  it('(c) an undated report: LDL 500 corrected to 3.1 before the day is chosen has no range error and no value blocker', () => {
    let s: UploadState = open([labRead('f0', { reportDate: null, values: [core({ valueSI: 500, displayValue: 500 })] })]);
    expect(see(s, EMPTY).list.rows[0].error).toBe('Max 12.9 mmol/L');
    s = chose(s, 'f0', { edit: 'v0', value: 3.1 });
    const { list, view } = see(s, EMPTY);
    expect(list.rows[0]).toMatchObject({ error: null, status: { kind: 'waits' }, caption: UPLOAD_TEXT.chooseDay, shown: { current: 3.1 } });
    expect(view.save.blockers).toEqual([{ why: UPLOAD_TEXT.chooseDay, at: 'f0|test' }]);
  });
});

describe('every offered value is a row (US-13 AC26)', () => {
  it('a value already in the record: "Already in your record", collapsed behind Show all', () => {
    const { list, view } = see(open([labRead('f0', { values: [core({})], additionalValues: [extra({ unit: 'zzz' })] })]), held([LDL(3.1)]));
    expect(list.rows).toMatchObject([
      { key: 'f0:v0', status: { kind: 'alreadyInRecord' }, caption: REVIEW_CELL_TEXT.alreadyInRecord, saves: false, attention: false },
      { key: 'f0:a0', status: { kind: 'notSaved', reason: 'unit' }, caption: NOT_SAVED_TEXT.unit, saves: false, attention: false },
    ]);
    expect(REVIEW_CELL_TEXT.alreadyInRecord).toBe('Already in your record');
    expect(list.showAll).toBe(IMPORT_REVIEW_TEXT.showAll(2));
    expect(view.alreadySaved).toBe(IMPORT_REVIEW_TEXT.alreadySaved(1));
  });

  it('each day source is a section and a day control keyed by what printed, never the day picked', () => {
    let s: UploadState = open([labRead('f0', { reportDate: null, values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', recordedAt: UNDATED_PREVIOUS }), core({ recordedAt: '2026-09-15' })] })]);
    s = chose(s, 'f0', { testDay: '2026-10-20' });
    const { list } = see(s, EMPTY);
    expect(list.rows.map((r) => r.section)).toEqual(['f0|test', 'f0|previous', 'f0|printed:2026-09-15']);
    expect(list.days.map((d) => [d.key, d.source, d.day])).toEqual([['f0|test', 'test', '2026-10-20'], ['f0|previous', 'previous', null], ['f0|printed:2026-09-15', 'column', '2026-09-15']]);
  });

  it('a touched row needs attention, so Show all never hides it', () => {
    const s = chose(open([labRead('f0', { values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]), 'f0', { edit: 'v1', value: 41 });
    expect(see(s, EMPTY).list.rows.map((r) => r.attention)).toEqual([false, true]);
  });

  it('a range error is worded in the unit the person reads', () => {
    const s = open([labRead('f0', { values: [core({ valueSI: 500, displayValue: 500 })] })]);
    const review = uploadReview(s, EMPTY, NOW);
    expect(uploadList(s, EMPTY, NOW, review, () => 'conventional').rows[0].error).toBe('Max 498 mg/dL') // the cell's own range, rounded inward (US-35 AC17);
    expect(uploadList(s, EMPTY, NOW, review, si).rows[0]).toMatchObject({ error: 'Max 12.9 mmol/L', status: { kind: 'refused' } }); // US-13 AC27
  });
});

describe('typed text commits (US-13 AC5, AC12; US-02 AC4, AC7)', () => {
  const ldl = (valueSI: number) => open([labRead('f0', { values: [core({ valueSI, displayValue: valueSI })] })]);
  const choicesAfter = (s: UploadState, text: string) => {
    const f = (chose(s, 'f0', { typed: 'v0', text, unit: 'si' }) as Open).files[0];
    return f.status.s === 'read' ? f.status.choices : null;
  };

  it('retyping the shown "12.9" of an out-of-range 12.94 corrects it (AC5); in range, the shown number again changes nothing', () => {
    expect(see(ldl(12.94), EMPTY).list.rows[0].shown).toMatchObject({ number: '12.9', current: 12.94 });
    expect(choicesAfter(ldl(12.94), '12.9')?.edits).toEqual({ v0: 12.9 });
    expect(choicesAfter(ldl(3.14), '3.1')?.edits).toEqual({});
  });

  // Web list PR 1d (US-13 AC5): the person's own edit shows as they gave it, never rounded.
  it('an edit finer than the display step is exact, shown as typed, and a finer number typed over it is an edit', () => {
    const s = chose(ldl(3.1), 'f0', { typed: 'v0', text: '3.14', unit: 'si' });
    expect(see(s, EMPTY).list.rows[0].shown).toMatchObject({ text: '3.14', number: '3.14', current: 3.14 });
    expect(choicesAfter(s, '3.12')?.edits).toEqual({ v0: 3.12 });
    expect(choicesAfter(s, '3.14')?.edits).toEqual({ v0: 3.14 });
  });

  it('an emptied input unticks the row and drops its text; anything typed into a cleared row ticks it', () => {
    const typed = chose(ldl(3.1), 'f0', { typed: 'v0', text: 'abc', unit: 'si' });
    expect(choicesAfter(typed, '')).toMatchObject({ ticks: { v0: false } });
    expect(choicesAfter(typed, '')).not.toHaveProperty('typed');
    const cleared = chose(ldl(3.1), 'f0', { tick: 'v0', on: false });
    expect(choicesAfter(cleared, 'x')).toMatchObject({ ticks: { v0: true }, typed: { v0: { text: 'x', unit: 'si' } } });
  });

  it('held text leaves the rows Save writes and the label, though its slot stays taken', async () => {
    const s = chose(open([labRead('f0', { values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]), 'f0', { typed: 'v1', text: '1,2,3', unit: 'si' });
    const { view, review, list } = see(s, EMPTY);
    expect(view.save.label).toBe(IMPORT_REVIEW_TEXT.save(1));
    expect(reviewedWrites(review).map((v) => v.ref)).toEqual(['v0']);
    expect(list.rows[1]).toMatchObject({ saves: false, error: expect.any(String) });
    expect(await saveRefused(s, EMPTY)).toBe(FIX_ERRORS_TEXT);
  });
});

describe('owner rulings on PR 1944 (2026-11-21)', () => {
  it('Save\'s blockers: sent rows first, then days, then rows not sent, so the phone\'s `why` stays main\'s', () => {
    // Held text blocks; an out-of-range number alone no longer does (US-13 AC27).
    const s = chose(chose(open([
      labRead('f0', { values: [core({})] }), // sent, held text
      labRead('f1', { reportDate: null, values: [core({ valueSI: 600, displayValue: 600 })] }), // waits for its day; held text, not sent
    ]), 'f1', { typed: 'v0', text: 'abc', unit: 'si' }), 'f0', { typed: 'v0', text: 'abc', unit: 'si' });
    const { view } = see(s, EMPTY);
    expect(view.save.blockers).toEqual([
      { why: FIX_ERRORS_TEXT, at: 'f0:v0' },
      { why: UPLOAD_TEXT.chooseDay, at: 'f1|test' },
      { why: FIX_ERRORS_TEXT, at: 'f1:v0' },
    ]);
    expect(view.save.why).toBe(FIX_ERRORS_TEXT);
  });

  // KNOWN labAsCoreOutOfRange (main's rule kept): an additional lab the engine files as a core metric, out of range, is
  // not written and does not block Save; the list shows the write's own words on the row, so it is never silent (L5).
  it('KNOWN labAsCoreOutOfRange: not written, no blocker, the write\'s words on the row', () => {
    const s = open([labRead('f0', { values: [core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })], additionalValues: [extra({ name: 'LDL Cholesterol', value: 500, unit: 'mmol/L' })] })]);
    const { list, view, review } = see(s, EMPTY);
    const row = list.rows.find((r) => r.ref === 'a0')!;
    expect(row).toMatchObject({ ticked: true, saves: false, status: { kind: 'check' }, error: expect.any(String) });
    expect(row.caption).toBe(row.error);
    expect(view.save).toMatchObject({ enabled: true, blockers: [], label: IMPORT_REVIEW_TEXT.save(1) });
    expect(reviewedWrites(review).map((v) => v.ref)).toEqual(['v0']);
  });

  it('a ticked, out-of-range value whose own printed day is still to come does not block: not saved, captioned', () => {
    let s: UploadState = open([labRead('f0', { reportDate: '2026-12-15', values: [core({ valueSI: 500, displayValue: 500, recordedAt: '2026-12-01' }), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]);
    s = chose(s, 'f0', { testDay: '2026-10-20' });
    const { list, view } = see(s, EMPTY);
    expect(list.rows[0]).toMatchObject({ ticked: true, saves: false, error: 'Max 12.9 mmol/L', status: { kind: 'notSaved', reason: 'futureCoreDay' }, caption: NOT_SAVED_TEXT.futureCoreDay });
    expect(view.save).toMatchObject({ enabled: true, blockers: [] });
  });
});
