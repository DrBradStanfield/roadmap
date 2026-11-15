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
 *   an archive row with no list (every row written before PR 5) is known
 *   only while an active value exists on its date, so a report whose values
 *   were all deleted is read again (owner's ruling Q6);
 * - several rows with one hash: a row holding the original wins, then a shown
 *   document over a lab archive row, whatever their order;
 * - a tombstoned row, an unreadable row (US-65) and an empty hash are never
 *   known. Erased rows are already gone from any record a reader holds
 *   (`migrateFile`, `mergeFiles`);
 * - a hashless older shown document is matched after the read, by name and
 *   date (`legacyMatch`), and counts as known with no row rewritten. Never a
 *   lab report: its values keep the (metric, day) dedup after the read.
 *
 * Hashes and names stay here: never logged, never in an event.
 */
import { dedupFileName, documentView, isLabArchiveDocument, listedRows, type DocumentFields } from './document-rows';
import { isActive } from './blood-tests';
import { dayOf, rootIdOf } from './merge';
import { isReadableRow } from './readable-rows';
import type { FileLabValue, RoadmapFile } from './roadmap-file';

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
 * a readable active row marks itself and each row up its `correctsId` chain.
 * The links come from every row, readable or not (only `id` and `correctsId`
 * are read, and only as strings), so an unreadable row mid-chain does not
 * break it. A walk stops at a row already marked, so a cycle ends.
 */
function activeRoots(all: readonly unknown[], readable: readonly FileLabValue[]): Set<string> {
  const parent = new Map<string, string>();
  for (const r of all as Array<{ id?: unknown; correctsId?: unknown }>) {
    if (typeof r?.id === 'string' && typeof r.correctsId === 'string') parent.set(r.id, r.correctsId);
  }
  const seen = new Set<string>();
  for (const row of readable) {
    if (!isActive(row)) continue;
    for (let id: string | undefined = row.id; id !== undefined && !seen.has(id); id = parent.get(id)) seen.add(id);
  }
  return new Set([...seen].map(rootIdOf));
}


/** Index the record's live, hashed rows by content (section 2's table). */
export function knownIndex(record: RoadmapFile): KnownIndex {
  const labRows = record.labValues.filter((r) => isReadableRow('labValues', r));
  const active = activeRoots(record.labValues, labRows);
  const activeDays = new Set(labRows.filter(isActive).map((r) => dayOf(r.recordedAt)));
  const index = new Map<string, Known>();
  const rank = (k: Known) => (k.archiveOnly ? 0 : 2) + (k.as === 'document' ? 1 : 0);
  for (const d of record.documents) {
    if (!isReadableRow('documents', d) || d.deleted || !d.contentHash) continue;
    const lab = isLabArchiveDocument(documentView(d));
    if (lab) {
      const rows = listedRows(d);
      if (rows ? !rows.some((id) => active.has(rootIdOf(id))) : !activeDays.has(d.date ?? '')) continue;
    }
    const next: Known = { as: lab ? 'labReport' : 'document', archiveOnly: !d.fileRef };
    const held = index.get(d.contentHash);
    if (!held || rank(next) > rank(held)) index.set(d.contentHash, next);
  }
  return index;
}

/** How the record holds these bytes, or null when it does not. An empty hash is never indexed. */
export function knownAs(index: KnownIndex, hash: string): Known | null {
  return index.get(hash) ?? null;
}

/**
 * After the read, for a shown document only: a hashless live shown row
 * (written before hashing, or by the connector without bytes) with this
 * file's name (as `dedupFileName` reads it) and date holds the same document,
 * so it counts as known. Never the type: it is the model's guess per read, and
 * a re-read under another type would save a duplicate. Never a lab report:
 * two different reports can share a name and a day, and their values keep the
 * (metric, day) dedup. The old row is not rewritten (owner's rulings Q5 a,
 * Q1 b). As the connector's name check does, only rows this build reads (US-65).
 */
export function legacyMatch(record: RoadmapFile, name: string, read: DocumentFields): boolean {
  if (isLabArchiveDocument(read)) return false;
  const base = dedupFileName(name);
  return record.documents.some((d) =>
    isReadableRow('documents', d) && !d.deleted && !d.contentHash && d.sourceFileName != null &&
    dedupFileName(d.sourceFileName) === base &&
    // Two undated rows match too: today's name-only review rule already counts them as saved (Q2).
    (d.date ?? null) === (read.documentDate ?? null) && !isLabArchiveDocument(documentView(d)));
}
