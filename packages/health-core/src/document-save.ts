/**
 * Saving reviewed documents: one rule for the website and, next, the iPhone
 * app. The caller supplies the I/O (hashing and the blob write), so this runs
 * in a browser, in Node and in JavaScriptCore alike: `F` is whatever the
 * caller holds the bytes in (a Blob on the web, a Uint8Array on the phone).
 *
 * The order is §5.3's: the blob is written to the user's cloud FIRST
 * (organised path from buildDocumentRef: 'Lab results/2024-05-10 Lipid
 * panel.pdf'), THEN the caller commits the rows, so an interrupted save leaves
 * a harmless orphan blob, never a dangling ref. A failed blob write (e.g.
 * GitHub's ~1 MB cap, localStorage quota) degrades to metadata-only: the
 * extracted values are never lost with the file. Except behind a held
 * metadata-only row (below): there the details already exist, so the failure
 * is settled, counted in `unstored`, and only a changed title or date files a
 * new row.
 *
 * `contentHash` is ONE key for the website and the connector (US-35 AC6): a
 * live row that carries the hash AND a `fileRef` is the archived original, so
 * the upload is a no-op; a row with the hash and no `fileRef` came in through
 * the connector metadata-only (or is a website save whose blob failed), and
 * THIS upload, of the same kind, is the user archiving that original — the new
 * row lands with the blob and the old one is tombstoned, never edited
 * (documents are immutable under merge).
 */
import { buildDocumentRef, LAB_ARCHIVE_TITLE, splitDocumentRef } from './document-path';
import { documentRow, LAB_ARCHIVE_FLAG, labArchiveFields, type DocumentFields } from './document-rows';
import { newId as freshId } from './record-edits';
import type { FileDocument, RoadmapFile } from './roadmap-file';

/** One reviewed document to save. `file` is the original's bytes, when kept. */
export interface DocumentPayload<F> extends DocumentFields {
  file?: F;
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
  if (doc.metadata?.[LAB_ARCHIVE_FLAG] === true) return true;
  return (
    doc.documentType === 'pathology_report' &&
    doc.title === LAB_ARCHIVE_TITLE &&
    doc.contentMd.trim() === ''
  );
}

/** The lab report's archive row (`labArchiveFields`) with the original's bytes: the website (archive-payloads.ts) and the iPhone app. */
export function labArchivePayload<F>(sourceFileName: string | null, reportDate: string | null, file: F | undefined): DocumentPayload<F> {
  return { ...labArchiveFields(sourceFileName, reportDate), file };
}

/** A stored row as the archive step reads it. */
export type ExistingDoc = Pick<DocumentView, 'documentType' | 'title' | 'contentMd' | 'metadata'> & {
  contentHash?: string | null;
  fileRef?: string | null;
  createdAt?: string;
};

/**
 * The live metadata-only rows of one kind (lab archive or shown document)
 * holding these bytes, newest first (US-14 AC4). An upload of that kind
 * replaces them all once its blob lands, and its review card starts from the
 * newest. One rule for the card and the store.
 */
export function pendingRowsFor<T extends ExistingDoc>(existing: readonly T[], hash: string | null | undefined, lab: boolean): T[] {
  return existing.filter((d) => !!hash && d.contentHash === hash && !d.fileRef && isLabArchiveDocument(d) === lab)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/** The I/O a save needs. Nothing here touches storage itself. */
export interface DocumentSaveIO<F> {
  /** 'sha256-<hex>' of the bytes. JavaScriptCore has no crypto.subtle, so the caller hashes. */
  hash(file: F): Promise<string>;
  /** Write the bytes at `ref`; reject on failure. */
  write(ref: string, file: F): Promise<void>;
  /** The bytes' MIME type, '' when unknown. */
  mimeType(file: F): string;
  /** A failed blob write, for the caller's telemetry. The save carries on. */
  onWriteError?(error: unknown): void;
  /** ISO instant for `addedAt`; read once per document. */
  now?(): string;
  newId?(): string;
}

export interface DocumentSavePlan {
  /** The rows `commit` appends, in payload order. */
  saved: FileDocument[];
  /** Failed blob writes behind a held metadata-only row: settled, not errors (US-14 AC4). */
  unstored: number;
  /**
   * Tombstone the metadata-only rows these uploads replace, then append
   * `saved`. Run it on the file as it is at commit time (inside the caller's
   * edit), so a same-hash row merged in from another device during the
   * upload is replaced too. Flags `deleted` on replaced rows; never edits a
   * row otherwise.
   */
  commit(file: RoadmapFile): void;
}

/*
 * The six duplicate checks on the way into `documents[]` (US-52 AC14). Each
 * runs where it does because each surface knows different things at that
 * moment; none is a copy of another, so a de-dup must not fold them together.
 * 1. Website review, `isDocDuplicate` (ReviewTable.tsx): an exact
 *    `sourceFileName` match unticks the keep box. Titles drift between reads;
 *    the name does not, and the bytes are not hashed yet.
 * 2. iPhone review, `alreadySaved` (ios/engine/lab-review.ts): the same
 *    exact-name rule, so the app's card starts as the web's does.
 * 3. Here: by hash, skipping only a row that holds a stored original; a
 *    same-hash metadata-only row of the same kind (lab archive or shown
 *    document, US-14 AC4) is replaced behind and tombstoned (US-13 AC1).
 *    Only the save holds the bytes and the cloud write.
 * 4. Connector, `isAlreadyImported` (mcp-tools.ts): the hash of whatever row
 *    holds it; else, for a hashless candidate, name and date with a " (n)"
 *    stripped; else the name alone against a hashless live row whose date is
 *    compatible (either unknown, or equal). The assistant route often has no
 *    bytes to hash (US-36 AC5).
 * 5. Connector, `folderNudge` (mcp-tools.ts): a live row with the listed name,
 *    hashed or not, compared by `dedupFileName` on both sides (" (n)"
 *    stripped); a folder listing has names only, and rule 4 would nag every
 *    folder-imported file forever (US-37 AC1).
 * 6. Website archive step (widget-src archive-payloads.ts):
 *    `unarchivedOriginals` / `isArchivableFile` keep a by-hash archived set
 *    (a `contentHash` with a stored original) and the `alreadyCovered` name
 *    set, and `pendingRowsFor` files an unselected letter behind its
 *    metadata-only row; the iPhone's review-time held check uses
 *    `pendingRowsFor` too.
 */
/**
 * Hash, dedup and write the blobs for `payloads` against `current`. Returns
 * the rows to commit; it changes nothing in `current`.
 */
export async function saveDocuments<F>(
  current: RoadmapFile,
  payloads: ReadonlyArray<DocumentPayload<F>>,
  io: DocumentSaveIO<F>,
): Promise<DocumentSavePlan> {
  const now = io.now ?? (() => new Date().toISOString());
  const newId = io.newId ?? freshId;
  const out: FileDocument[] = [];
  const existingRefs = new Set(current.documents.map((d) => d.fileRef).filter(Boolean));
  // Content-hash dedup: re-uploading a file the archive already holds (live,
  // not tombstoned) must not create a second entry or a " (2)" blob. The
  // review step dedups extracted VALUES but knows nothing about originals.
  const hashed = current.documents.filter((d) => !d.deleted && d.contentHash);
  const archived = new Set(hashed.filter((d) => d.fileRef).map((d) => d.contentHash));
  // Metadata-only rows are replaced only by an upload of their own kind, a
  // lab archive or a shown document (US-14 AC4): `deleted` is OR-ed on merge,
  // so a letter tombstoned by a lab re-read would be gone for good. Kind, not
  // type: the type is the model's per-run guess.
  const metadataOnly = hashed.filter((d) => !d.fileRef).map(documentView);

  // Phase 1 (serial, order-dependent): dedup by hash, assign collision-safe
  // refs, build the metadata rows.
  const writes: Array<{ doc: FileDocument; ref: string; file: F; lab: boolean; held?: DocumentView; /** The held row a failed write leaves standing. */ failed?: DocumentView }> = [];
  for (const d of payloads) {
    const hash = d.file ? await io.hash(d.file) : null;
    if (hash) {
      if (archived.has(hash)) continue; // identical original already archived
      archived.add(hash);
    }
    // The hash is the bytes' identity even when the blob write fails, so a
    // later upload of the same bytes can replace this row (US-14 AC4).
    const doc = documentRow(d, { id: newId(), contentHash: hash ?? '', mimeType: '', addedAt: now() });
    if (d.file) {
      const ref = buildDocumentRef({
        type: doc.type,
        title: doc.title,
        date: doc.date,
        sourceFileName: d.sourceFileName,
        existingRefs,
      });
      existingRefs.add(ref);
      // The metadata-only rows for these bytes are tombstoned only once the
      // blob lands, or a changed row replaces them: a failed write must not
      // lose the hash key.
      const lab = isLabArchiveDocument(d);
      writes.push({ doc, ref, file: d.file, lab, held: pendingRowsFor(metadataOnly, hash, lab)[0] });
    }
    out.push(doc);
  }

  // Phase 2: blob uploads, 3 at a time — serial writes made a 20-file batch
  // ~40 sequential round trips (20-40s on a slow link). The FIRST write into
  // each folder still runs alone (concurrent find-or-create of the same new
  // folder would create duplicates); the rest pool. A failed write degrades
  // to metadata-only — unless a held row already holds these bytes: a
  // plain row beside it would list the letter twice, and every later upload
  // would offer to archive it again (Sentry 7715862604).
  const writeOne = async (w: (typeof writes)[number]) => {
    try {
      await io.write(w.ref, w.file);
      w.doc.fileRef = w.ref;
      w.doc.mimeType = io.mimeType(w.file);
    } catch (error) {
      io.onWriteError?.(error);
      w.failed = w.held; // a failure behind a held row is settled (below)
    }
  };
  const seenFolders = new Set<string>();
  const pooled: typeof writes = [];
  for (const w of writes) {
    const folder = splitDocumentRef(w.ref).folder ?? '';
    if (seenFolders.has(folder)) {
      pooled.push(w);
    } else {
      seenFolders.add(folder);
      await writeOne(w); // folder-creating write runs alone
    }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, pooled.length) }, async () => {
      while (next < pooled.length) await writeOne(pooled[next++]);
    }),
  );

  // A repeat failure behind a held row (a connector's or an earlier failed
  // save, alike) is settled, never an error: an original that can never be
  // stored (a size cap) must not loop on "Failed to save". The held details
  // stay, unless the review changed the title or date: then a new
  // metadata-only row carries them and replaces the held rows. `unstored`
  // tells the done screen to say so (US-14 AC4).
  const unstored = writes.flatMap(({ doc, failed }) => (failed ? [{ doc, held: failed }] : []));
  const unchanged = new Set(unstored.filter(({ doc, held }) => doc.title === held.title && doc.date === held.documentDate).map((u) => u.doc));
  const saved = out.filter((d) => !unchanged.has(d));
  return {
    saved,
    unstored: unstored.length,
    commit(file) {
      // The rows to replace, read from the file as it now is, so a same-hash
      // row merged in from another device during the upload goes too.
      const pending = file.documents.filter((d) => !d.deleted && d.contentHash && !d.fileRef).map(documentView);
      const replaced = new Set(writes.filter((w) => w.doc.fileRef || (w.failed && !unchanged.has(w.doc)))
        .flatMap((w) => pendingRowsFor(pending, w.doc.contentHash, w.lab).map((d) => d.id)));
      for (const d of file.documents) if (replaced.has(d.id)) d.deleted = true;
      file.documents.push(...saved);
    },
  };
}
