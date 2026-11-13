/**
 * `import_documents` on the hosted server (US-35): the half of the import the
 * tool layer cannot do — read a file from somewhere, send it to the extraction
 * model, park the result where the commit can find it, and hand back a
 * receipt that names it. `file_results` (US-36) uses the same park-and-receipt
 * half and none of the reading: the assistant read the file.
 *
 * The tool layer (`mcp-tools.ts`) slots what comes back and applies the
 * user's selection; this module is the `ImportSurface` it is handed. Nothing
 * here keeps a byte between requests: the file is read into memory, extracted,
 * and dropped; the candidate payload lives in the USER's own folder as
 * `imports/pending-<id>.json` until its commit reads it and removes it (AC7).
 * The receipt the assistant carries is that file's id, a plain UUID. The file
 * holds the payload beside an HMAC over its id, its issue time, its hash, the
 * connection and the client, so a value the server did not extract cannot be
 * committed, and a receipt is good for one connection only.
 *
 * One fetch target, ever: the user's own folder through its `StorageAdapter`
 * (the ChatGPT file-host route was deleted 2026-09-10, US-36 AC12). Type is
 * decided by magic bytes, never by a declared mime type or a name.
 *
 * NOTHING HERE MAY LOG A FILE NAME, A URL, A VALUE OR EXTRACTED TEXT (AC9).
 */
import crypto from 'node:crypto';
import JSZip from 'jszip';
import * as Sentry from '@sentry/react-router';
import { extractOrClassify, ExtractionStopError, isNetworkOrTimeoutError, reportExtractionStop } from './anthropic.server';
import { type McpClientLabel } from './mcp-clients.server';
import { type AccessPayload, chargeWrites, connectionKey, importFiles, WRITE_COST } from './mcp-grants.server';
import { audienceFor, hash } from './mcp-seal.server';
import { openStep, signStep, UUID } from './mcp-step.server';
import { recordServerEvent } from './product-events.server';
import { machineFiles } from './rate-limiter';
import { deadlineSignal, StorageError, type StorageAdapter, type StoredFile } from '../../packages/health-core/src/adapter';
import { type ImportFileReason, IMPORT_LIMITS, IMPORT_REFUSALS } from '../../packages/health-core/src/import-hints';
import {
  type DocumentPromptMode,
  isImportableEntryName,
  type PageContent,
  type UnifiedExtractionResult,
  zipMemberName,
  fileNameLine,
  inflateCapped,
} from '../../packages/health-core/src/lab-extraction';
import { type ImportCommit, type ImportRequest, MAX_FILE_NAME_LENGTH, MAX_IMPORT_FILES_PER_CALL, RECEIPT_LIFETIME_SECONDS } from '../../packages/health-core/src/mcp-tool-contract';
import {
  type ExtractedFile,
  type ImportBundle,
  type ImportFileStatus,
  type ImportPayload,
  type ImportRefusal,
  type ImportSurface,
  importableFileName,
  isAlreadyImported,
} from '../../packages/health-core/src/mcp-import';
import { oneLine } from '../../packages/health-core/src/plan';
import { importFilesBucket, type McpImportRoute } from '../../packages/health-core/src/product-events';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

// ---------------------------------------------------------------------------
// Bounds (AC10)
// ---------------------------------------------------------------------------

/**
 * The whole call, record read to answer — an extract or a commit. ChatGPT
 * cuts a tool call off at 60 s (OpenAI staff, 2026-04), so 40 s leaves room
 * for transport and the receipt. `runImport` starts the clock and hands this
 * surface the deadline; every read, write, download and model call below is
 * ABORTED at it (AC5) — a `deadlineSignal` on each adapter call, and what is
 * left of it as the model call's timeout.
 */
export const MCP_IMPORT_BUDGET_MS = Number(process.env.MCP_IMPORT_BUDGET_MS || 40_000);
/** Time kept back at the end of an extract's budget to slot, park the payload and answer. */
const BUDGET_RESERVE_MS = 4_000;
/** Folder files one call attempts by default; the rest come back as `remaining`. */
export const IMPORT_FILES_PER_CALL = 5;
/** One PDF or image. Pages reach the model as images, so 5 MB of scans is already many pages. The hint table names the number. */
export const MAX_IMPORT_FILE_BYTES = IMPORT_LIMITS.fileMb * 1024 * 1024;
/** One ZIP, as downloaded. */
export const MAX_IMPORT_ZIP_BYTES = IMPORT_LIMITS.zipMb * 1024 * 1024;
/** Where a pending payload lives in the user's folder, and how long before the next import sweeps it. */
export const PENDING_FOLDER = 'imports';
// Twice a receipt's life: past that the receipt is certainly dead, so the file
// is residue and nothing can still be committed from it. A commit deletes its
// own file; the sweep only takes what an extract nobody confirmed left behind,
// and it runs on the next `stash`, which every route passes through.
const PENDING_STALE_MS = 2 * RECEIPT_LIFETIME_SECONDS * 1000;
const EXTRACT_CONCURRENCY = 3;
/** One model call, HTTP. Inside the budget by construction; a hung call fails, never waits. */
const EXTRACT_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Test seam — the model call
// ---------------------------------------------------------------------------

type Extractor = (pages: PageContent[], opts: { timeoutMs: number; httpAttempts: number; documentMode: DocumentPromptMode }) => Promise<UnifiedExtractionResult>;

let extract: Extractor = extractOrClassify;

export function setImportSeams(next: { extract?: Extractor } | null): void {
  extract = next?.extract ?? extractOrClassify;
}

// ---------------------------------------------------------------------------
// Bytes: what kind, and what is inside
// ---------------------------------------------------------------------------

export type SniffedType = 'application/pdf' | 'application/zip' | 'image/jpeg' | 'image/png';

/** The type the bytes say they are. A declared mime type or a name is never consulted (AC4). */
export function sniff(bytes: Uint8Array): SniffedType | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return 'application/pdf';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'application/zip';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

/** A file's name as `sourceFileName`: printable, bounded; a label, never a path anything is read from. Empty stays empty — a made-up name would dedup every nameless file against the first. */
function cleanName(name: string): string {
  return oneLine(name).slice(0, MAX_FILE_NAME_LENGTH);
}

export interface ZipEntryBytes {
  name: string;
  bytes: Uint8Array;
  mimeType: SniffedType;
}

/** Skipped members a ZIP names one by one; past these, one count per reason (AC5b). */
const MAX_SKIPPED_ROWS = 20;
/** Members a ZIP may list at all: parsing the directory costs CPU per entry, before any inflate (AC5b). */
export const MAX_ZIP_ENTRIES = IMPORT_LIMITS.zipEntries;

/**
 * Why JSZip must not parse these bytes, or null (AC5b), in one pass of plain
 * byte compares (a native search crawls on bytes like `PPPP…`). Over
 * `MAX_ZIP_ENTRIES` central-directory signatures is `too_many`: JSZip parses
 * every record it finds, whatever count the directory declares, and each starts
 * with the signature, so the count can run high but never low. An end record
 * that sends JSZip to its ZIP64 reader is `unreadable`: that reader's loop over
 * the record's extra data never advances, and crafted bytes keep it spinning
 * until the reader runs out. The check is JSZip's own, on the record it uses
 * (the last), so a ZIP64 signature inside compressed data refuses nothing.
 */
export function zipRefusal(bytes: Uint8Array): 'too_many' | 'unreadable' | null {
  let entries = 0;
  let end = -1;
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0x50 || bytes[i + 1] !== 0x4b) continue;
    if (bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02 && ++entries > MAX_ZIP_ENTRIES) return 'too_many';
    if (bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) end = i;
  }
  if (end < 0 || end + 22 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + end, 22);
  const zip64 = [4, 6, 8, 10].some((at) => view.getUint16(at, true) === 0xffff) || [12, 16].some((at) => view.getUint32(at, true) === 0xffffffff);
  return zip64 ? 'unreadable' : null;
}

/**
 * Open a ZIP under the caps (AC5): it opens at most `MAX_IMPORT_FILES_PER_CALL`
 * importable entries, kept or skipped (AC5a), each at most `MAX_IMPORT_FILE_BYTES` INFLATED — the
 * bytes are counted as they inflate and the stream is stopped past the cap,
 * so a bomb declaring 1 MB never fills memory. `budget` is the CALL's: every
 * ZIP in one call draws on it, so a call inflates at most that many members
 * in all (AC5b). A ZIP the budget cut short before its own cap is `deferred`,
 * and the caller hands it back in `remaining`. Entries are taken by position;
 * a name is a label (the entry's path inside the ZIP), never a path anything
 * is read from. Nested zips and anything the junk filter drops are skipped by name.
 * A name is one line but NOT cut: `zipMemberName` does the only cut, from the
 * whole path, as the website's upload does, so both file it under one name.
 * Past `MAX_SKIPPED_ROWS` skipped members are counted by reason in `more`, not named.
 */
export async function unzip(bytes: Uint8Array, budget = { left: MAX_IMPORT_FILES_PER_CALL }): Promise<{
  entries: ZipEntryBytes[];
  skipped: Array<{ name: string; reason: string }>;
  more: Array<{ reason: string; count: number }>;
  deferred: boolean;
}> {
  const zip = await JSZip.loadAsync(bytes);
  const entries: ZipEntryBytes[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const more: Array<{ reason: string; count: number }> = [];
  const skip = (name: string, reason: string) => {
    if (skipped.length < MAX_SKIPPED_ROWS) return void skipped.push({ name, reason });
    const counted = more.find((m) => m.reason === reason);
    if (counted) counted.count++;
    else more.push({ reason, count: 1 });
  };
  const listed: Array<{ name: string; entry: JSZip.JSZipObject }> = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    listed.push({ name: fileNameLine(relativePath), entry });
  });
  // Every member opened counts, kept or skipped, so oversized or unreadable
  // members cannot keep it inflating (US-35 AC5a).
  let opened = 0;
  let deferred = false;
  for (const { name, entry } of listed) {
    if (!isImportableEntryName(name)) {
      if (name.toLowerCase().endsWith('.zip')) skip(name, 'nested_zip');
      continue;
    }
    if (opened >= MAX_IMPORT_FILES_PER_CALL || budget.left <= 0) {
      if (opened < MAX_IMPORT_FILES_PER_CALL) deferred = true;
      skip(name, 'too_many');
      continue;
    }
    opened++;
    budget.left--;
    const inflated = await inflateCapped(entry, MAX_IMPORT_FILE_BYTES);
    if (!inflated) {
      skip(name, 'too_large');
      continue;
    }
    const mimeType = sniff(inflated);
    if (!mimeType || mimeType === 'application/zip') {
      skip(name, mimeType ? 'nested_zip' : 'unsupported');
      continue;
    }
    entries.push({ name, bytes: inflated, mimeType });
  }
  return { entries, skipped, more, deferred };
}

function sha256Hex(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The record's own document key for these bytes — `FileDocument.contentHash`'s shape. */
function contentHashOf(bytes: Uint8Array): string {
  return `sha256-${sha256Hex(bytes)}`;
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

/**
 * A pending file that would not delete, as a COUNT: one Sentry title, no file
 * name, no path, no error text (AC9). What it costs is a file that lives until
 * the sweep takes it, so the number is the whole signal.
 */
function countCleanupFailure(): void {
  Sentry.captureMessage('mcp_import: pending file not deleted', { level: 'warning', tags: { feature: 'mcp_import' } });
}

/** A park the provider refused, by HTTP status and error class only: never the message, which names the file (AC9, AC18). */
function countParkFailure(error: unknown): false {
  const errorClass = error instanceof Error && ['StorageError', 'TimeoutError', 'AbortError'].includes(error.name) ? error.name : 'other';
  const httpStatus = error instanceof StorageError ? error.status : undefined;
  Sentry.captureMessage('mcp_import: candidates not parked', { level: 'warning', tags: { feature: 'mcp_import', errorClass, ...(httpStatus ? { httpStatus } : null) } });
  return false;
}

function pendingName(id: string): string {
  return `${PENDING_FOLDER}/pending-${id}.json`;
}
/** The sweep's own files, by name: never another file the user keeps in the folder. */
const PENDING_NAME = /(^|\/)pending-[^/]+\.json$/;

/** A pending file as `stash` writes it (US-35 AC7): the payload, its issue time in epoch seconds, and the MAC over both. */
interface PendingFile {
  v: 2;
  payload: ImportPayload;
  issued: number;
  mac: string;
}

const RECEIPT_INVALID = 'That receipt is not valid for this connection. Nothing was written. Extract again and show the user the fresh candidates.';
const PENDING_UNREADABLE = 'The pending import is not readable. Nothing was written. Extract again.';

/** AC3, per client: the way that works for THIS assistant comes first. */
function driveRefusal(client: McpClientLabel): string {
  const why = 'This record lives in Google Drive, and the permission the connector holds cannot see files dropped into the folder. ';
  return client === 'chatgpt'
    ? why + 'Drag the file into this chat from a desktop browser instead, or upload it on the website, which reads the PDF in your browser. Nothing was read.'
    : why + 'Upload it on the website, which reads the PDF in your browser and files it into the same record. Nothing was read.';
}

/** Why one file could not be read, as a closed word the assistant can act on. */
function failureReason(error: unknown): ImportFileReason {
  if (isNetworkOrTimeoutError(error)) return 'time';
  if (error instanceof Error && /status 400/.test(error.message)) return 'too_large';
  if (error instanceof ExtractionStopError) return error.code;
  return 'unreadable';
}

function fail(name: string, status: ImportFileStatus, reason: string): ExtractedFile {
  return { name, status, reason };
}

/** One file to read: its bytes come on demand, so a download overlaps another file's model call. */
interface Unit {
  name: string;
  size?: number;
  fetch(): Promise<Uint8Array>;
}

export interface HostedImporterOptions {
  token: AccessPayload;
  adapter: StorageAdapter;
  client: McpClientLabel;
  maxCorrectionAgeDays: number;
}

/** The `ImportSurface` for one hosted call. Built per call, like the adapter; holds nothing after. */
export function hostedImporter(options: HostedImporterOptions): ImportSurface {
  const { token, adapter, client } = options;
  const connection = connectionKey(token);
  const audience = audienceFor(token.clientId);
  const conn = hash(connection);
  /** What the MAC covers between its issue time and the connection; the step module adds the rest. */
  const macFields = (id: string, payload: unknown) => [id, sha256Hex(JSON.stringify(payload))];

  async function sweepStale(nowMs: number, signal: AbortSignal): Promise<void> {
    if (!adapter.list || !adapter.remove) return;
    try {
      for (const stale of await adapter.list(PENDING_FOLDER, signal)) {
        if (!PENDING_NAME.test(stale.name)) continue;
        const at = Date.parse(stale.modified);
        if (Number.isFinite(at) && nowMs - at > PENDING_STALE_MS) await adapter.remove(stale.name, signal);
      }
    } catch {
      // A sweep that fails costs a stale file, not the import.
      countCleanupFailure();
    }
  }

  function count(route: McpImportRoute, phase: 'extract' | 'commit', files: number, fromNudge = false): void {
    void recordServerEvent('mcp_import', { route, phase, files: importFilesBucket(files), ...(fromNudge ? { fromNudge: true } : null) });
  }

  return {
    maxCorrectionAgeDays: options.maxCorrectionAgeDays,
    client,
    budgetMs: MCP_IMPORT_BUDGET_MS,

    async extract(request: ImportRequest, file: RoadmapFile, now: string, deadline: number): Promise<ImportBundle | ImportRefusal> {
      // Every listing, download and model call ends by here; the reserve is for slotting and the stash.
      const ioDeadline = deadline - BUDGET_RESERVE_MS;
      const signal = deadlineSignal(ioDeadline);
      const units: Unit[] = [];
      const remaining: string[] = [];

      if (token.provider === 'google' || !adapter.list) {
        count('drive_refused', 'extract', 0);
        return { refusal: driveRefusal(client) };
      }
      let listed: StoredFile[];
      try {
        listed = await adapter.list('', signal);
      } catch (error) {
        if (!signal.aborted) throw error;
        return { refusal: 'The folder did not list in time, so nothing was read. Try once more.' };
      }
      // The nudge's own rule for what a folder file is, so a name it offered is one `fileNames` matches (US-37).
      const listing = listed
        .flatMap((entry) => { const name = importableFileName(entry.name); return name ? [{ ...entry, name }] : []; })
        .sort((a, b) => a.name.localeCompare(b.name));
      let chosen = listing;
      if (request.fileNames) {
        chosen = [];
        for (const wanted of request.fileNames) {
          const found = listing.find((entry) => entry.name === wanted);
          if (!found) {
            return { refusal: `“${cleanName(wanted)}” is not an importable file in the folder root. Nothing was read. The folder holds: ${listing.map((e) => e.name).join(', ') || 'no importable files'}.` };
          }
          if (!chosen.includes(found)) chosen.push(found);
        }
      }
      if (chosen.length === 0) return { refusal: IMPORT_REFUSALS.emptyFolder };
      for (const entry of chosen.slice(0, IMPORT_FILES_PER_CALL)) {
        // By the listing's own ref, never by a name an assistant supplied.
        units.push({ name: entry.name, size: entry.size, fetch: async () => new Uint8Array(await (await adapter.readDocument(entry.ref, signal)).arrayBuffer()) });
      }
      remaining.push(...chosen.slice(IMPORT_FILES_PER_CALL).map((entry) => entry.name));

      // Off the critical path: it overlaps the reads below and is awaited at the end.

      /** One file through the model, inside what is left of the budget. */
      const extractOne = async (name: string, bytes: Uint8Array, mimeType: SniffedType): Promise<ExtractedFile> => {
        const left = ioDeadline - Date.now();
        if (left <= 0) return fail(name, 'skipped', 'time');
        const contentHash = contentHashOf(bytes);
        const base = { name, contentHash, mimeType };
        if (isAlreadyImported(file, name, contentHash)) return { ...base, status: 'already_imported' };
        // Three counters, charged in turn; a refusal by a later one hands the earlier charge back, so a file the
        // model never saw costs nothing on any of them (AC10).
        const refundFile = () => { machineFiles.refund('machine', 1); importFiles.refund(connection, 1); };
        if (!importFiles.take(connection, 1)) return { ...base, status: 'failed', reason: 'quota' };
        if (!machineFiles.take('machine', 1)) { importFiles.refund(connection, 1); return { ...base, status: 'failed', reason: 'quota' }; }
        if (chargeWrites(connection, WRITE_COST.add)) { refundFile(); return { ...base, status: 'failed', reason: 'allowance' }; }
        const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
        const pages: PageContent[] = mimeType === 'application/pdf' ? [{ type: 'pdf', content }] : [{ type: 'image', content, mimeType }];
        try {
          // One HTTP attempt per call, inside what is left: a malformed answer's one re-send shares the deadline.
          // Metadata only for a letter: the connector files no text, so none is asked for.
          return { ...base, status: 'extracted', result: await extract(pages, { timeoutMs: Math.min(EXTRACT_TIMEOUT_MS, left), httpAttempts: 1, documentMode: 'metadata' }) };
        } catch (error) {
          const reason = failureReason(error);
          if (reason === 'time') {
            // The model never answered, so the file was not read: its day's charge comes back.
            refundFile();
          } else if (error instanceof ExtractionStopError) {
            // Declined or cut off: the code and category, as on the website (US-15 AC34).
            reportExtractionStop(error.code, error.refusalCategory, 'connector');
          } else if (reason === 'unreadable') {
            // The error CLASS and the file kind, nothing else (AC9): a parse
            // error's message quotes the model's output, which is document text.
            const scrubbed = new Error('import_documents: extraction failed');
            scrubbed.name = error instanceof Error ? error.name : 'unknown';
            Sentry.captureException(scrubbed, { tags: { feature: 'mcp_import', errorName: scrubbed.name }, extra: { kind: mimeType } });
          }
          return { ...base, status: 'failed', reason };
        }
      };

      // Bytes, then type, then contents. A queue of three runners: a unit's
      // download overlaps another's model call, and a ZIP's entries join the
      // queue so idle runners share them. Results keep the listing's order.
      const results: Array<ExtractedFile | ExtractedFile[]> = [];
      /** ZIP members this call may still inflate, across every ZIP it opens (AC5b). */
      const zipBudget = { left: MAX_IMPORT_FILES_PER_CALL };
      // ZIPs open one at a time: two sharing the budget side by side could each be cut short, and
      // asking again for both would open the same members again. Taken in turn, the first ZIP of
      // any call gets the whole budget, so asking again for `remaining` always finishes one.
      let zipTurn: Promise<unknown> = Promise.resolve();
      const queue: Array<() => Promise<void>> = units.map((unit, i) => async () => {
        if (signal.aborted) {
          remaining.push(unit.name);
          return;
        }
        const isZip = unit.name.toLowerCase().endsWith('.zip');
        if (unit.size !== undefined && unit.size > (isZip ? MAX_IMPORT_ZIP_BYTES : MAX_IMPORT_FILE_BYTES)) {
          results[i] = fail(unit.name, 'failed', 'too_large');
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = await unit.fetch();
        } catch (error) {
          // A token the provider now refuses is not an unreadable file: the
          // route's own catch turns it into the reconnect hint.
          if (error instanceof StorageError && (error.status === 401 || error.status === 403)) throw error;
          results[i] = signal.aborted ? fail(unit.name, 'skipped', 'time') : fail(unit.name, 'failed', 'unreadable');
          return;
        }
        const mimeType = sniff(bytes);
        if (mimeType === 'application/zip') {
          if (bytes.length > MAX_IMPORT_ZIP_BYTES) {
            results[i] = fail(unit.name, 'failed', 'too_large');
            return;
          }
          const refused = zipRefusal(bytes);
          if (refused) {
            results[i] = fail(unit.name, 'failed', refused);
            return;
          }
          let opened: Awaited<ReturnType<typeof unzip>> | 'time' | 'spent';
          try {
            // A ZIP whose turn comes after the deadline or with the budget spent is not parsed at all;
            // asked for again alone, it gets the whole budget.
            const turn = zipTurn.then(async (): Promise<typeof opened> => (signal.aborted ? 'time' : zipBudget.left <= 0 ? 'spent' : unzip(bytes, zipBudget)));
            zipTurn = turn.catch(() => undefined);
            opened = await turn;
          } catch {
            results[i] = fail(unit.name, 'failed', 'unreadable');
            return;
          }
          if (opened === 'time') {
            results[i] = fail(unit.name, 'skipped', 'time');
            return;
          }
          if (opened === 'spent') {
            results[i] = fail(unit.name, 'skipped', 'too_many');
            if (!remaining.includes(unit.name)) remaining.push(unit.name);
            return;
          }
          // A member is named `zip/member`, as the website's upload names it (US-12 AC9): unique in a
          // call, and one `sourceFileName` for the same member on both surfaces.
          // Each carries the ZIP's own name, the one a later call can ask for (US-35 AC7a).
          const member = (path: string) => zipMemberName(unit.name, path);
          const inZip = (read: ExtractedFile): ExtractedFile => ({ ...read, zip: unit.name });
          const inside: ExtractedFile[] = new Array<ExtractedFile>(opened.entries.length);
          results[i] = inside;
          opened.entries.forEach((entry, k) => queue.push(async () => { inside[k] = inZip(await extractOne(member(entry.name), entry.bytes, entry.mimeType)); }));
          for (const skip of opened.skipped) inside.push(inZip(fail(member(skip.name), 'skipped', skip.reason)));
          for (const { reason, count } of opened.more) inside.push(inZip(fail(member(`(and ${count} more)`), 'skipped', reason)));
          if (opened.deferred && !remaining.includes(unit.name)) remaining.push(unit.name);
          return;
        }
        if (!mimeType) {
          results[i] = fail(unit.name, 'failed', 'unsupported');
          return;
        }
        if (bytes.length > MAX_IMPORT_FILE_BYTES) {
          results[i] = fail(unit.name, 'failed', 'too_large');
          return;
        }
        results[i] = await extractOne(unit.name, bytes, mimeType);
      });
      const runner = async () => {
        while (queue.length) await queue.shift()!();
      };
      await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, queue.length) }, runner));

      const files = results.flat();
      // What time cut off is `remaining`, and the assistant is told (AC2): it names those files in `fileNames`.
      // A ZIP's entry is not in the folder root, so the ZIP's own name stands for it (filed entries are
      // skipped by hash on the re-read).
      results.forEach((r, i) => {
        for (const f of [r].flat()) {
          if (f.status !== 'skipped' || f.reason !== 'time') continue;
          const name = Array.isArray(r) ? units[i].name : f.name;
          if (!remaining.includes(name)) remaining.push(name);
        }
      });
      count('dropbox', 'extract', files.filter((f) => f.contentHash).length, request.fromNudge === true);
      return { route: 'dropbox', files, remaining };
    },

    async stash(payload: ImportPayload, deadline: number) {
      // The assistant route has no extract of its own to count (US-36 usage signal): every propose that read something parks here.
      if (payload.route === 'assistant') count('assistant', 'extract', 1);
      const signal = deadlineSignal(deadline);
      // Every route parks here — the Dropbox folder, a file the assistant read,
      // Drive — so this is the one place a sweep reaches every user. It was in
      // `extract`, which `file_results` and every Drive user never call, so
      // their abandoned pending files were never swept at all.
      // The receipt is the payload's own id; the MAC that makes it ours lives in the file it names (AC7).
      const { mac, issued } = signStep('import', macFields(payload.id, payload), conn, audience, Date.parse(payload.createdAt));
      const pending: PendingFile = { v: 2, payload, issued, mac };
      // Park first, sweep after: deletes racing the park drew a Dropbox 429 that refused it (AC18).
      // A refused park skips the sweep: the provider just pushed back, and the next stash sweeps.
      const parked = await adapter.write(pendingName(payload.id), pending, null, signal).then(() => true, countParkFailure);
      if (!parked) {
        return { refusal: 'The candidates could not be parked in the user’s folder, so there is nothing to commit. Try the import again.' };
      }
      await sweepStale(Date.parse(payload.createdAt), signal);
      return { receipt: payload.id, expiresAt: new Date((issued + RECEIPT_LIFETIME_SECONDS) * 1000).toISOString() };
    },

    async open(commit: ImportCommit, _file: RoadmapFile, now: string, deadline: number): Promise<ImportPayload | ImportRefusal> {
      // Verified BEFORE anything is charged, in this order: a forged receipt costs nothing and deletes nothing.
      // The user's quoted approval first (ChatGPT's safety layer judges the call, 2026-10-07): read for
      // presence only, never stored or logged, and its absence reads nothing and keeps the pending file.
      if (!commit.approval?.trim()) {
        return { refusal: 'If the user has not yet answered in their own words, show them the candidates and end your turn. Otherwise commit again with the same receipt and approval set to the user’s own words approving these candidates, quoted from their message. Nothing was written.' };
      }
      // Only a lowercase UUID may form a path.
      const id = commit.receipt;
      if (!UUID.test(id)) return { refusal: RECEIPT_INVALID };
      const signal = deadlineSignal(deadline);
      let body: unknown;
      try {
        ({ body } = await adapter.read(pendingName(id), signal));
      } catch (error) {
        if (!signal.aborted) throw error;
        return { refusal: 'The pending import did not read in time. Nothing was written. Try the commit once more.' };
      }
      if (body == null) {
        return { refusal: 'That receipt names no pending import: it was committed, discarded or mistyped. Nothing was written. Extract again if the user still wants it.' };
      }
      // A pending file from before 2026-10-07 has no `v`: not readable, and the sweep takes it by name.
      const pending = body as Partial<PendingFile>;
      if (pending.v !== 2 || typeof pending.payload !== 'object' || pending.payload === null || !Number.isSafeInteger(pending.issued) || typeof pending.mac !== 'string') {
        return { refusal: PENDING_UNREADABLE };
      }
      // The MAC binds the id and the payload's hash, and only `stash` signs, so a payload that opens is one we wrote.
      // A file too deep to serialise was never ours: refused in words, never thrown.
      let fields: string[];
      try {
        fields = macFields(id, pending.payload);
      } catch {
        return { refusal: PENDING_UNREADABLE };
      }
      const { status } = openStep('import', fields, conn, pending.mac, pending.issued as number, audience, Date.parse(now));
      if (status === 'expired') {
        return { refusal: `That receipt has expired: a pending import waits ${RECEIPT_LIFETIME_SECONDS / 60} minutes. Nothing was written. Extract again and show the user the fresh candidates.` };
      }
      if (status !== 'ok') return { refusal: RECEIPT_INVALID };
      const payload = pending.payload as ImportPayload;
      // Ids checked before the charge: a replace list of invented ids must not spend the hour.
      const ids = new Set(payload.candidates.map((c) => c.id));
      const unknown = [...commit.accept, ...commit.replace].find((id) => !ids.has(id));
      if (unknown !== undefined) return { refusal: `${oneLine(unknown)} is not a candidate in this receipt. Nothing was written.` };
      const refusal = chargeWrites(connection, WRITE_COST.add + WRITE_COST.correct * commit.replace.length);
      if (refusal) return { refusal };
      count(payload.route, 'commit', new Set([...payload.candidates, ...payload.documents].map((c) => c.sourceFileName)).size);
      return payload;
    },

    async discard(payload: ImportPayload, deadline: number): Promise<void> {
      try {
        await adapter.remove?.(pendingName(payload.id), deadlineSignal(deadline));
      } catch {
        // Best effort: the commit already answered. A pending file that outlives
        // it is swept on the next extract.
        countCleanupFailure();
      }
    },
  };
}
