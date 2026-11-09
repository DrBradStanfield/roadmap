// My health's Documents (US-73 AC12, US-14 AC8): the clinic letters and scan
// results in the record, as the iPhone lists them. Web twin: MyHealth.tsx
// HealthRecordsSection, with its rules: live rows only, never a lab report's
// archive row (its values are the record), scan results apart from the rest.
import { byNewestDocument, DOCUMENT_TYPE_LABELS } from '../../packages/health-core/src/document-path';
import { documentView, isLabArchiveDocument, type DocumentView } from '../../packages/health-core/src/document-save';
import type { FileDocument, RoadmapFile } from '../../packages/health-core/src/roadmap-file';

/** One document as its row and its page show it. */
export interface ShownDocument {
  id: string;
  title: string;
  /** The web's label for its classification ("Clinic Letter"). */
  typeLabel: string;
  /** YYYY-MM-DD, or null when the document gave none. */
  day: string | null;
  /** The extracted markdown the page shows. */
  content: string;
  sourceFileName: string | null;
  /** The original in the person's cloud, by its file name and type; null for a text-only row. */
  original: { name: string; mimeType: string } | null;
}

/** Scan results, then letters and every other document, each in health-core's order (`byNewestDocument`). */
export interface DocumentShelf {
  scans: ShownDocument[];
  others: ShownDocument[];
}

export function documentShelf(file: RoadmapFile): DocumentShelf {
  const live = file.documents
    .filter((d) => !d.deleted && typeof d.id === 'string')
    .map(complete)
    .map((d) => ({ ...documentView(d), mimeType: d.mimeType }))
    .filter((d) => !isLabArchiveDocument(d))
    .sort(byNewestDocument);
  const scan = (d: { documentType: string }) => d.documentType === 'scan_result';
  return { scans: live.filter(scan).map(shownDocument), others: live.filter((d) => !scan(d)).map(shownDocument) };
}

/** A legacy row may lack fields the schema now names, or hold one of the wrong type (review
 *  R1): each reads as the web's default, so one old row never breaks the screen or blanks
 *  the list. The stored row is not changed. */
function complete(d: FileDocument): FileDocument {
  const text = (value: unknown, otherwise: string) => (typeof value === 'string' ? value : otherwise);
  return {
    ...d, title: text(d.title, ''), type: text(d.type, 'other') as FileDocument['type'], date: typeof d.date === 'string' ? d.date : null,
    extractedText: text(d.extractedText, ''), fileRef: text(d.fileRef, ''), mimeType: text(d.mimeType, ''), addedAt: text(d.addedAt, ''),
    sourceFileName: typeof d.sourceFileName === 'string' ? d.sourceFileName : null,
  };
}

function shownDocument(d: DocumentView & { mimeType: string }): ShownDocument {
  return {
    id: d.id,
    title: d.title,
    typeLabel: DOCUMENT_TYPE_LABELS[d.documentType] ?? d.documentType,
    day: d.documentDate,
    content: d.contentMd,
    sourceFileName: d.sourceFileName,
    original: d.fileRef ? { name: d.fileRef.split('/').pop() || d.fileRef, mimeType: d.mimeType } : null,
  };
}
