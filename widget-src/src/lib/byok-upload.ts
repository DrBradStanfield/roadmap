/**
 * BYOK lab extraction — the standalone (GitHub Pages / self-host) replacement
 * for upload-api.ts, swapped in by the vite resolveId redirect (same mechanism
 * as api.ts → roadmap-data.ts and chat-api.ts → byok-chat.ts). Identical
 * export surface, different transport:
 *
 *   Shopify v2 page:  browser → Brad's Fly endpoint → Claude (Brad pays, capped)
 *   Standalone:       browser → api.anthropic.com DIRECT with the USER's key
 *
 * Same key as the BYOK chat (hr_anthropic_key, this device only), same model
 * and the SAME extraction prompt as the server — both import it from
 * health-core/lab-extraction.ts so they can never drift. Shipping the prompt
 * in the public bundle was Brad's call 2026-06-10: it is mechanical value
 * extraction, not clinical IP.
 *
 * Batches: the server path uses Anthropic's Batch API; here the user is
 * present and pays for themselves, so a "batch" is just a client-side queue
 * of direct calls (concurrency 2 — gentle on entry-tier key rate limits)
 * behind the same labImportBatch/pollBatchStatus interface.
 */
import {
  EXTRACTION_MAX_TOKENS,
  UNIFIED_SYSTEM_PROMPT,
  pagesToContentBlocks,
  parseExtractionJson,
  parseUnifiedResult,
  toUnifiedResult,
} from '@roadmap/health-core/lab-extraction';
import { EXTRACTION_MODEL, modelParams } from '@roadmap/health-core/models';
import { getAnthropicKey } from './byok-chat';
import { ByokAnthropicError, callAnthropicDirect, type ByokErrorCode } from './byok-anthropic';
import type { BatchPollResponse, LabImportResult, PageContent, UploadErrorCode } from './api-types';

const NO_KEY_MESSAGE =
  'Connect your Anthropic API key (in the "Ask about your plan" panel) to process documents on this page.';

export async function checkLabImportQuota(): Promise<{ allowed: boolean; remaining: number; message?: string }> {
  if (!getAnthropicKey()) return { allowed: false, remaining: 0, message: NO_KEY_MESSAGE };
  // The user's own key — any limits are theirs, enforced by Anthropic per call.
  return { allowed: true, remaining: Number.MAX_SAFE_INTEGER };
}

/** Map the shared transport's error code → the upload modal's UploadErrorCode. */
const UPLOAD_ERROR_CODE: Record<ByokErrorCode, UploadErrorCode> = {
  network: 'network',
  rate_limit: 'rate_limit',
  unauthorized: 'key_refused',
  bad_request: 'server_error',
  empty: 'server_error',
  server_error: 'server_error',
  refused: 'server_error',
};

/** A 400 that names credit or billing is the key's account, not the file:
 *  trying again never helps, so the modal says what to check (US-12 AC9). */
function uploadErrorCode(error: ByokAnthropicError): UploadErrorCode {
  return error.code === 'bad_request' && /credit|billing/i.test(error.message) ? 'no_credit' : UPLOAD_ERROR_CODE[error.code];
}

/** What a failure was, never what it said: a SyntaxError or ZodError message
 *  can quote report text, and the console must not carry it. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** One direct extraction call; on bad JSON the SAME request is sent once more
 *  (same recovery as the server's extractOrClassifyOnce; Haiku 5.5 400s on the
 *  `{` prefill this used to send, US-15 AC34). */
async function extractDirect(apiKey: string, pages: PageContent[]): Promise<LabImportResult> {
  const body = {
    ...modelParams(EXTRACTION_MODEL, EXTRACTION_MAX_TOKENS),
    system: UNIFIED_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: pagesToContentBlocks(pages) }],
  };

  const responseText = await callAnthropicDirect(apiKey, body);
  try {
    return toResult(responseText);
  } catch {
    return toResult(await callAnthropicDirect(apiKey, body));
  }
}

function toResult(responseText: string): LabImportResult {
  // toUnifiedResult returns UnifiedExtractionResult; LabImportResult is the same
  // shape minus `unrecognized` (which the review UI doesn't consume) and with
  // document.classification typed DocumentType instead of string. The widening
  // cast is safe because the review UI reads document.classification as a plain
  // string; the extra `unrecognized` field is harmless if present.
  return toUnifiedResult(parseUnifiedResult(parseExtractionJson(responseText))) as LabImportResult;
}

export async function labImport(
  pages: PageContent[],
  _unitSystem: 'si' | 'conventional',
): Promise<{ result: LabImportResult | null; remaining?: number; error?: string; errorCode?: UploadErrorCode }> {
  const apiKey = getAnthropicKey();
  if (!apiKey) return { result: null, error: NO_KEY_MESSAGE, errorCode: 'server_error' };
  try {
    return { result: await extractDirect(apiKey, pages) };
  } catch (error) {
    if (error instanceof ByokAnthropicError) {
      return { result: null, error: error.message, errorCode: uploadErrorCode(error) };
    }
    // The error's kind only: a parse error can quote the report it failed on.
    console.warn('BYOK extraction error:', errorKind(error));
    return { result: null, error: 'Could not read this document. Try again.', errorCode: 'server_error' };
  }
}

// --- client-side "batch": a queue of direct calls behind the batch interface ---

interface ByokBatch {
  total: number;
  completed: number;
  done: boolean;
  results: NonNullable<BatchPollResponse['results']>;
}

const activeBatches = new Map<string, ByokBatch>();
const BATCH_CONCURRENCY = 2;

export async function labImportBatch(
  files: Array<{ pages: PageContent[] }>,
): Promise<{ batchId: string | null; error?: string; errorCode?: UploadErrorCode }> {
  const apiKey = getAnthropicKey();
  if (!apiKey) return { batchId: null, error: NO_KEY_MESSAGE, errorCode: 'server_error' };

  const batchId = `byok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const batch: ByokBatch = { total: files.length, completed: 0, done: false, results: [] };
  activeBatches.set(batchId, batch);

  void runBatch(apiKey, files, batch);
  return { batchId };
}

async function runBatch(
  apiKey: string,
  files: Array<{ pages: PageContent[] }>,
  batch: ByokBatch,
): Promise<void> {
  const results: ByokBatch['results'] = new Array(files.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < files.length) {
      const index = next++;
      try {
        results[index] = { ...await extractDirect(apiKey, files[index].pages), index };
      } catch (error) {
        // Marked by position, like the server batch path (pollBatch in
        // anthropic.server.ts), so the modal names the file and why (US-12 AC9).
        // By index and kind: a file name can hold a patient's name, an error message the report.
        console.warn(`BYOK batch: file ${index} failed:`, errorKind(error));
        results[index] = { index, errorCode: error instanceof ByokAnthropicError ? uploadErrorCode(error) : 'server_error' };
      }
      batch.completed += 1;
    }
  }

  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, files.length) }, () => worker()));
  batch.results = results;
  batch.done = true;
}

export async function pollBatchStatus(batchId: string): Promise<BatchPollResponse> {
  const batch = activeBatches.get(batchId);
  if (!batch) {
    return { status: 'ended', completed: 0, total: 0, error: 'Batch not found.', errorCode: 'server_restart' };
  }
  if (!batch.done) return { status: 'processing', completed: batch.completed, total: batch.total };
  activeBatches.delete(batchId);
  return { status: 'ended', completed: batch.completed, total: batch.total, results: batch.results };
}
