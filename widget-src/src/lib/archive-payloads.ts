/**
 * Archive policy for uploaded originals (decision record §lab-uploads):
 * EVERY successfully-processed original belongs in the user's cloud archive.
 * Reviewed documents carry their own blob; value-bearing lab files produce no
 * DocumentResult in the pipeline, so they get a synthesized pathology entry —
 * derived HERE (pure, testable) rather than inside the upload component.
 * Blobs are only attached to results when the backend can archive them
 * (getDocumentArchiveMode() === 'cloud'), so off-cloud this returns [].
 */
import { LAB_ARCHIVE_FLAG, LAB_ARCHIVE_TITLE, pendingRowsFor, type DocumentPayload, type ExistingDoc } from '@roadmap/health-core';
import type { FileResult } from '../components/ReviewTable';

/** 'sha256-<hex>' content fingerprint — names the blob + detects corruption. */
export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256-${hex}`;
}

/** Hash each result's original bytes, which travel with the result itself:
 *  a name-keyed map handed two ZIPs' `results.pdf` one original. */
export async function attachOriginals(results: FileResult[]): Promise<FileResult[]> {
  return Promise.all(results.map(async (r) => (r.file ? { ...r, contentHash: await sha256Blob(r.file) } : r)));
}

/** A file the archive step can file: bytes in hand, and either a reviewed
 *  document or extracted values. `alreadyCovered` names the files the save
 *  already carries as reviewed documents. */
function isArchivableFile(r: FileResult, alreadyCovered: Set<string | null>): boolean {
  if (r.error || alreadyCovered.has(r.fileName) || !r.file) return false;
  return !!r.document || r.values.length > 0 || r.additionalValues.length > 0;
}


/**
 * Unarchived lab originals remain saveable after their values become history
 * context (US-12 AC6). Unselected letters require a matching metadata-only
 * shown-document row (the connector's, or a website save whose blob failed;
 * US-35 AC8, US-14 AC4), so deselecting a new letter still excludes it, and a
 * lab-archive row never stands in for one: the store replaces only its own kind.
 */
export function unarchivedOriginals(
  results: FileResult[],
  existing: ReadonlyArray<ExistingDoc>,
  alreadyCovered: Set<string | null>,
): FileResult[] {
  const archived = new Set(existing.filter((d) => d.contentHash && d.fileRef).map((d) => d.contentHash));
  return results.filter((r) => isArchivableFile(r, alreadyCovered)
    && !archived.has(r.contentHash) && (!r.document || pendingRowsFor(existing, r.contentHash, false).length > 0));
}

/**
 * Documents the review left unselected (name-deduped against the connector's
 * row) whose bytes that row holds metadata-only: filed with their reviewed
 * content so the blob lands and the store tombstones the hash-only row.
 */
export function connectorDocumentEntries(
  results: FileResult[],
  existing: ReadonlyArray<ExistingDoc>,
  alreadyCovered: Set<string | null>,
): DocumentPayload<Blob>[] {
  return unarchivedOriginals(results, existing, alreadyCovered)
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
): DocumentPayload<Blob>[] {
  const out: DocumentPayload<Blob>[] = [];
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
