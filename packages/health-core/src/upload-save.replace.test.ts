/**
 * PR 1908 fix round, item 4 (Codex R3; US-13 AC7): Replace on a value the person had cleared selects
 * it, through the engine, so the real save writes the correction: the held row goes entered-in-error
 * and the new row names it in `correctsId`. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, NOW, recordWith } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { NO_CHOICES } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadReview } from './upload-review';
import { uploadSave } from './upload-save';
import { uploadView } from './upload-view';

const asked: UnifiedExtractionResult = {
  classification: 'lab_report', reportDate: DAY, values: [core({ confidence: 'medium', question: 'Was this fasting?' })], additionalValues: [], unrecognized: [], document: null,
};
const open: UploadState = {
  phase: 'open', platform: 'phone', run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'lab', name: 'lab.pdf', bytes: 1, hash: 'h-lab', pages: { count: 1, truncated: false }, status: { s: 'read', extraction: asked, choices: NO_CHOICES } }],
};

describe('Replace on a cleared value (item 4)', () => {
  it('selects the value, and the save corrects the held row', async () => {
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.0 }]);
    const held = uploadView(open, record, NOW, uploadReview(open, record, NOW), false).sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : []))[0].replaces!;
    expect(held).toBeTruthy();
    let s = transition(open, { type: 'chose', id: 'lab', change: { tick: 'v0', on: false }, now: NOW }).state;
    s = transition(s, { type: 'chose', id: 'lab', change: { replace: 'v0', correctsId: held }, now: NOW }).state;
    s = transition(s, { type: 'saveStarted' }).state;
    const out = await uploadSave(s, record, NOW, false, { holds: () => false, original: () => null, mimeType: () => '', write: async () => {} });
    if (!out.ok) throw new Error(out.reason);
    const { file } = out.commit(record);
    const ldl = file.labValues.filter((m) => m.metricName === 'ldl');
    expect(ldl.find((m) => m.id === held)?.status).toBe('entered-in-error');
    expect(ldl.filter((m) => m.status === 'active').map((m) => [m.value, m.correctsId])).toEqual([[3.1, held]]);
  });
});
