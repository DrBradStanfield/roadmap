/**
 * What one Save writes (design section 1, PR 8; US-52 AC8c, US-13 AC13, AC14): lab rows by
 * file from the one classification the view used (upload-review.ts), every new document with
 * the person's fixes, the lab reports' archive rows, and, with a cloud, the originals of known
 * files filed behind the row the record holds. Pure; the bytes stay with the platform, by file id.
 */
import { documentView, pendingRowsFor } from './document-save';
import type { DocumentFields } from './document-rows';
import type { UnifiedExtractionResult } from './lab-extraction';
import { validDay, type BulkRow } from './record-edits';
import { isReadableRow } from './readable-rows';
import type { RoadmapFile } from './roadmap-file';
import { documentDate } from './upload-choices';
import { uploadFileName, type UploadState } from './upload-flow';
import { readDocumentFields } from './upload-known';
import type { UploadReview } from './upload-review';
import { screeningBox, type ScreeningBox, type ScreeningPerson } from './upload-screening';

export interface UploadSavePlan {
  /** Each read lab report's rows Save writes, in Save's order; a file with none is left out. */
  labRows: Array<{ fileId: string; rows: BulkRow[] }>;
  /** Every read letter or document, saved by default (owner's ruling Q3 a), with the person's fixes. `screening`: its
   *  screening box (US-13 AC6), on the web only and only when the caller names the person; Save writes `key` with `date`
   *  when it is ticked and dated (upload-save.ts). */
  documents: Array<{ fileId: string; fields: DocumentFields; screening?: ScreeningBox }>;
  /** Each read lab report's hidden archive row, built at write time with the rows it wrote: with no cloud only one with a
   *  value ticked (a hash-only row); with a cloud also one with none ticked, its original kept alone (US-14 AC11). */
  labArchives: Array<{ fileId: string; sourceFileName: string; reportDate: string | null }>;
  /** With a cloud: known files whose held row stores no original, filed behind it as the kind the record holds (US-14 AC4). */
  archiveOnly: Array<{ fileId: string; fields: DocumentFields }>;
  /** `originals`: the files Save stores in the cloud (lab archives and archive-only); 0 with no cloud. */
  counts: { values: number; documents: number; archived: number; originals: number };
}

/** A read lab report holds something to review: a value, an extra lab or one the write refuses. */
export const labReadFound = (x: UnifiedExtractionResult) => (x.values?.length ?? 0) + (x.additionalValues?.length ?? 0) + (x.refusedValues?.length ?? 0) > 0;

/** Bytes a live row already stores the original of: `saveDocuments` files no second one, so Save never offers it. */
export const storedHashes = (record: RoadmapFile) =>
  new Set(record.documents.flatMap((d) => (!d.deleted && d.fileRef && d.contentHash && isReadableRow('documents', d) ? [d.contentHash] : [])));

const fieldsOf = (d: ReturnType<typeof documentView>, sourceFileName: string): DocumentFields => ({
  documentType: d.documentType, title: d.title, documentDate: d.documentDate, contentMd: d.contentMd, metadata: d.metadata, sourceFileName,
});

/**
 * `review`: the caller's `uploadReview`, the same one it hands `uploadView`. Each file is
 * planned once in picked order: a second file with the bytes of one already planned writes
 * nothing (`saveDocuments` would skip it by hash, US-13 AC1). `person`: the web's plan's age and sex, for a letter's
 * screening box; the phone passes none and has none.
 */
export function uploadSavePlan(s: UploadState, record: RoadmapFile, now: string, review: UploadReview, cloudConnected: boolean, person?: ScreeningPerson): UploadSavePlan {
  // Only rows this build reads (US-65) give a held title, date or kind, newest first, as upload-known.ts indexes them.
  const views = record.documents.filter((d) => !d.deleted && isReadableRow('documents', d)).map(documentView);
  const labs = new Map(review.labFiles.map((f) => [f.fileId, f]));
  const seen = new Set<string>();
  const documents: UploadSavePlan['documents'] = [];
  const labArchives: UploadSavePlan['labArchives'] = [];
  const archiveOnly: UploadSavePlan['archiveOnly'] = [];
  // A report with nothing ticked keeps its original only when no other copy in the pick claims its bytes: it writes no
  // row, so it never hides a letter or a ticked copy of them (decided after the loop).
  const alone: Array<UploadSavePlan['labArchives'][number] & { hash: string }> = [];
  const stored = storedHashes(record);
  for (const f of 'files' in s ? s.files : []) {
    if (f.hash && seen.has(f.hash)) continue;
    if (f.status.s === 'read' && f.status.extraction.classification !== 'lab_report' && f.status.extraction.document) {
      const doc = f.status.extraction.document;
      // A metadata-only row holding these bytes: the card starts from its title and date (US-14 AC4).
      const held = pendingRowsFor(views, f.hash, false)[0];
      const fix = f.status.choices.document;
      const fixedDate = 'date' in fix ? documentDate(fix.date ?? null, now) : undefined; // an impossible date is never planned
      const raw = held ? held.documentDate : doc.documentDate;
      const screening = s.platform === 'web' && person ? screeningBox(doc.metadata, raw, fixedDate, fix.screening, person, now) : null;
      documents.push({ fileId: f.id, fields: {
        ...readDocumentFields(doc, uploadFileName(f)),
        documentType: fix.kind ?? doc.classification,
        title: fix.title ?? held?.title ?? doc.title,
        documentDate: fixedDate !== undefined ? fixedDate : validDay(raw ?? undefined, { now }),
      }, ...(screening ? { screening } : {}) });
    } else if (f.status.s === 'read') {
      // A report's original is filed with its values: not while it waits for a day, nor for a photo or a scan, which has
      // none (`original: false`, US-52 AC13e): no hidden archive row for it at all. With every value unticked, only with a
      // cloud, its original alone (US-14 AC11, Brad 2026-11-21), unless the read found nothing or a live row stores it.
      const lab = labs.get(f.id);
      if (!lab || lab.needsDay || f.original === false) continue;
      const entry = { fileId: f.id, sourceFileName: uploadFileName(f), reportDate: lab.day };
      if (!lab.ticked.length) {
        if (cloudConnected && f.hash && labReadFound(f.status.extraction) && !stored.has(f.hash)) alone.push({ ...entry, hash: f.hash });
        continue;
      }
      labArchives.push(entry);
    } else if (cloudConnected && f.status.s === 'known' && f.status.archiveOnly && f.status.as !== 'legacy' && f.hash && f.original !== false) {
      const held = pendingRowsFor(views, f.hash, f.status.as === 'labReport')[0];
      if (!held) continue;
      archiveOnly.push({ fileId: f.id, fields: fieldsOf(held, uploadFileName(f)) });
    } else continue;
    if (f.hash) seen.add(f.hash);
  }
  for (const { hash, ...entry } of alone) if (!seen.has(hash)) { seen.add(hash); labArchives.push(entry); }
  const labRows = review.labFiles.flatMap(({ fileId }) => {
    const rows = review.rowsByFile.get(fileId);
    return rows ? [{ fileId, rows }] : [];
  });
  return {
    labRows, documents, labArchives, archiveOnly,
    counts: {
      values: review.classification.rows.length, documents: documents.length, archived: archiveOnly.length,
      originals: cloudConnected ? labArchives.length + archiveOnly.length : 0,
    },
  };
}

/** Save would write nothing new: no value, no document, no original to store. */
export const planIsEmpty = (p: UploadSavePlan) => !p.counts.values && !p.counts.documents && !p.counts.originals;
