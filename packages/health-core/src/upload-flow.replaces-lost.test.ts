/**
 * PR 1906 owner ruling 2026-11-20 (US-13 AC7): when the record the review shows no longer has a chosen
 * Replace's target holding that slot (another writer moved or corrected it), the shared state drops that
 * Replace and unticks the value, so nothing is written without the person's say and the review is never
 * stuck; ticked again, it saves as a new row. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, NOW, recordWith } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { lostReplaces, uploadReview } from './upload-review';
import { uploadSave } from './upload-save';

const report: UnifiedExtractionResult = { classification: 'lab_report', reportDate: DAY, values: [core({ valueSI: 3.1, displayValue: 3.1 })], additionalValues: [], unrecognized: [], document: null };
const reviewed = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 4.2 }]);
const held = reviewed.labValues.find((l) => l.metricName === 'ldl')!;
const open: Extract<UploadState, { phase: 'open' }> = { phase: 'open', platform: 'web', run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'f', name: 'labs.pdf', bytes: 1, hash: 'h-labs', pages: null, status: { s: 'read', extraction: report, choices: { ...NO_CHOICES, replace: { v0: held.id } } } }] };
// Another writer moved the held LDL to another day while the review was open.
const moved: RoadmapFile = bulkAppendValues({ ...reviewed, labValues: reviewed.labValues.map((l) => (l.id === held.id ? { ...l, status: 'entered-in-error' as const } : l)) },
  [{ kind: 'measurement', metricType: 'ldl', value: 4.2, recordedAt: '2026-10-02', source: 'manual' }], NOW).file;
const choicesOf = (s: UploadState) => ('files' in s && s.files[0].status.s === 'read' ? s.files[0].status.choices : null);

describe('a Replace whose target leaves the slot while the review is open', () => {
  it('is not lost while the target still holds the slot', () => {
    expect(lostReplaces(uploadReview(open, reviewed, NOW), open)).toEqual([]);
  });

  it('is dropped and the value unticked; ticked again it saves as a new row', async () => {
    const lost = lostReplaces(uploadReview(open, moved, NOW), open);
    expect(lost).toEqual([{ id: 'f', ref: 'v0' }]);
    const after = transition(open, { type: 'replacesLost', lost }).state;
    expect(choicesOf(after)).toMatchObject({ replace: {}, ticks: { v0: false } });
    expect(lostReplaces(uploadReview(after, moved, NOW), after)).toEqual([]);
    expect(uploadReview(after, moved, NOW).classification.rows).toEqual([]);
    const reTicked = transition(after, { type: 'chose', id: 'f', change: { tick: 'v0', on: true }, now: NOW }).state;
    const saving = transition(reTicked, { type: 'saveStarted' }).state;
    const out = await uploadSave(saving, moved, NOW, false, { holds: () => false, original: () => null, mimeType: () => '', write: async () => {}, now: () => NOW });
    if (!out.ok) throw new Error(out.reason);
    const { file } = out.commit(moved);
    expect(file.labValues.filter((l) => l.metricName === 'ldl' && l.status === 'active').map((l) => [l.recordedAt.slice(0, 10), l.value, l.correctsId ?? null]).sort())
      .toEqual([['2026-10-02', 4.2, null], [DAY, 3.1, null]]);
  });
});
