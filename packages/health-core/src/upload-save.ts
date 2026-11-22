/**
 * One Save of the shared upload (US-52 AC8c, US-14 AC10): the pick's values AND its document and lab
 * archive rows, written in one step, through the website's own save paths, never a copy of them:
 * `uploadSavePlan` for what to write, `bulkAppendValues` for the values (FHIR: rows appended, a
 * correction by `correctsId`, one active row per slot), `labRowsByFile` for the rows each report's
 * archive row lists, `labArchivePayload` and `saveDocuments` for the rows and the originals (hash
 * dedup, a held metadata-only row replaced and tombstoned, a stored original never lost).
 *
 * Two halves, as saveDocuments has: the originals are written first (async), then `commit(file)` writes
 * every row on the record as it stands at commit time (sync), as the web's `session.edit(commit)` does.
 * The values are written there, so an edit that landed meanwhile is kept and a slot it took is
 * skipped; each archive row lists the rows that commit wrote. An original is written once.
 *
 * A repeat on the record it saved writes nothing (commit answers the same file): saved values are
 * classified saved, and saveDocuments skips bytes the record already holds. It refuses, writing
 * nothing, while the view would: a selected value the write refuses, or a report waiting for its day
 * (`saveBlocked`). Pure but for `io`: the bytes and the cloud writes are the caller's.
 *
 * A letter's ticked, dated screening box (web only, `person` given; upload-screening.ts, US-13 AC6) writes its
 * `<type>_last_date` in the same commit, so one erase stamp covers the letter and its date (US-16 AC2a), as the web's
 * own Save checked the erase before it set them (the old lib/upload-save.ts, `getEraseIdentity() === erase`). For every letter
 * the page shows with its box ticked, whatever its document save did, as the web's own Save looped over every ticked
 * letter (lib/upload-save.ts); one value per type, the last such letter in picked order, as the web's per-key save let
 * the last call win.
 */
import { LAB_ARCHIVE_ROWS, labRowsByFile, listedRows, writtenLabRows } from './document-rows';
import { committedFile, labArchivePayload, saveDocuments, type DocumentPayload, type DocumentSaveIO } from './document-save';
import { bulkAppendValues, type BulkAppendResult } from './record-edits';
import { labReason } from './import-review';
import { labTestLabel, labUnitTaken, resolveLabCatalogEntry } from './lab-catalog';
import { METRIC_LABELS } from './mappings';
import { labUnitForEvent } from './product-events';
import type { RoadmapFile } from './roadmap-file';
import type { MetricTypeValue } from './validation';
import type { RefusedCode, SaveOutcome, UploadState } from './upload-flow';
import { storedHashes, uploadSavePlan } from './upload-plan';
import { reviewedWrites, uploadReview } from './upload-review';
import { isScreeningDateKey, writeScreeningDates, type ScreeningPerson } from './upload-screening';
import { measurementRefusalText } from './upload-text';
import { saveBlocked } from './upload-view';

/**
 * What only the caller holds. Asked about an original only with a cloud, and only for a file the plan
 * stores; its bytes are read only as it is written (saveDocuments writes 3 at a time), so a large pick
 * never holds every original at once, and a file already archived is never read.
 */
export interface UploadSaveIO<F> {
  /** The caller holds this file's original. */
  holds(fileId: string): boolean;
  /** Its bytes, read as it is written; null when they cannot be read now. */
  original(fileId: string): F | null;
  /** The original's MIME type by file id, '' when unknown. */
  mimeType(fileId: string): string;
  /** Write file `fileId`'s bytes at `ref` in the person's cloud; reject on failure. */
  write(ref: string, bytes: F, fileId: string): Promise<void>;
  makesFolders?: DocumentSaveIO<F>['makesFolders'];
  now?(): string;
  newId?(): string;
}

/**
 * `commit(file)`: every row on `file` as it stands now; the same `file` when nothing is new. Its
 * outcome's `unstored`: originals the plan stores that did not land (not held, unreadable, or the cloud
 * refused them): their rows keep the hash alone, and a later upload of the same file can still store them.
 */
export type UploadSaveResult =
  | { ok: true; commit(file: RoadmapFile): { file: RoadmapFile; outcome: SavedOutcome } }
  | { ok: false; reason: 'not-saving' | 'not-ready'; message: string };

/** A landed Save's counts: every one but the skips and the screening dates, which are there only when some were. */
export type SavedOutcome = Required<Omit<SaveOutcome, 'skippedValues' | 'skippedLabValues' | 'refused' | 'refusedCodes' | 'screenings'>> & SaveOutcome;

/** Each value a write refused as its closed code (US-12 AC6), labs then core values, as `refused` lists them: the
 *  `lab_unit_refused` counter's test (refused-spellings.ts) and words, and `measurement_refused`'s reason and metric. */
export function refusalCodes(written: Pick<BulkAppendResult, 'refused' | 'measurementRefusals'>): RefusedCode[] {
  return [
    // No commit produces a lab code today: a lab refusal turns on the row alone (record-edits.ts:944-958), so the plan drops it first.
    ...written.refused.map((r): RefusedCode => {
      if (labUnitTaken(resolveLabCatalogEntry(r.key), r.unit)) return { kind: 'lab', key: r.key, reason: 'value' };
      const unit = labUnitForEvent(r.unit);
      return { kind: 'lab', key: r.key, reason: 'unit', ...(unit !== undefined ? { unit } : {}) };
    }),
    ...written.measurementRefusals.map((r): RefusedCode => (r.reason === 'unknown-metric' ? { kind: 'measurement', reason: r.reason }
      : { kind: 'measurement', reason: r.reason, metricType: r.metricType as MetricTypeValue })),
  ];
}

/** An original as saveDocuments holds it: the file it is, with the hash the state read for its bytes. */
interface Held { fileId: string; hash: string }

export async function uploadSave<F>(s: UploadState, record: RoadmapFile, now: string, cloudConnected: boolean, io: UploadSaveIO<F>, person?: ScreeningPerson): Promise<UploadSaveResult> {
  if (s.phase !== 'saving') return { ok: false, reason: 'not-saving', message: 'The upload is not saving.' };
  const review = uploadReview(s, record, now);
  const blocked = saveBlocked(review, s);
  if (blocked) return { ok: false, reason: 'not-ready', message: blocked };
  const plan = uploadSavePlan(s, record, now, review, cloudConnected, person);

  // Each row's value as `file:ref`, in plan order: by file, each file's in the order `rowsByFile` took them.
  const writes = reviewedWrites(review);
  const planKeys = plan.labRows.flatMap((f) => writes.filter((v) => v.file === f.fileId).map((v) => `${v.file}:${v.ref}`));
  // Only what the page displayed as to be written (`reviewed`, echoed from the view): a value the record now lets
  // through that the page did not promise (a kept conflict whose held row went) is never written (owner ruling 2026-11-20).
  const promised = s.reviewed && new Set(s.reviewed.map((v) => `${v.file}:${v.ref}`));
  const keep = planKeys.map((k) => !promised || promised.has(k));
  const rows = plan.labRows.flatMap((f) => f.rows).filter((_, i) => keep[i]);
  const rowFiles = plan.labRows.flatMap((f) => f.rows.map(() => f.fileId)).filter((_, i) => keep[i]);
  const rowKeys = planKeys.filter((_, i) => keep[i]);
  // The rows a write on `record` would give each report: what its archive row plans to list. The
  // commit writes them again on the record as it is then, and the lists take those rows' ids.
  const onRecord = bulkAppendValues(record, rows, now);
  const planned = writtenLabRows(onRecord);
  const hashOf = new Map(s.files.map((f) => [f.id, f.hash ?? undefined]));
  // By the bytes, not the copy: two copies of one report in a pick file one archive row listing every value either wrote (US-14 AC10).
  const bytesOf = (fileId: string) => hashOf.get(fileId) ?? fileId;
  const rowsOf = labRowsByFile(planned, rowFiles.map(bytesOf));
  // A photo or a scan (`original: false`, US-52 AC13e) is never stored, a letter read from it included.
  const noOriginal = new Set(s.files.filter((f) => f.original === false).map((f) => f.id));
  const held = (fileId: string): Held | undefined => {
    const hash = hashOf.get(fileId);
    return cloudConnected && hash && !noOriginal.has(fileId) && io.holds(fileId) ? { fileId, hash } : undefined;
  };
  const payloads: DocumentPayload<Held>[] = [
    ...plan.documents.map((d) => ({ ...d.fields, file: held(d.fileId), contentHash: hashOf.get(d.fileId) })),
    ...plan.labArchives.map((a) => labArchivePayload(a.sourceFileName, a.reportDate, held(a.fileId), { rows: rowsOf.get(bytesOf(a.fileId)), contentHash: hashOf.get(a.fileId) })),
    ...plan.archiveOnly.map((d) => ({ ...d.fields, file: held(d.fileId), contentHash: hashOf.get(d.fileId) })),
  ];
  // What this Save itself wrote: `archived` comes from it, never from the plan's lists.
  const wrote = new Set<string>();
  const docs = await saveDocuments(record, payloads, {
    hash: async (f) => f.hash,
    write: async (ref, f) => {
      const bytes = io.original(f.fileId);
      if (bytes === null) throw new Error('The original could not be read.');
      await io.write(ref, bytes, f.fileId);
      wrote.add(ref);
    },
    mimeType: (f) => io.mimeType(f.fileId), makesFolders: io.makesFolders, now: io.now, newId: io.newId,
  });
  // `documents`: the letters and documents the list showed to be saved, as the Save label counts them (owner ruling
  // 2026-11-20), never a lab report's hidden archive row nor an original filed behind a held row.
  const shown = new Set(plan.documents.map((d) => hashOf.get(d.fileId) ?? d.fields.sourceFileName));
  const documents = new Set(docs.saved.filter((d) => shown.has(d.contentHash ?? d.sourceFileName)).map((d) => d.contentHash ?? d.sourceFileName ?? d.id)).size;
  // The originals the plan stores, by bytes.
  const nominated = new Set([...plan.documents, ...plan.labArchives, ...plan.archiveOnly].flatMap(({ fileId }) => {
    const hash = hashOf.get(fileId);
    return cloudConnected && hash && !noOriginal.has(fileId) ? [hash] : [];
  }));

  return {
    ok: true,
    // Once per Save: it writes the archive rows' lists in place.
    commit(file) {
      // On the record it planned on, the planned write stands; on any other, the values are written
      // again and each planned row id becomes the one this write gave the same row, or leaves the list.
      const written = file === record ? onRecord : bulkAppendValues(file, rows, now);
      if (written !== onRecord) {
        const ids = writtenLabRows(written);
        const swap = new Map(planned.flatMap((id, i) => (id ? [[id, ids[i]] as const] : [])));
        for (const d of docs.saved) {
          const list = listedRows(d);
          if (list) d.metadata = { ...d.metadata, [LAB_ARCHIVE_ROWS]: list.flatMap((id) => { const to = swap.has(id) ? swap.get(id) : id; return to ? [to] : []; }) };
        }
      }
      const values = written.saved.length;
      // `archived`, with its own line: each original this Save put in the cloud that no shown document holds and whose bytes wrote no value now.
      const valued = new Set(rowFiles.flatMap((id, i) => (written.outcomes[i] === 'written' ? [bytesOf(id)] : [])));
      const archived = docs.saved.filter((d) => d.fileRef && wrote.has(d.fileRef) && !shown.has(d.contentHash ?? d.sourceFileName) && !valued.has(d.contentHash ?? '')).length;
      // A reviewed row whose slot another writer took meanwhile is skipped, never a second active row, and counted
      // (US-12 AC6a): each value the reviewed page would write that this commit did not write nor refuse, the slot
      // having gone before Save planned or before it committed; with no reviewed page given, the commit's own skips.
      const settled = new Set(written.outcomes.flatMap((o, i) => (o === 'skipped' ? [] : [rowKeys[i]])));
      const notWritten = s.reviewed?.filter((v) => !settled.has(`${v.file}:${v.ref}`))
        ?? written.outcomes.flatMap((o, i) => (o === 'skipped' ? [{ lab: rows[i].kind === 'lab' }] : []));
      const [sv, sl] = [notWritten.filter((v) => !v.lab).length, notWritten.filter((v) => v.lab).length];
      // A value the commit refused, the record having changed since the plan (a blood pressure's other half,
      // say), is named, never dropped silently (US-13 AC17): a lab in the review's not-saved words, a core value
      // in the web's own refusal line. A core value out of range has no line without the cell's unit: it reads
      // as misread, as the review names a misread number (it cannot newly arise at commit: the range is the value's own).
      const refused = [
        ...written.refused.map((r) => ({ label: labTestLabel(r.key), reason: labReason(r) })),
        ...written.measurementRefusals.map((r) => { const line = measurementRefusalText(r); return line !== null ? { line } : { label: METRIC_LABELS[r.metricType] ?? labTestLabel(r.metricType), reason: 'misread' as const }; }),
      ];
      const filed = values || docs.saved.length ? committedFile(written.file, docs) : file;
      // Each ticked, dated box the page shows; of one type the latest date is written, and only when it is later than
      // the record's (Brad 2026-11-23).
      const dates = plan.documents.flatMap(({ screening: box }) =>
        (box?.ticked && box.date !== null && isScreeningDateKey(box.key) ? [[box.key, box.date] as const] : []));
      const { file: out, written: screenings } = writeScreeningDates(filed, dates, now);
      // `unstored`: each original the plan stores that no live row on the committed record stores (a failed or
      // untried write, the app not holding it), judged at commit so another writer's copy counts as kept.
      const stored = storedHashes(out);
      const unstored = [...nominated].filter((h) => !stored.has(h)).length;
      return { file: out, outcome: { values, documents, archived, unstored, ...(sv ? { skippedValues: sv } : {}), ...(sl ? { skippedLabValues: sl } : {}), ...(refused.length ? { refused, refusedCodes: refusalCodes(written) } : {}), ...(screenings ? { screenings } : {}) } };
    },
  };
}
