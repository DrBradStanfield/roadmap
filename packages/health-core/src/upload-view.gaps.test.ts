/**
 * The gaps upload-view.property.test.ts found between the list view and Save, each at the seed that
 * first showed it, now fixed (owner rulings 2026-11-20; US-52 AC8c, US-13 AC13, US-12 AC6a). Each
 * test was "today's behaviour" in PR 1911 and now states the ruled behaviour. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW } from './import-review.test-helpers';
import { IMPORT_REVIEW_TEXT, NOT_SAVED_TEXT } from './import-review';
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues, type BulkRow } from './record-edits';
import { DAY_NOT_HAPPENED, LAB_DAY_REFUSAL } from './lab-series';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { lostReplaces, reviewedWrites, uploadReview } from './upload-review';
import { uploadSave } from './upload-save';
import { DAY_CONTROL_TEXT, FIX_ERRORS_TEXT, UPLOAD_TEXT } from './upload-text';
import { uploadView, type UploadView, type ValueRow } from './upload-view';
import { uploadList } from './upload-list';
import { PRESSURE_ORDER } from './validation';

const PICKED_DAY = '2026-10-20';
const FUTURE = '2026-12-01';
const REPORT_FUTURE = '2026-12-15';

type Open = Extract<UploadState, { phase: 'open' }>;
const labRead = (id: string, over: Partial<UnifiedExtractionResult>): Open['files'][number] => ({
  id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
const open = (files: Open['files']): Open => ({ phase: 'open', platform: 'phone', run: 1, files, started: NOW, firstRead: NOW });
const see = (s: UploadState, record: RoadmapFile) => { const review = uploadReview(s, record, NOW); return { review, view: uploadView(s, record, NOW, review, false) }; };
const chose = (s: UploadState, id: string, change: ChoiceChange) => transition(s, { type: 'chose', id, change, now: NOW }).state;
/** Save pressed as the engine door steps it: with what the page would write (ios/engine/upload-doors.ts). */
const saveOn = (s: UploadState, record: RoadmapFile) => transition(s, { type: 'saveStarted', reviewed: reviewedWrites(uploadReview(s, record, NOW)) }).state;
const held = (rows: BulkRow[]) => bulkAppendValues(EMPTY, rows, NOW).file;
const LDL = (value: number, recordedAt = DAY): BulkRow => ({ kind: 'measurement', metricType: 'ldl', value, recordedAt, source: 'manual' });
const rows = (view: UploadView): ValueRow[] => [...view.sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : [])), ...(view.sure?.rows ?? [])];
const notSaved = (view: UploadView) => view.sections.flatMap((x) => (x.kind === 'notSaved' ? x.lines : []));
const off = { stopped: () => false, holds: () => false, original: () => null, mimeType: () => '', write: async () => {}, now: () => NOW };

/** Save as the platform runs it, committed on `atCommit` (the record, or one another writer changed), then the done view. */
async function saved(s: UploadState, record: RoadmapFile, atCommit = record) {
  const out = await uploadSave(saveOn(s, record), record, NOW, false, off);
  if (!out.ok) throw new Error(out.message);
  const { file, outcome } = out.commit(atCommit);
  const done: UploadState = { ...(s as Open), phase: 'done', outcome };
  return { file, outcome, done: uploadView(done, file, NOW, uploadReview(done, file, NOW), false).done! };
}

describe('gaps the list-view property found, fixed (owner rulings 2026-11-20)', () => {
  it('futureOwnDay (seed 227): a value whose own printed day has not happened is never a ticked row: it is named under Not saved', () => {
    let s: UploadState = open([labRead('f0', { reportDate: REPORT_FUTURE, values: [core({ recordedAt: FUTURE }), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]);
    s = chose(s, 'f0', { testDay: PICKED_DAY });
    const { view } = see(s, EMPTY);
    expect(rows(view).map((row) => row.ref)).toEqual(['v1']);
    expect(notSaved(view)).toEqual([`LDL Cholesterol: ${DAY_NOT_HAPPENED}`]); // a core value: the blood test words (adversary R5)
    expect(view.save).toMatchObject({ enabled: true, label: IMPORT_REVIEW_TEXT.save(1) });
  });

  it('replaceOnCopy (seed 196): a copy of another reading has no Replace, says it is the same test and day, and Replace on the first one writes', async () => {
    const record = held([LDL(2.0)]);
    const s = open([labRead('f0', { values: [core({})] }), labRead('f1', { values: [core({})] })]);
    const [first, copy] = rows(see(s, record).view);
    expect(copy).toMatchObject({ fileId: 'f1', replaces: null, replace: null, replacing: false, copy: NOT_SAVED_TEXT.sameDay, conflict: null }); // only its caption: nothing to resolve (adversary R5)
    expect(first).toMatchObject({ fileId: 'f0', copy: null, replace: 'Replace' });
    const replaced = chose(s, 'f0', { replace: 'v0', correctsId: first.replaces! });
    const { file, outcome } = await saved(replaced, record);
    expect(outcome.values).toBe(1);
    expect(file.labValues.filter((l) => l.metricName === 'ldl' && l.status === 'active').map((l) => l.value)).toEqual([3.1]);
  });

  it('droppedUncounted (seed 91): a reviewed value whose slot another writer took before the commit is counted, in the web\'s words', async () => {
    const s = open([labRead('f0', { values: [core({})] })]);
    expect(see(s, EMPTY).view.save.label).toBe(IMPORT_REVIEW_TEXT.save(1));
    const { outcome, done } = await saved(s, EMPTY, held([LDL(2.7)]));
    expect(outcome).toMatchObject({ values: 0, skippedValues: 1 });
    expect(done.line).toBe('Saved 0 values.');
    expect(done.skipped).toEqual([UPLOAD_TEXT.skippedLine(1, false)]);
  });

  it('dayForNothing (seed 37): an undated report of only refused values asks no day; they sit under Not saved and its original is filed undated', () => {
    const s = open([labRead('f0', { reportDate: null, additionalValues: [extra({ unit: 'zzz' })] }), labRead('f1', { values: [core({})] })]);
    const { view, review } = see(s, EMPTY);
    expect(view.sections.filter((x) => x.kind === 'undated')).toEqual([]);
    expect(view.save).toMatchObject({ enabled: true, label: IMPORT_REVIEW_TEXT.save(1) });
    expect(notSaved(view)).toEqual([expect.stringContaining('Ferritin')]);
    expect(uploadSavePlan(s, EMPTY, NOW, review, true).labArchives).toContainEqual({ fileId: 'f0', sourceFileName: 'f0.pdf', reportDate: null });
  });

  it('futureOwnDay for a lab: the lab words', () => {
    let s: UploadState = open([labRead('f0', { reportDate: REPORT_FUTURE, additionalValues: [extra({ recordedAt: FUTURE })], values: [core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]);
    s = chose(s, 'f0', { testDay: PICKED_DAY });
    expect(notSaved(see(s, EMPTY).view)).toEqual([`Ferritin: ${LAB_DAY_REFUSAL}`]);
  });

  it('dayForNothing: an out-of-range value still asks the day (it can be corrected, and then saves)', () => {
    const s = open([labRead('f0', { reportDate: null, values: [core({ valueSI: 500, displayValue: 500 })] })]);
    expect(see(s, EMPTY).view.save.why).toBe(UPLOAD_TEXT.chooseDay);
  });

  it('savedNotShown (seed 3): a value the record already holds is counted, as the web counts it', () => {
    const { view } = see(open([labRead('f0', { values: [core({})] })]), held([LDL(3.1)]));
    expect(rows(view)).toEqual([]);
    expect(view.alreadySaved).toBe(IMPORT_REVIEW_TEXT.alreadySaved(1));
    expect(view.save.why).toBe(UPLOAD_TEXT.saveNothing);
  });

  // KNOWN, left for the engine-owned matrix work: ruling 7 was reverted (Codex re-check on c890ebc42), because counting an
  // edit equal to the held value as saved, after slot placement, hid a differing sibling's conflict. The phone has no edit control.
  it('KNOWN editEqualSaysDifferent: an edit typed equal to the held value reads "a different value"', () => {
    const s = chose(open([labRead('f0', { values: [core({ valueSI: 2.4, displayValue: 2.4 })] })]), 'f0', { edit: 'v0', value: 3.1 });
    const { view, review } = see(s, held([LDL(3.1)]));
    expect(rows(view)).toMatchObject([{ conflict: IMPORT_REVIEW_TEXT.conflictKept }]);
    expect(review.classification.rows).toEqual([]);
  });

  it('doneDocumentsDiffer (seed 1): a lab report alone that the label calls "Save 1 value" ends "Saved 1 value."', async () => {
    const s = open([labRead('f0', { values: [core({})] })]);
    expect(see(s, EMPTY).view.save.label).toBe('Save 1 value');
    expect((await saved(s, EMPTY)).done.line).toBe('Saved 1 value.');
  });

  it('ticksAfterFailedSave: a tick after a failed Save returns to the review and is what the retry writes', () => {
    const failed: UploadState = { ...open([labRead('f0', { values: [core({})] })]), phase: 'saveFailed', attempt: 1, message: 'The cloud refused the write.' };
    const next = chose(failed, 'f0', { tick: 'v0', on: false });
    expect(next.phase).toBe('open');
    expect(rows(see(next, EMPTY).view)).toMatchObject([{ ticked: false }]);
  });

  // US-13 AC27 replaced the wait: the write refuses that row alone, which keeps its words; with nothing else to write,
  // the retry waits, saying so (owner ruling on PR 2152).
  it('refusedAfterChange (seed 869): a record change that makes the write refuse a row leaves the row saying why; Save waits on nothing to save', () => {
    // The other writer's diastolic makes the upload's systolic the wrong way up; the app sends the refusal as a failed Save.
    const record = held([{ kind: 'measurement', metricType: 'diastolic_bp', value: 125, recordedAt: DAY, source: 'manual' }]);
    const s: UploadState = { ...open([labRead('f0', { values: [core({ metric: 'systolic_bp', valueSI: 120, displayValue: 120, displayUnit: 'mmHg' })] })]), phase: 'saveFailed', attempt: 1, message: FIX_ERRORS_TEXT };
    const { view } = see(s, record);
    expect(view.save).toMatchObject({ enabled: false, why: UPLOAD_TEXT.saveNothing, blockers: [] });
    expect(rows(view)).toMatchObject([{ ticked: true, error: expect.any(String) }]);
  });

  it('staleReplaceDeleted (ruling 9b a): a Replace whose held row another device deleted is dropped and the value unticked; ticked, it saves as a new row', async () => {
    const record = held([LDL(2.0)]);
    const s = chose(open([labRead('f0', { values: [core({})] })]), 'f0', { replace: 'v0', correctsId: record.labValues[0].id });
    const deleted = { ...record, labValues: record.labValues.map((l) => ({ ...l, status: 'entered-in-error' as const })) };
    // What the engine door does before each event and in each view (ios/engine/upload-doors.ts).
    const lost = lostReplaces(uploadReview(s, deleted, NOW), s);
    expect(lost).toEqual([{ id: 'f0', ref: 'v0' }]);
    const after = transition(s, { type: 'replacesLost', lost }).state;
    expect(rows(see(after, deleted).view)).toMatchObject([{ ticked: false, conflict: null, replace: null, replaces: null }]);
    const { file, outcome } = await saved(chose(after, 'f0', { tick: 'v0', on: true }), deleted);
    expect(outcome.values).toBe(1);
    expect(file.labValues.filter((l) => l.status === 'active').map((l) => [l.value, l.correctsId ?? null])).toEqual([[3.1, null]]);
  });

  it('refusedAtCommit (seed 277): a pair another writer turns the wrong way up before the commit is named on the done screen', async () => {
    const bp = (metric: string, v: number) => core({ metric, valueSI: v, displayValue: v, displayUnit: 'mmHg' });
    const s = open([labRead('f0', { values: [bp('systolic_bp', 120), bp('diastolic_bp', 80)] })]);
    expect(see(s, EMPTY).view.save.label).toBe(IMPORT_REVIEW_TEXT.save(2));
    const { outcome, done } = await saved(s, EMPTY, held([{ kind: 'measurement', metricType: 'diastolic_bp', value: 125, recordedAt: DAY, source: 'manual' }]));
    expect(outcome.values).toBe(0);
    expect(done.line).toBe('Saved 0 values.');
    expect(done.notSaved).toEqual(['Blood pressure not saved: the top number (systolic) must be higher than the bottom number (diastolic). Check the report, then enter it again.']);
  });

  // Fix round on 52434ce85 (Codex R1, adversary R6): Save writes exactly what the page displayed as to be written.
  it('writes exactly what was displayed: a sync lands a different LDL between the displayed review and the tap, and the LDL is counted as not added', async () => {
    const s = open([labRead('f0', { values: [core({})] })]);
    const shown = see(s, EMPTY).view;
    expect(shown.reviewed).toEqual([{ file: 'f0', ref: 'v0', lab: false }]);
    const synced = held([LDL(2.7)]);
    const saving = transition(s, { type: 'saveStarted', reviewed: shown.reviewed }).state; // echoed by the app, as drawn
    const out = await uploadSave(saving, synced, NOW, false, off);
    if (!out.ok) throw new Error(out.message);
    const { outcome } = out.commit(synced);
    expect(outcome).toMatchObject({ values: 0, skippedValues: 1 });
  });

  it('writes exactly what was displayed: a kept conflict whose held row is deleted between the tap and the save is not written into the freed slot', async () => {
    const record = held([LDL(2.0)]);
    const s = open([labRead('f0', { values: [core({})] }), labRead('f1', { values: [core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]);
    const shown = see(s, record).view;
    expect(shown.save.label).toBe(IMPORT_REVIEW_TEXT.save(1)); // the HbA1c; the LDL conflict is kept
    const saving = transition(s, { type: 'saveStarted', reviewed: shown.reviewed }).state;
    const deleted = { ...record, labValues: record.labValues.map((l) => ({ ...l, status: 'entered-in-error' as const })) };
    const out = await uploadSave(saving, deleted, NOW, false, off);
    if (!out.ok) throw new Error(out.message);
    const { file, outcome } = out.commit(deleted);
    expect(file.labValues.filter((l) => l.status === 'active').map((l) => l.metricName)).toEqual(['hba1c']);
    expect(outcome.values).toBe(1);
  });

  it('an edit that differs from the held value stays a conflict, and with Replace it is written (negative pin for editEqualSaysDifferent)', async () => {
    const record = held([LDL(3.1)]);
    let s: UploadState = chose(open([labRead('f0', { values: [core({ valueSI: 2.4, displayValue: 2.4 })] })]), 'f0', { edit: 'v0', value: 2.6 });
    const [row] = rows(see(s, record).view);
    expect(row).toMatchObject({ conflict: IMPORT_REVIEW_TEXT.conflictKept, value: '2.6' });
    expect(see(s, record).view.alreadySaved).toBeNull();
    s = chose(s, 'f0', { replace: 'v0', correctsId: row.replaces! });
    const { file, outcome } = await saved(s, record);
    expect(outcome.values).toBe(1);
    expect(file.labValues.filter((l) => l.status === 'active').map((l) => [l.value, l.correctsId])).toEqual([[2.6, record.labValues[0].id]]);
  });

  it('P7: an edited value shows the number Save writes, in its SI unit', () => {
    const s = chose(open([labRead('f0', { values: [core({ valueSI: 3.0, displayValue: 116, displayUnit: 'mg/dL', displaySystem: 'conventional' })] })]), 'f0', { edit: 'v0', value: 2.5 });
    expect(rows(see(s, EMPTY).view)).toMatchObject([{ value: '2.5', unit: 'mmol/L' }]);
  });
});

// Found reviewing PR 1926 (adversary R2, R3; 2026-11-21), on main: an undated previous column's value.
describe('the undated previous column (US-13 AC25)', () => {
  const undated = (reportDate: string | null) => labRead('f0', { reportDate, values: [core({ recordedAt: UNDATED_PREVIOUS })] });

  it('undatedPreviousDay: once its day is picked, its row shows that day, the day Save writes (before, the report\'s)', () => {
    let s: UploadState = open([undated(DAY)]);
    expect(rows(see(s, EMPTY).view)).toEqual([]); // before a pick it waits behind the day question, no row
    s = chose(s, 'f0', { previousDay: '2026-10-05' });
    const { review, view } = see(s, EMPTY);
    expect(rows(view)[0]).toMatchObject({ ref: 'v0', day: '2026-10-05' });
    expect(uploadSavePlan(s, EMPTY, NOW, review, false).labRows[0].rows[0].recordedAt.slice(0, 10)).toBe('2026-10-05');
  });

  // Property seed 66 with the generator extended to the web's undated column: a cleared value vanished from the page.
  it('undatedClearedStaysReachable: a cleared value whose column\'s day stops being valid keeps the day question, so it can be found again', () => {
    let s: UploadState = { ...open([undated(DAY)]), platform: 'web' };
    s = chose(s, 'f0', { previousDay: '2026-10-05' });
    s = chose(s, 'f0', { tick: 'v0', on: false });
    s = chose(s, 'f0', { previousDay: DAY }); // on the report's day: no longer a previous day
    const { review, view } = see(s, EMPTY);
    expect(review.classification.values.find((v) => v.ref === 'v0')).toMatchObject({ group: 'waiting' });
    expect(view.sections).toContainEqual(expect.objectContaining({ kind: 'undatedPrevious', fileId: 'f0' }));
    expect(view.save.why).not.toBe(UPLOAD_TEXT.chooseDay); // nothing ticked waits: the question holds up no Save
  });

  it('undatedReplaceKept: a Replace on it is kept, never dropped and unticked, when its pick stops being before the test\'s day', () => {
    const record = held([LDL(2.0, '2026-10-05')]);
    const target = record.labValues[0].id;
    let s: UploadState = open([undated(null)]);
    s = chose(s, 'f0', { previousDay: '2026-10-05' });
    s = chose(s, 'f0', { replace: 'v0', correctsId: target });
    expect(see(s, record).review.labFiles[0].replacing).toEqual(['v0']);
    s = chose(s, 'f0', { testDay: '2026-10-03' }); // the previous day is no longer before the test's: the column waits
    const { review, view } = see(s, record);
    expect(lostReplaces(review, s)).toEqual([]);
    expect(review.labFiles[0]).toMatchObject({ needsPreviousDay: true, ticked: ['v0'], replacing: ['v0'] });
    expect(review.classification.rows).toEqual([]);
    expect(view.save).toMatchObject({ enabled: false, why: UPLOAD_TEXT.chooseDay });
  });
});

// KNOWN phoneEditPreview (owner ruling 2026-11-21, web list PR 1b): the phone's door takes an edit (PHONE_CHANGE) though no
// page sends one, and its preview of a value not sent reads the number read, never the edit (`reviewFlags`). A lead, not
// a fault today: when the phone gets a value-edit control, its preview must take the edit too.
describe('the phone\'s preview of a value not sent', () => {
  it('KNOWN phoneEditPreview: an edited, cleared out-of-range value of a waiting report is still previewed out of range on the phone', () => {
    let s: UploadState = open([labRead('f0', { reportDate: null, values: [core({ valueSI: 500, displayValue: 500 })] })]);
    s = chose(chose(s, 'f0', { tick: 'v0', on: false }), 'f0', { edit: 'v0', value: 3.1 });
    expect(see(s, EMPTY).review.classification.values[0]).toMatchObject({ group: 'unsure', reasons: ['outOfRange'] });
    expect(see({ ...s, platform: 'web' } as UploadState, EMPTY).review.classification.values[0]).toMatchObject({ group: 'waiting' });
  });
});

// Found by the list-view property on PR 1942 (seed 71), owner ruling 2026-11-21; closed in web list PR 1b, where each row's
// error comes from its own candidate (upload-candidates.ts). The phone's view is unchanged: its copies still draw none.
describe('a copy of a refused reading (web list PR 1b)', () => {
  it('copyBlocksWithoutError, closed: in the web list a copy of a blood pressure the write refuses draws the error it is refused for (US-13 AC27)', () => {
    const turned = [core({ metric: 'systolic_bp', valueSI: 80, displayValue: 80, displayUnit: 'mmHg' }), core({ metric: 'diastolic_bp', valueSI: 120, displayValue: 120, displayUnit: 'mmHg' })];
    const s = open([labRead('f0', { values: [...turned, ...turned] })]);
    const { view, review } = see(s, EMPTY);
    expect(view.save.blockers).toEqual([]);
    const list = uploadList(s, EMPTY, NOW, review, () => 'si');
    expect(list.rows.map((r) => [r.ref, r.error, r.status.kind])).toEqual(['v0', 'v1', 'v2', 'v3'].map((ref) => [ref, PRESSURE_ORDER, 'refused']));
    // The phone's view, as main drew it.
    expect(rows(view).filter((r) => r.ref === 'v2' || r.ref === 'v3').map((r) => [r.ref, r.error, r.copy])).toEqual([['v2', null, NOT_SAVED_TEXT.sameDay], ['v3', null, NOT_SAVED_TEXT.sameDay]]);
  });
});

// Found by the list-view property on PR 1926 (seed 964), owner ruling 2026-11-21: option A for PR 0, since nothing draws column days yet.
describe('a dated previous column waiting for its pick (US-13 AC24)', () => {
  const PRINTED = '2026-10-01';
  // Seed 964's report: a Ferritin 80 printed on a previous day the record already holds; an LDL beside it differs from the held one.
  const s = (): UploadState => chose({ ...open([labRead('f0', {
    values: [core({ valueSI: 3.1, displayValue: 3.1, recordedAt: PRINTED })],
    additionalValues: [extra({ value: 80, recordedAt: PRINTED })],
  })]), platform: 'web' }, 'f0', { columnDay: PRINTED, day: '2026-10' });
  const record = held([LDL(2.0, PRINTED), { kind: 'lab', metricName: 'Ferritin', value: 80, unit: 'µg/L', referenceLow: null, referenceHigh: null, recordedAt: PRINTED, source: 'manual' }]);

  // Closed in web list PR 1b (`valueDays` takes the column map): a value whose dated column waits for its pick has no day,
  // so it is judged on none, never previewed on the day it printed: no "already in your record", no Replace against a slot
  // the person is moving it off.
  it('columnWaitsPreviewedOnPrintedDay, closed: a waiting column\'s values are judged on no day', () => {
    const { review, view } = see(s(), record);
    expect(review.labFiles[0]).toMatchObject({ needsColumnDay: true, days: { v0: null, a0: null }, waits: ['v0', 'a0'] });
    expect(view.alreadySaved).toBeNull();
    expect(rows(view)).toEqual([]);
    expect(review.classification.values.filter((v) => v.ref[0] !== 'r').map((v) => [v.ref, v.group])).toEqual([['v0', 'waiting'], ['a0', 'waiting']]);
    expect(review.held.size).toBe(0);
  });

  // Closed in web list PR 1b (owner's word): a value the write refuses on any day does not make its column wait, as the
  // test's day does not wait for one; it sits under Not saved.
  it('columnWaitsOnRefusedValue, closed: a waiting column holding only a value refused on any day holds up nothing', () => {
    const lone = chose({ ...open([labRead('f0', {
      values: [core({ valueSI: 3.1, displayValue: 3.1 })],
      additionalValues: [extra({ unit: 'zzz', recordedAt: PRINTED })],
    })]), platform: 'web' }, 'f0', { columnDay: PRINTED, day: '2026-10' });
    const { review, view } = see(lone, EMPTY);
    expect(review.labFiles[0]).toMatchObject({ needsColumnDay: false, waits: ['a0'] });
    expect(review.classification.rows).toHaveLength(1);
    expect(view.save).toMatchObject({ enabled: true, why: null, label: IMPORT_REVIEW_TEXT.save(1) });
    expect(notSaved(view)).toEqual([`Ferritin: ${NOT_SAVED_TEXT.unit}`]);
  });

  // Closed in web list PR 1b: the web's list draws a control for every day source, a dated column's by the day it printed.
  it('columnBlockerUndrawn, closed: a waiting dated column\'s blocker names a day control the list draws', () => {
    const state = s();
    const { view, review } = see(state, record);
    expect(view.save.blockers).toEqual([{ why: UPLOAD_TEXT.chooseDay, at: `f0|printed:${PRINTED}` }]);
    const list = uploadList(state, record, NOW, review, () => 'si');
    expect(list.days).toEqual([{ key: `f0|printed:${PRINTED}`, fileId: 'f0', source: 'column', printed: PRINTED, chosen: '2026-10', day: null, printedLine: '1 Oct 2026', label: DAY_CONTROL_TEXT.previous,
      // Web list PR 1e: a partial pick shows nothing in the picker, and the control names its limits (it said nothing).
      picker: null, pickerLine: DAY_CONTROL_TEXT.noDay, hint: DAY_CONTROL_TEXT.pickDay(null, '2026-11-01'),
      fileName: 'f0.pdf', name: `${DAY_CONTROL_TEXT.previous}, 1 Oct 2026, f0.pdf` }]);
    expect(list.rows.map((r) => [r.key, r.section, r.status.kind])).toEqual([['f0:v0', `f0|printed:${PRINTED}`, 'waits'], ['f0:a0', `f0|printed:${PRINTED}`, 'waits']]);
  });

  it('columnWaitsNeverWritten (negative pin): nothing of a report whose column waits is written, and Save says to choose the day', () => {
    const { review, view } = see(s(), record);
    expect(review.classification.rows).toEqual([]);
    expect(reviewedWrites(review)).toEqual([]);
    expect(view.save).toMatchObject({ enabled: false, why: UPLOAD_TEXT.chooseDay });
  });
});
