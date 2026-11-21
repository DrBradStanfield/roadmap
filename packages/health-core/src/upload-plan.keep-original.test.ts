/**
 * A lab report with nothing ticked keeps its original in the person's cloud (US-14 AC11, Brad
 * 2026-11-21: "I think the original letters should still be kept in the cloud storage"). Save offers
 * it as "Save 1 original", files it as the lab report's hidden archive row, and the done screen says
 * it was kept, in the words an archive-only Save already uses. With no cloud nothing changes: no row,
 * Save disabled. A report the read found nothing in files nothing, as before. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, NOW } from './import-review.test-helpers';
import { documentView, isLabArchiveDocument } from './document-rows';
import type { UnifiedExtractionResult } from './lab-extraction';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type FileChoices } from './upload-choices';
import { transition, type UploadFile, type UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { uploadSave, type UploadSaveIO } from './upload-save';
import { uploadView } from './upload-view';

const labX = (over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: DAY, values: [core()], additionalValues: [], unrecognized: [], document: null, ...over });
const read = (id: string, extraction: UnifiedExtractionResult, choices: Partial<FileChoices> = {}): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices: { ...NO_CHOICES, ...choices } } });
const open = (files: UploadFile[]): UploadState => ({ phase: 'open', platform: 'phone', run: 1, files, started: NOW, firstRead: null });
const unticked = { ticks: { v0: false } };
const view = (s: UploadState, cloud: boolean, record: RoadmapFile = EMPTY) => uploadView(s, record, NOW, uploadReview(s, record, NOW), cloud);
const plan = (s: UploadState, cloud: boolean) => uploadSavePlan(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), cloud);
const cloudIO = (fails = false): UploadSaveIO<string> & { stored: string[] } => {
  const stored: string[] = [];
  let n = 0;
  return {
    stored, holds: () => true, original: (id) => `bytes of ${id}`, mimeType: () => 'application/pdf',
    write: async (ref) => { if (fails) throw new Error('synthetic refusal'); stored.push(ref); },
    now: () => NOW, newId: () => `id-${n++}`,
  };
};
/** Save, then the done screen as the person sees it. */
async function saveAndShow(s: UploadState, cloud: boolean, io = cloudIO()) {
  const saving = transition(s, { type: 'saveStarted' }).state;
  const out = await uploadSave(saving, EMPTY, NOW, cloud, io);
  if (!out.ok) throw new Error(out.reason);
  const { file, outcome } = out.commit(EMPTY);
  const done = transition(saving, { type: 'saved', run: saving.run, attempt: 'attempt' in saving ? saving.attempt : 1, outcome }).state;
  return { file, outcome, done: view(done, cloud, file).done, stored: io.stored };
}

describe('US-14 AC11: a lab report with nothing ticked keeps its original in the cloud', () => {
  it('with a cloud, Save offers the original alone and is enabled', () => {
    expect(view(open([read('a', labX(), unticked)]), true).save).toEqual({ label: 'Save 1 original', enabled: true, why: null, error: null });
  });

  it('Save stores the original as the report\'s hidden archive row; the done screen says it was kept', async () => {
    const { file, outcome, done, stored } = await saveAndShow(open([read('a', labX(), unticked)]), true);
    expect(stored).toHaveLength(1);
    expect(file.measurements).toEqual([]);
    expect(file.documents).toHaveLength(1);
    expect(isLabArchiveDocument(documentView(file.documents[0]))).toBe(true);
    expect(file.documents[0]).toMatchObject({ fileRef: stored[0], contentHash: 'h-a', date: DAY });
    expect(outcome).toEqual({ values: 0, documents: 0, archived: 1, unstored: 0 });
    expect(done).toEqual({ line: 'Saved 0 values.', archived: '1 original file kept in your cloud.', unstored: null, skipped: [], notSaved: [] });
  });

  it('a report whose every value is refused keeps its original too', () => {
    const refusedOnly = labX({ values: [], refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'unit unknown' }] });
    expect(view(open([read('a', refusedOnly)]), true).save).toMatchObject({ label: 'Save 1 original', enabled: true });
  });

  it('beside a report with values ticked: Save names the values, and the done screen counts the kept original', async () => {
    const s = open([read('a', labX()), read('b', labX({ values: [core({ metric: 'hdl', valueSI: 1.2, displayValue: 1.2 })] }), unticked)]);
    expect(view(s, true).save).toMatchObject({ label: 'Save 1 value', enabled: true });
    const { outcome, done, stored } = await saveAndShow(s, true);
    expect(stored).toHaveLength(2);
    expect(outcome).toMatchObject({ values: 1, archived: 1 });
    expect(done).toMatchObject({ line: 'Saved 1 value.', archived: '1 original file kept in your cloud.' });
  });

  it('an original the cloud refuses is not said to be kept: the done screen says it could not be stored', async () => {
    const { outcome, done } = await saveAndShow(open([read('a', labX(), unticked)]), true, cloudIO(true));
    expect(outcome).toEqual({ values: 0, documents: 0, archived: 0, unstored: 1 });
    expect(done).toMatchObject({ archived: null, unstored: "The original file couldn't be stored; its details are saved." });
  });

  it('with no cloud nothing changes: no row is planned and Save stays off', () => {
    const s = open([read('a', labX(), unticked)]);
    expect(plan(s, false)).toMatchObject({ labArchives: [], archiveOnly: [], counts: { values: 0, documents: 0, archived: 0, originals: 0 } });
    expect(view(s, false).save).toMatchObject({ enabled: false, why: 'Nothing new to save' });
  });

  it('a lab report the read found nothing in files nothing, as before', () => {
    const s = open([read('a', labX({ values: [] }))]);
    expect(plan(s, true)).toMatchObject({ labArchives: [], archiveOnly: [], counts: { originals: 0 } });
  });

  it('a photo or a scan (no original) still files nothing', () => {
    const s = open([{ ...read('a', labX(), unticked), original: false }]);
    expect(plan(s, true).counts.originals).toBe(0);
  });
});
