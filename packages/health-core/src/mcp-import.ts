/**
 * The import pipeline: `import_documents` (extract, then commit; US-35) and
 * `file_results` (US-36). Split out of `mcp-tools.ts`, which re-exports it
 * (issue #429).
 */
import { bloodTestKeyOf, isCoreRow } from './blood-tests';
import { dayOf, daysBetween, localDay } from './merge';
import { displayLabUnit, labSlotKey } from './lab-catalog';
import {
  type AdditionalLabValue,
  type ExtractedValue,
  FOLDER_IMPORT_EXTENSIONS,
  isImportableEntryName,
  MAX_FILE_NAME_LENGTH,
  MAX_NAME_LENGTH,
  resolveName,
  type ResolvedName,
  type UnifiedExtractionResult,
  VALID_METRICS,
} from './lab-extraction';
import { oneLine } from './plan';
import {
  appendLabValue,
  appendMeasurement,
  type BulkRow,
  bulkAppendValues,
  type EditContext,
  PRESSURE_ORDER_HALF,
  resolveRecordedAt,
  sameLabQuantity,
  slotIndex,
  slotKey,
  type SlotState,
  slotState,
  stampUpdatedAt,
  type EditRejection,
  validDay,
} from './record-edits';
import type { FileDocument, FileLabValue, FileMeasurement, RoadmapFile } from './roadmap-file';
import { CANONICAL_UNITS, formatRange, getDisplayLabel, getDisplayRange, reportedToCanonical, UNIT_DEFS, UNIT_SWAP_FLOORS, unitSystemOf, type MetricType, type UnitSystem } from './units';
import { comparatorOf, formatValue, withComparator, type Comparator } from './lab-limits';
import { IMPORT_REFUSALS, importHint } from './import-hints';
import { LAB_ARCHIVE_TITLE } from './document-path';
import { documentRow, labArchiveFields, type DocumentFields } from './document-rows';
import { DOCUMENT_TYPES, type DocumentType, PRESSURE_ORDER, pressureInverted } from './validation';
import * as z from './zod';
import { isReadableRow } from './readable-rows';
import {
  describe,
  type FileResultsRequest,
  type FileResultsSource,
  folderNudgeOutput,
  IMPORT_FILE_STATUSES,
  IMPORT_ROUTES,
  importCandidateOutput,
  type ImportCommit,
  importFileOutput,
  type ImportRequest,
  MAX_DOCUMENT_TEXT,
  MAX_IMPORT_CANDIDATES,
  MAX_UNRECOGNIZED_LINE_LENGTH,
  MAX_UNRECOGNIZED_LINES,
  readableSlotRow,
  ToolContractError,
  type ToolOutcome,
} from './mcp-tool-contract';

// ---------------------------------------------------------------------------
// import_documents — extract, then commit (US-35)
// ---------------------------------------------------------------------------

export type ImportRoute = (typeof IMPORT_ROUTES)[number];
export type ImportFileStatus = (typeof IMPORT_FILE_STATUSES)[number];

/**
 * One file as the surface read it. `result` is the extraction, present only
 * when `extracted`; the text of the document never comes with it — what the
 * tool layer needs is numbers, dates and a classification. `contentHash` is
 * the record's own document key (`sha256-<hex>` of the bytes), so the website
 * and the connector dedup on ONE field (AC6); a row that never had bytes
 * carries neither it nor a type.
 */
export interface ExtractedFile {
  /** The file's own name, control characters stripped, as `sourceFileName`; a ZIP member's is `zip/member`, as on the website. */
  name: string;
  contentHash?: string;
  mimeType?: string;
  status: ImportFileStatus;
  reason?: string;
  result?: UnifiedExtractionResult;
  /** The day an `already_imported` match was made on, when it was by name and date (US-36 AC5). */
  date?: string | null;
  /** A ZIP member's ZIP, as the folder lists it: the name `fileNames` takes to read the member again (US-35 AC7a). */
  zip?: string;
}

/** Everything one extract call read, and what it did not reach (AC2). */
export interface ImportBundle {
  route: ImportRoute;
  files: ExtractedFile[];
  /** Folder-route names not reached inside the budget: pass them as `fileNames` next. */
  remaining: string[];
  /** The user's own answer to "what date was this test?", per file name (AC13); it wins over the file's date. */
  fileDates?: Record<string, string>;
  /** Every value already passed the record's own dry run, worded per row (US-36 AC2): `prepareImport` need not run it again. */
  checked?: true;
}

export type ImportCandidate = z.infer<typeof importCandidateOutput>;

/** A document as the commit will file it: metadata only, never its text (AC9). */
export interface ImportDocument {
  sourceFileName: string;
  contentHash: string;
  mimeType: string;
  type: DocumentType;
  title: string;
  summary?: string;
  date: string | null;
}

/**
 * What an extract parks for its commit — in the user's own folder, as
 * `imports/pending-<id>.json`, where the record itself lives. The receipt the
 * assistant carries is its id; the file holds the MAC over it; nothing an assistant sends can
 * put a value in here that the server did not extract (AC7).
 */
export interface ImportPayload {
  id: string;
  route: ImportRoute;
  createdAt: string;
  candidates: ImportCandidate[];
  documents: ImportDocument[];
}

export type ImportRefusal = { refusal: string };

/**
 * Reading files and parking a payload need a network, a model key and a
 * folder to write to — the hosted server has all three, the stdio server has
 * none (AC11). So the surface hands them in, the way `fileFeedback` hands in
 * a GitHub token, and the tool layer stays pure: it slots candidates and
 * applies a selection. Every method answers a refusal in words rather than
 * throwing, because "Dropbox would not list the folder" is the user's to act
 * on, not a fault in us. The surface charges its own allowance per file and
 * per replace; the call's base charge is the loop's `beforeCall`, as for
 * every write — and `open` verifies the receipt BEFORE it charges anything,
 * so a forged receipt costs nothing.
 */
export interface ImportSurface {
  /** The oldest value a `replace` may correct, in days — the hosted 90-day rule. Absent: no limit. */
  maxCorrectionAgeDays?: number;
  /** The pinned label of the assistant calling, stamped on the document row at commit (US-36 AC5). */
  client?: string;
  /**
   * One call's whole budget, ms (AC5). `runImport` starts the clock before the
   * record is read and hands every phase the same `deadline` (epoch ms): the
   * record's read and write go through `SyncManager` under `deadlineSignal`,
   * and the surface bounds its own I/O the same way. Nothing an import does
   * runs past it.
   */
  budgetMs: number;
  stash(payload: ImportPayload, deadline: number): Promise<{ receipt: string; expiresAt: string } | ImportRefusal>;
  open(commit: ImportCommit, file: RoadmapFile, now: string, deadline: number): Promise<ImportPayload | ImportRefusal>;
  discard(payload: ImportPayload, deadline: number): Promise<void>;
  /**
   * READ files: the folder route needs a listing, a download and the
   * extraction model, which only the hosted server has (AC11). Absent,
   * `import_documents` refuses in words; `file_results` needs none of it —
   * the assistant read the file — so it runs on the stdio server too (US-36).
   */
  extract?(request: ImportRequest, file: RoadmapFile, now: string, deadline: number): Promise<ImportBundle | ImportRefusal>;
}

export const IMPORT_HOSTED_ONLY =
  'import_documents needs a server that can read files and reach the extraction model, and this one cannot. ' +
  'Use the website’s upload, or connect the hosted connector. Nothing was read and nothing was written.';

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
  const live = file.documents.filter((d) => !d.deleted);
  const byHash = contentHash === '' ? undefined : live.find((d) => d.contentHash === contentHash);
  if (byHash) return { row: byHash, by: 'hash' };
  // The name paths read only documents this build reads (US-65): a hidden one's name may be anything.
  const named = live.filter((d) => isReadableRow('documents', d));
  const sameName = (d: FileDocument) => d.sourceFileName != null && dedupFileName(d.sourceFileName) === dedupFileName(name);
  const byNameDate = contentHash === '' && date ? named.find((d) => sameName(d) && d.date === date) : undefined;
  if (byNameDate) return { row: byNameDate, by: 'name_date' };
  // A dated candidate against a hashless row dated differently is the portal's next `Results.pdf`, not a twin.
  const byName = named.find((d) => d.contentHash === '' && sameName(d) && (!date || !d.date || d.date === date));
  return byName ? { row: byName, by: 'name' } : null;
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
 * A folder entry as both the import and the nudge read it (US-35 AC2, US-37
 * AC1): printable, bounded to a file name — so a nudged name is one
 * `fileNames` will match — and only when it is a lab file. Null otherwise.
 */
export function importableFileName(name: string): string | null {
  const clean = oneLine(name).slice(0, MAX_FILE_NAME_LENGTH);
  return isImportableEntryName(clean, FOLDER_IMPORT_EXTENSIONS) ? clean : null;
}

/** Names one nudge carries, at most; the folder can hold more. */
export const FOLDER_NUDGE_MAX = 10;

/** The one fixed sentence a nudge carries (US-37 AC1, AC3): the way in, and the way to make a file stop being offered. */
export const FOLDER_NUDGE_HINT =
  'These files in the Dropbox folder are not in the record. Offer to import them (import_documents with fromNudge true), ' +
  'or the user can drop them into this chat; never import unasked. If the user wants a file left alone, commit it with ' +
  'empty accept and replace: it is filed as a document and not offered again.';

/**
 * What a read adds on a Dropbox connection (US-37): the folder-root names the
 * folder route would read that no live document row names. Pure — the
 * surface lists and hands the names in — and `undefined` when there is
 * nothing to offer, so the field is absent rather than empty.
 *
 * The nudge's own rule (AC1): a live row with this `sourceFileName`, hashed
 * or not. `isAlreadyImported`'s name rule matches hashless rows only, by
 * design (twins named `Results.pdf`); here there are no bytes to hash, and
 * that rule would nag every folder-imported file forever. The trade-off runs
 * the other way: a second `Results.pdf` looks imported and is silent, which
 * is why the sentence says "not in your record", never "new".
 */
export function folderNudge(file: RoadmapFile, entryNames: string[]): z.infer<typeof folderNudgeOutput> | undefined {
  const filed = new Set(file.documents.filter((d) => !d.deleted).flatMap((d) => (d.sourceFileName == null ? [] : dedupFileName(d.sourceFileName))));
  const unimported = entryNames
    .flatMap((name) => importableFileName(name) ?? [])
    .filter((name) => !filed.has(dedupFileName(name)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, FOLDER_NUDGE_MAX);
  return unimported.length ? { unimported, hint: FOLDER_NUDGE_HINT } : undefined;
}

/** The sentence for an `already_imported` entry: which row, when, and the way past it (AC13). Names a file, never a title. */
function alreadyImportedHint(match: ImportedMatch | null): string {
  // A hidden document's date and name are never echoed (US-65 AC3).
  if (!match || !isReadableRow('documents', match.row)) return 'Already in the record. Nothing to do.';
  const when = match.row.date ?? dayOf(match.row.addedAt);
  const as = match.row.sourceFileName ? ` as ${oneLine(match.row.sourceFileName)}` : '';
  if (match.by === 'hash') return `Already in the record: the same file was filed on ${when}${as}. Nothing to do.`;
  if (match.by === 'name_date') return `Already in the record: a file with this name and date was filed on ${when}${as}. Nothing to do.`;
  return `A file with this name was filed on ${when}${as}, and that row carries no fingerprint to tell the two apart. Rename the file to import it.`;
}

/** Text lifted out of a document, bounded and printable, before it reaches the assistant (AC9). */
function fromDocument(text: string | undefined | null): string | undefined {
  const clean = oneLine(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DOCUMENT_TEXT);
  return clean || undefined;
}

/** What a candidate finds in its slot (AC6): a core metric by its displayed string, a lab by quantity (`sameLabQuantity`, the website's rule too). */
function slotFor(
  existing: FileMeasurement | FileLabValue | undefined,
  candidate: Omit<ImportCandidate, 'id' | 'sameDayAs' | 'slot'>,
  now: string,
  maxAgeDays: number | undefined,
  system: UnitSystem,
): ImportCandidate['slot'] {
  if (!existing) return { state: 'free' };
  // A row no reader can read holds the day, with nothing to show or compare (US-65 AC3).
  if (!readableSlotRow(existing)) return { state: 'held_different', existingRowId: existing.id, replaceable: false };
  // A core value, in either array, compares by its displayed string, a limit with its symbol (US-66 AC6, US-12 AC20).
  const state: SlotState = 'metricType' in existing || isCoreRow(existing)
    ? slotState(formatValue(('metricType' in existing ? existing.metricType : existing.metricName) as MetricType, existing.value, system, existing.comparator), candidate.displayValue)
    : sameLabQuantity(
      { name: existing.metricName, value: existing.value, unit: existing.unit, comparator: existing.comparator },
      { name: candidate.printedName ?? candidate.metric, value: candidate.value, unit: candidate.unit, comparator: candidate.comparator },
    ) ? 'held_equal' : 'held_different';
  if (state === 'held_equal') return { state, existingRowId: existing.id, existingValue: existing.value };
  const age = daysBetween(dayOf(existing.recordedAt ?? ''), dayOf(now));
  return {
    state, existingRowId: existing.id, existingValue: existing.value,
    replaceable: maxAgeDays === undefined || age <= maxAgeDays,
  };
}

/** Rule 9 alone, as a dry run's refusal: null for a day the record takes. */
function dayFault(day: string, ctx: EditContext): EditRejection | null {
  const resolved = resolveRecordedAt(day, ctx);
  return typeof resolved === 'string' ? null : resolved;
}

type PreparedImport = { payload: ImportPayload; files: Array<z.infer<typeof importFileOutput>>; unrecognized: string[] };

/**
 * US-36 AC7a: `file_results` takes at most MAX_LAB_ROWS_PER_CALL rows, so a
 * long report is split over calls with one `sourceFileName`. The first commit
 * files the report, and a later call with that name and date is then
 * `already_imported`, so every part must be read before the first commit.
 */
function splitReportNote(route: ImportRoute, values: number): string[] {
  return route === 'assistant' && values > 0
    ? ['If the report has result lines this call did not carry, send them now with the same sourceFileName, before any commit: once filed, the report reads as already imported.']
    : [];
}

/**
 * The instruction the assistant follows after an extract: the counts and one
 * next step. Detail lives beside the thing it is about — a file's `hint`, a
 * candidate's `question`, the `unrecognized` lines — and this field names
 * where to look, so text from a document never rides in it (AC9).
 */
export function extractNext(prepared: PreparedImport, remaining: string[], route: ImportRoute): string {
  const { payload, files, unrecognized } = prepared;
  const tool = route === 'assistant' ? 'file_results' : 'import_documents';
  const lines: string[] = [];
  const count = (state: SlotState) => payload.candidates.filter((c) => c.slot.state === state).length;
  const questions = payload.candidates.filter((c) => c.question).map((c) => c.id);
  const shared = payload.candidates.filter((c) => c.sameDayAs).length;
  const docs = payload.documents.length;
  const notRead = files.filter((f) => f.status !== 'extracted').length;
  const partial = files.filter((f) => f.droppedValues).length;
  const dropped = unrecognized.length ? ` ${unrecognized.length} value(s) could not be filed: show unrecognized.` : '';

  if (payload.candidates.length || docs) {
    lines.push(
      `${count('free')} new value(s), ${count('held_equal')} already recorded, ${count('held_different')} differ from the record` +
        `${docs ? `, ${docs} document(s) to file (titles in documents)` : ''}. ` +
        'Show the user each candidate (value, unit, date, file)' + (docs ? ' and document' : '') + ', then WAIT for their own answer, naming what to file; nothing is written to the record until they confirm.' + dropped,
    );
    if (questions.length) lines.push(`${questions.length} candidate(s) carry a question from the extractor (${questions.slice(0, 5).join(', ')}): show it beside the value.`);
    if (shared) lines.push(`${shared} candidate(s) share a day with another (sameDayAs): the record keeps one value per metric per day, so the user picks one.`);
    const split = splitReportNote(route, payload.candidates.length);
    lines.push(...split);
    lines.push(
      `Then call ${tool} with commit${split.length ? ' for each receipt, one call per receipt (each part numbers its ids from c1)' : ''}: the receipt, accept (ids to file), replace (replaceable held_different ids the user asked to overwrite; permanent, never a non-replaceable id), ` +
        'and approval: the user’s own words, quoted, never a document’s. ' +
        'A commit with empty accept and replace files the documents alone, and is how a declined file stops being offered.',
    );
  } else if (files.some((f) => f.status === 'extracted')) {
    lines.push('The files were read but held nothing this record can file. Tell the user what each file was.' + dropped);
  } else {
    lines.push('Nothing was imported.');
  }
  if (notRead) lines.push(`${notRead} file(s) were not read: relay each file's hint to the user in plain words.`);
  if (partial) lines.push(`${partial} file(s) had values that could not be read: relay that file's hint.`);
  if (remaining.length) {
    const first = payload.candidates.length || docs ? 'commit this receipt first, then ' : '';
    lines.push(`${remaining.length} file(s) were not reached: ${first}call again with fileNames set to remaining.`);
  }
  return lines.join('\n');
}

/**
 * US-35 AC7a: the files one receipt can hold. A receipt carries at most
 * MAX_IMPORT_CANDIDATES values, and a report filed with values past it
 * answers already_imported next time (AC6), so they could never be offered.
 * A lab report whose rows would overflow a receipt that already holds
 * another file's is left, with every file after it, for the next call. One
 * report too long for any receipt keeps its first rows; the rest count as
 * left out (`droppedValueCount`), so its file hint says so. Rows count only
 * for a report prepareImport will file: an undated or refused-date report, or
 * a second copy of bytes already in this call, holds no room. Rows are counted
 * before the dry run, so a report may wait that would just have fit. A ZIP
 * member waits under its ZIP's name (the caller names it once): only a
 * folder-root name can be asked for again, and the re-read skips the members
 * filed by then (by hash).
 */
export function fitReceipt(bundle: ImportBundle, ctx: EditContext): { bundle: ImportBundle; deferred: string[] } {
  const files: ExtractedFile[] = [];
  const deferred: string[] = [];
  const seenBytes = new Set<string>();
  let held = 0;
  for (const read of bundle.files) {
    // Rows count only for a report prepareImport will file: a dated lab report, not a twin of one
    // already in this call. Any other file's rows are empty (toUnifiedResult).
    const twin = !!read.contentHash && seenBytes.has(read.contentHash);
    const lab = read.status === 'extracted' && read.result?.classification === 'lab_report' && !twin
      && labReportDay(read.name, read.result, bundle, ctx).day ? read.result : undefined;
    const rows = lab ? lab.values.length + lab.additionalValues.length : 0;
    if (deferred.length || (held > 0 && held + rows > MAX_IMPORT_CANDIDATES)) {
      deferred.push(read.zip ?? read.name);
      continue;
    }
    held += rows;
    if (read.status === 'extracted' && read.contentHash) seenBytes.add(read.contentHash);
    files.push(rows > MAX_IMPORT_CANDIDATES ? { ...read, result: firstRows(lab!, MAX_IMPORT_CANDIDATES) } : read);
  }
  return { bundle: { ...bundle, files }, deferred };
}

/**
 * A lab report's day: the user's own answer (`fileDates`, AC13) over the print.
 * No day is `no_date`; one the record refuses comes back as `refused` (`bad_date`).
 */
function labReportDay(name: string, result: UnifiedExtractionResult, bundle: ImportBundle, ctx: EditContext): { day: string | null; refused?: EditRejection } {
  const given = bundle.fileDates?.[name];
  const own = given === undefined ? null : resolveRecordedAt(given, ctx);
  if (typeof own === 'string') return { day: own };
  return own ? { day: null, refused: own } : { day: validDay(result.reportDate, ctx) };
}

/** A report cut to its first `n` value rows, core rows first; the rest counted as left out. */
function firstRows(result: UnifiedExtractionResult, n: number): UnifiedExtractionResult {
  const values = result.values.slice(0, n);
  const additionalValues = result.additionalValues.slice(0, n - values.length);
  const cut = result.values.length + result.additionalValues.length - values.length - additionalValues.length;
  return { ...result, values, additionalValues, droppedValueCount: (result.droppedValueCount ?? 0) + cut };
}

/**
 * The extract phase's second half, pure: every file the surface read, slotted
 * against the record (AC6) and reduced to what a commit can apply (AC7). A
 * value the record would refuse — out of range, a day that has not happened,
 * a core metric under a lab name — is dropped here with the reason, by the
 * same rules `add_measurement` and `add_lab_values` apply, so the receipt can
 * never carry a value the record would not take. Values are shown in the
 * record's own unit system and stored canonical (AC6).
 */
export function prepareImport(
  file: RoadmapFile,
  bundle: ImportBundle,
  ctx: EditContext & { maxCorrectionAgeDays?: number; payloadId: string },
): PreparedImport {
  const latestDay = ctx.latestDay ?? localDay(ctx.now);
  const system = unitSystemOf(file.profile);
  const files: Array<z.infer<typeof importFileOutput>> = [];
  const candidates: ImportCandidate[] = [];
  const documents: ImportDocument[] = [];
  const unrecognized: string[] = [];
  const held = slotIndex(file);
  /** Slot → the id of the first candidate this call put there; a second one is offered too, marked. */
  const seenSlots = new Map<string, string>();
  /** contentHash → the first file this call read with those bytes: a twin ("Results (1).pdf") files nothing (AC6). */
  const seenBytes = new Map<string, string>();

  for (const read of bundle.files) {
    const name = read.name;
    if (read.status === 'already_imported') {
      files.push({ name, status: read.status, hint: alreadyImportedHint(isAlreadyImported(file, name, read.contentHash ?? '', read.date)) });
      continue;
    }
    if (read.status !== 'extracted' || !read.result) {
      files.push({ name, status: read.status, ...(read.reason ? { reason: read.reason } : null), hint: importHint(read.reason) });
      continue;
    }
    const twin = read.contentHash ? seenBytes.get(read.contentHash) : undefined;
    if (twin) {
      files.push({ name, status: 'already_imported', hint: `The same file as ${oneLine(twin)} in this call. Nothing to do.` });
      continue;
    }
    if (read.contentHash) seenBytes.set(read.contentHash, name);
    const result = read.result;
    const report: z.infer<typeof importFileOutput> = { name, status: 'extracted', classification: result.classification };
    // Every file read lands as a document: metadata only, its text left
    // behind (AC8). `contentHash` names the bytes the user still holds; the
    // website archives them on `fileRef` when the same file is uploaded there,
    // and the row is what makes the next extract `already_imported` (AC6).
    let doc: Pick<ImportDocument, 'type' | 'title' | 'summary' | 'date'>;

    if (result.classification === 'lab_report') {
      // The user's own answer to "what date was this test?" wins over the print
      // (AC13), and one the record refuses is said back with the refusal — a
      // `no_date` here would ask for the date the user just gave.
      const { day, refused } = labReportDay(name, result, bundle, ctx);
      if (!day) {
        const reason = refused ? 'bad_date' : 'no_date';
        files.push({ ...report, status: 'failed', reason, hint: importHint(reason, refused?.message) });
        continue;
      }
      report.documentDate = day;
      const offer = (slot: string, candidate: Omit<ImportCandidate, 'id' | 'sameDayAs' | 'slot'>) => {
        const first = seenSlots.get(slot);
        const id = `c${candidates.length + 1}`;
        if (!first) seenSlots.set(slot, id);
        candidates.push({ id, ...candidate, ...(first ? { sameDayAs: first } : null), slot: slotFor(held.get(slot), candidate, ctx.now, ctx.maxCorrectionAgeDays, system) });
      };
      // The name as printed rides along on the assistant route (US-36 AC3), bounded like every string from a document.
      const printed = (value: { printedName?: string }) => (value.printedName ? { printedName: oneLine(value.printedName).slice(0, MAX_NAME_LENGTH) } : null);
      // A day of its own on the folder route is a dated previous-results column
      // the shared parse now reads for the website (US-12 AC12). Held off the
      // connector for OpenAI's MCP 1.0.2 review (ended 2026-10-29; releasing it
      // is open work): left out, as the old prompt left it out. The assistant's
      // own per-line day (US-36 AC1) is kept.
      const previousColumn = (value: { recordedAt?: string }) => bundle.route !== 'assistant' && !!value.recordedAt;
      // A core value, given in SI or in a printed unit. A dry run of the real
      // append: it validates the value, the unit and the day the way the record
      // will. A taken slot is not a reason to drop it, nor a blood pressure
      // half judged alone: the pair pass below judges the report's whole pair
      // (US-02 AC8).
      const offerCore = (
        metric: MetricType, own: string, reported: { value: number; unit?: string }, label: string,
        value: { confidence: ImportCandidate['confidence']; question?: string; printedName?: string; comparator?: Comparator },
      ) => {
        const check = bundle.checked ? null : appendMeasurement(file, { metricType: metric, ...reported, recordedAt: own, now: ctx.now, latestDay });
        if (check && !check.ok && check.reason !== 'slot-occupied' && check.message !== PRESSURE_ORDER_HALF) {
          unrecognized.push(`${label}: ${oneLine(check.message)}`);
          return;
        }
        const valueSI = reported.unit === undefined ? reported.value : reportedToCanonical(metric, reported.value, reported.unit)?.valueSI;
        if (valueSI === undefined) return;
        // A limit offers its bound with its code, shown with its symbol (US-12 AC20).
        offer(slotKey('measurement', metric, own), {
          kind: 'measurement', metric, value: valueSI, unit: CANONICAL_UNITS[metric], ...comparatorOf(value),
          displayValue: formatValue(metric, valueSI, system, value.comparator), displayUnit: getDisplayLabel(metric, system),
          recordedAt: own, confidence: value.confidence,
          ...(value.question ? { question: fromDocument(value.question) } : null),
          sourceFileName: name, ...printed(value),
        });
      };
      for (const value of result.values) {
        if (candidates.length >= MAX_IMPORT_CANDIDATES) break;
        if (!VALID_METRICS.includes(value.metric as MetricType) || previousColumn(value)) continue;
        const metric = value.metric as MetricType;
        offerCore(metric, value.recordedAt ?? day, { value: value.valueSI }, metric, value);
      }
      for (const value of result.additionalValues) {
        if (candidates.length >= MAX_IMPORT_CANDIDATES) break;
        if (previousColumn(value)) continue;
        const own = value.recordedAt ?? day;
        // Brad D5 (US-66 AC6): an extra value named like a core test is offered
        // as that core value; a unit that will not convert is said, not filed.
        // An extra creatinine stays a lab row under its printed name (US-12 AC11).
        const named = bloodTestKeyOf(value.name);
        if (named && named !== 'creatinine') {
          offerCore(named, own, { value: value.value, unit: value.unit }, oneLine(value.name).slice(0, MAX_NAME_LENGTH),
            { confidence: value.confidence ?? 'high', question: value.question, printedName: value.printedName ?? value.name, ...comparatorOf(value) });
          continue;
        }
        // With its range: the write checks the whole row (US-21 AC15), so the preview does too.
        // An extra creatinine has no catalogue entry to check, only its day.
        const check = bundle.checked ? null : named ? dayFault(own, { ...ctx, latestDay }) : appendLabValue(file, {
          metricName: value.name, value: value.value, unit: value.unit, referenceLow: value.referenceLow, referenceHigh: value.referenceHigh,
          recordedAt: own, now: ctx.now, latestDay,
        });
        if (check && !check.ok && check.reason !== 'slot-occupied') {
          unrecognized.push(`${oneLine(value.name).slice(0, MAX_NAME_LENGTH)}: ${oneLine(check.message)}${check.bound ? `. ${ASK_NOT_RESEND}` : ''}`);
          continue;
        }
        const metric = labSlotKey(value.name);
        const unit = oneLine(value.unit).slice(0, MAX_NAME_LENGTH);
        const display = withComparator(String(value.value), value.comparator);
        // The name the dry run above just accepted rides on the candidate, and
        // the commit writes under it: "BUN" carries the mg/dL factor that the
        // slot key "urea" refuses, so a receipt built under one name and
        // committed under the other would throw away the value it offered.
        offer(slotKey('lab', metric, own), {
          kind: 'lab', metric, value: value.value, unit, displayValue: display, displayUnit: unit, ...comparatorOf(value),
          recordedAt: own, confidence: 'high',
          referenceLow: value.referenceLow ?? null, referenceHigh: value.referenceHigh ?? null,
          sourceFileName: name, ...printed({ printedName: value.printedName ?? value.name }),
        });
      }
      for (const line of result.unrecognized) unrecognized.push(oneLine(line).slice(0, MAX_UNRECOGNIZED_LINE_LENGTH));
      // A creatinine the extractor refused rather than guessed (US-12 AC15, D7a): one line with why, never a "could not be read" count.
      for (const value of result.refusedValues ?? []) {
        if (!previousColumn(value)) unrecognized.push(oneLine(`${`${value.metric} ${value.value} ${value.unit}`.trim()}: not saved. ${value.reason}`).slice(0, MAX_UNRECOGNIZED_LINE_LENGTH));
      }
      // Once filed, the report dedups as already_imported: a refused value is said now or never. A count, no value.
      const n = result.droppedValueCount ?? 0;
      if (n > 0) {
        report.droppedValues = n;
        report.hint = n === 1
          ? '1 value on this report could not be read and was left out. Check the report for it.'
          : `${n} values on this report could not be read and were left out. Check the report for them.`;
      }
      // The row the website writes for a lab PDF (`synthesizeLabArchiveEntries`),
      // which its Documents list hides: the values are the record, the file is the archive.
      doc = { type: 'pathology_report', title: LAB_ARCHIVE_TITLE, date: day };
    } else {
      const type = (DOCUMENT_TYPES as readonly string[]).includes(result.classification) ? result.classification as DocumentType : 'other';
      const summary = fromDocument(result.document?.summary);
      doc = { type, title: fromDocument(result.document?.title) ?? name, ...(summary ? { summary } : null), date: validDay(result.document?.documentDate, ctx) };
      report.title = doc.title;
      if (doc.summary) report.summary = doc.summary;
      report.documentDate = doc.date;
    }
    documents.push({ sourceFileName: name, contentHash: read.contentHash ?? '', mimeType: read.mimeType ?? '', ...doc });
    files.push(report);
  }

  // US-02 AC8, per report: a report whose blood pressure halves on a day (its
  // own, else the halves held) can only form inverted pairs offers neither half
  // for that day, and says why. A report with any right-way-up pairing, and
  // another report's pair that day, stay offered; the commit judges the halves
  // the user picks (`bulkAppendValues`).
  const isBp = (c: ImportCandidate) => c.kind === 'measurement' && c.metric.endsWith('_bp');
  const reportDay = (c: ImportCandidate) => `${c.sourceFileName}\u0000${dayOf(c.recordedAt)}`;
  const pairs = new Map<string, { file: string; day: string; systolic_bp: number[]; diastolic_bp: number[] }>();
  for (const c of candidates.filter(isBp)) {
    const pair = pairs.get(reportDay(c)) ?? { file: c.sourceFileName, day: dayOf(c.recordedAt), systolic_bp: [], diastolic_bp: [] };
    pair[c.metric as 'systolic_bp' | 'diastolic_bp'].push(c.value);
    pairs.set(reportDay(c), pair);
  }
  const halves = (own: number[], metric: string, day: string) => (own.length ? own : [held.get(slotKey('measurement', metric, day))?.value]);
  const inverted = new Set([...pairs].filter(([, { day, systolic_bp, diastolic_bp }]) =>
    halves(systolic_bp, 'systolic_bp', day).every((s) => halves(diastolic_bp, 'diastolic_bp', day).every((d) => pressureInverted(s, d)))).map(([key]) => key));
  for (const key of inverted) unrecognized.push(`Blood pressure on ${pairs.get(key)!.day} in ${pairs.get(key)!.file}: ${PRESSURE_ORDER}`);
  // A withheld candidate may be the one others name in sameDayAs: each slot's
  // first survivor takes its place, so every link resolves in the payload.
  const firstOf = new Map<string, string>();
  const offered = candidates.filter((c) => !(isBp(c) && inverted.has(reportDay(c)))).map((c) => {
    const group = c.sameDayAs ?? c.id;
    const first = firstOf.get(group);
    if (!first) firstOf.set(group, c.id);
    if (first === c.sameDayAs) return c;
    const { sameDayAs: _withheld, ...rest } = c;
    return first ? { ...rest, sameDayAs: first } : rest;
  });
  const payload: ImportPayload = { id: ctx.payloadId, route: bundle.route, createdAt: ctx.now, candidates: offered, documents };
  return { payload, files, unrecognized: unrecognized.slice(0, MAX_UNRECOGNIZED_LINES) };
}

// ---------------------------------------------------------------------------
// file_results — the assistant read the file; the server checks every row (US-36)
// ---------------------------------------------------------------------------

const describeName = (resolved: ResolvedName): string => (resolved?.kind === 'core' ? resolved.metric : resolved?.kind === 'lab' ? resolved.key : 'nothing this record knows');

/** A lab value past its plausible range (US-21 AC26) is the person's to check, never the agent's to re-unit. */
const ASK_NOT_RESEND = 'Ask the user to check the report; never re-send it in another unit.';

/**
 * The rows the assistant read, checked the way `add_measurement` and
 * `add_lab_values` would check them and shaped as one `ExtractedFile`, so the
 * slotting, the receipt and the commit are `import_documents`' own code
 * (AC5). Every refusal is one `unrecognized` line naming the row, the reason
 * and the way round it (AC2); the call itself is refused only when it read
 * nothing it could file. Pure: no clock, no I/O.
 *
 * Per row, in order (AC3, AC4): the printed name is resolved and must agree
 * with the claimed `metric`; a core row's unit must be one the metric is
 * measured in and is converted; the day is resolved; the real append is dry
 * run; a canonical value under the metric's display floor is offered with a
 * question, because a unit swap on a floor-0 metric passes every range.
 */
export function fileResultsBundle(request: FileResultsSource, file: RoadmapFile, ctx: EditContext): ImportBundle | ImportRefusal {
  const name = oneLine(request.sourceFileName).slice(0, MAX_FILE_NAME_LENGTH);
  const { classification } = request;
  const isLab = classification === 'lab_report';
  if (isLab && !request.collectedOn) {
    return { refusal: 'A lab report needs collectedOn: the date the sample was taken, YYYY-MM-DD. If the report prints none, ask the user — never guess. Nothing was read.' };
  }
  // The file's own day is the call's to get right: refused here in its own name, or the file would fail
  // downstream with the folder route's `fileDates` advice, an argument this tool has not got.
  const collected = isLab ? resolveRecordedAt(request.collectedOn, ctx) : null;
  if (collected !== null && typeof collected !== 'string') {
    return { refusal: `collectedOn: ${oneLine(collected.message)}. Ask the user for the date the sample was taken, then re-send. Nothing was read.` };
  }
  if (isLab && !request.values?.length && !request.document) {
    return { refusal: 'The file was read as a lab report but no value was sent. Read every line of results on every page and send each one, or tell the user what the file was. Nothing was written.' };
  }
  if (!isLab && !request.document) {
    return { refusal: `A ${classification.replace(/_/g, ' ')} is filed from its document block: send title, type and date (null if none is printed). Nothing was written.` };
  }
  const contentHash = request.document?.sha256 ? `sha256-${request.document.sha256}` : '';
  const date = isLab ? request.collectedOn! : request.document?.date ?? null;
  if (isAlreadyImported(file, name, contentHash, date)) return { route: 'assistant', files: [{ name, contentHash, status: 'already_imported', date }], remaining: [] };

  const values: ExtractedValue[] = [];
  const additionalValues: AdditionalLabValue[] = [];
  const unrecognized: string[] = [];
  for (const row of request.values ?? []) {
    const printedName = oneLine(row.printedName).slice(0, MAX_NAME_LENGTH);
    const unit = oneLine(row.unit).slice(0, MAX_NAME_LENGTH);
    const line = `${printedName} ${row.value} ${unit}`;
    const refuse = (reason: string) => unrecognized.push(`${line}: ${reason}`);
    const claimedIsCore = VALID_METRICS.includes(row.metric as MetricType);
    if (claimedIsCore && row.printedName.trim() === row.metric) {
      refuse(`printedName is the name as the report prints it, not the key ${row.metric}. Re-send with the printed name.`);
      continue;
    }
    const printed = resolveName(printedName);
    const claimed: ResolvedName = claimedIsCore ? { kind: 'core', metric: row.metric as MetricType } : resolveName(row.metric);
    if (claimed?.kind === 'core') {
      if (!printed) {
        refuse(`printed name ${printedName} is not a name this record knows for ${claimed.metric}. If the report really calls ${claimed.metric} that, tell the user and add it with add_measurement.`);
        continue;
      }
      if (printed.kind !== 'core' || printed.metric !== claimed.metric) {
        refuse(`printed name ${printedName} is ${describeName(printed)}, not ${claimed.metric}. Re-send it as ${describeName(printed)}.`);
        continue;
      }
    } else if (printed?.kind === 'core') {
      refuse(`printed name ${printedName} is the core metric ${printed.metric}. Re-send it with metric ${printed.metric}.`);
      continue;
    } else if (printed && claimed && printed.key !== claimed.key) {
      refuse(`printed name ${printedName} is ${printed.key}, not ${claimed.key}. Re-send it as ${printed.key}.`);
      continue;
    }

    const own = row.recordedAt ?? request.collectedOn;
    const day = own ? resolveRecordedAt(own, ctx) : { ok: false as const, message: 'no date: a value needs the day it was measured' };
    if (typeof day !== 'string') {
      refuse(`${oneLine(day.message)}. Ask the user for the date, then re-send.`);
      continue;
    }

    if (claimed?.kind === 'core') {
      const metric = claimed.metric;
      const def = UNIT_DEFS[metric];
      // The real append, dry run under the printed unit: it refuses an unknown
      // unit, an out-of-range number and a bad day in the record's own words.
      // A blood pressure half is judged with its pair by prepareImport (US-02 AC8).
      const check = appendMeasurement(file, { metricType: metric, value: row.value, unit, recordedAt: day, now: ctx.now, latestDay: ctx.latestDay });
      if (!check.ok && check.reason !== 'slot-occupied' && check.message !== PRESSURE_ORDER_HALF) {
        const si = getDisplayRange(metric, 'si');
        const conv = getDisplayRange(metric, 'conventional');
        refuse(check.reason === 'unknown-unit'
          ? `${oneLine(check.message)}. Check the unit column; if the report really prints that, tell the user and do not file it.`
          : check.reason === 'out-of-range'
            ? `${oneLine(check.message)} (${formatRange(si, def.label.si)}; ${formatRange(conv, def.label.conventional)}). Check the unit; if the report really says that, tell the user and do not file it.`
            : `${oneLine(check.message)}.`);
        continue;
      }
      // Non-null: the dry run just accepted this unit.
      const { valueSI: canonical, system } = reportedToCanonical(metric, row.value, unit)!;
      const floor = UNIT_SWAP_FLOORS[metric];
      const swapped = floor !== undefined && canonical < floor;
      const other = system === 'si' ? def.label.conventional : def.label.si;
      values.push({
        metric, valueSI: canonical, displayValue: row.value, displayUnit: unit, displaySystem: system,
        confidence: swapped ? 'low' : 'high',
        ...(swapped ? { question: `${row.value} ${unit} is ${canonical.toFixed(2)} ${def.label.si}, below any usual result; was the printed unit ${other}?` } : null),
        printedName, recordedAt: day, ...comparatorOf(row),
      });
    } else {
      const entry = printed?.kind === 'lab' ? printed.entry : undefined;
      // The PRINTED name all the way through — the dry run, the row, the
      // candidate and the commit. It is what decides a conversion ("BUN" in
      // mg/dL converts, the bare molecule name does not), and the slot it
      // lands in is the same either way: `labSlotKey` folds both to `urea`.
      const check = appendLabValue(file, {
        metricName: printedName, value: row.value, unit, referenceLow: row.referenceLow, referenceHigh: row.referenceHigh,
        recordedAt: day, now: ctx.now, latestDay: ctx.latestDay,
      });
      if (!check.ok && check.reason !== 'slot-occupied') {
        refuse(`${oneLine(check.message)}.${check.bound ? ` ${ASK_NOT_RESEND}` : ''}`);
        continue;
      }
      additionalValues.push({
        name: printedName, value: row.value, unit: displayLabUnit(unit, entry),
        referenceLow: row.referenceLow ?? null, referenceHigh: row.referenceHigh ?? null, printedName, recordedAt: day, ...comparatorOf(row),
      });
    }
  }

  const document = request.document;
  const result: UnifiedExtractionResult = {
    classification,
    reportDate: isLab ? request.collectedOn! : null,
    values, additionalValues, unrecognized,
    document: isLab || !document ? null : { classification, title: document.title, documentDate: document.date, contentMarkdown: '', ...(document.summary ? { summary: document.summary } : null), metadata: {} },
  };
  return { route: 'assistant', files: [{ name, contentHash, status: 'extracted', result }], remaining: [], checked: true };
}

/**
 * The commit (AC8): apply the user's selection to a FRESH record, all or
 * nothing. A `held_different` id in `accept` but not in `replace` writes
 * nothing — silence is not consent to overwrite. A slot whose active row moved
 * since the extract (another device wrote) refuses the WHOLE commit, naming
 * the slot, and the assistant extracts again. Rows land through the same bulk
 * rule the website's review table saves with, carrying `source: lab_import`.
 */
export function importDocumentsCommit(
  file: RoadmapFile,
  payload: ImportPayload,
  commit: ImportCommit,
  now: string,
  /** The pinned label of the assistant committing — the proposing one too, since the receipt is bound to the connection (US-36 AC5). */
  client?: string,
): ToolOutcome {
  const byId = new Map(payload.candidates.map((c) => [c.id, c]));
  for (const id of [...commit.accept, ...commit.replace]) {
    if (!byId.has(id)) return { status: 'rejected', text: `${oneLine(id)} is not a candidate in this receipt. Nothing was written.` };
  }
  const replace = new Set(commit.replace);
  const chosen = new Set([...commit.accept, ...commit.replace]);
  const held = slotIndex(file);
  const rows: BulkRow[] = [];
  /** Slot → the chosen id that took it: two files can offer one day, the record keeps one value (AC6). */
  const taken = new Map<string, string>();

  for (const id of chosen) {
    const c = byId.get(id)!;
    const slot = slotKey(c.kind, c.metric, c.recordedAt);
    const other = taken.get(slot);
    if (other) {
      return { status: 'rejected', text: `${oneLine(id)} and ${other} both name ${oneLine(c.metric)} on ${c.recordedAt}, and the record keeps one value per metric per day. Pick one. Nothing was written.` };
    }
    taken.set(slot, id);
    const current = held.get(slot);
    const moved = c.slot.state === 'free'
      ? current !== undefined
      : !current || current.id !== c.slot.existingRowId || (readableSlotRow(current) ? current.value : undefined) !== c.slot.existingValue;
    if (moved) {
      return {
        status: 'rejected',
        text: `${oneLine(c.metric)} on ${c.recordedAt} changed in the record since these files were read. Nothing was written. ` +
          'Extract again and show the user the fresh candidates.',
      };
    }
    if (c.slot.state === 'held_equal') continue;
    if (c.slot.state === 'held_different') {
      if (!replace.has(id)) continue;
      // The age rule, enforced once: `replaceable` was computed at extract
      // against this surface's limit, and the receipt's hash keeps it honest.
      if (c.slot.replaceable === false) {
        return { status: 'rejected', text: `${oneLine(id)} (${oneLine(c.metric)} on ${c.recordedAt}) is too old to replace here. Nothing was written. The user can correct older values in the app.` };
      }
    }
    const correctsId = replace.has(id) ? c.slot.existingRowId : undefined;
    rows.push(c.kind === 'measurement'
      ? { kind: 'measurement', metricType: c.metric, value: c.value, recordedAt: c.recordedAt, source: 'lab_import', ...(correctsId ? { correctsId } : null), ...comparatorOf(c) }
      : {
          // The name the receipt was built from, not the slot key it folds to:
          // the conversion at the write must be the one the dry run offered.
          kind: 'lab', metricName: c.printedName ?? c.metric, value: c.value, unit: c.unit,
          referenceLow: c.referenceLow ?? null, referenceHigh: c.referenceHigh ?? null,
          recordedAt: c.recordedAt, source: 'lab_import', ...(correctsId ? { correctsId } : null), ...comparatorOf(c),
        });
  }

  // Documents need no selection: a clinic letter yields no candidates, and
  // the only commit it can get is an empty one. The no-op is "nothing chosen
  // AND nothing left to file".
  // The route is the audit trail (US-36 AC5): rows keep `source: lab_import`
  // (a document the user reviewed), and the document row says which way it
  // came and, on the assistant route, which assistant read it.
  const metadata = payload.route === 'assistant'
    ? { importedVia: 'assistant', ...(client ? { client } : null) }
    : { importedVia: 'connector' };
  const docs: FileDocument[] = payload.documents
    .filter((d) => !isAlreadyImported(file, d.sourceFileName, d.contentHash, d.date))
    .map((d) => {
      // A lab report's row is the website's and the iPhone's hidden archive row
      // (`labArchive: true`), told apart at commit by the signature the extract
      // gave it, so a receipt parked before this rule commits the same way.
      const fields: DocumentFields = d.type === 'pathology_report' && d.title === LAB_ARCHIVE_TITLE
        ? labArchiveFields(d.sourceFileName, d.date)
        : { documentType: d.type, title: d.title, documentDate: d.date, contentMd: '', metadata: {}, sourceFileName: d.sourceFileName };
      return documentRow({ ...fields, metadata: { ...fields.metadata, ...metadata } }, { id: crypto.randomUUID(), contentHash: d.contentHash, mimeType: d.mimeType, addedAt: now });
    });
  const base = { phase: 'committed' as const, route: payload.route, files: [], candidates: [], documents: [], unrecognized: [], remaining: [] };
  if (chosen.size === 0 && docs.length === 0) {
    return {
      status: 'ok',
      text: 'Nothing was selected, so nothing was written and the record is unchanged.',
      data: { ...base, next: 'Tell the user nothing was filed.', written: { measurements: 0, labValues: 0, corrections: 0, documents: 0 } },
    };
  }

  const applied = bulkAppendValues(file, rows, now);
  const pressure = applied.measurementRefusals.find((r) => r.message === PRESSURE_ORDER);
  if (pressure) {
    return {
      status: 'rejected',
      text: `The selection would leave the blood pressure on ${dayOf(rows[pressure.index].recordedAt)} with the top number (systolic) at or below the bottom number (diastolic). ` +
        'Nothing was written. Accept or replace both halves of that blood pressure, or neither.',
    };
  }
  if (applied.measurementRefusals.length) {
    return { status: 'rejected', text: 'A selected core measurement is invalid or outside the accepted range. Nothing was written. Extract again and review the values.' };
  }
  if (applied.skippedDuplicates > 0) throw new ToolContractError('import commit skipped a row its own slot check accepted');
  // A unit the catalogue does not know for that test is refused at the write
  // (US-21 phase 3). Said out loud, never dropped quietly: the user chose that
  // row, and a value that vanishes between the review and the record is the
  // failure this whole rule exists to prevent.
  const listed = (refused: typeof applied.refused) => refused.map((r) => `${oneLine(r.key)}: ${oneLine(r.message)}`).join('; ');
  // A refusal for the number (US-21 AC15) is the person's to settle: no offer of another unit.
  const unknownSpellings = applied.refused.filter((r) => !r.fault);
  const refusedNumbers = applied.refused.filter((r) => r.fault);
  const next = docs.length ? stampUpdatedAt({ ...applied.file, documents: [...applied.file.documents, ...docs] }, now) : applied.file;

  const written = {
    measurements: applied.saved.filter((r) => 'metricType' in r && !r.correctsId).length,
    labValues: applied.saved.filter((r) => 'metricName' in r && !r.correctsId).length,
    // Counted from what the write saved: a replacement it refused replaced nothing (US-21 AC15).
    corrections: applied.saved.filter((r) => r.correctsId).length,
    documents: docs.length,
  };
  const lines = [
    describe('Filed', applied.saved),
    ...(unknownSpellings.length ? [`Not filed — ${listed(unknownSpellings)}. Tell the user, and offer to add these with the unit the catalogue takes.`] : []),
    ...(refusedNumbers.length ? [`Not filed — ${listed(refusedNumbers)}.${refusedNumbers.some((r) => r.bound) ? ` ${ASK_NOT_RESEND}` : ''}`] : []),
    ...docs.map((d) => `Filed document “${oneLine(d.title)}” (${d.type}${d.date ? `, ${d.date}` : ''}) from ${oneLine(d.sourceFileName ?? '')}`),
    `${written.measurements + written.labValues} value(s) added, ${written.corrections} replaced, ${docs.length} document(s) filed. ` +
      'If another device wrote the same day at the same moment, the newer row wins and the other stays in history.',
  ].filter(Boolean);
  const changed = next !== file;
  return {
    status: 'ok',
    ...(changed ? { file: next } : null),
    text: lines.join('\n'),
    data: { ...base, next: 'Tell the user what was filed.', written },
  };
}

/**
 * How a tool that runs through the import surface reads its request (US-35,
 * US-36): declared per tool, like `cost`, so `runImport` compares no names.
 * `R` is the tool's parsed request; the definition list holds them untyped.
 */
export interface ImportTool<R = unknown> {
  /** Which refusal a malformed call gets, by the first failing field (AC13). */
  malformed(path: string): keyof typeof IMPORT_REFUSALS;
  /** True when the request names something to read — a source, which a commit may not ride beside. */
  hasSource(request: R): boolean;
  /** A source too incomplete to read, in words; null when it is whole. Checked before the record opens or anything is charged. */
  incomplete(request: R): string | null;
  /** What was read: the surface's own reading (the folder route) or the assistant's (`file_results`). */
  bundle(request: R, file: RoadmapFile, surface: ImportSurface, ctx: EditContext & { deadline: number }): ImportBundle | ImportRefusal | Promise<ImportBundle | ImportRefusal>;
}

export const importDocumentsTool: ImportTool<ImportRequest> = {
  malformed: (path) => (path === 'commit' ? 'commit' : 'arguments'),
  hasSource: (request) => Boolean(request.fileNames),
  incomplete: () => null,
  async bundle(request, file, surface, ctx) {
    // Reading files is the surface's; without a reader (the stdio server, AC11) the tool refuses in words.
    if (!surface.extract) return { refusal: IMPORT_HOSTED_ONLY };
    const bundle = await surface.extract(request, file, ctx.now, ctx.deadline);
    if ('refusal' in bundle) return bundle;
    // A list of pairs on the wire (ChatGPT's tool renderer drops a map-shaped
    // param, and the model then declares the field missing; live 2026-09-07), a map here.
    return { ...bundle, ...(request.fileDates ? { fileDates: Object.fromEntries(request.fileDates.map((d) => [d.file, d.date])) } : null) };
  },
};

export const fileResultsTool: ImportTool<FileResultsRequest> = {
  malformed: (path) => (path === 'commit' ? 'commit' : 'fileResults'),
  hasSource: (request) => Boolean(request.sourceFileName || request.values || request.document),
  incomplete: (request) => (request.sourceFileName && request.classification ? null : IMPORT_REFUSALS.fileResults),
  // The assistant read the file: nothing to download, nothing to extract (US-36 AC6).
  bundle: (request, file, _surface, ctx) => fileResultsBundle(request as FileResultsSource, file, ctx),
};
