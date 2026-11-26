// PR 1906 fix round, item 3 (US-12 AC6, AC15): a value the final commit refuses, because the record
// changed while the originals uploaded, is named with its reason on the done screen in the review's
// not-saved words, never dropped silently. Synthetic values only.
import { describe, expect, it } from 'vitest';
import { EMPTY, NOW } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues } from './record-edits';
import { NO_CHOICES } from './upload-choices';
import type { UploadState } from './upload-flow';
import { uploadSave } from './upload-save';
import { uploadView } from './upload-view';
import { uploadReview } from './upload-review';

const DAY = '2026-10-01';
// A systolic reading alone: fine on the record as reviewed.
const bp: UnifiedExtractionResult = {
  classification: 'lab_report', reportDate: DAY, additionalValues: [], unrecognized: [], document: null,
  values: [{ metric: 'systolic_bp', valueSI: 90, displayValue: 90, displayUnit: 'mmHg', displaySystem: 'si', confidence: 'high' }],
};
const saving: UploadState = { phase: 'saving', platform: 'web', run: 1, started: NOW, firstRead: NOW, attempt: 1,
  files: [{ id: 'f', name: 'bp.pdf', bytes: 1, hash: 'h-bp', pages: null, status: { s: 'read', extraction: bp, choices: NO_CHOICES } }] };

describe('a value refused at the final commit (item 3)', () => {
  it('is carried in the outcome and named on the done screen with its reason', async () => {
    const out = await uploadSave(saving, EMPTY, NOW, false, { stopped: () => false, holds: () => false, original: () => null, mimeType: () => '', write: async () => {} });
    if (!out.ok) throw new Error(out.reason);
    // While the originals uploaded, another device saved a diastolic of 120 for that day: 90/120 is the wrong way up.
    const changed = bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: 'diastolic_bp', value: 120, recordedAt: DAY, source: 'manual' }], NOW).file;
    const { file, outcome } = out.commit(changed);
    expect(file.measurements.filter((m) => m.metricType === 'systolic_bp')).toEqual([]);
    expect(outcome.values).toBe(0);
    const done: UploadState = { ...saving, phase: 'done', outcome };
    // Owner ruling 2026-11-20: in the web's own words for a refused blood test value (measurementRefusalLine), not "misread".
    expect(uploadView(done, file, NOW, uploadReview(done, file, NOW), false).done?.notSaved)
      .toEqual(['Blood pressure not saved: the top number (systolic) must be higher than the bottom number (diastolic). Check the report, then enter it again.']);
  });
});
