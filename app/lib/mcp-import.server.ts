/**
 * `import_documents` on the hosted server (US-35): the half of the import the
 * tool layer cannot do — read a file from somewhere, send it to the extraction
 * model, park the result where the commit can find it, and hand back a
 * receipt that names it.
 *
 * The tool layer (`mcp-tools.ts`) slots what comes back and applies the
 * user's selection; this module is the `ImportSurface` it is handed. Nothing
 * here keeps a byte between requests: the file is read into memory, extracted,
 * and dropped; the candidate payload lives in the USER's own folder as
 * `imports/pending-<id>.json` until its commit reads it and removes it (AC7).
 * The receipt the assistant carries is small — an id, an expiry, the
 * connection it belongs to and the payload's hash — sealed like every other
 * credential this server hands out, so a value the server did not extract
 * cannot be committed.
 *
 * Two fetch targets, ever: the user's own folder through its `StorageAdapter`,
 * and OpenAI's file host for a file dragged into ChatGPT, under a closed
 * allow-list (AC4). Type is decided by magic bytes, never by a declared mime
 * type or a name.
 *
 * NOTHING HERE MAY LOG A FILE NAME, A URL, A VALUE OR EXTRACTED TEXT (AC9).
 */
import crypto from 'node:crypto';
import JSZip from 'jszip';
import * as Sentry from '@sentry/react-router';
import { extractOrClassify, isNetworkOrTimeoutError } from './anthropic.server';
import { type McpClientLabel, readCappedBytes } from './mcp-clients.server';
import { resourceUrl } from './mcp-config.server';
import { type AccessPayload, chargeWrites, connectionKey, importFiles, nowSeconds, WRITE_COST } from './mcp-grants.server';
import { hash, seal, unseal } from './mcp-seal.server';
import { recordServerEvent } from './product-events.server';
import { DAY_MS, machineFiles } from './rate-limiter';
import { deadlineSignal, StorageError, type StorageAdapter } from '../../packages/health-core/src/adapter';
import { IMPORT_LIMITS, IMPORT_REFUSALS } from '../../packages/health-core/src/import-hints';
import {
  type DocumentPromptMode,
  IMPORTABLE_EXTENSIONS,
  isImportableEntryName,
  type PageContent,
  type UnifiedExtractionResult,
} from '../../packages/health-core/src/lab-extraction';
import {
  type ExtractedFile,
  type ImportBundle,
  type ImportCommit,
  type ImportFileStatus,
  type ImportPayload,
  type ImportRefusal,
  type ImportRequest,
  type ImportSurface,
  isAlreadyImported,
  MAX_IMPORT_FILES_PER_CALL,
} from '../../packages/health-core/src/mcp-tools';
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
/** One ZIP, as downloaded — and the most one ChatGPT file may be. */
export const MAX_IMPORT_ZIP_BYTES = IMPORT_LIMITS.zipMb * 1024 * 1024;
export const CHATGPT_FETCH_TIMEOUT_MS = 10_000;
export const RECEIPT_LIFETIME_SECONDS = 60 * 60;
/** Where a pending payload lives in the user's folder, and how long before an extract sweeps it. */
export const PENDING_FOLDER = 'imports';
const PENDING_STALE_MS = DAY_MS;
const EXTRACT_CONCURRENCY = 3;
/** One model call, HTTP. Inside the budget by construction; a hung call fails, never waits. */
const EXTRACT_TIMEOUT_MS = 20_000;

/**
 * OpenAI's file hosts, from field reports — the docs name none. Two forms so
 * far: `files.oaiusercontent.com`, and the region-suffixed Azure blob store
 * ChatGPT hands out for a dragged-in file (`oaisdmntprnznorth.blob.core.windows.net`,
 * seen live 2026-09-05). Honestly: the blob form is a NAMESPACE, not a closed
 * list — any Azure storage account named `oaisdmntprn…` (3–24 lowercase
 * letters and digits; Azure allows no hyphen, so none is matched) would pass.
 * What bounds the route is not the host: it is the per-connection file quota
 * and that fetched bytes only ever become candidates the same user must
 * confirm. The match is anchored at both ends so a prefix, a suffix or a
 * look-alike domain fails; a refused host shows up as a `chatgpt_refused`
 * count and a hostname warning, and `CHATGPT_FILE_HOSTS` adds exact hosts
 * without a deploy.
 */
const CHATGPT_BLOB_HOST = /^oaisdmntprn[a-z0-9]*\.blob\.core\.windows\.net$/;
export function isChatgptFileHost(hostname: string): boolean {
  if (hostname === 'files.oaiusercontent.com' || CHATGPT_BLOB_HOST.test(hostname)) return true;
  return (process.env.CHATGPT_FILE_HOSTS || '').split(',').map((h) => h.trim()).includes(hostname);
}

// ---------------------------------------------------------------------------
// Test seam — the model call
// ---------------------------------------------------------------------------

type Extractor = (pages: PageContent[], opts: { timeoutMs: number; attempts: number; httpAttempts: number; documentMode: DocumentPromptMode }) => Promise<UnifiedExtractionResult>;

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

/** A file's own name as `sourceFileName`: printable, bounded, never a path. Empty stays empty — a made-up name would dedup every nameless file against the first. */
function cleanName(name: string): string {
  return oneLine(name).slice(0, 255);
}

const EXTENSION: Record<SniffedType, string> = { 'application/pdf': '.pdf', 'application/zip': '.zip', 'image/jpeg': '.jpg', 'image/png': '.png' };

/** A name for bytes that came without one (a ChatGPT drag with no `file_name`): from the bytes, so two different files never share it. */
function nameFromBytes(bytes: Uint8Array, type: SniffedType | null): string {
  return `file-${sha256Hex(bytes).slice(0, 8)}${type ? EXTENSION[type] : ''}`;
}

export interface ZipEntryBytes {
  name: string;
  bytes: Uint8Array;
  mimeType: SniffedType;
}

/**
 * Open a ZIP under the caps (AC5): at most `MAX_IMPORT_FILES_PER_CALL`
 * importable entries, each at most `MAX_IMPORT_FILE_BYTES` INFLATED — the
 * bytes are counted as they inflate and the stream is stopped past the cap,
 * so a bomb declaring 1 MB never fills memory. Entries are taken by position;
 * a name is a label, never a path. Nested zips and anything the junk filter
 * drops are skipped by name.
 */
export async function unzip(bytes: Uint8Array): Promise<{ entries: ZipEntryBytes[]; skipped: Array<{ name: string; reason: string }> }> {
  const zip = await JSZip.loadAsync(bytes);
  const entries: ZipEntryBytes[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const listed: Array<{ name: string; entry: JSZip.JSZipObject }> = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    listed.push({ name: cleanName(relativePath), entry });
  });
  for (const { name, entry } of listed) {
    if (!isImportableEntryName(name)) {
      if (name.toLowerCase().endsWith('.zip')) skipped.push({ name, reason: 'nested_zip' });
      continue;
    }
    if (entries.length >= MAX_IMPORT_FILES_PER_CALL) {
      skipped.push({ name, reason: 'too_many' });
      continue;
    }
    const inflated = await inflateCapped(entry, MAX_IMPORT_FILE_BYTES);
    if (!inflated) {
      skipped.push({ name, reason: 'too_large' });
      continue;
    }
    const mimeType = sniff(inflated);
    if (!mimeType || mimeType === 'application/zip') {
      skipped.push({ name, reason: mimeType ? 'nested_zip' : 'unsupported' });
      continue;
    }
    entries.push({ name, bytes: inflated, mimeType });
  }
  return { entries, skipped };
}

/** JSZip's streaming reader, which its typings leave undeclared. */
interface EntryStream {
  on(event: 'data', handler: (chunk: Uint8Array) => void): EntryStream;
  on(event: 'end', handler: () => void): EntryStream;
  on(event: 'error', handler: (error: Error) => void): EntryStream;
  pause(): EntryStream;
  resume(): EntryStream;
}

/** Inflate one entry, counting bytes; null once the count passes `cap`. */
function inflateCapped(entry: JSZip.JSZipObject, cap: number): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let stopped = false;
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): EntryStream }).internalStream('uint8array');
    stream.on('data', (chunk: Uint8Array) => {
      if (stopped) return;
      size += chunk.byteLength;
      if (size > cap) {
        stopped = true;
        stream.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (error: Error) => (stopped ? undefined : reject(error)));
    stream.on('end', () => (stopped ? undefined : resolve(Buffer.concat(chunks))));
    stream.resume();
  });
}

function sha256Hex(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The record's own document key for these bytes — `FileDocument.contentHash`'s shape. */
function contentHashOf(bytes: Uint8Array): string {
  return `sha256-${sha256Hex(bytes)}`;
}

// ---------------------------------------------------------------------------
// The ChatGPT file route (AC4)
// ---------------------------------------------------------------------------

/**
 * Fetch the file ChatGPT described. `https:` only, host on the allow-list,
 * no redirects, ten seconds, capped bytes. The URL is never logged; a refused
 * host is warned by hostname only, which is how a second legitimate host
 * would ever be learned.
 */
export async function fetchChatgptFile(downloadUrl: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array } | ImportRefusal> {
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    return { refusal: 'That file reference is not a URL this server can fetch. Drag the file in from a browser, or put it in the connected folder. Nothing was read.' };
  }
  if (url.protocol !== 'https:' || !isChatgptFileHost(url.hostname)) {
    console.warn('import: file host refused', url.hostname);
    return { refusal: 'That file is not on a host this server will fetch from. Drag the file in from a browser, or put it in the connected folder. Nothing was read.' };
  }
  try {
    const timeout = AbortSignal.timeout(CHATGPT_FETCH_TIMEOUT_MS);
    const res = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) return { refusal: `The file host answered ${res.status}, so the file could not be read. Ask the user to drag it in again.` };
    return { bytes: await readCappedBytes(res, MAX_IMPORT_ZIP_BYTES) };
  } catch (error) {
    if (error instanceof Error && error.message === 'body too large') {
      return { refusal: `That file is larger than ${MAX_IMPORT_ZIP_BYTES / (1024 * 1024)} MB, so it was not read. Split it, or put smaller files in the connected folder.` };
    }
    return { refusal: 'The file host did not answer in time, so the file could not be read. Ask the user to drag it in again.' };
  }
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

/** What a receipt names (AC7). Sealed under `'import'`, bound to the client and resource as every blob is. */
interface ReceiptClaims {
  id: string;
  exp: number;
  /** The connection hash, so a receipt cannot be committed over another connection to the same client. */
  conn: string;
  sha256: string;
}

function pendingName(id: string): string {
  return `${PENDING_FOLDER}/pending-${id}.json`;
}
/** The sweep's own files, by name: never another file the user keeps in the folder. */
const PENDING_NAME = /(^|\/)pending-[^/]+\.json$/;

/** A `crypto.randomUUID()` and nothing else — the only id that may name a pending file. (`route-helpers`' `isValidUuid` sits behind the Shopify session store, which this layer must not load.) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** AC3, per client: the way that works for THIS assistant comes first. */
function driveRefusal(client: McpClientLabel): string {
  const why = 'This record lives in Google Drive, and the permission the connector holds cannot see files dropped into the folder. ';
  return client === 'chatgpt'
    ? why + 'Drag the file into this chat from a desktop browser instead, or upload it on the website, which reads the PDF in your browser. Nothing was read.'
    : why + 'Upload it on the website, which reads the PDF in your browser and files it into the same record. Nothing was read.';
}

/** Why one file could not be read, as a closed word the assistant can act on. */
function failureReason(error: unknown): string {
  if (isNetworkOrTimeoutError(error)) return 'time';
  if (error instanceof Error && /status 400/.test(error.message)) return 'too_large';
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
  const connection = connectionKey(token.rt);
  const audience = { clientId: token.clientId, resource: resourceUrl() };

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
    }
  }

  function count(route: McpImportRoute, phase: 'extract' | 'commit', files: number): void {
    void recordServerEvent('mcp_import', { route, phase, files: importFilesBucket(files) });
  }

  return {
    maxCorrectionAgeDays: options.maxCorrectionAgeDays,
    budgetMs: MCP_IMPORT_BUDGET_MS,

    async extract(request: ImportRequest, file: RoadmapFile, now: string, deadline: number): Promise<ImportBundle | ImportRefusal> {
      const started = Date.now();
      // Every listing, download and model call ends by here; the reserve is for slotting and the stash.
      const ioDeadline = deadline - BUDGET_RESERVE_MS;
      const signal = deadlineSignal(ioDeadline);
      let route: McpImportRoute;
      const units: Unit[] = [];
      const remaining: string[] = [];

      if (request.file) {
        route = 'chatgpt_file';
        const fetched = await fetchChatgptFile(request.file.download_url, signal);
        if ('refusal' in fetched) {
          // A drag that was not read is still a drag: counted, so the route's demand is visible.
          count('chatgpt_refused', 'extract', 0);
          return fetched;
        }
        units.push({ name: cleanName(request.file.file_name ?? '') || nameFromBytes(fetched.bytes, sniff(fetched.bytes)), fetch: async () => fetched.bytes });
      } else {
        if (token.provider === 'google' || !adapter.list) {
          count('drive_refused', 'extract', 0);
          return { refusal: driveRefusal(client) };
        }
        route = 'dropbox';
        let listed: Awaited<ReturnType<NonNullable<StorageAdapter['list']>>>;
        try {
          listed = await adapter.list('', signal);
        } catch (error) {
          if (!signal.aborted) throw error;
          return { refusal: 'The folder did not list in time, so nothing was read. Try once more.' };
        }
        const listing = listed
          .map((entry) => ({ ...entry, name: cleanName(entry.name) }))
          .filter((entry) => isImportableEntryName(entry.name, [...IMPORTABLE_EXTENSIONS, '.zip']))
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
      }

      // Off the critical path: it overlaps the reads below and is awaited at the end.
      const sweep = sweepStale(started, signal);

      /** One file through the model, inside what is left of the budget. */
      const extractOne = async (name: string, bytes: Uint8Array, mimeType: SniffedType): Promise<ExtractedFile> => {
        const left = ioDeadline - Date.now();
        if (left <= 0) return fail(name, 'skipped', 'time');
        const contentHash = contentHashOf(bytes);
        const base = { name, contentHash, mimeType };
        if (isAlreadyImported(file, name, contentHash)) return { ...base, status: 'already_imported' };
        if (!machineFiles.take('machine', 1) || !importFiles.take(connection, 1)) return { ...base, status: 'failed', reason: 'quota' };
        if (chargeWrites(connection, WRITE_COST.add)) return { ...base, status: 'failed', reason: 'allowance' };
        const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
        const pages: PageContent[] = mimeType === 'application/pdf' ? [{ type: 'pdf', content }] : [{ type: 'image', content, mimeType }];
        try {
          // One HTTP attempt, inside what is left: no retry, inner or outer, can run past the deadline.
          // Metadata only for a letter: the connector files no text, so none is asked for.
          return { ...base, status: 'extracted', result: await extract(pages, { timeoutMs: Math.min(EXTRACT_TIMEOUT_MS, left), attempts: 1, httpAttempts: 1, documentMode: 'metadata' }) };
        } catch (error) {
          const reason = failureReason(error);
          if (reason === 'time') {
            // The model never answered, so the file was not read: its day's charge comes back.
            machineFiles.refund('machine', 1);
            importFiles.refund(connection, 1);
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
      const queue: Array<() => Promise<void>> = units.map((unit, i) => async () => {
        if (signal.aborted) {
          if (route === 'dropbox') remaining.push(unit.name);
          else results[i] = fail(unit.name, 'skipped', 'time');
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
          let opened: Awaited<ReturnType<typeof unzip>>;
          try {
            opened = await unzip(bytes);
          } catch {
            results[i] = fail(unit.name, 'failed', 'unreadable');
            return;
          }
          const inside: ExtractedFile[] = new Array<ExtractedFile>(opened.entries.length);
          results[i] = inside;
          opened.entries.forEach((entry, k) => queue.push(async () => { inside[k] = await extractOne(entry.name, entry.bytes, entry.mimeType); }));
          for (const skip of opened.skipped) inside.push(fail(skip.name, 'skipped', skip.reason));
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
      await sweep;

      const files = results.flat();
      // What time cut off is `remaining` on every route: the folder route names it in `fileNames`,
      // the drag route asks for the ZIP again, and either way the assistant is told (AC2).
      for (const f of files) if (f.status === 'skipped' && f.reason === 'time' && !remaining.includes(f.name)) remaining.push(f.name);
      count(route, 'extract', files.filter((f) => f.contentHash).length);
      return { route, files, remaining };
    },

    async stash(payload: ImportPayload, deadline: number) {
      const exp = nowSeconds(Date.parse(payload.createdAt)) + RECEIPT_LIFETIME_SECONDS;
      const claims: ReceiptClaims = { id: payload.id, exp, conn: hash(connection), sha256: sha256Hex(JSON.stringify(payload)) };
      try {
        await adapter.write(pendingName(payload.id), payload, null, deadlineSignal(deadline));
      } catch {
        return { refusal: 'The candidates could not be parked in the user’s folder, so there is nothing to commit. Try the import again.' };
      }
      return { receipt: seal('import', claims, audience), expiresAt: new Date(exp * 1000).toISOString() };
    },

    async open(commit: ImportCommit, _file: RoadmapFile, now: string, deadline: number): Promise<ImportPayload | ImportRefusal> {
      // Verified BEFORE anything is charged: a forged receipt costs nothing.
      // A claims block sealed by us but naming a non-UUID id can never form a path.
      const claims = unseal<ReceiptClaims>('import', commit.receipt, audience, Date.parse(now));
      if (!claims || typeof claims.id !== 'string' || !UUID.test(claims.id) || claims.conn !== hash(connection) || typeof claims.sha256 !== 'string') {
        return { refusal: 'That receipt is not valid for this connection, or has expired. Nothing was written. Extract again and show the user the fresh candidates.' };
      }
      const signal = deadlineSignal(deadline);
      let body: unknown;
      try {
        ({ body } = await adapter.read(pendingName(claims.id), signal));
      } catch (error) {
        if (!signal.aborted) throw error;
        return { refusal: 'The pending import did not read in time. Nothing was written. Try the commit once more.' };
      }
      if (body == null) return { refusal: 'That import was already committed or discarded. Nothing was written. Extract again if the user still wants it.' };
      if (sha256Hex(JSON.stringify(body)) !== claims.sha256) {
        return { refusal: 'The pending import does not match its receipt. Nothing was written. Extract again.' };
      }
      const payload = body as ImportPayload;
      if (payload.id !== claims.id || !Array.isArray(payload.candidates) || !Array.isArray(payload.documents)) {
        return { refusal: 'The pending import is not readable. Nothing was written. Extract again.' };
      }
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
        // A pending file that outlives its commit is swept on the next extract.
      }
    },
  };
}
