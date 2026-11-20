/**
 * PR 1906 owner ruling 2026-11-20 (US-12 AC6a): a value the person reviewed that Save did not write
 * never vanishes silently. Save plans on the record as it is at Save time, so a value whose slot
 * another writer took after the review is not written: the outcome counts it, from what the reviewed
 * page would write (carried by `saveStarted`) against what the commit wrote, and the done screen says
 * so in the web's "not added" words. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { reviewedWrites, uploadReview } from './upload-review';
import { uploadSave } from './upload-save';
import { UPLOAD_TEXT } from './upload-text';
import { uploadView } from './upload-view';

const report: UnifiedExtractionResult = { classification: 'lab_report', reportDate: DAY, values: [core()], additionalValues: [extra()], unrecognized: [], document: null };
const open: Extract<UploadState, { phase: 'open' }> = { phase: 'open', platform: 'web', run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'f', name: 'labs.pdf', bytes: 1, hash: 'h-labs', pages: null, status: { s: 'read', extraction: report, choices: NO_CHOICES } }] };
const off = { holds: () => false, original: () => null, mimeType: () => '', write: async () => {}, now: () => NOW };

/** The person reviews on `reviewed`, presses Save, and Save runs on `atSave`. */
async function saveAfter(reviewed: RoadmapFile, atSave: RoadmapFile) {
  const saving = transition(open, { type: 'saveStarted', reviewed: reviewedWrites(uploadReview(open, reviewed, NOW)) }).state;
  const out = await uploadSave(saving, atSave, NOW, false, off);
  if (!out.ok) throw new Error(out.reason);
  const { file, outcome } = out.commit(atSave);
  const done: UploadState = { ...open, phase: 'done', outcome };
  return { file, outcome, done: uploadView(done, file, NOW, uploadReview(done, file, NOW), false).done! };
}
const taken = (value: number) => bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: 'ldl', value, recordedAt: DAY, source: 'manual' }], NOW).file;

describe('a reviewed value whose slot another writer took before Save (owner ruling 2026-11-20)', () => {
  it('the same value saved meanwhile: the done screen says one blood test value was not added; Ferritin is saved', async () => {
    const { outcome, done } = await saveAfter(EMPTY, taken(3.1));
    expect(outcome.values).toBe(1);
    expect(done.skipped).toEqual([UPLOAD_TEXT.skippedLine(1, false)]);
  });

  it('another value saved meanwhile (now a conflict): named the same way, never written over', async () => {
    const { file, done } = await saveAfter(EMPTY, taken(4.2));
    expect(file.labValues.filter((l) => l.metricName === 'ldl' && l.status === 'active').map((l) => l.value)).toEqual([4.2]);
    expect(done.skipped).toEqual([UPLOAD_TEXT.skippedLine(1, false)]);
  });

  it('nothing taken: everything saved, no line', async () => {
    const { outcome, done } = await saveAfter(EMPTY, EMPTY);
    expect(outcome.values).toBe(2);
    expect(done.skipped).toEqual([]);
  });

  it('a value already saved before the review is no surprise: no line', async () => {
    const { outcome, done } = await saveAfter(taken(3.1), taken(3.1));
    expect(outcome.values).toBe(1);
    expect(done.skipped).toEqual([]);
  });
});
