/**
 * An undated previous column (US-12 AC14) as the web takes it today, pinned from ReviewTable.tsx:
 * a column's day is a real past day and, when the report's own day is known, before it
 * (`datedColumns`; a later pick is refused, `handleColumnDateChange`); Save waits while a kept
 * value sits in a column with no day (`allDatesSet`). The upload's review, plan and view honour
 * the same rule. Synthetic values.
 */
import { describe, expect, it } from 'vitest';
import { core, EMPTY, NOW } from './import-review.test-helpers';
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import type { FileChoices } from './upload-choices';
import type { UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { previousDay, uploadReview } from './upload-review';
import { uploadView } from './upload-view';

const REPORT = '2026-11-01';
const x = (reportDate: string | null): UnifiedExtractionResult => ({
  classification: 'lab_report', reportDate, additionalValues: [], unrecognized: [], document: null,
  values: [core(), core({ metric: 'hdl', valueSI: 1.2, recordedAt: UNDATED_PREVIOUS, printedMonth: '2026-06' })],
});
const state = (reportDate: string | null, choices: Partial<FileChoices> = {}): UploadState => ({
  phase: 'open', platform: 'web', run: 1, started: NOW, firstRead: null,
  files: [{ id: 'a', name: 'a.pdf', bytes: 1, hash: 'h', pages: null, status: { s: 'read', extraction: x(reportDate), choices: { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {}, ...choices } } }],
});
const rowsOf = (s: UploadState) => uploadSavePlan(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), true).labRows.flatMap((l) => l.rows.map((r) => [r.kind === 'measurement' ? r.metricType : r.metricName, r.recordedAt.slice(0, 10)]));

describe('previousDay: the web\'s rule for an undated previous column', () => {
  it('a past day before the report\'s is taken; on or after it, or in the future, is refused', () => {
    expect(previousDay('2026-06-15', REPORT, NOW)?.slice(0, 10)).toBe('2026-06-15');
    expect(previousDay(REPORT, REPORT, NOW)).toBeNull();
    expect(previousDay('2026-11-01', '2026-10-31', NOW)).toBeNull();
    expect(previousDay('2027-01-01', null, NOW)).toBeNull();
    expect(previousDay('2026-10-31', null, NOW)?.slice(0, 10)).toBe('2026-10-31'); // no report day: any past day
    expect(previousDay(null, REPORT, NOW)).toBeNull();
  });
});

describe('the upload honours it (US-12 AC14)', () => {
  it('with no day picked, the whole report waits and the view asks for the column\'s day', () => {
    const s = state(REPORT);
    expect(rowsOf(s)).toEqual([]);
    expect(uploadView(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), true).sections).toContainEqual({ kind: 'undatedPrevious', key: 'a|previous', fileId: 'a', name: 'a.pdf', month: '2026-06', before: REPORT, day: null, rows: [expect.objectContaining({ fileId: 'a', day: null, ticked: true, saves: false })] });
  });

  it('a day picked before the report\'s files the column\'s values on it, the rest on the report\'s', () => {
    expect(rowsOf(state(REPORT, { previousDay: '2026-06-15' }))).toEqual([['ldl', REPORT], ['hdl', '2026-06-15']]);
  });

  it('a pick on the report\'s day is refused, so the report still waits', () => {
    expect(rowsOf(state(REPORT, { previousDay: REPORT }))).toEqual([]);
  });

  it('unticking the column\'s values lets the rest save without a day', () => {
    expect(rowsOf(state(REPORT, { ticks: { v1: false } }))).toEqual([['ldl', REPORT]]);
  });
});
