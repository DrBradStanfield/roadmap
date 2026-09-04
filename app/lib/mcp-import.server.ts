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
 * The receipt the assistant carries is ~200 bytes — an id, an expiry, the
 * connection it belongs to and the payload's hash — under an HMAC keyed off
 * `MCP_SEAL_KEYS`, so a value the server did not extract cannot be committed.
 *
 * Two fetch targets, ever: the user's own provider through the shared REST
 * modules, and OpenAI's file host for a file dragged into ChatGPT, under a
 * closed allow-list (AC4). Type is decided by magic bytes, never by a
 * declared mime type or a name.
 *
 * NOTHING HERE MAY LOG A FILE NAME, A URL, A VALUE OR EXTRACTED TEXT (AC9).
 */
import crypto from 'node:crypto';
import JSZip from 'jszip';
import * as Sentry from '@sentry/react-router';
import { extractOrClassify } from './anthropic.server';
import { consumeMachineFiles } from './lab-import-quota.server';
import { type McpClientLabel, readCappedBytes } from './mcp-clients.server';
import { sealKeys } from './mcp-config.server';
import { type AccessPayload, connectionKey, spendWrites, WRITE_COST, WRITES_PER_HOUR } from './mcp-grants.server';
import { b64url, hash, typeKey } from './mcp-seal.server';
import type { McpProvider } from './mcp-providers.server';
import { recordServerEvent } from './product-events.server';
import { createQuotaCounter } from './rate-limiter';
import type { StorageAdapter } from '../../packages/health-core/src/adapter';
import { dropboxDownload, dropboxListFolder } from '../../packages/health-core/src/dropbox-rest';
import {
  IMPORTABLE_EXTENSIONS,
  isImportableEntryName,
  type PageContent,
  type UnifiedExtractionResult,
} from '../../packages/health-core/src/lab-extraction';
import {
  type ExtractedFile,
  type ImportBundle,
  type ImportCommit,
  type ImportPayload,
  type ImportRefusal,
  type ImportRequest,
  type ImportSurface,
  isAlreadyImported,
  MAX_IMPORT_FILES_PER_CALL,
} from '../../packages/health-core/src/mcp-tools';
import { importFilesBucket, type McpImportRoute } from '../../packages/health-core/src/product-events';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

// ---------------------------------------------------------------------------
// Bounds (AC10)
// ---------------------------------------------------------------------------

/**
 * The whole call, listing to answer. ChatGPT cuts a tool call off at 60 s
 * (OpenAI staff, 2026-04), so 40 s leaves room for transport and the receipt.
 */
export const MCP_IMPORT_BUDGET_MS = Number(process.env.MCP_IMPORT_BUDGET_MS || 40_000);
/** Time kept back at the end of the budget to slot, stash and answer. */
const BUDGET_RESERVE_MS = 4_000;
/** Folder files one call attempts by default; the rest come back as `remaining`. */
export const IMPORT_FILES_PER_CALL = 5;
/** One PDF or image. Pages reach the model as images, so 5 MB of scans is already many pages. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
/** One ZIP, as downloaded. */
export const MAX_IMPORT_ZIP_BYTES = 20 * 1024 * 1024;
/** One file fetched from OpenAI's host — a ZIP at most. */
export const MAX_CHATGPT_FILE_BYTES = MAX_IMPORT_ZIP_BYTES;
export const CHATGPT_FETCH_TIMEOUT_MS = 10_000;
/** Files one connection may extract in a day, per machine (×2 apps in production). */
export const IMPORT_FILES_PER_DAY = 30;
export const RECEIPT_LIFETIME_SECONDS = 60 * 60;
/** Where a pending payload lives in the user's folder, and how long before an extract sweeps it. */
export const PENDING_FOLDER = 'imports';
const PENDING_STALE_MS = 24 * 60 * 60 * 1000;
const EXTRACT_CONCURRENCY = 3;
/** One model call, HTTP. Inside the budget by construction; a hung call fails, never waits. */
const EXTRACT_TIMEOUT_MS = 20_000;

const DAY_MS = 24 * 60 * 60_000;
let perConnectionFiles = createQuotaCounter(IMPORT_FILES_PER_DAY, DAY_MS, 30 * 60_000);

/** OpenAI's file host, from field reports — the docs name none. A second one shows up as a refusal count. */
function chatgptFileHosts(): Set<string> {
  return new Set((process.env.CHATGPT_FILE_HOSTS || 'files.oaiusercontent.com').split(',').map((h) => h.trim()).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** A folder the connector can list and download from — Dropbox, in production. */
export interface FolderSource {
  list(): Promise<Array<{ id: string; name: string; size: number }>>;
  download(id: string): Promise<Uint8Array>;
}

type Extractor = (pages: PageContent[], opts: { timeoutMs: number }) => Promise<UnifiedExtractionResult>;

interface ImportSeams {
  /** Null means the provider cannot list a folder — Google Drive under `drive.file` (AC3). */
  folder?: (provider: McpProvider, accessToken: string) => FolderSource | null;
  extract?: Extractor;
}

const REAL_SEAMS: Required<ImportSeams> = {
  folder: (provider, accessToken) =>
    provider === 'google'
      ? null
      : {
          list: () => dropboxListFolder(accessToken, ''),
          download: (id) => dropboxDownload(accessToken, id),
        },
  extract: (pages, opts) => extractOrClassify(pages, opts),
};

let seams: Required<ImportSeams> = REAL_SEAMS;

export function setImportSeams(next: ImportSeams | null): void {
  seams = { ...REAL_SEAMS, ...next };
}

/** Test seam — the per-connection counter is process-global. */
export function resetImportMemory(): void {
  seams = REAL_SEAMS;
  perConnectionFiles = createQuotaCounter(IMPORT_FILES_PER_DAY, DAY_MS, 30 * 60_000);
}

// ---------------------------------------------------------------------------
// Bytes: what kind, and what is inside
// ---------------------------------------------------------------------------

export type SniffedType = 'application/pdf' | 'application/zip' | 'image/jpeg' | 'image/png';

/** The type the bytes say they are. A declared mime type or a name is never consulted (AC4). */
export function sniff(bytes: Uint8Array): SniffedType | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 5 && at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2d) return 'application/pdf';
  if (bytes.length >= 4 && at(0) === 0x50 && at(1) === 0x4b && at(2) === 0x03 && at(3) === 0x04) return 'application/zip';
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  return null;
}

/** A file's own name as `sourceFileName`: printable, bounded, never a path. */
function cleanName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255) || 'file';
}

export interface ZipEntryBytes {
  name: string;
  bytes: Uint8Array;
  mimeType: SniffedType;
}

/**
 * Open a ZIP under the caps (AC5): at most `MAX_IMPORT_FILES_PER_CALL`
 * importable entries, each at most `MAX_IMPORT_FILE_BYTES` INFLATED — the
 * declared size is the archive's claim and is only a cheap first refusal; the
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
      if (name.toLowerCase().endsWith('.zip')) skipped.push({ name, reason: 'unsupported' });
      continue;
    }
    if (entries.length >= MAX_IMPORT_FILES_PER_CALL) {
      skipped.push({ name, reason: 'too_many' });
      continue;
    }
    // JSZip publishes no size; the central directory's claim sits on a
    // private field. Read behind one line, typed loosely, as the cheap check.
    const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof declared === 'number' && declared > MAX_IMPORT_FILE_BYTES) {
      skipped.push({ name, reason: 'too_large' });
      continue;
    }
    const inflated = await inflateCapped(entry, MAX_IMPORT_FILE_BYTES);
    if (!inflated) {
      skipped.push({ name, reason: 'too_large' });
      continue;
    }
    const mimeType = sniff(inflated);
    if (!mimeType || mimeType === 'application/zip') {
      skipped.push({ name, reason: 'unsupported' });
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

// ---------------------------------------------------------------------------
// The ChatGPT file route (AC4)
// ---------------------------------------------------------------------------

/**
 * Fetch the file ChatGPT described. `https:` only, host on the allow-list,
 * no redirects, ten seconds, capped bytes. The URL is never logged; a refused
 * host is warned by hostname only, which is how a second legitimate host
 * would ever be learned.
 */
export async function fetchChatgptFile(downloadUrl: string): Promise<{ bytes: Uint8Array } | ImportRefusal> {
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    return { refusal: 'That file reference is not a URL this server can fetch. Drag the file in from a browser, or put it in the connected folder. Nothing was read.' };
  }
  if (url.protocol !== 'https:' || !chatgptFileHosts().has(url.hostname)) {
    console.warn('import: file host refused', url.hostname);
    return { refusal: 'That file is not on a host this server will fetch from. Drag the file in from a browser, or put it in the connected folder. Nothing was read.' };
  }
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(CHATGPT_FETCH_TIMEOUT_MS) });
    if (!res.ok) return { refusal: `The file host answered ${res.status}, so the file could not be read. Ask the user to drag it in again.` };
    return { bytes: await readCappedBytes(res, MAX_CHATGPT_FILE_BYTES) };
  } catch (error) {
    if (error instanceof Error && error.message === 'body too large') {
      return { refusal: `That file is larger than ${MAX_CHATGPT_FILE_BYTES / (1024 * 1024)} MB, so it was not read. Split it, or put smaller files in the connected folder.` };
    }
    return { refusal: 'The file host did not answer in time, so the file could not be read. Ask the user to drag it in again.' };
  }
}

// ---------------------------------------------------------------------------
// The receipt (AC7)
// ---------------------------------------------------------------------------

interface ReceiptClaims {
  id: string;
  exp: number;
  conn: string;
  sha256: string;
}

function receiptMac(key: Buffer, header: string): string {
  return b64url(crypto.createHmac('sha256', typeKey(key, 'import')).update(header, 'utf8').digest());
}

export function mintReceipt(claims: ReceiptClaims): string {
  const keys = sealKeys();
  if (keys.length === 0) throw new Error('MCP_SEAL_KEYS is not configured');
  const header = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${header}.${receiptMac(keys[0], header)}`;
}

/**
 * The claims, or null — for a bad MAC, another connection, an expiry passed,
 * or a shape that is not a receipt, all alike. Every configured key is tried,
 * so a rotation inside the hour does not strand a receipt.
 */
export function verifyReceipt(receipt: string, connection: string, nowMs: number): ReceiptClaims | null {
  const [header, mac, ...rest] = receipt.split('.');
  if (!header || !mac || rest.length > 0) return null;
  const presented = Buffer.from(mac, 'base64url');
  const valid = sealKeys().some((key) => {
    const expected = Buffer.from(receiptMac(key, header), 'base64url');
    return expected.length === presented.length && crypto.timingSafeEqual(expected, presented);
  });
  if (!valid) return null;
  let claims: ReceiptClaims;
  try {
    claims = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as ReceiptClaims;
  } catch {
    return null;
  }
  if (typeof claims.id !== 'string' || !/^[0-9a-f-]{36}$/.test(claims.id)) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) return null;
  if (claims.conn !== hash(connection) || typeof claims.sha256 !== 'string') return null;
  return claims;
}

function pendingName(id: string): string {
  return `${PENDING_FOLDER}/pending-${id}.json`;
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

function allowanceRefusal(): ImportRefusal {
  return {
    refusal:
      `This connection has spent its write allowance for the hour — ${WRITES_PER_HOUR} weighted writes an hour, and an ` +
      'import costs one plus one per file. Reading still works. The allowance comes back with the hour. Nothing was written.',
  };
}

/** AC3, per client: the way that works for THIS assistant comes first. */
function driveRefusal(client: McpClientLabel): string {
  const why = 'This record lives in Google Drive, and the permission the connector holds cannot see files dropped into the folder. ';
  return client === 'chatgpt'
    ? why + 'Drag the file into this chat from a desktop browser instead, or upload it on the website, which reads the PDF in your browser. Nothing was read.'
    : why + 'Upload it on the website, which reads the PDF in your browser and files it into the same record. Nothing was read.';
}

/** Why one file could not be read, as a closed word the assistant can act on. */
function failureReason(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'time';
  if (error instanceof Error && /status 400/.test(error.message)) return 'too_large';
  return 'unreadable';
}

interface Unit {
  name: string;
  size?: number;
  bytes?: Uint8Array;
  fetch?: () => Promise<Uint8Array>;
}

export interface HostedImporterOptions {
  token: AccessPayload;
  accessToken: string;
  adapter: StorageAdapter;
  client: McpClientLabel;
  /** The hosted `correct_value` guard, run per `replace` (AC8, review 6). */
  checkCorrection(file: RoadmapFile, args: { id: string; expectedValue: number }, now: string): string | null;
  maxCorrectionAgeDays: number;
}

/** The `ImportSurface` for one hosted call. Built per call, like the adapter; holds nothing after. */
export function hostedImporter(options: HostedImporterOptions): ImportSurface {
  const { token, accessToken, adapter, client } = options;
  const connection = connectionKey(token.rt);

  async function sweepStale(nowMs: number): Promise<void> {
    if (!adapter.list || !adapter.remove) return;
    try {
      for (const stale of await adapter.list(PENDING_FOLDER)) {
        const at = Date.parse(stale.modified);
        if (Number.isFinite(at) && nowMs - at > PENDING_STALE_MS) await adapter.remove(stale.name);
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

    async extract(request: ImportRequest, file: RoadmapFile, now: string): Promise<ImportBundle | ImportRefusal> {
      const started = Date.now();
      const deadline = started + MCP_IMPORT_BUDGET_MS - BUDGET_RESERVE_MS;
      const overBudget = () => Date.now() > deadline;
      if (!spendWrites(connection, WRITE_COST.add)) return allowanceRefusal();

      let route: McpImportRoute;
      const units: Unit[] = [];
      const remaining: string[] = [];
      const files: ExtractedFile[] = [];

      if (request.file) {
        route = 'chatgpt_file';
        const fetched = await fetchChatgptFile(request.file.download_url);
        if ('refusal' in fetched) return fetched;
        units.push({ name: cleanName(request.file.file_name ?? 'file'), bytes: fetched.bytes });
      } else {
        const source = seams.folder(token.provider, accessToken);
        if (!source) {
          count('drive_refused', 'extract', 0);
          return { refusal: driveRefusal(client) };
        }
        route = 'dropbox';
        const listing = (await source.list())
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
        for (const entry of chosen.slice(0, IMPORT_FILES_PER_CALL)) {
          units.push({ name: entry.name, size: entry.size, fetch: () => source.download(entry.id) });
        }
        remaining.push(...chosen.slice(IMPORT_FILES_PER_CALL).map((entry) => entry.name));
      }

      // Bytes, then type, then contents — one unit at a time, inside the budget.
      const work: Array<{ name: string; bytes: Uint8Array; mimeType: SniffedType }> = [];
      for (const unit of units) {
        if (overBudget()) {
          if (route === 'dropbox') remaining.push(unit.name);
          else files.push({ name: unit.name, sha256: '', mimeType: '', status: 'skipped', reason: 'time' });
          continue;
        }
        const isZip = unit.name.toLowerCase().endsWith('.zip');
        if (unit.size !== undefined && unit.size > (isZip ? MAX_IMPORT_ZIP_BYTES : MAX_IMPORT_FILE_BYTES)) {
          files.push({ name: unit.name, sha256: '', mimeType: '', status: 'failed', reason: 'too_large' });
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = unit.bytes ?? (await unit.fetch!());
        } catch {
          files.push({ name: unit.name, sha256: '', mimeType: '', status: 'failed', reason: 'unreadable' });
          continue;
        }
        const mimeType = sniff(bytes);
        if (mimeType === 'application/zip') {
          if (bytes.length > MAX_IMPORT_ZIP_BYTES) {
            files.push({ name: unit.name, sha256: '', mimeType: '', status: 'failed', reason: 'too_large' });
            continue;
          }
          let opened: Awaited<ReturnType<typeof unzip>>;
          try {
            opened = await unzip(bytes);
          } catch {
            files.push({ name: unit.name, sha256: '', mimeType: '', status: 'failed', reason: 'unreadable' });
            continue;
          }
          for (const entry of opened.entries) work.push({ name: entry.name, bytes: entry.bytes, mimeType: entry.mimeType });
          for (const skip of opened.skipped) files.push({ name: skip.name, sha256: '', mimeType: '', status: 'skipped', reason: skip.reason });
          continue;
        }
        if (!mimeType) {
          files.push({ name: unit.name, sha256: '', mimeType: '', status: 'failed', reason: 'unsupported' });
          continue;
        }
        if (bytes.length > MAX_IMPORT_FILE_BYTES) {
          files.push({ name: unit.name, sha256: '', mimeType: '', status: 'failed', reason: 'too_large' });
          continue;
        }
        work.push({ name: unit.name, bytes, mimeType });
      }

      // Extraction, three at a time, each inside what is left of the budget.
      const read: ExtractedFile[] = new Array(work.length);
      let next = 0;
      const runner = async () => {
        while (next < work.length) {
          const index = next++;
          const item = work[index];
          const sha256 = sha256Hex(item.bytes);
          const base = { name: item.name, sha256, mimeType: item.mimeType };
          if (isAlreadyImported(file, item.name, sha256)) {
            read[index] = { ...base, status: 'already_imported' };
            continue;
          }
          const left = deadline - Date.now();
          if (left <= 0) {
            read[index] = { ...base, status: 'skipped', reason: 'time' };
            continue;
          }
          if (!perConnectionFiles.take(connection, 1) || !consumeMachineFiles(1)) {
            read[index] = { ...base, status: 'failed', reason: 'quota' };
            continue;
          }
          if (!spendWrites(connection, WRITE_COST.add)) {
            read[index] = { ...base, status: 'failed', reason: 'allowance' };
            continue;
          }
          const content = Buffer.from(item.bytes).toString('base64');
          const pages: PageContent[] = item.mimeType === 'application/pdf'
            ? [{ type: 'pdf', content }]
            : [{ type: 'image', content, mimeType: item.mimeType }];
          try {
            const result = await seams.extract(pages, { timeoutMs: Math.min(EXTRACT_TIMEOUT_MS, left) });
            read[index] = { ...base, status: 'extracted', result };
          } catch (error) {
            const reason = failureReason(error);
            if (reason === 'unreadable') {
              Sentry.captureException(error, { tags: { feature: 'mcp_import', errorName: error instanceof Error ? error.name : 'unknown' }, extra: { kind: item.mimeType } });
            }
            read[index] = { ...base, status: 'failed', reason };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, work.length) }, runner));

      await sweepStale(started);
      count(route, 'extract', work.length);
      return { route, files: [...read, ...files], remaining };
    },

    async stash(payload: ImportPayload) {
      const exp = Math.floor(Date.parse(payload.createdAt) / 1000) + RECEIPT_LIFETIME_SECONDS;
      const sha256 = sha256Hex(JSON.stringify(payload));
      try {
        await adapter.write(pendingName(payload.id), payload, null);
      } catch {
        return { refusal: 'The candidates could not be parked in the user’s folder, so there is nothing to commit. Try the import again.' };
      }
      return { receipt: mintReceipt({ id: payload.id, exp, conn: hash(connection), sha256 }), expiresAt: new Date(exp * 1000).toISOString() };
    },

    async open(commit: ImportCommit, file: RoadmapFile, now: string): Promise<ImportPayload | ImportRefusal> {
      // Verified BEFORE anything is charged: a forged receipt costs nothing.
      const claims = verifyReceipt(commit.receipt, connection, Date.parse(now));
      if (!claims) return { refusal: 'That receipt is not valid for this connection, or has expired. Nothing was written. Extract again and show the user the fresh candidates.' };
      const { body } = await adapter.read(pendingName(claims.id));
      if (body == null) return { refusal: 'That import was already committed or discarded. Nothing was written. Extract again if the user still wants it.' };
      if (sha256Hex(JSON.stringify(body)) !== claims.sha256) {
        return { refusal: 'The pending import does not match its receipt. Nothing was written. Extract again.' };
      }
      const payload = body as ImportPayload;
      if (payload.id !== claims.id || !Array.isArray(payload.candidates) || !Array.isArray(payload.documents)) {
        return { refusal: 'The pending import is not readable. Nothing was written. Extract again.' };
      }
      for (const id of commit.replace) {
        const candidate = payload.candidates.find((c) => c.id === id);
        if (!candidate || candidate.slot.state !== 'held_different') continue; // the tool layer answers in its own words
        const refusal = options.checkCorrection(file, { id: candidate.slot.existingRowId ?? '', expectedValue: candidate.slot.existingValue ?? NaN }, now);
        if (refusal) return { refusal };
      }
      if (!spendWrites(connection, WRITE_COST.add + WRITE_COST.correct * commit.replace.length)) return allowanceRefusal();
      count(payload.route, 'commit', new Set(payload.candidates.map((c) => c.sourceFileName)).size + payload.documents.length);
      return payload;
    },

    async discard(payload: ImportPayload): Promise<void> {
      try {
        await adapter.remove?.(pendingName(payload.id));
      } catch {
        // A pending file that outlives its commit is swept on the next extract.
      }
    },
  };
}
