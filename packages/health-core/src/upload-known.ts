/**
 * What the record already holds, by content (US-12 AC27, US-13 AC1): a file
 * whose bytes' hash the record knows is never read, shown or offered again,
 * only counted. One rule for the website and the iPhone app, read before any
 * AI read. `saveDocuments` (document-save.ts) keeps its own by-hash check as
 * the last guard; whatever this calls known, that save writes nothing new for.
 *
 * Section 2 of the upload design:
 * - a live document or lab archive row carrying the hash is known; with no
 *   stored original (`fileRef ''`) it is `archiveOnly`: a cloud upload files
 *   the original behind the held row (US-14 AC4) and reads nothing;
 * - a lab archive row is known only while one of the lab rows it produced
 *   (`LAB_ARCHIVE_ROWS`) is active, judged on each row's newest correction;
 *   an archive row with no list (written before the list) is known;
 * - a tombstoned row and an empty hash are never known. Erased rows are
 *   already gone from any record a reader holds (`migrateRecord`, `mergeFiles`);
 * - a hashless older document is matched after the read, by name, date and
 *   kind (`legacyMatch`), and counts as known with no row rewritten.
 *
 * Hashes and names stay here: never logged, never in an event.
 */
import { documentView, isLabArchiveDocument } from './document-save';
import { LAB_ARCHIVE_ROWS, type DocumentFields } from './document-rows';
import { dedupFileName } from './mcp-import';
import { rootIdOf } from './merge';
import { isReadableRow } from './readable-rows';
import type { FileDocument, FileLabValue, RoadmapFile } from './roadmap-file';

/** How the record holds a file's bytes. */
export interface Known {
  /** The kind of row that holds them: a shown document or a lab report's archive row. */
  as: 'document' | 'labReport';
  /** No live row stores the original: with a cloud open, the upload files it behind the held row. */
  archiveOnly: boolean;
}

/** Known files by content hash. */
export type KnownIndex = ReadonlyMap<string, Known>;

/**
 * The root id of every lab row that is, or is corrected into, an active row:
 * an active row marks itself and each row up its `correctsId` chain. A walk
 * stops at a row already marked, since everything above it is marked too.
 */
function activeRoots(rows: readonly FileLabValue[]): Set<string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.status !== 'active') continue;
    for (let id: string | null = row.id; id !== null && !seen.has(id); id = byId.get(id)?.correctsId ?? null) seen.add(id);
  }
  return new Set([...seen].map(rootIdOf));
}

/** The lab rows an archive row lists, or null for a row written before the list. */
function producedRows(d: FileDocument): string[] | null {
  const rows = d.metadata?.[LAB_ARCHIVE_ROWS];
  return Array.isArray(rows) ? rows.filter((id): id is string => typeof id === 'string') : null;
}

/** Index the record's live, hashed rows by content (section 2's table). */
export function knownIndex(record: RoadmapFile): KnownIndex {
  const active = activeRoots(record.labValues);
  const index = new Map<string, Known>();
  for (const d of record.documents) {
    if (d.deleted || !d.contentHash) continue;
    const lab = isLabArchiveDocument(documentView(d));
    const rows = lab ? producedRows(d) : null;
    if (rows && !rows.some((id) => active.has(rootIdOf(id)))) continue;
    // A row holding the original wins: the upload is then a plain skip.
    const held = index.get(d.contentHash);
    if (held && (!held.archiveOnly || !d.fileRef)) continue;
    index.set(d.contentHash, { as: lab ? 'labReport' : 'document', archiveOnly: !d.fileRef });
  }
  return index;
}

/** How the record holds these bytes, or null when it does not. An empty hash is never indexed. */
export function knownAs(index: KnownIndex, hash: string): Known | null {
  return index.get(hash) ?? null;
}

/**
 * After the read: a hashless live row (written before hashing, or by the
 * connector without bytes) with this file's name (as `dedupFileName` reads
 * it), date, type and kind holds the same document, so it counts as known.
 * The old row is not rewritten (owner's ruling Q5 a). As the connector's name
 * check does, only rows this build reads (US-65).
 */
export function legacyMatch(record: RoadmapFile, name: string, document: DocumentFields): boolean {
  const base = dedupFileName(name);
  const lab = isLabArchiveDocument(document);
  return record.documents.some((d) =>
    !d.deleted && !d.contentHash && d.sourceFileName != null && dedupFileName(d.sourceFileName) === base &&
    d.date === document.documentDate && d.type === document.documentType &&
    isReadableRow('documents', d) && isLabArchiveDocument(documentView(d)) === lab);
}
