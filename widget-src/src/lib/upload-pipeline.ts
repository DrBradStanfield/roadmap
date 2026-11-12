// The upload pipeline: reading each file's pages, sending them to be read (one by one or as a batch),
// what a file read becomes (FileResult) and what the review hands back to save.
import { resolveLabValues, type RefusedLabValue, type UnreadLabValue } from '@roadmap/health-core/lab-extraction';
import { UNIT_DEFS, reportedToCanonical, type UnitSystem } from '@roadmap/health-core/units';
import { comparatorOf, type Comparator } from '@roadmap/health-core/lab-limits';
import { bloodTestKeyOf } from '@roadmap/health-core/blood-tests';
import type { MeasurementSource } from '@roadmap/health-core/validation';
import { fileVerdict, UPLOAD_LIMITS } from '@roadmap/health-core/upload-rules';
import type { UploadOutcomeKey } from '@roadmap/health-core/product-events';
import type { ExtractedValue, AdditionalLabValue, DocumentResult, LabImportResult, PageContent, UploadErrorCode } from './api-types';
import { labImport, labImportBatch, pollBatchStatus } from './upload-api';
import { isDocx, isLegacyDoc } from './file-kinds';
// Type only: a value import would pull the lazy upload bundle into the main one.
import type { HealthUploadAPI } from '../upload-entry';

export interface FileResult {
  fileName: string;
  reportDate: string | null;
  values: ExtractedValue[];
  additionalValues: AdditionalLabValue[];
  error?: string;
  /** Present for non-lab documents (scan results, clinic letters, etc.) */
  document?: DocumentResult;
  /** Values the extractor refused rather than guessed, listed under "Not saved" (US-12 AC15). */
  refusedValues?: RefusedLabValue[];
  /** The original uploaded bytes — saved into the user's cloud archive (v2). */
  file?: Blob;
  /** 'sha256-<hex>' of `file` — matched against the record's document rows. */
  contentHash?: string;
}

/** Document to be saved, assembled from review state */
export interface DocumentToSave {
  documentType: string;
  title: string;
  documentDate: string | null;
  contentMd: string;
  metadata: Record<string, unknown>;
  sourceFileName: string | null;
  /** If this maps to a screening type, the key to update (e.g. "colorectal_last_date") */
  screeningUpdate?: { key: string; date: string };
  /** The original bytes, carried inside the payload (no name-keyed re-join). */
  file?: Blob;
}

/** A reviewed row on its way to the store. `correctsId` is set when the user
 *  ticked "Replace" on a slot an earlier writer already holds — the store
 *  turns it into a FHIR correction. */
export interface ReviewedValue {
  metric: string; valueSI: number; recordedAt: string; source?: MeasurementSource; correctsId?: string;
  /** Printed as a limit and saved as printed (US-12 AC20); an edited cell is an exact value. */
  comparator?: Comparator;
}
export interface ReviewedLabValue {
  name: string; value: number; unit: string;
  referenceLow?: number | null; referenceHigh?: number | null;
  recordedAt: string; correctsId?: string;
  comparator?: Comparator;
}

/**
 * Brad D5 (US-66 AC6): an extra value named like a core test, creatinine
 * excepted (US-12 AC11), is offered as that core value. The extractor moves
 * one into a free slot; one it left is offered here. In a unit the test takes
 * it joins the core row, where a held day shows the conflict (US-13 AC3) and
 * a second reading of a day is listed as hidden (US-12 AC14). In any other
 * unit it is listed as not saved, with why (US-12 AC19).
 */
export function offerCoreExtras(result: Pick<FileResult, 'values' | 'additionalValues' | 'refusedValues'>): Pick<FileResult, 'values' | 'additionalValues' | 'refusedValues'> {
  const values = [...result.values];
  const additionalValues: FileResult['additionalValues'] = [];
  const refusedValues = [...(result.refusedValues ?? [])];
  for (const v of result.additionalValues ?? []) {
    const metric = bloodTestKeyOf(v.name);
    if (!metric || metric === 'creatinine') { additionalValues.push(v); continue; }
    const day = { ...(v.recordedAt ? { recordedAt: v.recordedAt } : null), ...(v.printedMonth ? { printedMonth: v.printedMonth } : null) };
    if (reportedToCanonical(metric, v.value, v.unit)) {
      values.push(...resolveLabValues([{ metric, value: v.value, unit: v.unit, confidence: v.confidence ?? 'high', question: v.question, printedName: v.printedName, ...day, ...comparatorOf(v) }]));
    } else {
      const { si, conventional } = UNIT_DEFS[metric].label;
      refusedValues.push({ metric, value: v.value, unit: v.unit, reason: `This test is measured in ${si === conventional ? si : `${si} or ${conventional}`}.`, ...day });
    }
  }
  return { values, additionalValues, ...(refusedValues.length ? { refusedValues } : null) };
}

export class UploadError extends Error {
  constructor(message: string, public code: UploadErrorCode) {
    super(message);
  }
}

/** The Pages build's own key or its account, not the file, so "try again"
 *  never helps: each says what to check (US-12 AC9). */
export const KEY_ERROR_MESSAGES = {
  key_refused: 'Anthropic refused your API key. Check the key in the "Ask about your plan" panel.',
  no_credit: 'Your Anthropic account has no credit. Check its billing, then try again.',
};

export const BATCH_THRESHOLD = UPLOAD_LIMITS.web.batchFrom; // Use batch API for 20+ files; pipeline for fewer
const POLL_INTERVAL = 5000;
const FAKE_TICK_INTERVAL = 500;
const EXTRACT_TIMEOUT = 30_000;
// Max LLM calls in flight at once. Tier 2 ceiling (80K output tokens/min)
// comfortably absorbs 5 concurrent lab-report extractions (~500-1500 output
// tokens each). Scan/letter markdown conversion (~4K tokens) can overflow:
// fetchAnthropicRaw() does not retry a 429, so that file fails as a server error.
const LLM_CONCURRENCY = 5;
// Parallel pdf.js extractors. Extraction is CPU-bound on the main thread,
// so 3 workers keep the queue feeding 5 LLM workers without UI jank.
const EXTRACT_CONCURRENCY = 3;

/** Rotating status messages shown during batch processing */
const PROGRESS_MESSAGES = [
  'Analyzing health records...',
  'Reading clinical data...',
  'Extracting medical information...',
  'Processing documents...',
  'Identifying blood test values...',
  'Reviewing scan results...',
];

/** The size cap readPages applies through fileVerdict; kept by name for the golden pins (upload-decisions.pins.test.tsx). */
export const MAX_FILE_SIZE = UPLOAD_LIMITS.web.fileBytes;

/** Why a file was not fully read (US-12 AC9). Each is also its `upload_outcome` count. */
export type FileNoticeReason = Exclude<UploadOutcomeKey, 'picked' | 'withValues' | 'docx' | 'undatedPrevious' | 'unitsGuessed' | 'unitsRefused' | 'valuesLimit' | 'valuesLimitUngraded' | 'cancelled'>;
/** `name` is the file's whole path, its identity; the list shows it short (`noticeName`).
 *  `count` is how many the notice stands for (values dropped), `unread` the ones that
 *  name their test (US-12 AC19); `text` overrides the reason's. */
export interface FileNotice { name: string; reason: FileNoticeReason; count?: number; unread?: UnreadLabValue[]; text?: string }

const LEGACY_DOC_TEXT = 'Word .doc files cannot be read. Save it as a PDF or .docx, then upload that.';

export const shortName = (fileName: string) => fileName.split('/').pop() || fileName;

export const hasValues = (r: FileResult) => r.values.length + r.additionalValues.length > 0;
function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), EXTRACT_TIMEOUT); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** One file to read. A ZIP member's `fileName` is its ZIP's name, then its
 *  path (`labs.zip/results.pdf`): two ZIPs can hold one path, and the name is
 *  the document's `sourceFileName`, stable across uploads of the same ZIP. */
export interface ReadInput { fileName: string; getFile: () => Promise<File> }

/** Reads one file's pages (pdf.js, image resize or .docx text), with the file they came
 *  from: its original travels with its result. A file that will not open, or
 *  has no pages, is noted and gives none; it is never silently dropped. The
 *  size limit is checked here too: a small ZIP can hold a member past it. */
async function readPages(upload: HealthUploadAPI, { fileName: name, getFile }: ReadInput, notices: FileNotice[]): Promise<{ pages: PageContent[]; file?: File }> {
  try {
    const file = await getFile();
    if (fileVerdict({ name, bytes: file.size, kind: 'file', platform: 'web' }) === 'tooLarge') {
      notices.push({ name, reason: 'tooLarge' });
      return { pages: [] };
    }
    if (upload.isPdf(file)) {
      const { pages, truncated } = await withTimeout(upload.extractFromPdf(file));
      if (truncated) notices.push({ name, reason: 'truncated' });
      if (pages.length > 0) return { pages, file };
    } else if (upload.isImage(file)) {
      return { pages: [{ type: 'image', content: await withTimeout(upload.resizeImage(file, UPLOAD_LIMITS.web.photoPx)), mimeType: 'image/jpeg' }], file };
    } else if (isDocx(file)) {
      const { text, truncated, picturesOnly } = await withTimeout(upload.docxToText(await file.arrayBuffer()));
      if (truncated) notices.push({ name, reason: 'truncated' });
      if (text) return { pages: [{ type: 'text', content: text }], file };
      if (picturesOnly) {
        notices.push({ name, reason: 'picturesOnly' });
        return { pages: [] };
      }
    } else if (isLegacyDoc(file)) {
      notices.push({ name, reason: 'openFailed', text: LEGACY_DOC_TEXT });
      return { pages: [] };
    }
  } catch { /* noted below: the reason is the user's, the error is pdf.js's */ }
  notices.push({ name, reason: 'openFailed' });
  return { pages: [] };
}

/** A file the server read, as a review row; values its parse refused are named (US-12 AC9). */
function readResult(fileName: string, result: LabImportResult, notices: FileNotice[]): FileResult {
  if (result.droppedValueCount) notices.push({ name: fileName, reason: 'valuesDropped', count: result.droppedValueCount, unread: result.unreadValues });
  return { fileName, reportDate: result.reportDate, ...offerCoreExtras(result), document: result.document ?? undefined };
}

/** The notice for a file's own error code; anything else is a server error. */
const UNREAD_REASONS: Partial<Record<UploadErrorCode, FileNoticeReason>> = { rate_limit: 'limitError', refused: 'refused', too_long: 'tooLong' };

/** A file the server did not read, named with why: the daily limit, a refusal, a cut-off answer, or anything else. */
function unreadResult(fileName: string, errorCode: UploadErrorCode | undefined, error: string, notices: FileNotice[]): FileResult {
  const keyError = errorCode === 'key_refused' || errorCode === 'no_credit' ? `Not read. ${KEY_ERROR_MESSAGES[errorCode]}` : undefined;
  notices.push({ name: fileName, reason: (errorCode && UNREAD_REASONS[errorCode]) || 'serverError', text: keyError });
  return { fileName, reportDate: null, values: [], additionalValues: [], error };
}

/**
 * Pipeline: producer extracts files (ZIP blob → pdf.js → pages), consumer
 * sends pages to LLM one at a time. Extraction runs ahead of LLM calls —
 * while file 1 is in the LLM (~5s), files 2-4 are being extracted client-side.
 */
export async function processPipeline(
  upload: HealthUploadAPI,
  allInputs: ReadInput[],
  abort: AbortController,
  updateProgress: (p: { current: number; total: number; fileName: string }) => void,
  us: UnitSystem,
  notices: FileNotice[],
): Promise<FileResult[]> {
  const totalFiles = allInputs.length;
  const queue: Array<{ index: number; fileName: string; pages: PageContent[]; file?: File }> = [];
  // By picked position, so the review and its notices list files as picked, whatever order they finish in (US-12 AC23).
  const allResults: Array<FileResult | undefined> = [];
  const fileNotices: FileNotice[][] = allInputs.map(() => []);
  let completedCount = 0;
  let activeWorkers = 0;
  let feedingDone = false;
  let resolveAll: (() => void) | null = null;
  const allDone = new Promise<void>(resolve => { resolveAll = resolve; });

  function checkDone() {
    if (abort.signal.aborted) queue.length = 0;
    if (feedingDone && activeWorkers === 0 && queue.length === 0) {
      resolveAll?.();
    }
  }

  function tryStartWorker() {
    while (activeWorkers < LLM_CONCURRENCY && queue.length > 0) {
      if (abort.signal.aborted) break;
      activeWorkers++;
      const item = queue.shift()!;
      updateProgress({ current: Math.round((completedCount / totalFiles) * 100), total: 100, fileName: shortName(item.fileName) });

      // Send to LLM
      labImport(item.pages, us).then(({ result, error: importError, errorCode }) => {
        allResults[item.index] = result
          ? { ...readResult(item.fileName, result, fileNotices[item.index]), file: item.file }
          : unreadResult(item.fileName, errorCode, importError || 'Extraction failed', fileNotices[item.index]);
      }).catch(() => {
        allResults[item.index] = unreadResult(item.fileName, undefined, 'Processing failed', fileNotices[item.index]);
      }).finally(() => {
        completedCount++;
        activeWorkers--;
        updateProgress({
          current: Math.round((completedCount / totalFiles) * 100),
          total: 100,
          fileName: `Processed ${completedCount} of ${totalFiles}`,
        });
        tryStartWorker();
        checkDone();
      });
    }
  }

  // Producer: a pool of extractors in parallel. Sequential extraction starved
  // LLM workers (extraction ~2s vs LLM ~5s); EXTRACT_CONCURRENCY parallel
  // extractors keep the LLM queue full.
  let extractIndex = 0;
  async function extractWorker() {
    while (extractIndex < allInputs.length) {
      if (abort.signal.aborted) break;
      const index = extractIndex++;
      const input = allInputs[index];
      const { pages, file } = await readPages(upload, input, fileNotices[index]);
      if (abort.signal.aborted) return;
      if (pages.length > 0) {
        queue.push({ index, fileName: input.fileName, pages, file });
        tryStartWorker();
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(EXTRACT_CONCURRENCY, allInputs.length) }, () => extractWorker()),
  );

  feedingDone = true;
  checkDone();

  await allDone;
  notices.push(...fileNotices.flat());
  const results = allResults.filter((r): r is FileResult => r !== undefined);
  if (results.length === 0 && !abort.signal.aborted) {
    throw new UploadError('No readable files found.', 'no_files');
  }
  return results;
}

/** Batch: send all files in one request, poll for results. For 20+ files. */
export async function processBatch(
  upload: HealthUploadAPI,
  queue: ReadInput[],
  abort: AbortController,
  updateProgress: (p: { current: number; total: number; fileName: string }) => void,
  notices: FileNotice[],
): Promise<FileResult[]> {
  const allFiles: Array<{ fileName: string; pages: PageContent[] }> = [];
  const originals: Array<File | undefined> = []; // by position in allFiles
  for (let i = 0; i < queue.length; i++) {
    if (abort.signal.aborted) break;
    const { fileName } = queue[i];
    updateProgress({ current: Math.round((i / queue.length) * 30), total: 100, fileName: `Reading ${shortName(fileName)}...` });
    const { pages, file } = await readPages(upload, queue[i], notices);
    if (pages.length > 0) {
      allFiles.push({ fileName, pages });
      originals.push(file);
    }
  }

  if (abort.signal.aborted) return [];
  if (allFiles.length === 0) throw new UploadError('No readable files found.', 'no_files');

  updateProgress({ current: 33, total: 100, fileName: `Analyzing ${allFiles.length} files...` });

  const { batchId, error: batchError, errorCode: batchErrorCode } = await labImportBatch(allFiles, abort.signal);
  if (abort.signal.aborted) return [];
  if (!batchId) throw new UploadError(batchError || 'Failed to start processing', batchErrorCode || 'server_error');

  const fileNames = allFiles.map(f => shortName(f.fileName));
  let fakeProgress = 35;
  let realCompleted = 0;
  let tickCount = 0;

  const fakeTimer = setInterval(() => {
    if (abort.signal.aborted) return;
    tickCount++;
    fakeProgress += (90 - fakeProgress) * 0.015;
    const realPct = allFiles.length > 0 ? (realCompleted / allFiles.length) * 100 : 0;
    const displayPct = Math.max(fakeProgress, realPct);
    const statusMsg = PROGRESS_MESSAGES[Math.floor(tickCount / 8) % PROGRESS_MESSAGES.length];
    const fileName = fileNames[Math.floor(tickCount / 3) % fileNames.length];
    const msg = realCompleted > 0
      ? `Processed ${realCompleted} of ${allFiles.length}: ${fileName}`
      : `${statusMsg} ${fileName}`;
    updateProgress({ current: Math.round(displayPct), total: 100, fileName: msg });
  }, FAKE_TICK_INTERVAL);

  try {
    const maxPollTime = Date.now() + 10 * 60_000;
    while (!abort.signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      if (abort.signal.aborted) break;
      if (Date.now() > maxPollTime) throw new UploadError('Processing timed out.', 'timeout');

      const poll = await pollBatchStatus(batchId);
      realCompleted = Math.max(realCompleted, poll.completed); // never less than the last answer (US-12 AC24)
      if (poll.error) throw new UploadError(poll.error, poll.errorCode || 'server_error');

      if (poll.status === 'ended' && poll.results) {
        clearInterval(fakeTimer);
        updateProgress({ current: 100, total: 100, fileName: 'All files processed!' });
        // Each result names its request's position, so a lost or failed one
        // is reported against its own file, never "Unknown file" (US-12 AC9).
        // An old server (the deploy window) sends no index, only the order,
        // which says nothing when the counts differ: then every file is unread.
        const indexed = poll.results.some(r => typeof r.index === 'number');
        const byIndex = new Map(indexed || poll.results.length === allFiles.length
          ? poll.results.map((r, i) => [indexed ? r.index : i, r]) : []);
        return allFiles.map(({ fileName }, i) => {
          const r = byIndex.get(i);
          return r && !('errorCode' in r)
            ? { ...readResult(fileName, r, notices), file: originals[i] }
            : unreadResult(fileName, r?.errorCode, 'Extraction failed', notices);
        });
      }
    }
    return [];
  } finally {
    clearInterval(fakeTimer);
  }
}
