/**
 * SERVER-TRANSPORT lab extraction for the v2 builds — the upload functions
 * that POST to Brad's stateless extraction endpoint (api.lab-import-v2):
 * same Claude pipeline as the v1 proxy path, §7 transit-never-store,
 * per-IP + per-day caps server-side.
 *
 * Phase-5 hardening (2026-06-11): calls go THROUGH the Shopify app proxy
 * (relative path, same-origin on drstanfield.com) so every request carries
 * Shopify's un-forgeable signature — the server accepts nothing else. This
 * replaced the cross-origin direct-to-Fly URL + Origin allow-list.
 *
 * Transport selection is a BUILD-TIME module swap (same mechanism as
 * api.ts → roadmap-data.ts):
 *  - Shopify v2 build (drstanfield.com page): uses THIS module — Brad pays.
 *  - Pages/self-host build: vite.config.standalone.ts redirects this module
 *    → byok-upload.ts (the user's own Anthropic key, browser-direct).
 */
import { EXTRACTION_STOP_CODES } from '@roadmap/health-core/models';
import * as z from '@roadmap/health-core/zod';
import { parseJsonResponse, PROXY_PATH } from './server-api';
import type { BatchPollResponse, LabImportResult, PageContent, QuotaCheck, UploadErrorCode } from './api-types';

const LAB_IMPORT_V2_URL = `${PROXY_PATH}/api/lab-import-v2`;

export async function checkLabImportQuota(): Promise<QuotaCheck> {
  try {
    const response = await fetch(LAB_IMPORT_V2_URL);
    if (!response.ok) return { allowed: true, remaining: 0 }; // optimistic — the POST enforces
    const data = await parseJsonResponse<{ allowed: boolean; remaining: number }>(response);
    if (data && !data.allowed) return { allowed: false, remaining: data.remaining, reason: 'quota' };
    return { allowed: true, remaining: data?.remaining ?? 0 };
  } catch {
    return { allowed: true, remaining: 0 }; // optimistic — the POST enforces
  }
}

export async function labImport(
  pages: PageContent[],
  unitSystem: 'si' | 'conventional',
): Promise<{ result: LabImportResult | null; remaining?: number; error?: string; errorCode?: UploadErrorCode }> {
  try {
    const response = await fetch(LAB_IMPORT_V2_URL, {
      method: 'POST',
      // No Content-Type header — the route parses JSON regardless of it
      // (parseSimpleRequestJson). Same-origin via the app proxy; no CORS here.
      // `ownDates`: this widget files a value on its own day (US-12 AC12);
      // `undatedPrev`: it asks the day of an undated previous column (AC14);
      // `refusedRows`: it lists refused values under "Not saved" (AC15).
      body: JSON.stringify({ pages, unitSystem, ownDates: true, undatedPrev: true, refusedRows: true }),
    });
    if (response.status === 429) {
      return { result: null, error: 'Daily upload limit reached. You can upload more tomorrow.', errorCode: 'rate_limit' };
    }
    if (response.status === 422) {
      // A file Claude declined or stopped short on: the code says which (US-15 AC34).
      const code = (await parseJsonResponse<{ errorCode?: string }>(response))?.errorCode;
      const stop = EXTRACTION_STOP_CODES.find(c => c === code);
      return { result: null, error: 'Not read', errorCode: stop ?? 'server_error' };
    }
    if (!response.ok) return { result: null, error: 'Extraction failed', errorCode: 'server_error' };
    const data = await parseJsonResponse<{ success: boolean; data?: LabImportResult; remaining?: number; error?: string }>(response);
    if (!data?.success || !data.data) return { result: null, error: data?.error || 'Extraction failed', errorCode: 'server_error' };
    return { result: data.data, remaining: data.remaining };
  } catch (error) {
    console.warn('Lab import error:', error instanceof Error ? error.name : typeof error);
    return { result: null, error: 'Network error', errorCode: 'network' };
  }
}

/**
 * The poll token the batch POST handed back, per batch id. A batch id alone
 * does not read results — the server wants this too — and keeping it here means
 * the callers pass a batch id around exactly as they always did. It is dropped
 * when the batch ends; the map only ever holds this tab's own batches.
 */
const pollTokens = new Map<string, string>();

export async function labImportBatch(
  files: Array<{ pages: PageContent[] }>,
  // Used by the Pages build's queue (byok-upload.ts, US-12 AC5a). Here the
  // batch is one request, unchanged.
  _signal?: AbortSignal,
): Promise<{ batchId: string | null; error?: string; errorCode?: UploadErrorCode }> {
  try {
    const response = await fetch(LAB_IMPORT_V2_URL, {
      method: 'POST',
      // No real name: a file name can hold a patient's name. Results come back
      // by request index, and the modal maps the index to its file. `fileName`
      // is a compatibility label that names nothing: a server older than
      // 2026-10-13 requires the field, and CI ships this widget before the
      // server. Drop it once every live server strips it.
      body: JSON.stringify({ batch: true, ownDates: true, undatedPrev: true, refusedRows: true, files: files.map(({ pages }, i) => ({ fileName: `file-${i + 1}`, pages })) }),
    });
    if (response.status === 429) {
      return { batchId: null, error: 'Daily upload limit reached. You can upload more tomorrow.', errorCode: 'rate_limit' };
    }
    if (!response.ok) return { batchId: null, error: 'Failed to start batch processing', errorCode: 'server_error' };
    const data = await parseJsonResponse<{ success: boolean; batchId?: string; pollToken?: string; error?: string }>(response);
    if (!data?.success || !data.batchId) return { batchId: null, error: data?.error || 'Batch creation failed', errorCode: 'server_error' };
    if (data.pollToken) pollTokens.set(data.batchId, data.pollToken);
    return { batchId: data.batchId };
  } catch (error) {
    // The error's kind only: a parse error can quote the body, lab text included.
    console.warn('Batch import error:', error instanceof Error ? error.name : typeof error);
    return { batchId: null, error: 'Network error', errorCode: 'network' };
  }
}

const pollCount = z.number().int().nonnegative();
/** A poll answer as the pipeline reads it, checked once where it enters (US-12 AC24): counts it can
 *  show, and an end that says what ended. A result's own fields are read by the review, not here. */
export const batchPollAnswer = z.union([
  z.object({ status: z.enum(['processing', 'error']), completed: pollCount, total: pollCount }),
  z.looseObject({ status: z.literal('ended'), completed: pollCount, total: pollCount,
    results: z.array(z.looseObject({})).optional(), error: z.string().min(1).optional(), errorCode: z.string().optional() })
    // The loop finishes only on results and throws only on error text (upload-pipeline.ts:350-352).
    .refine(p => p.results !== undefined || p.error !== undefined),
]);

/** A failed poll that can change (a 5xx, a network throw, a drop while the body streams) answers
 *  `error` and the caller polls on. One that cannot (404, 401, 403, an answer that is not a poll)
 *  ends the watch (US-12 AC24). */
export async function pollBatchStatus(batchId: string): Promise<BatchPollResponse> {
  const ended = (error: string, errorCode: UploadErrorCode): BatchPollResponse => {
    pollTokens.delete(batchId);
    return { status: 'ended', completed: 0, total: 0, error, errorCode };
  };
  let response: Response;
  let text = '';
  try {
    const token = pollTokens.get(batchId) ?? '';
    // A POST so the token travels in the body: the server logs request URLs
    // (morgan) and a logged token reads the extracted lab text back.
    response = await fetch(LAB_IMPORT_V2_URL, {
      method: 'POST',
      body: JSON.stringify({ batchId, pollToken: token }),
    });
    // The body is part of the call: a drop while it streams can change, as a fetch throw can.
    if (response.ok) text = await response.text();
  } catch {
    return { status: 'error', completed: 0, total: 0 };
  }
  if (response.status === 404) return ended('Batch not found — server may have restarted.', 'server_restart');
  if (response.status === 401 || response.status === 403) return ended('Batch poll refused', 'server_error');
  if (!response.ok) return { status: 'error', completed: 0, total: 0 };
  let body: unknown = null;
  try {
    if ((response.headers.get('content-type') ?? '').includes('application/json')) body = JSON.parse(text);
  } catch { /* malformed: refused below */ }
  const poll = batchPollAnswer.safeParse(body);
  if (!poll.success) return ended('Batch poll answer unreadable', 'server_error');
  if (poll.data.status === 'ended') pollTokens.delete(batchId);
  // The schema checks what the loop reads; each result's own shape is the review's to read.
  return poll.data as BatchPollResponse;
}
