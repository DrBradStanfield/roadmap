/**
 * The document row, built once for every writer: the website and the iPhone
 * app through `saveDocuments` (document-save.ts), and the connector's import
 * commit (mcp-import.ts). This module holds no save and no I/O, so the
 * connector builds its rows without importing the blob-writing path.
 */
import { LAB_ARCHIVE_TITLE } from './document-path';
import type { BulkRowOutcome } from './bulk-row-target';
import { rootIdOf } from './merge';
import type { FileDocument } from './roadmap-file';
import type { DocumentType } from './validation';

/**
 * Metadata flag stamped on synthesized blood-test archive entries. These exist
 * ONLY to persist the original lab PDF to the user's cloud — the extracted
 * VALUES surface in the Blood Test Results table, so the synthesized entry must
 * never appear in the Documents list. Real biopsy/histology pathology reports
 * carry markdown content + their own metadata and are NEVER flagged.
 */
export const LAB_ARCHIVE_FLAG = 'labArchive';

/** Metadata key on a lab archive row: the ids of the lab rows its import wrote (upload-known.ts reads it). */
export const LAB_ARCHIVE_ROWS = 'rows';

/** What a reviewed document says about itself, before it is a row. */
export interface DocumentFields {
  documentType: string;
  title: string;
  documentDate: string | null;
  contentMd: string;
  metadata: Record<string, unknown>;
  sourceFileName: string | null;
}

/** A stored document row as the surfaces read it (the web's ApiDocument). */
export interface DocumentView {
  id: string;
  documentType: string;
  title: string;
  documentDate: string | null;
  contentMd: string;
  metadata: Record<string, unknown>;
  sourceFileName: string | null;
  createdAt: string;
  fileRef: string | null;
  contentHash: string | null;
}

export function documentView(d: FileDocument): DocumentView {
  return {
    id: d.id,
    documentType: d.type,
    title: d.title,
    documentDate: d.date,
    contentMd: d.extractedText,
    metadata: d.metadata ?? {},
    sourceFileName: d.sourceFileName ?? null,
    createdAt: d.addedAt,
    fileRef: d.fileRef || null,
    contentHash: d.contentHash || null,
  };
}

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
  // Total over any stored shape (US-65 AC3): what it cannot read is not a lab archive row.
  if (typeof doc !== 'object' || doc === null) return false;
  const { metadata, contentMd } = doc as { metadata?: unknown; contentMd?: unknown };
  if (typeof metadata === 'object' && metadata !== null && (metadata as Record<string, unknown>)[LAB_ARCHIVE_FLAG] === true) return true;
  return (
    doc.documentType === 'pathology_report' &&
    doc.title === LAB_ARCHIVE_TITLE &&
    (contentMd == null || (typeof contentMd === 'string' && contentMd.trim() === '')) // a readable row's text may be null (US-65)
  );
}

/**
 * The hidden row that keeps a lab report's original in the user's cloud: the
 * extracted values live in the record, so this row carries no text. One shape
 * for the website, the iPhone app and the connector. `rows`: the lab value
 * rows this report's import wrote (`labRowsByFile`), listed under
 * `LAB_ARCHIVE_ROWS` so a later upload knows the file while one is active
 * (US-14 AC10). None written, or a writer that cannot say (the iPhone's
 * `documentSave` until one engine step writes both): no list, and the row is
 * judged by its date instead (upload-known.ts).
 */
export function labArchiveFields(sourceFileName: string | null, reportDate: string | null, rows?: readonly string[]): DocumentFields {
  return {
    documentType: 'pathology_report',
    title: LAB_ARCHIVE_TITLE,
    documentDate: reportDate,
    contentMd: '',
    metadata: { [LAB_ARCHIVE_FLAG]: true, ...(rows?.length ? { [LAB_ARCHIVE_ROWS]: [...rows] } : null) },
    sourceFileName,
  };
}

/**
 * Each submitted row's written lab value row (a blood test, core or not), by
 * its root id, from a bulk write (`bulkAppendValues`): null for a row skipped,
 * refused, or written as a vital. `outcomes` is by submitted index; `saved`
 * holds the written rows in that order.
 */
export function writtenLabRows(write: { saved: ReadonlyArray<{ id: string }>; outcomes: readonly BulkRowOutcome[] }): Array<string | null> {
  let next = 0;
  return write.outcomes.map((outcome) => {
    if (outcome !== 'written') return null;
    const row = write.saved[next++];
    return row && 'metricName' in row ? rootIdOf(row.id) : null;
  });
}

/**
 * `writtenLabRows` grouped by the file each submitted row came from: what each
 * file's archive row lists. `files` names each row's file by an identity unique
 * in the pick (the web: its bytes' hash, else its place in the pick; the
 * connector: its folder entry), never a display name two files can share. A
 * Map, so a name like `__proto__` is only a key.
 */
export function labRowsByFile(rows: ReadonlyArray<string | null>, files: ReadonlyArray<string | null | undefined>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  rows.forEach((id, i) => {
    const file = files[i];
    if (id && file) out.set(file, [...(out.get(file) ?? []), id]);
  });
  return out;
}

/** The lab rows an archive row lists (`LAB_ARCHIVE_ROWS`), or null for a row with no list. */
export function listedRows(d: { metadata?: Record<string, unknown> | null }): string[] | null {
  const rows = d.metadata?.[LAB_ARCHIVE_ROWS];
  return Array.isArray(rows) ? rows.filter((id): id is string => typeof id === 'string') : null;
}

/**
 * The name a dedup check compares (US-36 AC5). ChatGPT's file library renames
 * a re-dropped file `labs(1).pdf` or `labs (2).pdf` (live 2026-09-07), so a
 * trailing ` (n)` before the extension is dropped for the comparison only —
 * the stored `sourceFileName` keeps the name as given. Digits only: `Lp(a).pdf`
 * keeps its `(a)`.
 */
export function dedupFileName(name: string): string {
  return name.replace(/ ?\(\d+\)(?=\.[^.]*$|$)/, '');
}

/**
 * A new document row with no original stored yet (`fileRef: ''`). A save that
 * then stores the blob sets `fileRef` and `mimeType` on it; the connector never
 * stores one (US-35 AC8).
 */
export function documentRow(d: DocumentFields, row: Pick<FileDocument, 'id' | 'contentHash' | 'mimeType' | 'addedAt'>): FileDocument {
  return {
    id: row.id, title: d.title, type: d.documentType as DocumentType, date: d.documentDate,
    fileRef: '', contentHash: row.contentHash, mimeType: row.mimeType, extractedText: d.contentMd,
    addedAt: row.addedAt, metadata: d.metadata, sourceFileName: d.sourceFileName,
  };
}
