/**
 * Archive policy for uploaded originals (decision record §lab-uploads):
 * EVERY successfully-processed original belongs in the user's cloud archive.
 * Reviewed documents carry their own blob; value-bearing lab files produce no
 * DocumentResult in the pipeline, so they get a synthesized pathology entry —
 * derived HERE (pure, testable) rather than inside the upload component.
 * Blobs are only attached to results when the backend can archive them
 * (getDocumentArchiveMode() === 'cloud'). Off-cloud a result keeps only its
 * bytes' hash, so a lab report still leaves a metadata-only archive row with
 * it (US-14 AC10); an unselected letter is never filed without its bytes.
 */
import { labArchivePayload, pendingRowsFor, type DocumentPayload, type ExistingDoc } from '@roadmap/health-core/document-save';
import type { FileResult } from './upload-pipeline';
import { fileKey } from './file-key';

/** 'sha256-<hex>' content fingerprint — names the blob + detects corruption. The upload hashes
 *  each file before it is read (US-12 AC27); the hash travels with its result. */
export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256-${hex}`;
}

/** A file the archive step can file: read, not saved as a reviewed document
 *  (`alreadyCovered`, by `fileKey`, never the name two files can share), and
 *  either a document or extracted values. `index`: its place in the pick. */
function isFileable(r: FileResult, index: number, alreadyCovered: ReadonlySet<string>): boolean {
  if (r.error || alreadyCovered.has(fileKey(r, index))) return false;
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
  alreadyCovered: ReadonlySet<string>,
): FileResult[] {
  const archived = new Set(existing.filter((d) => d.contentHash && d.fileRef).map((d) => d.contentHash));
  return results.filter((r, index) => !!r.file && isFileable(r, index, alreadyCovered)
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
  alreadyCovered: ReadonlySet<string>,
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

/**
 * Synthesized entries for lab files whose originals would otherwise be lost:
 * with the bytes in a cloud, or off-cloud with their hash alone (US-14 AC10).
 * `labRows`: the lab rows each file's values wrote, by the file's identity
 * (`fileKey`; health-core `labRowsByFile`), listed on its archive row.
 */
export function synthesizeLabArchiveEntries(
  results: FileResult[],
  alreadyCovered: ReadonlySet<string>,
  labRows: ReadonlyMap<string, string[]> = new Map(),
): DocumentPayload<Blob>[] {
  const out: DocumentPayload<Blob>[] = [];
  results.forEach((r, index) => {
    if (r.document || !(r.file || r.contentHash) || !isFileable(r, index, alreadyCovered)) return;
    out.push(labArchivePayload(r.fileName, r.reportDate, r.file, { rows: labRows.get(fileKey(r, index)), contentHash: r.contentHash }));
  });
  return out;
}
