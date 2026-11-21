/**
 * What one Save writes (design section 1, PR 8; US-52 AC8c, US-13 AC13, AC14): lab rows by
 * file from the one classification the view used (upload-review.ts), every new document with
 * the person's fixes, the lab reports' archive rows, and, with a cloud, the originals of known
 * files filed behind the row the record holds. Pure; the bytes stay with the platform, by file id.
 */
import { documentView, pendingRowsFor } from './document-save';
import { labArchiveFields, type DocumentFields } from './document-rows';
import type { UnifiedExtractionResult } from './lab-extraction';
import { validDay, type BulkRow } from './record-edits';
import { isReadableRow } from './readable-rows';
import type { RoadmapFile } from './roadmap-file';
import { documentDate } from './upload-choices';
import { uploadFileName, type UploadState } from './upload-flow';
import { readDocumentFields } from './upload-known';
import type { UploadReview } from './upload-review';

export interface UploadSavePlan {
  /** Each read lab report's rows Save writes, in Save's order; a file with none is left out. */
  labRows: Array<{ fileId: string; rows: BulkRow[] }>;
  /** Every read letter or document, saved by default (owner's ruling Q3 a), with the person's fixes. */
  documents: Array<{ fileId: string; fields: DocumentFields }>;
  /** Each read lab report's hidden archive row with at least one value ticked, built at write
   *  time with the rows it wrote. With no cloud it holds no original (a hash-only row). */
  labArchives: Array<{ fileId: string; sourceFileName: string; reportDate: string | null }>;
  /** With a cloud: known files whose held row stores no original, filed behind it as the kind the record holds (US-14 AC4),
   *  and read lab reports with no value ticked, their original alone as the hidden archive row (US-14 AC11). */
  archiveOnly: Array<{ fileId: string; fields: DocumentFields }>;
  /** `originals`: the files Save stores in the cloud (lab archives and archive-only); 0 with no cloud. */
  counts: { values: number; documents: number; archived: number; originals: number };
}

/** A read lab report holds something to review: a value, an extra lab or one the write refuses. */
export const labReadFound = (x: UnifiedExtractionResult) => (x.values?.length ?? 0) + (x.additionalValues?.length ?? 0) + (x.refusedValues?.length ?? 0) > 0;

const fieldsOf = (d: ReturnType<typeof documentView>, sourceFileName: string): DocumentFields => ({
  documentType: d.documentType, title: d.title, documentDate: d.documentDate, contentMd: d.contentMd, metadata: d.metadata, sourceFileName,
});

/**
 * `review`: the caller's `uploadReview`, the same one it hands `uploadView`. Each file is
 * planned once in picked order: a second file with the bytes of one already planned writes
 * nothing (`saveDocuments` would skip it by hash, US-13 AC1).
 */
export function uploadSavePlan(s: UploadState, record: RoadmapFile, now: string, review: UploadReview, cloudConnected: boolean): UploadSavePlan {
  // Only rows this build reads (US-65) give a held title, date or kind, newest first, as upload-known.ts indexes them.
  const views = record.documents.filter((d) => !d.deleted && isReadableRow('documents', d)).map(documentView);
  const labs = new Map(review.labFiles.map((f) => [f.fileId, f]));
  const seen = new Set<string>();
  const documents: UploadSavePlan['documents'] = [];
  const labArchives: UploadSavePlan['labArchives'] = [];
  const archiveOnly: UploadSavePlan['archiveOnly'] = [];
  for (const f of 'files' in s ? s.files : []) {
    if (f.hash && seen.has(f.hash)) continue;
    if (f.status.s === 'read' && f.status.extraction.classification !== 'lab_report' && f.status.extraction.document) {
      const doc = f.status.extraction.document;
      // A metadata-only row holding these bytes: the card starts from its title and date (US-14 AC4).
      const held = pendingRowsFor(views, f.hash, false)[0];
      const fix = f.status.choices.document;
      const fixedDate = 'date' in fix ? documentDate(fix.date ?? null, now) : undefined; // an impossible date is never planned
      documents.push({ fileId: f.id, fields: {
        ...readDocumentFields(doc, uploadFileName(f)),
        documentType: fix.kind ?? doc.classification,
        title: fix.title ?? held?.title ?? doc.title,
        documentDate: fixedDate !== undefined ? fixedDate : validDay((held ? held.documentDate : doc.documentDate) ?? undefined, { now }),
      } });
    } else if (f.status.s === 'read') {
      // A report's original is filed with its values: not while it waits for a day, nor for a photo or a scan, which has
      // none (`original: false`, US-52 AC13e): no hidden archive row for it at all. With nothing ticked and a cloud, its
      // original alone is kept, as an archive-only one (US-14 AC11, Brad 2026-11-21), unless the read found nothing in it.
      const lab = labs.get(f.id);
      if (!lab || lab.needsDay || f.original === false) continue;
      if (lab.ticked.length) labArchives.push({ fileId: f.id, sourceFileName: uploadFileName(f), reportDate: lab.day });
      else if (cloudConnected && f.hash && labReadFound(f.status.extraction)) archiveOnly.push({ fileId: f.id, fields: labArchiveFields(uploadFileName(f), lab.day) });
      else continue;
    } else if (cloudConnected && f.status.s === 'known' && f.status.archiveOnly && f.status.as !== 'legacy' && f.hash && f.original !== false) {
      const held = pendingRowsFor(views, f.hash, f.status.as === 'labReport')[0];
      if (!held) continue;
      archiveOnly.push({ fileId: f.id, fields: fieldsOf(held, uploadFileName(f)) });
    } else continue;
    if (f.hash) seen.add(f.hash);
  }
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
