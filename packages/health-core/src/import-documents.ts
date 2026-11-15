/**
 * The connector's document rows (US-35 AC6, AC8): which files the record
 * already holds, and the rows a commit files for the rest. Split from
 * mcp-import.ts (file budget); mcp-import re-exports `isAlreadyImported`.
 */
import { dedupFileName, documentRow, documentView, isLabArchiveDocument, labArchiveFields, listedRows, type DocumentFields } from './document-rows';
import { LAB_ARCHIVE_TITLE } from './document-path';
import type { ImportDocument } from './mcp-import';
import { isReadableRow } from './readable-rows';
import type { FileDocument, RoadmapFile } from './roadmap-file';
import { knownIndex } from './upload-known';

/** The live row a file already has in the record, and which key found it. */
export interface ImportedMatch {
  row: FileDocument;
  by: 'hash' | 'name' | 'name_date';
}

/**
 * AC6 — a document the record already holds. Hash first: the bytes' own
 * `contentHash` (the archive's key, shared with the website) names the file
 * whatever it is called. The name alone counts ONLY against a row that has no
 * hash — a website row from before hashes — because a lab portal that names
 * every download `Results.pdf` must not make the second report "already
 * imported". A candidate that has NO hash — the assistant route, where the
 * server never sees the bytes (US-36 AC5) — matches a live row of the same
 * name AND the same `date`, hashed or not: the same report re-read is a
 * duplicate, the portal's next `Results.pdf` on another date is not. Only
 * live rows count: a tombstoned document was deleted on purpose, and
 * importing it again is a decision, not a duplicate.
 */
export function isAlreadyImported(file: RoadmapFile, name: string, contentHash: string, date?: string | null): ImportedMatch | null {
  // Only rows this build reads (US-65): a hidden one's fields may be anything.
  const dead = deadLabRow(file);
  const live = file.documents.filter((d) => isReadableRow('documents', d) && !d.deleted && !dead(d));
  const byHash = contentHash === '' ? undefined : live.find((d) => d.contentHash === contentHash);
  if (byHash) return { row: byHash, by: 'hash' };
  const sameName = (d: FileDocument) => d.sourceFileName != null && dedupFileName(d.sourceFileName) === dedupFileName(name);
  const byNameDate = contentHash === '' && date ? live.find((d) => sameName(d) && d.date === date) : undefined;
  if (byNameDate) return { row: byNameDate, by: 'name_date' };
  // A dated candidate against a hashless row dated differently is the portal's next `Results.pdf`, not a twin.
  const byName = live.find((d) => d.contentHash === '' && sameName(d) && (!date || !d.date || d.date === date));
  return byName ? { row: byName, by: 'name' } : null;
}

/**
 * A hashed lab archive row that lists its values counts as the app counts it
 * (`knownIndex`): once every value it lists is gone it is not "already
 * imported" (US-14 AC10). One with no list stays imported, values or not: a
 * declined report's row is how it stops being offered (the commit's words).
 */
function deadLabRow(file: RoadmapFile): (d: FileDocument) => boolean {
  const known = knownIndex(file);
  return (d) => isReadableRow('documents', d) && !!d.contentHash && listedRows(d) !== null && isLabArchiveDocument(documentView(d)) && !known.has(d.contentHash);
}

/**
 * The rows a commit files for `filing` (the documents not already imported),
 * and the record's documents with what they replace tombstoned. A lab report's
 * row is the website's and the iPhone's hidden archive row (`labArchive:
 * true`), told apart by the signature the extract gave it, so a receipt parked
 * before this rule commits the same way. It lists the lab rows its values
 * wrote (`labRows`, US-14 AC10), keyed by the file's folder entry: one name is
 * one file in a payload (a folder lists a name once, a ZIP member carries its
 * ZIP, twin bytes file nothing). A lab archive row the record holds for these
 * bytes but no longer knows (its values gone) passes on its list and its
 * stored original, and is tombstoned, never edited, as the app's save does.
 */
export function importDocumentRows(
  file: RoadmapFile, filing: readonly ImportDocument[], labRows: ReadonlyMap<string, string[]>, metadata: Record<string, unknown>, now: string,
): { rows: FileDocument[]; documents: FileDocument[] } {
  const oldLabRows = (hash: string) => (hash ? file.documents.filter((x) => isReadableRow('documents', x) && !x.deleted && x.contentHash === hash && isLabArchiveDocument(documentView(x))) : []);
  const replaced = new Set<string>();
  const rows = filing.map((d) => {
    const lab = d.type === 'pathology_report' && d.title === LAB_ARCHIVE_TITLE;
    const old = lab ? oldLabRows(d.contentHash) : [];
    old.forEach((x) => replaced.add(x.id));
    const list = [...new Set([...old.flatMap((x) => listedRows(x) ?? []), ...(labRows.get(d.sourceFileName) ?? [])])];
    const fields: DocumentFields = lab
      ? labArchiveFields(d.sourceFileName, d.date, list)
      : { documentType: d.type, title: d.title, documentDate: d.date, contentMd: '', metadata: {}, sourceFileName: d.sourceFileName };
    const row = documentRow({ ...fields, metadata: { ...fields.metadata, ...metadata } }, { id: crypto.randomUUID(), contentHash: d.contentHash, mimeType: d.mimeType, addedAt: now });
    const stored = old.find((x) => x.fileRef);
    return stored ? { ...row, fileRef: stored.fileRef, mimeType: stored.mimeType } : row;
  });
  return { rows, documents: file.documents.map((d) => (replaced.has(d.id) ? { ...d, deleted: true } : d)) };
}
