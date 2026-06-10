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
      metadata: {},
      sourceFileName: r.fileName,
      file: r.file,
    });
  }
  return out;
}
