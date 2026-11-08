// My health's Documents (US-73 AC12, US-14 AC8): the clinic letters and scan
// results in the record, as the iPhone lists them. Web twin: MyHealth.tsx
// HealthRecordsSection, with its rules: live rows only, never a lab report's
// archive row (its values are the record), scan results apart from the rest.
import { DOCUMENT_TYPE_LABELS } from '../../packages/health-core/src/document-path';
import { documentView, isLabArchiveDocument } from '../../packages/health-core/src/document-save';
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

/** Scan results, then letters and every other document, each newest first; an undated one last. */
export interface DocumentShelf {
  scans: ShownDocument[];
  others: ShownDocument[];
}

export function documentShelf(file: RoadmapFile): DocumentShelf {
  const live = file.documents
    .filter((d) => !d.deleted && !isLabArchiveDocument(documentView(d)))
    .sort(newestFirst);
  const scan = (d: FileDocument) => d.type === 'scan_result';
  return { scans: live.filter(scan).map(shownDocument), others: live.filter((d) => !scan(d)).map(shownDocument) };
}

function newestFirst(a: FileDocument, b: FileDocument): number {
  if (a.date !== b.date) return a.date === null ? 1 : b.date === null ? -1 : b.date.localeCompare(a.date);
  return (b.addedAt ?? '').localeCompare(a.addedAt ?? '');
}

function shownDocument(d: FileDocument): ShownDocument {
  return {
    id: d.id,
    title: d.title,
    typeLabel: DOCUMENT_TYPE_LABELS[d.type] ?? d.type,
    day: d.date,
    content: d.extractedText,
    sourceFileName: d.sourceFileName ?? null,
    original: d.fileRef ? { name: d.fileRef.split('/').pop() || d.fileRef, mimeType: d.mimeType } : null,
  };
}
