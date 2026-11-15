/**
 * uploadSave as a caller sees it (US-52 AC8c, US-14 AC10, US-13 AC5): one step writes a pick's
 * values and its document and lab archive rows, through the web's own save paths. Synthetic values,
 * names and hashes only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW } from './import-review.test-helpers';
import { LAB_ARCHIVE_FLAG, LAB_ARCHIVE_ROWS, labRowsByFile, listedRows, writtenLabRows } from './document-rows';
import { labArchivePayload, saveDocuments, type DocumentPayload } from './document-save';
import type { UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues } from './record-edits';
import type { FileDocument, RoadmapFile } from './roadmap-file';
import type { FileChoices } from './upload-choices';
import type { FileStatus, UploadFile, UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { uploadSave, type UploadSaveIO } from './upload-save';

const NO: FileChoices = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };
const labX = (over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: DAY, values: [core()], additionalValues: [extra()], unrecognized: [], document: null, ...over });
const letterX: UnifiedExtractionResult = {
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-10-20', contentMarkdown: '## Plan', metadata: {} },
};
const read = (id: string, extraction: UnifiedExtractionResult, choices = NO): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices } });
const at = (id: string, status: FileStatus, hash: string | null = `h-${id}`): UploadFile => ({ id, name: `${id}.pdf`, bytes: 1, hash, pages: null, status });
const saving = (files: UploadFile[]): UploadState => ({ phase: 'saving', platform: 'phone', run: 1, files, started: NOW, firstRead: NOW, attempt: 1 });
const heldDoc = (over: Partial<FileDocument>): FileDocument => ({
  id: 'held', title: 'Held letter', type: 'clinic_letter', date: '2026-01-01', fileRef: '', contentHash: 'h-kn', mimeType: '', extractedText: '',
  addedAt: NOW, metadata: {}, sourceFileName: 'kn.pdf', ...over,
});
const withDocs = (documents: FileDocument[], file: RoadmapFile = EMPTY): RoadmapFile => ({ ...file, documents });

/** A cloud that keeps what is written, by ref; ids and times fixed so two runs compare. */
function cloud(): UploadSaveIO<string> & { stored: Map<string, string> } {
  const stored = new Map<string, string>();
  let n = 0;
  return {
    stored, holds: () => true, original: (fileId) => `bytes of ${fileId}`, mimeType: () => 'application/pdf',
    write: async (ref, bytes) => void stored.set(ref, bytes), now: () => NOW, newId: () => `id-${n++}`,
  };
}
const offCloud = (): UploadSaveIO<string> => { let n = 0; return { holds: () => false, original: () => null, mimeType: () => '', write: async () => { throw new Error('no cloud'); }, now: () => NOW, newId: () => `id-${n++}` }; };

const MIXED = saving([
  read('lab', labX()),
  read('letter', letterX),
  at('kn', { s: 'known', as: 'document', archiveOnly: true }),
  at('bad', { s: 'failed', reason: 'network', attempt: 1 }),
]);

describe('uploadSave: one step for values and rows (US-52 AC8c)', () => {
  it('a mixed pick saves once, and its counts are the plan\'s the view showed', async () => {
    const record = withDocs([heldDoc({})]);
    const plan = uploadSavePlan(MIXED, record, NOW, uploadReview(MIXED, record, NOW), true);
    const io = cloud();
    const out = await uploadSave(MIXED, record, NOW, true, io);
    if (!out.ok) throw new Error(out.reason);
    expect(out.outcome).toEqual({ values: plan.counts.values, documents: plan.counts.documents, archived: plan.counts.archived });
    expect(out.outcome).toEqual({ values: 2, documents: 1, archived: 1 });
    const live = out.file.documents.filter((d) => !d.deleted);
    const archive = live.find((d) => d.metadata?.[LAB_ARCHIVE_FLAG] === true)!;
    // The archive row lists exactly the lab rows its values wrote, and holds its original.
    expect(listedRows(archive)).toEqual(out.file.labValues.map((r) => r.id).filter((id) => listedRows(archive)!.includes(id)));
    expect(listedRows(archive)).toHaveLength(2);
    expect(archive.fileRef).not.toBe('');
    expect(io.stored.size).toBe(3); // the letter, the lab report and the known file's original
    // The held metadata-only row is replaced by the one with the original, never edited.
    expect(out.file.documents.find((d) => d.id === 'held')).toMatchObject({ deleted: true, fileRef: '' });
    expect(record.documents.find((d) => d.id === 'held')!.deleted).toBeUndefined();
  });

  it('a repeat call with the same state and the saved record adds nothing', async () => {
    for (const [cloudOn, io] of [[true, cloud()], [false, offCloud()]] as const) {
      const first = await uploadSave(MIXED, withDocs([heldDoc({})]), NOW, cloudOn, io);
      if (!first.ok) throw new Error(first.reason);
      const again = await uploadSave(MIXED, first.file, NOW, cloudOn, io);
      if (!again.ok) throw new Error(again.reason);
      expect(again.outcome, String(cloudOn)).toEqual({ values: 0, documents: 0, archived: 0 });
      expect(again.file.labValues.length + again.file.measurements.length).toBe(first.file.labValues.length + first.file.measurements.length);
      expect(again.file.documents.filter((d) => !d.deleted)).toEqual(first.file.documents.filter((d) => !d.deleted));
    }
  });

  it('a replacement keeps the stored original its old archive row held (US-14 AC10)', async () => {
    // An archive row with the original, whose listed values are all gone: the file is read again.
    const old = heldDoc({ id: 'old', title: 'Lab results', type: 'pathology_report', contentHash: 'h-lab', fileRef: 'Lab results/lab.pdf', mimeType: 'application/pdf',
      metadata: { [LAB_ARCHIVE_FLAG]: true, [LAB_ARCHIVE_ROWS]: ['gone'] }, sourceFileName: 'lab.pdf' });
    const s = saving([read('lab', labX())]);
    const out = await uploadSave(s, withDocs([old]), NOW, false, offCloud());
    if (!out.ok) throw new Error(out.reason);
    const archive = out.file.documents.find((d) => !d.deleted && d.contentHash === 'h-lab')!;
    expect(archive).toMatchObject({ fileRef: 'Lab results/lab.pdf', mimeType: 'application/pdf' });
    expect(listedRows(archive)).toEqual(expect.arrayContaining(['gone']));
    expect(listedRows(archive)).toHaveLength(3);
    expect(out.file.documents.find((d) => d.id === 'old')!.deleted).toBe(true);
  });

  it('a selected value Save would refuse, or a report waiting for its day, refuses with nothing written', async () => {
    const outOfRange = saving([read('lab', labX({ values: [core({ valueSI: 500, displayValue: 500 })] })), read('letter', letterX)]);
    const noDay = saving([read('lab', labX({ reportDate: null })), read('letter', letterX)]);
    for (const s of [outOfRange, noDay]) {
      const io = cloud();
      const out = await uploadSave(s, EMPTY, NOW, true, io);
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.reason).toBe('not-ready');
      expect(out.message).not.toMatch(/\d/); // the view's words; never a value
      expect(io.stored.size).toBe(0);
    }
  });

  it('refuses a state that is not saving', async () => {
    const out = await uploadSave({ ...MIXED, phase: 'open' } as UploadState, EMPTY, NOW, true, cloud());
    expect(out).toMatchObject({ ok: false, reason: 'not-saving' });
  });
});

/**
 * The website's save (roadmap-store.ts bulkSaveLabValues then bulkSaveDocuments, archive-payloads.ts
 * synthesizeLabArchiveEntries): the values first, their lab rows by file, then every document through
 * saveDocuments, committed on the values' record.
 */
async function webSave(s: UploadState, record: RoadmapFile, cloudOn: boolean, io: UploadSaveIO<string>): Promise<RoadmapFile> {
  const plan = uploadSavePlan(s, record, NOW, uploadReview(s, record, NOW), cloudOn);
  const rows = plan.labRows.flatMap((f) => f.rows);
  const written = bulkAppendValues(record, rows, NOW);
  const byFile = labRowsByFile(writtenLabRows(written), plan.labRows.flatMap((f) => f.rows.map(() => f.fileId)));
  const hash = (id: string) => ('files' in s ? s.files.find((f) => f.id === id)?.hash : null) ?? undefined;
  const file = (id: string) => (cloudOn && io.holds(id) ? io.original(id) ?? undefined : undefined);
  const payloads: DocumentPayload<string>[] = [
    ...plan.documents.map((d) => ({ ...d.fields, file: file(d.fileId), contentHash: hash(d.fileId) })),
    ...plan.labArchives.map((a) => labArchivePayload(a.sourceFileName, a.reportDate, file(a.fileId), { rows: byFile.get(a.fileId), contentHash: hash(a.fileId) })),
    ...plan.archiveOnly.map((d) => ({ ...d.fields, file: file(d.fileId), contentHash: hash(d.fileId) })),
  ];
  const hashOf = new Map(payloads.flatMap((p) => (p.file ? [[p.file, p.contentHash!]] : [])));
  const docs = await saveDocuments(written.file, payloads, { hash: async (f) => hashOf.get(f)!, write: (ref, f) => io.write(ref, f, ''), mimeType: () => io.mimeType(''), now: io.now, newId: io.newId });
  const next = { ...written.file, documents: written.file.documents.map((d) => ({ ...d })) };
  docs.commit(next);
  return next;
}

/** A record with its fresh ids replaced by their order, to compare two saves. */
function shape(file: RoadmapFile): unknown {
  const ids = new Map<string, string>();
  const id = (x: string) => (ids.has(x) ? ids.get(x)! : (ids.set(x, `#${ids.size}`), ids.get(x)!));
  const text = JSON.stringify({ m: file.measurements, l: file.labValues, d: file.documents });
  return JSON.parse(text.replace(/"(?:id|correctsId)":"([^"]+)"/g, (_, x) => `"id":"${id(x)}"`).replace(/"(?:[0-9a-f-]{36})"/g, (x) => `"${id(x)}"`));
}

describe('uploadSave agrees with the website\'s save path (US-52 AC8c)', () => {
  it('on 120 seeded picks, on and off a cloud', async () => {
    let r = 7;
    const rand = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    const ticks = (): FileChoices => ({ ...NO, ticks: rand() < 0.3 ? { v0: false } : {} });
    for (let seed = 0; seed < 120; seed++) {
      const files = Array.from({ length: 1 + Math.floor(rand() * 5) }, (_, i): UploadFile => {
        const id = `f${i}`;
        return pick([
          () => read(id, labX({ reportDate: pick([DAY, '2026-10-01']), values: [core({ valueSI: 2 + i / 10, displayValue: 2 + i / 10 })] }), ticks()),
          () => read(id, { ...letterX, document: { ...letterX.document!, title: `Letter ${i}` } }),
          () => at(id, { s: 'known', as: 'document', archiveOnly: true }, 'h-kn'),
          () => at(id, { s: 'failed', reason: 'busy', attempt: 1 }),
        ])();
      });
      const s = saving(files);
      const record = withDocs(rand() < 0.5 ? [heldDoc({})] : []);
      for (const cloudOn of [true, false]) {
        const mine = await uploadSave(s, record, NOW, cloudOn, cloudOn ? cloud() : offCloud());
        if (!mine.ok) throw new Error(`seed ${seed}: ${mine.reason}`);
        const web = await webSave(s, record, cloudOn, cloudOn ? cloud() : offCloud());
        expect(shape(mine.file), `seed ${seed} cloud ${cloudOn}`).toEqual(shape(web));
      }
    }
  });
});
