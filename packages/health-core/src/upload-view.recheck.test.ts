/**
 * Codex's re-check on PR 1840, one block per gap: a selected value out of range blocks Save
 * (US-13 AC5); a Replace never follows a value to another day (US-13 AC7); a file read only in
 * part is named (US-12 AC9); a chosen Replace reads as what Save will do. Synthetic values.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, NOW, recordWith } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type ChoiceChange, type FileChoices } from './upload-choices';
import { transition, type UploadFile, type UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { FILE_NOTICE_TEXT, FIX_ERRORS_TEXT, UPLOAD_TEXT } from './upload-text';
import { uploadView, type ValueRow } from './upload-view';

const labX = (over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: DAY, values: [core()], additionalValues: [], unrecognized: [], document: null, ...over });
const read = (id: string, choices: Partial<FileChoices> = {}, truncated = false): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated }, status: { s: 'read', extraction: labX(), choices: { ...NO_CHOICES, ...choices } } });
const open = (files: UploadFile[]): UploadState => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: null });
const both = (s: UploadState, record: RoadmapFile = EMPTY) => {
  const review = uploadReview(s, record, NOW);
  return { plan: uploadSavePlan(s, record, NOW, review, true), view: uploadView(s, record, NOW, review, true) };
};
const rows = (s: UploadState, record: RoadmapFile): ValueRow[] => both(s, record).view.sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : []));
const chose = (s: UploadState, change: ChoiceChange) => transition(s, { type: 'chose', id: 'a', change, now: NOW }).state;

describe('US-13 AC5: a selected core value out of its range blocks Save', () => {
  it('LDL edited to 999 blocks Save with the web\'s words and names the row; correcting or unticking it frees Save', () => {
    const wild = open([read('a', { edits: { v0: 999 } })]);
    const { view } = both(wild);
    expect(view.save).toMatchObject({ enabled: false, why: FIX_ERRORS_TEXT });
    expect(rows(wild, EMPTY).find((r) => r.ref === 'v0')?.error).toEqual(expect.any(String));
    expect(both(chose(wild, { edit: 'v0', value: 3.5 })).view.save).toMatchObject({ enabled: true, why: null });
    expect(both(chose(wild, { tick: 'v0', on: false })).view.save).toMatchObject({ why: 'Nothing new to save' });
    expect(both(chose(wild, { tick: 'v0', on: false })).view.save.why).not.toBe(FIX_ERRORS_TEXT);
  });
});

describe('US-13 AC7: a Replace never follows its value to another day', () => {
  const OTHER = '2026-10-15';
  const EMPTY_DAY = '2026-10-20';
  const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.0 }, { kind: 'measurement', metricType: 'ldl', value: 4.4, recordedAt: OTHER }]);
  const heldOn = (day: string) => record.labValues.concat().find((r) => r.recordedAt.slice(0, 10) === day)?.id ?? record.measurements.find((r) => r.recordedAt.slice(0, 10) === day)!.id;

  it('moved to an empty day: the Replace is cleared and the value saves as a first row', () => {
    const replaced = chose(open([read('a')]), { replace: 'v0', correctsId: heldOn(DAY) });
    expect(both(replaced, record).plan.labRows[0].rows[0]).toMatchObject({ correctsId: heldOn(DAY) });
    const movedState = chose(replaced, { testDay: EMPTY_DAY });
    expect('files' in movedState && movedState.files[0].status).toMatchObject({ choices: { replace: {} } });
    const [row] = both(movedState, record).plan.labRows[0].rows;
    expect(row.recordedAt.slice(0, 10)).toBe(EMPTY_DAY);
    expect(row.correctsId).toBeUndefined();
  });

  it('moved to a day another row holds: the conflict is shown again, Replace off', () => {
    const replaced = chose(open([read('a')]), { replace: 'v0', correctsId: heldOn(DAY) });
    const movedState = chose(replaced, { testDay: OTHER });
    const [row] = rows(movedState, record);
    expect(row).toMatchObject({ ref: 'v0', replacing: false, replaces: heldOn(OTHER), conflict: 'Your record already has a different value for this day. It stays as it is.' });
    expect(both(movedState, record).plan.counts.values).toBe(0);
  });

  it('defence in depth: a Replace aimed at a row not on the value\'s day is ignored', () => {
    const stale = open([read('a', { replace: { v0: heldOn(OTHER) } })]);
    expect(both(stale, record).plan.counts.values).toBe(0);
    expect(rows(stale, record)[0]).toMatchObject({ replacing: false });
  });
});

describe('US-12 AC9: a file read only in part is named', () => {
  it('in the open review and on the done screen, in the web\'s words', () => {
    const s = open([read('a', {}, true)]);
    expect(both(s).view.notices).toEqual([{ fileId: 'a', name: 'a.pdf', line: FILE_NOTICE_TEXT.truncated }]);
    const done: UploadState = { ...s, phase: 'done', outcome: { values: 1, documents: 0, archived: 0 } } as UploadState;
    expect(both(done).view.notices).toEqual([{ fileId: 'a', name: 'a.pdf', line: FILE_NOTICE_TEXT.truncated }]);
  });
});

describe('a chosen Replace reads as what Save will do', () => {
  it('the row says it replaces the held value, and carries the control\'s state', () => {
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.0 }]);
    const before = rows(open([read('a')]), record)[0];
    expect(before).toMatchObject({ replacing: false, conflict: 'Your record already has a different value for this day. It stays as it is.' });
    const after = rows(chose(open([read('a')]), { replace: 'v0', correctsId: before.replaces! }), record)[0];
    expect(after).toMatchObject({ replacing: true, replaces: before.replaces, conflict: UPLOAD_TEXT.replaces });
  });
});
