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
import { FIX_ERRORS_TEXT, UPLOAD_TEXT } from './upload-text';
import { uploadView, type UploadView, type ValueRow } from './upload-view';

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
const off = { holds: () => false, original: () => null, mimeType: () => '', write: async () => {}, now: () => NOW };

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

  it('refusedAfterChange (seed 869): a record change that makes Save refuse leaves Save waiting after the failure, saying why', () => {
    // The other writer's diastolic makes the upload's systolic the wrong way up; the app sends the refusal as a failed Save.
    const record = held([{ kind: 'measurement', metricType: 'diastolic_bp', value: 125, recordedAt: DAY, source: 'manual' }]);
    const s: UploadState = { ...open([labRead('f0', { values: [core({ metric: 'systolic_bp', valueSI: 120, displayValue: 120, displayUnit: 'mmHg' })] })]), phase: 'saveFailed', attempt: 1, message: FIX_ERRORS_TEXT };
    const { view } = see(s, record);
    expect(view.save).toMatchObject({ enabled: false, why: FIX_ERRORS_TEXT });
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

// Found by the list-view property on PR 1926 (seed 964), owner ruling 2026-11-21: option A for PR 0, since nothing draws column days yet.
describe('a dated previous column waiting for its pick (US-13 AC24)', () => {
  const PRINTED = '2026-10-01';
  // Seed 964's report: a Ferritin 80 printed on a previous day the record already holds; an LDL beside it differs from the held one.
  const s = (): UploadState => chose({ ...open([labRead('f0', {
    values: [core({ valueSI: 3.1, displayValue: 3.1, recordedAt: PRINTED })],
    additionalValues: [extra({ value: 80, recordedAt: PRINTED })],
  })]), platform: 'web' }, 'f0', { columnDay: PRINTED, day: '2026-10' });
  const record = held([LDL(2.0, PRINTED), { kind: 'lab', metricName: 'Ferritin', value: 80, unit: 'µg/L', referenceLow: null, referenceHigh: null, recordedAt: PRINTED, source: 'manual' }]);

  // KNOWN, for the PR that first DRAWS the column picker, which must flip this pin: a value whose dated column waits for its
  // pick has no day (the review's `days` is null), yet the classifier still previews it on its printed day. It can read
  // "already in your record", or offer Replace against the printed-day slot, for a column the person is moving. The deeper fix:
  // `valueDays` (import-review.ts) takes a column map beside `undatedDay`, so `ImportFile.days` and the lab file's `days` are one record.
  it('KNOWN columnWaitsPreviewedOnPrintedDay: a waiting column\'s values are classified on the day they printed', () => {
    const { review, view } = see(s(), record);
    expect(review.labFiles[0]).toMatchObject({ needsColumnDay: true, days: { v0: null, a0: null }, waits: ['v0', 'a0'] });
    expect(view.alreadySaved).toBe(IMPORT_REVIEW_TEXT.alreadySaved(1));
    expect(rows(view)).toMatchObject([{ ref: 'v0', day: null, conflict: IMPORT_REVIEW_TEXT.conflictKept, replace: expect.any(String) }]);
  });

  // KNOWN (PR 1926 R2), for the PR that draws the column picker to decide: `needsColumnDay` counts a value the write refuses
  // on any day (a lab with an unknown unit), so that value alone holds up the report while its column waits. The test's day
  // beside it does not wait for such a value (`refusedAnyDay`: it sits under Not saved and asks no day).
  it('KNOWN columnWaitsOnRefusedValue: a waiting column holding only a value refused on any day still holds up Save', () => {
    const lone = chose({ ...open([labRead('f0', {
      values: [core({ valueSI: 3.1, displayValue: 3.1 })],
      additionalValues: [extra({ unit: 'zzz', recordedAt: PRINTED })],
    })]), platform: 'web' }, 'f0', { columnDay: PRINTED, day: '2026-10' });
    const { review, view } = see(lone, EMPTY);
    expect(review.labFiles[0]).toMatchObject({ needsColumnDay: true, waits: ['a0'] });
    expect(review.classification.rows).toEqual([]);
    expect(view.save).toMatchObject({ enabled: false, why: UPLOAD_TEXT.chooseDay });
  });

  it('columnWaitsNeverWritten (negative pin): nothing of a report whose column waits is written, and Save says to choose the day', () => {
    const { review, view } = see(s(), record);
    expect(review.classification.rows).toEqual([]);
    expect(reviewedWrites(review)).toEqual([]);
    expect(view.save).toMatchObject({ enabled: false, why: UPLOAD_TEXT.chooseDay });
  });
});
