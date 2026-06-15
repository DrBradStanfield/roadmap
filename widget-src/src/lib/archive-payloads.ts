/**
 * Archive policy for uploaded originals (decision record §lab-uploads):
 * EVERY successfully-processed original belongs in the user's cloud archive.
 * Reviewed documents carry their own blob; value-bearing lab files produce no
 * DocumentResult in the pipeline, so they get a synthesized pathology entry —
 * derived HERE (pure, testable) rather than inside the upload component.
 * Blobs are only attached to results when the backend can archive them
 * (getDocumentArchiveMode() === 'cloud'), so off-cloud this returns [].
 */
import type { FileResult } from '../components/ReviewTable';

export interface ArchiveDocPayload {
  documentType: string;
  title: string;
  documentDate: string | null;
  contentMd: string;
  metadata: Record<string, unknown>;
  sourceFileName: string | null;
  file?: Blob;
}

/**
 * Metadata flag stamped on synthesized blood-test archive entries. These exist
 * ONLY to persist the original lab PDF to the user's cloud — the extracted
 * VALUES surface in the Blood Test Results table, so the synthesized entry must
 * never appear in the Documents list. Filtered out of the list via
 * isLabArchiveDocument(); see HealthRecordsSection. Real biopsy/histology
 * pathology reports carry markdown content + their own metadata and are NEVER
 * flagged, so they keep showing.
 */
export const LAB_ARCHIVE_FLAG = 'labArchive';

/**
 * True when a stored document is a synthesized blood-test archive entry (the
 * raw lab PDF kept purely for the user's cloud). Hidden from the Documents
 * list. Matches the explicit flag for new uploads AND a content signature for
 * legacy entries written before the flag existed: documentType
 * 'pathology_report' + title 'Blood test results' + empty contentMd (a real
 * pathology report always has extracted markdown).
 */
export function isLabArchiveDocument(doc: {
  documentType: string;
  title: string;
  contentMd: string;
  metadata: Record<string, unknown>;
}): boolean {
  if (doc.metadata?.[LAB_ARCHIVE_FLAG] === true) return true;
  return (
    doc.documentType === 'pathology_report' &&
    doc.title === 'Blood test results' &&
    doc.contentMd.trim() === ''
  );
}

/** Synthesized entries for lab files whose originals would otherwise be lost. */
export function synthesizeLabArchiveEntries(
  results: FileResult[],
  alreadyCovered: Set<string | null>,
): ArchiveDocPayload[] {
  const out: ArchiveDocPayload[] = [];
  for (const r of results) {
    if (r.error || r.document || alreadyCovered.has(r.fileName) || !r.file) continue;
    if (r.values.length === 0 && r.additionalValues.length === 0) continue;
    out.push({
      documentType: 'pathology_report',
      title: 'Blood test results',
      documentDate: r.reportDate,
      contentMd: '',
      metadata: { [LAB_ARCHIVE_FLAG]: true },
      sourceFileName: r.fileName,
      file: r.file,
    });
  }
  return out;
}
