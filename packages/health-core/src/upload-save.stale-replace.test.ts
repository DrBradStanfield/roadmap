/**
 * PR 1906 final Codex pass, item 1 (FHIR; US-13 AC7, US-35 AC8, US-12 AC6a): a Replace names one saved
 * row. If another writer moves or corrects that row before Save, the uploaded value is never written as
 * a plain new row in its place: the write refuses the stale target, and the done screen counts the value
 * as not added. With the target unchanged, Replace appends a correction and flips the old row.
 * Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, NOW, recordWith } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { reviewedWrites, uploadReview } from './upload-review';
import { uploadSave } from './upload-save';
import { UPLOAD_TEXT } from './upload-text';
import { uploadView } from './upload-view';

const report: UnifiedExtractionResult = { classification: 'lab_report', reportDate: DAY, values: [core({ valueSI: 3.1, displayValue: 3.1 })], additionalValues: [], unrecognized: [], document: null };
const off = { stopped: () => false, holds: () => false, original: () => null, mimeType: () => '', write: async () => {}, now: () => NOW };
const reviewed = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 4.2 }]);
const ldl = (f: RoadmapFile) => f.labValues.filter((l) => l.metricName === 'ldl');
const held = ldl(reviewed)[0];

/** The person ticks Replace on the reviewed record and presses Save; Save runs on `atSave`. */
async function replaceOn(atSave: RoadmapFile) {
  const open: Extract<UploadState, { phase: 'open' }> = { phase: 'open', platform: 'web', run: 1, started: NOW, firstRead: NOW,
    files: [{ id: 'f', name: 'labs.pdf', bytes: 1, hash: 'h-labs', pages: null, status: { s: 'read', extraction: report, choices: { ...NO_CHOICES, replace: { v0: held.id } } } }] };
  const saving = transition(open, { type: 'saveStarted', reviewed: reviewedWrites(uploadReview(open, reviewed, NOW)) }).state;
  const out = await uploadSave(saving, atSave, NOW, false, off);
  if (!out.ok) throw new Error(out.reason);
  const { file, outcome } = out.commit(atSave);
  const done: UploadState = { ...open, phase: 'done', outcome };
  return { file, outcome, skipped: uploadView(done, file, NOW, uploadReview(done, file, NOW), false).done!.skipped };
}

describe('a Replace whose target another writer changed before Save (item 1)', () => {
  it('the target moved to another day: nothing is written on the first day, and the value is named not added', async () => {
    const moved = bulkAppendValues({ ...reviewed, labValues: reviewed.labValues.map((l) => (l.id === held.id ? { ...l, status: 'entered-in-error' as const } : l)) },
      [{ kind: 'measurement', metricType: 'ldl', value: 4.2, recordedAt: '2026-10-02', source: 'manual' }], NOW).file;
    const { file, outcome, skipped } = await replaceOn(moved);
    expect(ldl(file).filter((l) => l.status === 'active').map((l) => [l.recordedAt.slice(0, 10), l.value])).toEqual([['2026-10-02', 4.2]]);
    expect(outcome.values).toBe(0);
    expect(skipped).toEqual([UPLOAD_TEXT.skippedLine(1, false)]);
  });

  it('the target corrected by another writer: its correction stays, and the value is named not added', async () => {
    const corrected = bulkAppendValues(reviewed, [{ kind: 'measurement', metricType: 'ldl', value: 4.5, recordedAt: DAY, source: 'manual', correctsId: held.id }], NOW).file;
    const { file, outcome, skipped } = await replaceOn(corrected);
    expect(ldl(file).filter((l) => l.status === 'active').map((l) => l.value)).toEqual([4.5]);
    expect(outcome.values).toBe(0);
    expect(skipped).toEqual([UPLOAD_TEXT.skippedLine(1, false)]);
  });

  it('the target unchanged: a correction naming it is appended and it is flipped', async () => {
    const { file, outcome, skipped } = await replaceOn(reviewed);
    expect(outcome.values).toBe(1);
    expect(ldl(file).find((l) => l.id === held.id)?.status).toBe('entered-in-error');
    expect(ldl(file).filter((l) => l.status === 'active')).toEqual([expect.objectContaining({ value: 3.1, correctsId: held.id })]);
    expect(skipped).toEqual([]);
  });
});
