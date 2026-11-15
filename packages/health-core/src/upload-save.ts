/**
 * One Save of the shared upload (US-52 AC8c, US-14 AC10): the pick's values AND its document and lab
 * archive rows, written in one step, through the website's own save paths, never a copy of them:
 * `uploadSavePlan` for what to write, `bulkAppendValues` for the values (FHIR: rows appended, a
 * correction by `correctsId`, one active row per slot), `labRowsByFile` for the rows each report's
 * archive row lists, `labArchivePayload` and `saveDocuments` for the rows and the originals (hash
 * dedup, a held metadata-only row replaced and tombstoned, a stored original never lost).
 *
 * A repeat on the record it saved writes nothing: saved values are classified saved, and
 * saveDocuments skips bytes the record already holds. It refuses, writing nothing, while the view
 * would: a selected value the write refuses, or a report waiting for its day (`saveBlocked`).
 * Pure but for `io`: the bytes and the cloud writes are the caller's, and `record` is not changed.
 */
import { labRowsByFile, writtenLabRows } from './document-rows';
import { committedFile, labArchivePayload, saveDocuments, type DocumentPayload } from './document-save';
import { bulkAppendValues } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import type { SaveOutcome, UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { saveBlocked } from './upload-view';

/**
 * What only the caller holds. Asked about an original only with a cloud, and only for a file the plan
 * stores; its bytes are read only as it is written (saveDocuments writes 3 at a time), so a large pick
 * never holds every original at once, and a file already archived is never read.
 */
export interface UploadSaveIO<F> {
  /** The caller holds this file's original. */
  holds(fileId: string): boolean;
  /** Its bytes, read as it is written; null when they cannot be read now (its row then keeps the hash alone). */
  original(fileId: string): F | null;
  /** The original's MIME type by file id, '' when unknown. */
  mimeType(fileId: string): string;
  /** Write file `fileId`'s bytes at `ref` in the person's cloud; reject on failure (the row then keeps the hash alone). */
  write(ref: string, bytes: F, fileId: string): Promise<void>;
  now?(): string;
  newId?(): string;
}

export type UploadSaveResult =
  | { ok: true; file: RoadmapFile; outcome: SaveOutcome; unstored: number }
  | { ok: false; reason: 'not-saving' | 'not-ready'; message: string };

/** An original as saveDocuments holds it: the file it is, with the hash the state read for its bytes. */
interface Held { fileId: string; hash: string }

export async function uploadSave<F>(s: UploadState, record: RoadmapFile, now: string, cloudConnected: boolean, io: UploadSaveIO<F>): Promise<UploadSaveResult> {
  if (s.phase !== 'saving') return { ok: false, reason: 'not-saving', message: 'The upload is not saving.' };
  const review = uploadReview(s, record, now);
  const blocked = saveBlocked(review);
  if (blocked) return { ok: false, reason: 'not-ready', message: blocked };
  const plan = uploadSavePlan(s, record, now, review, cloudConnected);

  const written = bulkAppendValues(record, plan.labRows.flatMap((f) => f.rows), now);
  const rowsOf = labRowsByFile(writtenLabRows(written), plan.labRows.flatMap((f) => f.rows.map(() => f.fileId)));
  const hashOf = new Map(s.files.map((f) => [f.id, f.hash ?? undefined]));
  const held = (fileId: string): Held | undefined => {
    const hash = hashOf.get(fileId);
    return cloudConnected && hash && io.holds(fileId) ? { fileId, hash } : undefined;
  };
  const payloads: DocumentPayload<Held>[] = [
    ...plan.documents.map((d) => ({ ...d.fields, file: held(d.fileId), contentHash: hashOf.get(d.fileId) })),
    ...plan.labArchives.map((a) => labArchivePayload(a.sourceFileName, a.reportDate, held(a.fileId), { rows: rowsOf.get(a.fileId), contentHash: hashOf.get(a.fileId) })),
    ...plan.archiveOnly.map((d) => ({ ...d.fields, file: held(d.fileId), contentHash: hashOf.get(d.fileId) })),
  ];
  const docs = await saveDocuments(written.file, payloads, {
    hash: async (f) => f.hash,
    write: async (ref, f) => {
      const bytes = io.original(f.fileId);
      if (bytes === null) throw new Error('The original could not be read.');
      await io.write(ref, bytes, f.fileId);
    },
    mimeType: (f) => io.mimeType(f.fileId), now: io.now, newId: io.newId,
  });
  const hashes = (files: ReadonlyArray<{ fileId: string }>) => new Set(files.map((f) => hashOf.get(f.fileId)));
  const count = (of: Set<string | undefined>) => docs.saved.filter((d) => of.has(d.contentHash)).length;
  return {
    ok: true, file: committedFile(written.file, docs), unstored: docs.unstored,
    outcome: { values: written.saved.length, documents: count(hashes(plan.documents)), archived: count(hashes(plan.archiveOnly)) },
  };
}
