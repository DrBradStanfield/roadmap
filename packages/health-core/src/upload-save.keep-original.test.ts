/**
 * US-14 AC11 (Brad 2026-11-21: "the original letters should still be kept in the cloud storage"): with a cloud, a
 * read lab report with nothing ticked keeps its original; `archived` and `unstored` come from what Save wrote, never
 * from the plan's lists. Each case checks what the caller sees after Save: the records before and after, the
 * cloud's writes, the outcome and the done lines. Synthetic values, names and hashes only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW, recordWith } from './import-review.test-helpers';
import { documentView, isLabArchiveDocument, listedRows } from './document-rows';
import type { UnifiedExtractionResult } from './lab-extraction';
import type { FileDocument, RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type FileChoices } from './upload-choices';
import { transition, type UploadFile, type UploadState } from './upload-flow';
import { knownIndex } from './upload-known';
import { uploadSavePlan } from './upload-plan';
import { reviewedWrites, uploadReview } from './upload-review';
import { uploadSave, type UploadSaveIO } from './upload-save';
import { UPLOAD_TEXT } from './upload-text';
import { uploadView } from './upload-view';

const labX = (over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [extra()], unrecognized: [], document: null, ...over });
const letterX: UnifiedExtractionResult = {
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-10-20', contentMarkdown: '## Plan', metadata: {} },
};
const read = (id: string, extraction: UnifiedExtractionResult, choices: Partial<FileChoices> = {}, hash = `h-${id}`): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices: { ...NO_CHOICES, ...choices } } });
const open = (files: UploadFile[]): UploadState => ({ phase: 'open', platform: 'phone', run: 1, files, started: NOW, firstRead: null });
const none = { ticks: { a0: false, a1: false, v0: false } };
const view = (s: UploadState, record: RoadmapFile, cloud = true) => uploadView(s, record, NOW, uploadReview(s, record, NOW), cloud);

/** A cloud that keeps what is written; `fail` names files it does not hold or refuses to store. */
function cloudIO(fail: { notHeld?: string[]; refused?: string[] } = {}): UploadSaveIO<string> & { stored: string[] } {
  const stored: string[] = [];
  let n = 0;
  return {
    stored, holds: (id) => !fail.notHeld?.includes(id), original: (id) => `bytes of ${id}`, mimeType: () => 'application/pdf',
    write: async (ref, _b, id) => { if (fail.refused?.includes(id)) throw new Error('refused'); stored.push(ref); },
    now: () => NOW, newId: () => `doc-${n++}`,
  };
}
const offCloud = (): UploadSaveIO<string> & { stored: string[] } => ({ ...cloudIO(), holds: () => false });

/** Save as the app runs it: pressed on the open page (its reviewed writes carried), the originals, the commit, the done view. */
async function press(s: UploadState, record: RoadmapFile, opts: { cloud?: boolean; io?: ReturnType<typeof cloudIO>; meanwhile?: (f: RoadmapFile) => RoadmapFile } = {}) {
  const { cloud = true, io = cloud ? cloudIO() : offCloud(), meanwhile = (f: RoadmapFile) => f } = opts;
  const reviewed = reviewedWrites(uploadReview(s, record, NOW));
  const saving = transition(s, { type: 'saveStarted', reviewed }).state;
  const out = await uploadSave(saving, record, NOW, cloud, io);
  if (!out.ok) throw new Error(out.reason);
  const at = meanwhile(record);
  const { file, outcome } = out.commit(at);
  const done = transition(saving, { type: 'saved', run: saving.run, attempt: 1, outcome }).state;
  return { file, at, outcome, done: view(done, file, cloud).done, stored: io.stored };
}
const archives = (f: RoadmapFile): FileDocument[] => f.documents.filter((d) => !d.deleted && isLabArchiveDocument(documentView(d)));
const newLabIds = (before: RoadmapFile, after: RoadmapFile) => after.labValues.filter((r) => !before.labValues.some((b) => b.id === r.id)).map((r) => r.id);
const KEPT = UPLOAD_TEXT.archivedLine(1);
/** Another lab value on the report's day: the list-less date rule calls any report of that day known. */
const sameDay = () => recordWith([{ kind: 'lab', metricName: 'Vitamin B12', value: 400, unit: 'pmol/L', referenceLow: null, referenceHigh: null }]);

describe('US-14 AC11: nothing ticked, the original is kept with a cloud', () => {
  it('with a cloud: the original is stored on a list-less archive row and the done screen says so', async () => {
    const s = open([read('a', labX(), none)]);
    expect(view(s, EMPTY).save).toMatchObject({ label: 'Save 1 original', enabled: true });
    const { file, outcome, done, stored } = await press(s, EMPTY);
    expect(stored).toHaveLength(1);
    expect(file.labValues).toEqual([]);
    expect(archives(file)).toHaveLength(1);
    expect(archives(file)[0]).toMatchObject({ contentHash: 'h-a', fileRef: stored[0], date: DAY });
    expect(listedRows(archives(file)[0])).toBeNull(); // list-less: known by the date rule, as the web files it
    expect(outcome).toEqual({ values: 0, documents: 0, archived: 1, unstored: 0 });
    expect(done).toMatchObject({ line: KEPT, archived: null, unstored: null }); // US-14 AC13: the kept line alone
  });

  it('with no cloud: nothing to save, as on main', async () => {
    const s = open([read('a', labX(), none)]);
    expect(view(s, EMPTY, false).save).toMatchObject({ enabled: false, why: UPLOAD_TEXT.saveNothing });
    const { file, outcome, stored } = await press(s, EMPTY, { cloud: false });
    expect(file).toBe(EMPTY);
    expect(stored).toEqual([]);
    expect(outcome).toEqual({ values: 0, documents: 0, archived: 0, unstored: 0 });
  });

  it('the kept row is judged by the date rule: known while its day holds an active value, read again otherwise', async () => {
    expect(knownIndex((await press(open([read('a', labX(), none)]), sameDay())).file).has('h-a')).toBe(true);
    expect(knownIndex((await press(open([read('a', labX(), none)]), EMPTY)).file).has('h-a')).toBe(false);
  });

  it('re-picked after it was kept: "Nothing new to save", Save disabled, and a forced Save writes nothing', async () => {
    const first = await press(open([read('a', labX(), none)]), EMPTY);
    const again = open([read('a', labX(), none)]);
    expect(view(again, first.file).save).toMatchObject({ label: UPLOAD_TEXT.saveBoth(0, 0), enabled: false, why: UPLOAD_TEXT.saveNothing });
    const forced = await press(again, first.file);
    expect(forced.file).toBe(first.file);
    expect(forced.stored).toEqual([]);
    expect(forced.outcome).toEqual({ values: 0, documents: 0, archived: 0, unstored: 0 });
  });
});

describe('US-14 AC11: the counts come from what Save wrote', () => {
  it("Codex's sequence: A's kept conflict, B saves a value, A's held row deleted after the press: A's original stored, counted, line shown", async () => {
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.0 }]);
    const s = open([read('a', labX({ values: [core()], additionalValues: [] })), read('b', labX())]);
    const deleted = (f: RoadmapFile) => ({ ...f, measurements: f.measurements.map((m) => ({ ...m, status: 'entered-in-error' as const })) });
    const { file, at, outcome, done, stored } = await press(s, record, { meanwhile: deleted });
    expect(stored).toHaveLength(2);
    expect(file.measurements.filter((m) => m.status === 'active')).toEqual([]); // A's value was not promised, so not written
    expect(newLabIds(at, file)).toHaveLength(1);
    const a = archives(file).find((d) => d.contentHash === 'h-a')!;
    expect(a.fileRef).toBeTruthy();
    expect(outcome).toMatchObject({ values: 1, archived: 1, unstored: 0 });
    expect(done).toMatchObject({ archived: KEPT });
  });

  it('a report whose every value the write refuses: original stored, "kept in your cloud"', async () => {
    for (const x of [labX({ additionalValues: [extra({ unit: 'zzz' })] }), labX({ additionalValues: [], refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'unit unknown' }] })]) {
      const { file, outcome, done, stored } = await press(open([read('a', x)]), EMPTY);
      expect(stored).toHaveLength(1);
      expect(archives(file)).toHaveLength(1);
      expect(outcome).toMatchObject({ values: 0, archived: 1, unstored: 0 });
      expect(done).toMatchObject({ line: KEPT, archived: null }); // US-14 AC13: never "Saved 0 values." above it
    }
  });

  it('a report the record fully holds: original stored, "kept in your cloud"', async () => {
    const record = recordWith([{ kind: 'lab', metricName: 'Ferritin', value: 80, unit: 'µg/L', referenceLow: null, referenceHigh: null }]);
    const { file, outcome, done, stored } = await press(open([read('a', labX())]), record);
    expect(stored).toHaveLength(1);
    expect(newLabIds(record, file)).toEqual([]);
    expect(outcome).toMatchObject({ values: 0, archived: 1 });
    expect(done).toMatchObject({ line: KEPT, archived: null }); // US-14 AC13
  });

  it('a report that saves a core value alone is never counted "kept": its bytes wrote a value', async () => {
    const { outcome, done, stored } = await press(open([read('a', labX({ values: [core()], additionalValues: [] }))]), EMPTY);
    expect(stored).toHaveLength(1);
    expect(outcome).toMatchObject({ values: 1, archived: 0 });
    expect(done).toMatchObject({ archived: null });
  });

  it('a nothing-ticked original the caller does not hold: "Save 1 original", nothing stored, the unstored line, never "kept"', async () => {
    const s = open([read('a', labX(), none)]);
    expect(view(s, EMPTY).save).toMatchObject({ label: 'Save 1 original' });
    const { file, outcome, done, stored } = await press(s, EMPTY, { io: cloudIO({ notHeld: ['a'] }) });
    expect(stored).toEqual([]);
    expect(archives(file).every((d) => !d.fileRef)).toBe(true); // its hash alone, so a later upload can still store it
    expect(outcome).toEqual({ values: 0, documents: 0, archived: 0, unstored: 1 });
    expect(done).toMatchObject({ archived: null, unstored: UPLOAD_TEXT.unstoredAlone }); // no details were saved (Brad 2026-11-23)
  });

  it('a ticked report and a letter the caller does not hold are counted unstored too', async () => {
    const { outcome, stored } = await press(open([read('a', labX()), read('l', letterX)]), EMPTY, { io: cloudIO({ notHeld: ['a', 'l'] }) });
    expect(stored).toEqual([]);
    expect(outcome).toMatchObject({ values: 1, documents: 1, archived: 0, unstored: 2 });
  });

  it('a failing original write: the unstored line, never "kept in your cloud"', async () => {
    const { file, outcome, done, stored } = await press(open([read('a', labX(), none)]), EMPTY, { io: cloudIO({ refused: ['a'] }) });
    expect(stored).toEqual([]);
    expect(archives(file).every((d) => !d.fileRef)).toBe(true);
    expect(outcome).toEqual({ values: 0, documents: 0, archived: 0, unstored: 1 });
    expect(done).toMatchObject({ archived: null, unstored: UPLOAD_TEXT.unstoredAlone }); // no details were saved (Brad 2026-11-23)
  });
});

describe('US-14 AC11: copies of the same bytes in one pick', () => {
  const two = labX({ additionalValues: [extra(), extra({ name: 'Vitamin D', value: 70, unit: 'nmol/L' })] });
  const cases = [
    ['unticked, then ticked', [none, {}]],
    ['ticked, then unticked', [{}, none]],
    ['unticked, ticked one, ticked the other', [none, { ticks: { a1: false } }, { ticks: { a0: false } }]],
    ['two unticked', [none, none]],
  ] as const;
  it.each(cases)('%s: one original stored, one archive row listing every value either wrote', async (_name, ticks) => {
    const s = open(ticks.map((t, k) => read(`f${k}`, two, t, 'h-x')));
    const { file, outcome, stored } = await press(s, EMPTY);
    const written = newLabIds(EMPTY, file);
    expect(stored).toHaveLength(1);
    expect(archives(file)).toHaveLength(1);
    expect(archives(file)[0].fileRef).toBe(stored[0]);
    expect([...(listedRows(archives(file)[0]) ?? [])].sort()).toEqual([...written].sort());
    expect(outcome).toMatchObject({ values: written.length, archived: written.length ? 0 : 1, unstored: 0 });
  });

  it.each([['lab first', ['lab', 'letter']], ['letter first', ['letter', 'lab']]] as const)(
    'an unticked lab copy and a letter copy (%s): the letter is filed with the original; the lab copy writes nothing',
    async (_name, order) => {
      const s = open(order.map((k) => (k === 'lab' ? read('lab', labX(), none, 'h-x') : read('letter', letterX, {}, 'h-x'))));
      expect(view(s, EMPTY).save).toMatchObject({ label: UPLOAD_TEXT.saveBoth(0, 1) });
      const { file, outcome, done, stored } = await press(s, EMPTY);
      expect(stored).toHaveLength(1);
      expect(archives(file)).toEqual([]);
      expect(file.documents.filter((d) => !d.deleted)).toEqual([expect.objectContaining({ contentHash: 'h-x', fileRef: stored[0], title: 'Synthetic letter' })]);
      expect(outcome).toEqual({ values: 0, documents: 1, archived: 0, unstored: 0 });
      expect(done).toMatchObject({ archived: null });
    },
  );
});

describe('US-14 AC11: the plan names no list beside it', () => {
  it('a nothing-ticked report sits in labArchives only with a cloud; archiveOnly stays known files alone', () => {
    const s = open([read('a', labX(), none)]);
    const plan = (cloud: boolean) => uploadSavePlan(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), cloud);
    expect(plan(true)).toMatchObject({ labArchives: [{ fileId: 'a' }], archiveOnly: [], counts: { originals: 1, archived: 0 } });
    expect(plan(false)).toMatchObject({ labArchives: [], archiveOnly: [], counts: { originals: 0 } });
  });
});
