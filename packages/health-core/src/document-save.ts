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
import { buildDocumentRef, splitDocumentRef } from './document-path';
import { documentRow, documentView, isLabArchiveDocument, LAB_ARCHIVE_ROWS, labArchiveFields, listedRows, withStoredOriginal, type DocumentFields, type DocumentView } from './document-rows';
import { isReadableRow } from './readable-rows';
import { newId as freshId } from './record-edits';
import { stableStringify, type FileDocument, type RoadmapFile } from './roadmap-file';
import { knownIndex } from './upload-known';

// In document-rows.ts, so upload-known.ts reads them without an import cycle; callers import them from here.
export { documentView, isLabArchiveDocument, writtenLabRows, type DocumentView } from './document-rows';

/**
 * One reviewed document to save. `file` is the original's bytes, when kept.
 * `contentHash`: the bytes' fingerprint when they are not kept (no cloud):
 * the row carries it with no original, so a later upload of the same file
 * knows it (US-14 AC10). With `file`, the hash is the caller's `io.hash`.
 */
export interface DocumentPayload<F> extends DocumentFields {
  file?: F;
  contentHash?: string;
}

/**
 * The lab report's archive row (`labArchiveFields`) with the original's bytes:
 * the website (archive-payloads.ts) and the iPhone app. `rows`: the lab rows
 * its values wrote, when the writer knows them (`labRowsByFile`);
 * `contentHash`: the bytes' hash when they are not kept (US-14 AC10).
 */
export function labArchivePayload<F>(
  sourceFileName: string | null, reportDate: string | null, file: F | undefined,
  { rows, contentHash }: { rows?: readonly string[]; contentHash?: string } = {},
): DocumentPayload<F> {
  return { ...labArchiveFields(sourceFileName, reportDate, rows), file, ...(contentHash ? { contentHash } : null) };
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
  /** ISO instant for `addedAt`; read once per document. */
  now?(): string;
  newId?(): string;
}

export interface DocumentSavePlan {
  /** The rows `commit` appends, in payload order. */
  saved: FileDocument[];
  /** Every original whose write failed: its row keeps the hash alone (US-14 AC4, AC10). One count for both clients (design 12c). */
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
 * 3. Here: by hash, skipping only a row that holds a stored original and
 *    that the record still knows (`knownIndex`: a lab archive row only while
 *    its values live); a same-hash metadata-only row of the same kind (lab
 *    archive or shown document, US-14 AC4) is replaced behind and tombstoned
 *    (US-13 AC1). With no bytes, a known shown document is replaced only when
 *    the review changed its title, type or date. A lab upload keeps the live
 *    lab archive rows' list and adds its own; with nothing to add and no
 *    original to file it writes nothing (US-14 AC10). Only the save holds the
 *    bytes and the cloud write.
 * 4. Connector, `isAlreadyImported` (import-documents.ts): the hash of whatever row
 *    holds it, a lab archive row whose listed values are all gone excepted; else, for a hashless candidate, name and date with a " (n)"
 *    stripped; else the name alone against a hashless live row whose date is
 *    compatible (either unknown, or equal). The assistant route often has no
 *    bytes to hash (US-36 AC5).
 * 5. Connector, `folderNudge` (mcp-import.ts): a live row with the listed name,
 *    hashed or not, compared by `dedupFileName` on both sides (" (n)"
 *    stripped); a folder listing has names only, and rule 4 would nag every
 *    folder-imported file forever (US-37 AC1).
 * 6. Website archive step (widget-src archive-payloads.ts):
 *    `unarchivedOriginals` / `isFileable` keep a by-hash archived set
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
  // Content-hash dedup: re-uploading a file the record already holds with its
  // original must not create a second entry or a " (2)" blob. The review step
  // dedups extracted VALUES but knows nothing about originals.
  const known = knownIndex(current);
  const archived = new Set([...known].filter(([, k]) => !k.archiveOnly).map(([hash]) => hash));
  const hashed = current.documents.filter((d) => !d.deleted && d.contentHash && isReadableRow('documents', d));
  // Metadata-only rows are replaced only by an upload of their own kind, a
  // lab archive or a shown document (US-14 AC4): `deleted` is OR-ed on merge,
  // so a letter tombstoned by a lab re-read would be gone for good. Kind, not
  // type: the type is the model's per-run guess.
  const metadataOnly = hashed.filter((d) => !d.fileRef).map(documentView);
  // A lab upload meets the record's live lab archive rows for its bytes,
  // known or not: their list is kept and extended, never lost, and the
  // original one stores is kept (US-14 AC10).
  const labRowsOf = (hash: string) => hashed.filter((d) => d.contentHash === hash && isLabArchiveDocument(documentView(d)));

  // Phase 1 (serial, order-dependent): dedup by hash, assign collision-safe
  // refs, build the metadata rows.
  const writes: Array<{ doc: FileDocument; ref: string; file: F; lab: boolean; held?: DocumentView; /** The held row a failed write leaves standing. */ failed?: DocumentView; lost?: true }> = [];
  /** Rows that land with no write: each replaces the held rows of its kind at commit, and `replaces`. */
  const filed: Array<{ doc: FileDocument; lab: boolean; replaces: string[] }> = [];
  const seen = new Set<string>();
  for (const d of payloads) {
    const hash = d.file ? await io.hash(d.file) : d.contentHash || null;
    if (hash) {
      if (seen.has(hash)) continue; // the same bytes twice in one save
      seen.add(hash);
    }
    // The hash is the bytes' identity even when the blob write fails, so a
    // later upload of the same bytes can replace this row (US-14 AC4).
    const doc = documentRow(d, { id: newId(), contentHash: hash ?? '', mimeType: '', addedAt: now() });
    const lab = isLabArchiveDocument(d);
    const labRows = lab && hash ? labRowsOf(hash) : [];
    if (labRows.length) {
      const before = new Set(labRows.flatMap((r) => listedRows(r) ?? []));
      const list = [...new Set([...before, ...(listedRows(doc) ?? [])])];
      const stored = labRows.find((r) => r.fileRef);
      // No new row to list and no original to file: nothing new.
      if ((stored || !d.file) && list.length === before.size) continue;
      if (list.length) doc.metadata = { ...doc.metadata, [LAB_ARCHIVE_ROWS]: list };
      if (stored) {
        // A copy with the stored original and the longer list; no second blob.
        const copy = withStoredOriginal(doc, stored);
        filed.push({ doc: copy, lab, replaces: labRows.map((r) => r.id) });
        out.push(copy);
        continue;
      }
    } else if (hash && archived.has(hash)) {
      continue; // identical original already archived
    }
    const held = pendingRowsFor(metadataOnly, hash, lab)[0];
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
      writes.push({ doc, ref, file: d.file, lab, held });
    } else if (hash) {
      // The bytes are not kept (no cloud): the row carries their hash alone
      // (US-14 AC10). Bytes the record already knows bring nothing new, unless
      // the review changed the held row's title, type or date: then, as a
      // cloud upload does, the new row replaces it.
      if (!labRows.length && known.has(hash) && (!held || sameRow(doc, held))) continue;
      filed.push({ doc, lab, replaces: [] });
    }
    out.push(doc);
  }

  // Phase 2: blob uploads, 3 at a time — serial writes made a 20-file batch
  // ~40 sequential round trips (20-40s on a slow link). The FIRST write into
  // each folder still runs alone (concurrent find-or-create of the same new
  // folder would create duplicates); the rest pool. A failed write degrades
  // to metadata-only — unless a held row already holds these bytes: a
  // plain row beside it would list the letter twice, and every later upload
  // would offer to archive it again (Sentry 7715862604). Every failed write is counted `unstored`.
  let lost = 0; // every write that failed
  const writeOne = async (w: (typeof writes)[number]) => {
    try {
      await io.write(w.ref, w.file);
      w.doc.fileRef = w.ref;
      w.doc.mimeType = io.mimeType(w.file);
    } catch {
      // The caller's own write reports its failure (RoadmapStore.saveUpload); the save carries on.
      lost += 1;
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
  // metadata-only row carries them and replaces the held rows.
  const heldFailures = writes.flatMap(({ doc, failed }) => (failed ? [{ doc, held: failed }] : []));
  const unchanged = new Set(heldFailures.filter(({ doc, held }) => sameRow(doc, held)).map((u) => u.doc));
  const saved = out.filter((d) => !unchanged.has(d));
  return {
    saved,
    unstored: lost,
    commit(file) {
      // The rows to replace, read from the file as it now is, so a same-hash
      // row merged in from another device during the upload goes too.
      const readable = file.documents.filter((d) => !d.deleted && d.contentHash && isReadableRow('documents', d));
      const pending = readable.filter((d) => !d.fileRef).map(documentView);
      const landing = new Map<FileDocument, { lab: boolean; replaces: string[] }>(
        // Every row this save adds: one whose write failed with nothing held may still meet a row merged in meanwhile.
        [...writes.filter((w) => !unchanged.has(w.doc)), ...filed].map((w) => [w.doc, { lab: w.lab, replaces: 'replaces' in w ? w.replaces : [] }]),
      );
      const replaced = new Set<string>();
      const rows = saved.map((doc) => {
        const entry = landing.get(doc);
        if (!entry) return doc;
        const old = [
          ...pendingRowsFor(pending, doc.contentHash, entry.lab).map((d) => d.id), ...entry.replaces,
          // A lab archive row it replaces, read now: one merged in during the upload passes on its list too (US-14 AC10).
          ...(entry.lab ? readable.filter((d) => d.contentHash === doc.contentHash && isLabArchiveDocument(documentView(d))).map((d) => d.id) : []),
        ];
        old.forEach((id) => replaced.add(id));
        if (!entry.lab) return doc;
        const olds = file.documents.filter((d) => old.includes(d.id));
        const list = [...new Set([...olds.flatMap((d) => listedRows(d) ?? []), ...(listedRows(doc) ?? [])])];
        // A replacement never loses a stored original: with none of its own, it takes the one a replaced row holds.
        return withStoredOriginal(list.length ? { ...doc, metadata: { ...doc.metadata, [LAB_ARCHIVE_ROWS]: list } } : doc, olds.find((d) => d.fileRef));
      });
      for (const d of file.documents) if (replaced.has(d.id)) d.deleted = true;
      file.documents.push(...rows);
    },
  };
}

/** `file` with `plan`'s rows committed, on a copy of its documents: `commit` writes in place (it pushes rows
 *  and flags `deleted`), and `file` may be shared (a read record, a session's working copy). */
export function committedFile(file: RoadmapFile, plan: DocumentSavePlan): RoadmapFile {
  const next = { ...file, documents: file.documents.map((d) => ({ ...d })) };
  plan.commit(next);
  return next;
}

/** A held row already saying what this new row would: same title, type, date and listed lab rows. */
function sameRow(doc: FileDocument, held: DocumentView): boolean {
  return doc.title === held.title && doc.type === held.documentType && doc.date === held.documentDate
    && stableStringify(listedRows(doc)) === stableStringify(listedRows(held));
}
