/**
 * Per-row refusal (US-13 AC27, Brad 2026-11-26: "per-row refusal in the shared engine for both, with the refused row
 * shown"): a readable number out of its range no longer blocks Save. Save writes every other row and refuses that one,
 * which stays on the list with its range words (web) and the write's words (phone). Text that is no number still blocks
 * (AC5, AC12). Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, NOW } from './import-review.test-helpers';
import { IMPORT_REVIEW_TEXT } from './import-review';
import type { UnifiedExtractionResult } from './lab-extraction';
import { NUMERIC_SYNTAX_GUIDANCE } from './cell-input';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadList } from './upload-list';
import { reviewedWrites, uploadReview } from './upload-review';
import { uploadSave } from './upload-save';
import { FIX_ERRORS_TEXT } from './upload-text';
import { uploadView } from './upload-view';

type Open = Extract<UploadState, { phase: 'open' }>;
const labRead = (id: string, over: Partial<UnifiedExtractionResult>): Open['files'][number] => ({
  id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
const open = (files: Open['files']): Open => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: NOW });
const si = () => 'si' as const;
const chose = (s: UploadState, change: ChoiceChange) => transition(s, { type: 'chose', id: 'f0', change, now: NOW }).state;
const see = (s: UploadState) => {
  const review = uploadReview(s, EMPTY, NOW);
  return { review, list: uploadList(s, EMPTY, NOW, review, si), view: uploadView(s, EMPTY, NOW, review, false, si) };
};
const off = { stopped: () => false, holds: () => false, original: () => null, mimeType: () => '', write: async () => {}, now: () => NOW };
const save = async (s: UploadState) => {
  const saving = transition(s, { type: 'saveStarted', reviewed: reviewedWrites(uploadReview(s, EMPTY, NOW)) }).state;
  const out = await uploadSave(saving, EMPTY, NOW, false, off);
  if (!out.ok) return { refused: out.message, wrote: [] as string[], values: 0 };
  const { file, outcome } = out.commit(EMPTY);
  return { refused: null, wrote: file.labValues.filter((r) => r.status === 'active').map((r) => r.metricName), values: outcome.values };
};

// An LDL and an HbA1c from one report on one day: the LDL is the row each case puts out of range.
const report = (ldlSI: number) => open([labRead('f0', { values: [
  core({ valueSI: ldlSI, displayValue: ldlSI }),
  core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' }),
] })]);

describe('US-13 AC27: a readable number out of range is refused alone; Save writes the rest', () => {
  it.each<[string, UploadState]>([
    ['read out of range', report(500)],
    ['edited out of range', chose(report(3.1), { edit: 'v0', value: 500 })],
    ['typed out of range', chose(report(3.1), { typed: 'v0', text: '500', unit: 'si' })],
  ])('%s: Save is open, counts one value, and writes the HbA1c alone', async (_, s) => {
    const { list, view } = see(s);
    expect(view.save).toMatchObject({ enabled: true, why: null, blockers: [], label: IMPORT_REVIEW_TEXT.save(1) });
    // The refused row stays on the list, ticked, with the range words it showed before (web).
    expect(list.rows[0]).toMatchObject({ key: 'f0:v0', ticked: true, typed: null, status: { kind: 'refused' }, caption: 'Max 12.9 mmol/L', error: 'Max 12.9 mmol/L', saves: false, attention: true });
    expect(list.rows[1]).toMatchObject({ key: 'f0:v1', status: { kind: 'saves' }, saves: true, error: null });
    // The phone's row keeps the write's own words.
    const unsure = view.sections.find((x) => x.kind === 'unsure');
    expect(unsure && 'rows' in unsure ? unsure.rows.find((r) => r.ref === 'v0')?.error : null).toEqual(expect.any(String));
    expect(await save(s)).toEqual({ refused: null, wrote: ['hba1c'], values: 1 });
  });

  it('text that is no number still blocks Save (AC5, AC12), beside a refused row that does not', async () => {
    const s = chose(report(500), { typed: 'v1', text: 'abc', unit: 'si' });
    const { list, view } = see(s);
    expect(list.rows.map((r) => r.status.kind)).toEqual(['refused', 'error']);
    expect(list.rows[1].error).toBe(NUMERIC_SYNTAX_GUIDANCE);
    expect(view.save).toMatchObject({ enabled: false, why: FIX_ERRORS_TEXT, blockers: [{ why: FIX_ERRORS_TEXT, at: 'f0:v1' }] });
    expect((await save(s)).refused).toBe(FIX_ERRORS_TEXT);
  });

  it('cleared, the refused row says nothing more and Save still writes the rest', async () => {
    const s = chose(report(500), { tick: 'v0', on: false });
    expect(see(s).list.rows[0]).toMatchObject({ status: { kind: 'cleared' }, ticked: false });
    expect(await save(s)).toEqual({ refused: null, wrote: ['hba1c'], values: 1 });
  });
});
