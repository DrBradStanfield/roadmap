/**
 * Archive policy for uploaded originals (decision record §lab-uploads):
 * EVERY successfully-processed original belongs in the user's cloud archive.
 * Reviewed documents carry their own blob; value-bearing lab files produce no
 * DocumentResult in the pipeline, so they get a synthesized pathology entry —
 * derived HERE (pure, testable) rather than inside the upload component.
 * Blobs are only attached to results when the backend can archive them
 * (getDocumentArchiveMode() === 'cloud'), so off-cloud this returns [].
 */
import { LAB_ARCHIVE_TITLE } from '@roadmap/health-core';
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
    doc.title === LAB_ARCHIVE_TITLE &&
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

/** A file the archive step can file: bytes in hand, and either a reviewed
 *  document or extracted values. `alreadyCovered` names the files the save
 *  already carries as reviewed documents. */
function isArchivableFile(r: FileResult, alreadyCovered: Set<string | null>): boolean {
  if (r.error || alreadyCovered.has(r.fileName) || !r.file) return false;
  return !!r.document || r.values.length > 0 || r.additionalValues.length > 0;
}

/**
 * Files whose bytes the connector filed metadata-only (hash, no fileRef —
 * US-35 AC8), lab report or letter alike, that this save would not otherwise
 * file. Saving archives the original behind the row already in the record
 * (US-13 AC1), so the review offers Save even with nothing selected.
 */
export function connectorOriginals(
  results: FileResult[],
  existing: ReadonlyArray<Pick<ApiDocument, 'contentHash' | 'fileRef'>>,
  alreadyCovered: Set<string | null>,
): FileResult[] {
  const pending = new Set(existing.filter((d) => d.contentHash && !d.fileRef).map((d) => d.contentHash));
  return results.filter((r) => isArchivableFile(r, alreadyCovered) && pending.has(r.contentHash));
}

/**
 * Documents the review left unselected (name-deduped against the connector's
 * row) whose bytes that row holds metadata-only: filed with their reviewed
 * content so the blob lands and the store tombstones the hash-only row.
 */
export function connectorDocumentEntries(
  results: FileResult[],
  existing: ReadonlyArray<Pick<ApiDocument, 'contentHash' | 'fileRef'>>,
  alreadyCovered: Set<string | null>,
): ArchiveDocPayload[] {
  return connectorOriginals(results, existing, alreadyCovered)
    .filter((r) => r.document)
    .map((r) => ({
      documentType: r.document!.classification,
      title: r.document!.title,
      documentDate: r.document!.documentDate,
      contentMd: r.document!.contentMarkdown,
      metadata: r.document!.metadata,
      sourceFileName: r.fileName,
      file: r.file,
    }));
}

/** Synthesized entries for lab files whose originals would otherwise be lost. */
export function synthesizeLabArchiveEntries(
  results: FileResult[],
  alreadyCovered: Set<string | null>,
): ArchiveDocPayload[] {
  const out: ArchiveDocPayload[] = [];
  for (const r of results) {
    if (r.document || !isArchivableFile(r, alreadyCovered)) continue;
    out.push({
      documentType: 'pathology_report',
      title: LAB_ARCHIVE_TITLE,
      documentDate: r.reportDate,
      contentMd: '',
      metadata: { [LAB_ARCHIVE_FLAG]: true },
      sourceFileName: r.fileName,
      file: r.file,
    });
  }
  return out;
}
