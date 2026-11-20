/**
 * PR 1906 Codex pass (US-13 AC8, US-12 AC12): every ticked value's day is checked, a printed one too. A
 * value printed on a day still to come keeps the report waiting with the existing reason until its day is
 * corrected or the value cleared; nothing ticked is dropped silently. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, EMPTY } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadReview } from './upload-review';
import { uploadSave } from './upload-save';
import { UPLOAD_TEXT } from './upload-text';
import { uploadView } from './upload-view';

const NOW = '2026-11-20T09:00:00.000Z';
const report: UnifiedExtractionResult = { classification: 'lab_report', reportDate: '2026-12-10', additionalValues: [], unrecognized: [], document: null,
  values: [core({ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, recordedAt: '2026-12-01' })] };
const open: UploadState = { phase: 'open', platform: 'web', run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'f', name: 'labs.pdf', bytes: 1, hash: 'h-labs', pages: null, status: { s: 'read', extraction: report, choices: NO_CHOICES } }] };
const chose = (s: UploadState, change: ChoiceChange) => transition(s, { type: 'chose', id: 'f', change, now: NOW }).state;
const viewOf = (s: UploadState) => uploadView(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), true);
const io = { holds: () => true, original: () => 'bytes', mimeType: () => 'application/pdf', write: async () => {}, now: () => NOW, newId: () => 'id-1' };

describe('a value printed on a day still to come', () => {
  it('keeps Save waiting with the existing reason', () => {
    expect(viewOf(open).save).toMatchObject({ enabled: false, why: UPLOAD_TEXT.chooseDay });
  });

  it('cleared, Save files the original alone', () => {
    expect(viewOf(chose(open, { tick: 'v0', on: false })).save).toMatchObject({ label: UPLOAD_TEXT.saveOriginals(1), enabled: true, why: null });
  });

  it('its day corrected, the LDL is saved on that day', async () => {
    const fixed = chose(open, { columnDay: '2026-12-01', day: '2026-11-01' });
    expect(viewOf(fixed).save).toMatchObject({ enabled: true, why: null });
    const out = await uploadSave(transition(fixed, { type: 'saveStarted' }).state, EMPTY, NOW, true, io);
    if (!out.ok) throw new Error(out.reason);
    const { file } = out.commit(EMPTY);
    expect(file.labValues.map((l) => [l.metricName, l.recordedAt.slice(0, 10), l.value])).toEqual([['ldl', '2026-11-01', 3.1]]);
  });
});
