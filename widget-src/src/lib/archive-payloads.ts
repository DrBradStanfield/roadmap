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
import type { ApiDocument } from './api-types';

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

/** 'sha256-<hex>' content fingerprint — names the blob + detects corruption. */
export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256-${hex}`;
}

/** Attach each result's original bytes and their hash (absent off-cloud). */
export async function attachOriginals(results: FileResult[], blobs: Map<string, Blob>): Promise<FileResult[]> {
  return Promise.all(results.map(async (r) => {
    const file = blobs.get(r.fileName);
    return file ? { ...r, file, contentHash: await sha256Blob(file) } : r;
  }));
}

/** A value-bearing lab file with its bytes in hand: the archive step files it. */
function isArchivableLabFile(r: FileResult, alreadyCovered: Set<string | null>): boolean {
  if (r.error || r.document || alreadyCovered.has(r.fileName) || !r.file) return false;
  return r.values.length > 0 || r.additionalValues.length > 0;
}

/**
 * Lab files whose bytes the connector filed metadata-only (hash, no fileRef —
 * US-35 AC8). Saving archives the original behind the values already in the
 * record (US-13 AC1), so the review offers Save even with nothing selected.
 */
export function countConnectorOriginals(
  results: FileResult[],
  existing: ReadonlyArray<Pick<ApiDocument, 'contentHash' | 'fileRef'>>,
): number {
  const pending = new Set(existing.filter((d) => d.contentHash && !d.fileRef).map((d) => d.contentHash));
  const none = new Set<string | null>();
  return results.filter((r) => isArchivableLabFile(r, none) && pending.has(r.contentHash)).length;
}

/** Synthesized entries for lab files whose originals would otherwise be lost. */
export function synthesizeLabArchiveEntries(
  results: FileResult[],
  alreadyCovered: Set<string | null>,
): ArchiveDocPayload[] {
  const out: ArchiveDocPayload[] = [];
  for (const r of results) {
    if (!isArchivableLabFile(r, alreadyCovered)) continue;
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
