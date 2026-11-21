/**
 * US-14 AC11 review fixes (owner rulings F1-F5 on PR 1934). An unticked copy never shadows a copy of the
 * same bytes that saves values (F1); "original only" is decided by what Save writes, not by the ticks (F2);
 * an original the record already keeps is never offered again (F3); the kept original's archive row lists
 * no rows, explicitly, so a later upload reads the file again and declined values can still be added (F4);
 * a report whose every value is refused is saved original-only (F5). Then a table over shared hashes.
 * Synthetic values and hashes only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW, recordWith } from './import-review.test-helpers';
import { documentView, isLabArchiveDocument, listedRows } from './document-rows';
import type { UnifiedExtractionResult } from './lab-extraction';
import type { FileDocument, RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type FileChoices } from './upload-choices';
import { transition, type UploadFile, type UploadState } from './upload-flow';
import { knownIndex } from './upload-known';
import { planIsEmpty, uploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { uploadSave, type UploadSaveIO } from './upload-save';
import { uploadView } from './upload-view';

const labX = (over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [extra()], unrecognized: [], document: null, ...over });
const read = (id: string, extraction: UnifiedExtractionResult, choices: Partial<FileChoices> = {}, hash = `h-${id}`): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices: { ...NO_CHOICES, ...choices } } });
const open = (files: UploadFile[]): UploadState => ({ phase: 'open', platform: 'phone', run: 1, files, started: NOW, firstRead: null });
const none = { ticks: { a0: false, v0: false } };
const both = (s: UploadState, record: RoadmapFile, cloud = true) => {
  const review = uploadReview(s, record, NOW);
  return { plan: uploadSavePlan(s, record, NOW, review, cloud), view: uploadView(s, record, NOW, review, cloud) };
};
const cloudIO = (): UploadSaveIO<string> & { stored: string[] } => {
  const stored: string[] = [];
  let n = 0;
  return { stored, holds: () => true, original: (id) => `bytes of ${id}`, mimeType: () => 'application/pdf', write: async (ref) => void stored.push(ref), now: () => NOW, newId: () => `doc-${n++}` };
};
async function saveAndShow(s: UploadState, record: RoadmapFile, cloud = true, io = cloudIO()) {
  const saving = transition(s, { type: 'saveStarted' }).state;
  const out = await uploadSave(saving, record, NOW, cloud, io);
  if (!out.ok) throw new Error(out.reason);
  const { file, outcome } = out.commit(record);
  const done = transition(saving, { type: 'saved', run: saving.run, attempt: 'attempt' in saving ? saving.attempt : 1, outcome }).state;
  return { file, outcome, done: both(done, file, cloud).view.done, stored: io.stored };
}
const archives = (f: RoadmapFile): FileDocument[] => f.documents.filter((d) => !d.deleted && isLabArchiveDocument(documentView(d)));
const newLabIds = (before: RoadmapFile, after: RoadmapFile) => after.labValues.filter((r) => !before.labValues.some((b) => b.id === r.id)).map((r) => r.id);
const KEPT = '1 original file kept in your cloud.';
/** Another lab value on the report's day: the list-less date rule would call any report of that day known. */
const sameDay = () => recordWith([{ kind: 'lab', metricName: 'Vitamin B12', value: 400, unit: 'pmol/L', referenceLow: null, referenceHigh: null }]);

describe('F1: an unticked copy never shadows a copy of the same bytes that saves values', () => {
  it('first copy unticked, second ticked: one archive row listing the second copy\'s value; deleted, the file is read again', async () => {
    const record = sameDay();
    const s = open([read('a', labX(), none, 'h-x'), read('b', labX(), {}, 'h-x')]);
    const { file, stored } = await saveAndShow(s, record);
    const written = newLabIds(record, file);
    expect(written).toHaveLength(1);
    expect(stored).toHaveLength(1);
    expect(archives(file)).toHaveLength(1);
    expect(listedRows(archives(file)[0])).toEqual(written);
    expect(knownIndex(file).has('h-x')).toBe(true);
    const deleted = { ...file, labValues: file.labValues.map((r) => (r.id === written[0] ? { ...r, status: 'entered-in-error' as const } : r)) };
    expect(knownIndex(deleted).has('h-x')).toBe(false);
  });

  it('two copies that each save a value: the one archive row lists both', async () => {
    const two = labX({ additionalValues: [extra(), extra({ name: 'Vitamin D', value: 70, unit: 'nmol/L' })] });
    const s = open([read('a', two, { ticks: { a1: false } }, 'h-x'), read('b', two, { ticks: { a0: false } }, 'h-x')]);
    const { file } = await saveAndShow(s, EMPTY);
    const written = newLabIds(EMPTY, file);
    expect(written).toHaveLength(2);
    expect(archives(file)).toHaveLength(1);
    expect([...(listedRows(archives(file)[0]) ?? [])].sort()).toEqual([...written].sort());
  });
});

describe('F2 and F5: "original only" is decided by what Save writes', () => {
  it('a dated report whose only values are refused extras: the original is kept and the done screen says so', async () => {
    const s = open([read('a', labX({ additionalValues: [extra({ unit: 'zzz' })] }))]);
    expect(both(s, EMPTY).view.save).toMatchObject({ label: 'Save 1 original', enabled: true });
    const { outcome, done, stored } = await saveAndShow(s, EMPTY);
    expect(stored).toHaveLength(1);
    expect(outcome).toMatchObject({ values: 0, archived: 1 });
    expect(done).toMatchObject({ line: 'Saved 0 values.', archived: KEPT });
  });

  it('a report the read found only refused values in: Save stores its original and says so', async () => {
    const s = open([read('a', labX({ additionalValues: [], refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'unit unknown' }] }))]);
    const { outcome, done, stored, file } = await saveAndShow(s, EMPTY);
    expect(stored).toHaveLength(1);
    expect(archives(file)).toHaveLength(1);
    expect(outcome).toMatchObject({ values: 0, archived: 1 });
    expect(done).toMatchObject({ archived: KEPT });
  });
});

describe('F3 and F4: an original the record keeps is never offered again, and declined values can still be added', () => {
  it.each([['dated', DAY], ['dateless', null]] as const)('%s: a second upload, nothing ticked, offers nothing; ticked, it saves the values', async (_name, reportDate) => {
    const x = labX({ reportDate, additionalValues: [extra({ recordedAt: '2026-10-01' })] });
    const first = await saveAndShow(open([read('a', x, none)]), sameDay());
    expect(first.stored).toHaveLength(1);
    // F4: the kept original's row lists no rows, explicitly, so the file is not known: a later upload reads it.
    expect(listedRows(archives(first.file)[0])).toEqual([]);
    expect(knownIndex(first.file).has('h-a')).toBe(false);
    // F3: read again with nothing ticked, Save has nothing to write, and says so.
    const again = both(open([read('a', x, none)]), first.file);
    expect(again.plan.counts.originals).toBe(0);
    expect(planIsEmpty(again.plan)).toBe(true);
    expect(again.view.save).toMatchObject({ enabled: false, why: 'Nothing new to save' });
    const io = cloudIO();
    const forced = await saveAndShow(open([read('a', x, none)]), first.file, true, io);
    expect(forced.outcome).toEqual({ values: 0, documents: 0, archived: 0, unstored: 0 });
    expect(io.stored).toEqual([]);
    // Ticked now, the declined value saves, with no second original, and the row lists it.
    const later = await saveAndShow(open([read('a', x)]), first.file);
    const written = newLabIds(first.file, later.file);
    expect(written).toHaveLength(1);
    expect(later.stored).toEqual([]);
    expect(archives(later.file)).toHaveLength(1);
    expect(archives(later.file)[0].fileRef).toBe(archives(first.file)[0].fileRef);
    expect(listedRows(archives(later.file)[0])).toEqual(written);
  });
});

describe('shared hashes across files: one archive row per hash, listing every value saved from it', () => {
  const ticks = [none, {}, { ticks: { a0: false } }] as const;
  const shapes = [[['h-1', 0], ['h-1', 1]], [['h-1', 1], ['h-1', 0]], [['h-1', 0], ['h-1', 0]], [['h-1', 1], ['h-1', 1]],
    [['h-1', 0], ['h-2', 1], ['h-1', 1]], [['h-1', 1], ['h-2', 0], ['h-2', 0]], [['h-1', 0], ['h-1', 2], ['h-1', 1]]] as const;
  it.each(shapes.map((shape, i) => [i, shape] as const))('shape %i', async (_i, shape) => {
    // Each hash's own bytes read its own test, so values from different files are never one another's copies.
    const own = (hash: string) => labX({ additionalValues: [extra({ name: hash === 'h-1' ? 'Ferritin' : 'Vitamin D', unit: hash === 'h-1' ? 'µg/L' : 'nmol/L' })] });
    const s = open(shape.map(([hash, t], k) => read(`f${k}`, own(hash), ticks[t], hash)));
    const { plan, view } = both(s, EMPTY);
    const io = cloudIO();
    const { file, outcome } = await saveAndShow(s, EMPTY, true, io);
    const written = newLabIds(EMPTY, file);
    for (const hash of new Set(shape.map(([h]) => h))) {
      const rows = archives(file).filter((d) => d.contentHash === hash);
      expect(rows, hash).toHaveLength(1);
      expect(rows[0].fileRef, hash).toBeTruthy();
      const fromHash = shape.some(([h, t]) => h === hash && t === 1);
      expect(listedRows(rows[0])?.length ?? 0, hash).toBe(fromHash ? 1 : 0);
    }
    expect([...new Set(archives(file).flatMap((d) => listedRows(d) ?? []))].sort()).toEqual([...written].sort());
    // The label, the plan and what Save did agree.
    expect(io.stored).toHaveLength(plan.counts.originals);
    expect(outcome.archived).toBe(plan.counts.archived);
    expect(view.save.enabled).toBe(!planIsEmpty(plan));
  });
});
