/**
 * What one Save writes (design section 1, PR 8; US-52 AC8c, US-13 AC13, AC14): lab rows by
 * file from the one classification the view used (upload-review.ts), every new document with
 * the person's fixes, the lab reports' archive rows, and the originals of known files filed
 * behind the row the record holds. Pure; the bytes stay with the platform, by file id.
 */
import { documentView, pendingRowsFor } from './document-save';
import type { DocumentFields } from './document-rows';
import { validDay, type BulkRow } from './record-edits';
import { isReadableRow } from './readable-rows';
import type { RoadmapFile } from './roadmap-file';
import type { UploadState } from './upload-flow';
import { isLabReport, readFiles, uploadReview, type UploadReview } from './upload-review';

/**
 * The shared lab-archive builder once design PR 5 gives it the rows its import wrote
 * (document-save.ts `labArchivePayload`). Not joined here: the row ids exist only after the
 * write, so the caller builds each `labArchives` entry with them. Follow-up: join to PR 5's
 * builder.
 */
export type LabArchiveBuilder = (sourceFileName: string | null, reportDate: string | null, rowIds: readonly string[]) => DocumentFields;

export interface UploadSavePlan {
  /** Each read lab report's rows Save writes, in Save's order; a file with none is left out. */
  labRows: Array<{ fileId: string; rows: BulkRow[] }>;
  /** Every read letter or document, saved by default (owner's ruling Q3 a), with the person's fixes. */
  documents: Array<{ fileId: string; fields: DocumentFields }>;
  /** Each read lab report's hidden archive row, built at write time with the rows it wrote. */
  labArchives: Array<{ fileId: string; sourceFileName: string; reportDate: string | null }>;
  /** Known files whose held row stores no original: filed behind it, as the kind the record holds (US-14 AC4). */
  archiveOnly: Array<{ fileId: string; fields: DocumentFields }>;
  counts: { values: number; documents: number; archived: number };
}

const fieldsOf = (d: ReturnType<typeof documentView>, sourceFileName: string): DocumentFields => ({
  documentType: d.documentType, title: d.title, documentDate: d.documentDate, contentMd: d.contentMd, metadata: d.metadata, sourceFileName,
});

export function uploadSavePlan(s: UploadState, record: RoadmapFile, now: string, review: UploadReview = uploadReview(s, record, now)): UploadSavePlan {
  const live = record.documents.filter((d) => !d.deleted);
  const views = live.map(documentView);
  const readable = (id: string) => isReadableRow('documents', live.find((d) => d.id === id));
  const files = 'files' in s ? s.files : [];

  const documents = readFiles(s).flatMap((f) => {
    const { extraction, choices } = f.status;
    const doc = extraction.document;
    if (isLabReport(f) || !doc) return [];
    // A metadata-only row holding these bytes: the card starts from its title and date (US-14 AC4),
    // read only when this build can read it (US-65), as the iPhone's review does.
    const found = pendingRowsFor(views, f.hash, false)[0];
    const held = found && readable(found.id) ? found : undefined;
    const fix = choices.document;
    const fields: DocumentFields = {
      documentType: fix.kind ?? doc.classification,
      title: fix.title ?? held?.title ?? doc.title,
      documentDate: 'date' in fix ? fix.date ?? null : validDay((held ? held.documentDate : doc.documentDate) ?? undefined, { now }),
      contentMd: doc.contentMarkdown ?? '',
      metadata: doc.metadata ?? {},
      sourceFileName: f.name,
    };
    return [{ fileId: f.id, fields }];
  });

  // A report's original is filed with its values, so it too waits for the report's day.
  const labArchives = review.labFiles.filter((f) => f.hasValues && !f.needsDay)
    .map(({ fileId, name, day }) => ({ fileId, sourceFileName: name, reportDate: day }));

  const archiveOnly = files.flatMap((f) => {
    if (f.status.s !== 'known' || !f.status.archiveOnly || f.status.as === 'legacy' || !f.hash) return [];
    const held = pendingRowsFor(views, f.hash, f.status.as === 'labReport')[0];
    return held ? [{ fileId: f.id, fields: fieldsOf(held, f.name) }] : [];
  });

  const labRows = review.labFiles.flatMap(({ fileId }) => {
    const rows = review.rowsByFile.get(fileId);
    return rows ? [{ fileId, rows }] : [];
  });
  return {
    labRows, documents, labArchives, archiveOnly,
    counts: { values: review.classification.rows.length, documents: documents.length, archived: archiveOnly.length },
  };
}

/** Save would write or file nothing. */
export const planIsEmpty = (p: UploadSavePlan) => !p.counts.values && !p.counts.documents && !p.counts.archived && !p.labArchives.length;
