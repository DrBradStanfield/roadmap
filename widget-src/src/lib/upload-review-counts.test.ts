/**
 * US-13 AC13, mount 3b: the `upload_review` row from the shared review and the person's choices: counts only, a zero
 * left out, `saved` always sent, and no `notSavedOpened` (the list has no "Not saved" disclosure). Synthetic values.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyFile } from '@roadmap/health-core/roadmap-file';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import { transition, type UploadState } from '@roadmap/health-core/upload-flow';
import { uploadReview } from '@roadmap/health-core/upload-review';
import { reviewCounts } from './upload-review-counts';

const NOW = '2026-11-22T00:00:00.000Z';
const value = (metric: string, v: number, more = {}) => ({ metric, valueSI: v, displayValue: v, displayUnit: 'mmol/L', confidence: 'high', ...more });
const s: UploadState = { phase: 'open', platform: 'web', run: 1, started: NOW, firstRead: NOW, files: [{
  id: 'f0', name: 'labs.pdf', bytes: 1, hash: 'hash-synthetic', pages: { count: 1, truncated: false }, status: { s: 'read', choices: NO_CHOICES, extraction: {
    classification: 'lab_report', reportDate: '2026-11-01', document: null, unrecognized: [],
    values: [value('ldl', 2.8), value('hdl', 1.4, { confidence: 'low' })],
    additionalValues: [{ name: 'Ferritin', value: 80, unit: 'mg/dL' }],
  } } as never,
}] };
const record = createEmptyFile({ deviceId: 'web', now: NOW });
const counts = (state: UploadState, showAll: boolean, saved: boolean) => reviewCounts(uploadReview(state, record, NOW), state, showAll, saved);
const chose = (state: UploadState, change: object) => transition(state, { type: 'chose', id: 'f0', change: change as never, now: NOW }).state;

describe('US-13 AC13: the upload_review counts', () => {
  it('groups only, untouched: a sure, an unsure, a not saved; saved 0 on Cancel', () => {
    expect(counts(s, false, false)).toEqual({ sure: 1, unsure: 1, notSaved: 1, saved: 0 });
  });

  it('a cleared sure value and an edited unsure one, after Show all, saved 1', () => {
    const changed = chose(chose(s, { tick: 'v0', on: false }), { edit: 'v1', value: 1.5 });
    expect(counts(changed, true, true)).toEqual(expect.objectContaining({ showAll: 1, changedUnsure: 1, saved: 1 }));
    expect(Object.keys(counts(changed, true, true))).not.toContain('notSavedOpened');
  });
});
