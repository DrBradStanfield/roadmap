/**
 * One Save of the shared upload (US-52 AC8c, US-14 AC10): the pick's values AND its document and lab
 * archive rows, written in one step, through the website's own save paths, never a copy of them:
 * `uploadSavePlan` for what to write, `bulkAppendValues` for the values (FHIR: rows appended, a
 * correction by `correctsId`, one active row per slot), `labRowsByFile` for the rows each report's
 * archive row lists, `labArchivePayload` and `saveDocuments` for the rows and the originals (hash
 * dedup, a held metadata-only row replaced and tombstoned, a stored original never lost).
 *
 * Two halves, as saveDocuments has: the originals are written first (async), then `commit(file)` writes
 * every row on the record as it stands at commit time (sync), as the web's `session.edit(commit)` does.
 * The values are written there, so an edit that landed meanwhile is kept and a slot it took is
 * skipped; each archive row lists the rows that commit wrote. An original is written once.
 *
 * A repeat on the record it saved writes nothing (commit answers the same file): saved values are
 * classified saved, and saveDocuments skips bytes the record already holds. It refuses, writing
 * nothing, while the view would: a selected value the write refuses, or a report waiting for its day
 * (`saveBlocked`). Pure but for `io`: the bytes and the cloud writes are the caller's.
 */
import { LAB_ARCHIVE_ROWS, labRowsByFile, listedRows, writtenLabRows } from './document-rows';
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
  /** Its bytes, read as it is written; null when they cannot be read now. */
  original(fileId: string): F | null;
  /** The original's MIME type by file id, '' when unknown. */
  mimeType(fileId: string): string;
  /** Write file `fileId`'s bytes at `ref` in the person's cloud; reject on failure. */
  write(ref: string, bytes: F, fileId: string): Promise<void>;
  now?(): string;
  newId?(): string;
}

/**
 * `unstored`: originals the plan stores that did not land (unreadable, or the cloud refused them):
 * their rows keep the hash alone, and a later upload of the same file can still store them.
 * `commit(file)`: every row on `file` as it stands now; the same `file` when nothing is new.
 */
export type UploadSaveResult =
  | { ok: true; unstored: number; commit(file: RoadmapFile): { file: RoadmapFile; outcome: SaveOutcome } }
  | { ok: false; reason: 'not-saving' | 'not-ready'; message: string };

/** An original as saveDocuments holds it: the file it is, with the hash the state read for its bytes. */
interface Held { fileId: string; hash: string }

export async function uploadSave<F>(s: UploadState, record: RoadmapFile, now: string, cloudConnected: boolean, io: UploadSaveIO<F>): Promise<UploadSaveResult> {
  if (s.phase !== 'saving') return { ok: false, reason: 'not-saving', message: 'The upload is not saving.' };
  const review = uploadReview(s, record, now);
  const blocked = saveBlocked(review);
  if (blocked) return { ok: false, reason: 'not-ready', message: blocked };
  const plan = uploadSavePlan(s, record, now, review, cloudConnected);

  const rows = plan.labRows.flatMap((f) => f.rows);
  const rowFiles = plan.labRows.flatMap((f) => f.rows.map(() => f.fileId));
  // The rows a write on `record` would give each report: what its archive row plans to list. The
  // commit writes them again on the record as it is then, and the lists take those rows' ids.
  const onRecord = bulkAppendValues(record, rows, now);
  const planned = writtenLabRows(onRecord);
  const rowsOf = labRowsByFile(planned, rowFiles);
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
  let unstored = 0;
  const docs = await saveDocuments(record, payloads, {
    hash: async (f) => f.hash,
    write: async (ref, f) => {
      const bytes = io.original(f.fileId);
      if (bytes === null) throw new Error('The original could not be read.');
      await io.write(ref, bytes, f.fileId);
    },
    // Every write that throws, the unreadable included: saveDocuments' own count is only those behind a held row.
    onWriteError: () => void (unstored += 1),
    mimeType: (f) => io.mimeType(f.fileId), now: io.now, newId: io.newId,
  });
  // Counted as the web's done screen counts them (useUploadFlow.ts `documents`): every distinct row
  // saved, a lab report's archive row and an original filed behind a held row included; `archived`
  // is the last of those alone.
  const archiveOnly = new Set(plan.archiveOnly.map((d) => hashOf.get(d.fileId)));
  const outcome = {
    documents: new Set(docs.saved.map((d) => d.contentHash ?? d.sourceFileName ?? d.id)).size,
    archived: docs.saved.filter((d) => archiveOnly.has(d.contentHash)).length,
  };

  return {
    ok: true, unstored,
    // Once per Save: it writes the archive rows' lists in place.
    commit(file) {
      // On the record it planned on, the planned write stands; on any other, the values are written
      // again and each planned row id becomes the one this write gave the same row, or leaves the list.
      const written = file === record ? onRecord : bulkAppendValues(file, rows, now);
      if (written !== onRecord) {
        const ids = writtenLabRows(written);
        const swap = new Map(planned.flatMap((id, i) => (id ? [[id, ids[i]] as const] : [])));
        for (const d of docs.saved) {
          const list = listedRows(d);
          if (list) d.metadata = { ...d.metadata, [LAB_ARCHIVE_ROWS]: list.flatMap((id) => { const to = swap.has(id) ? swap.get(id) : id; return to ? [to] : []; }) };
        }
      }
      const values = written.saved.length;
      return { file: values || docs.saved.length ? committedFile(written.file, docs) : file, outcome: { values, ...outcome } };
    },
  };
}
