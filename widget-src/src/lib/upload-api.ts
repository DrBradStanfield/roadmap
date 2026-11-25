/**
 * SERVER-TRANSPORT lab extraction for the v2 builds — the upload function
 * that POSTs to Brad's stateless extraction endpoint (api.lab-import-v2):
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
import { requestFlags, type RequestFlags } from '@roadmap/health-core/upload-rules';
import { uploadFailure } from '@roadmap/health-core/upload-failure';
import { parseJsonResponse, PROXY_PATH } from './server-api';
import type { LabImportResult, PageContent, QuotaCheck, UploadErrorCode } from './api-types';

const LAB_IMPORT_V2_URL = `${PROXY_PATH}/api/lab-import-v2`;

/** What a failed read says, by its code (health-core upload-failure.ts reads the code). */
const FAILURE_TEXT: Partial<Record<UploadErrorCode, string>> = {
  rate_limit: 'Daily upload limit reached. You can upload more tomorrow.',
  busy: 'Server busy. Please try again later.',
  refused: 'Not read',
  too_long: 'Not read',
  network: 'Network error',
};

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

/**
 * One file's read. `signal`: the upload's Cancel or Stop aborts it (US-12 AC28). `flags`: the
 * shared upload state's request flags (health-core `requestFlags`): `ownDates` files a value on its
 * own day (US-12 AC12), `undatedPrev` asks the day of an undated previous column (AC14),
 * `refusedRows` lists refused values under "Not saved" (AC15).
 */
export async function labImport(
  pages: PageContent[],
  unitSystem: 'si' | 'conventional',
  { signal, flags = requestFlags('web') }: { signal?: AbortSignal; flags?: RequestFlags } = {},
): Promise<{ result: LabImportResult | null; remaining?: number; error?: string; errorCode?: UploadErrorCode }> {
  try {
    const response = await fetch(LAB_IMPORT_V2_URL, {
      method: 'POST',
      // No Content-Type header — the route parses JSON regardless of it
      // (parseSimpleRequestJson). Same-origin via the app proxy; no CORS here.
      body: JSON.stringify({ pages, unitSystem, ...flags }),
      signal,
    });
    // undefined: said JSON but would not parse (upload-failure.ts reads it as a network error).
    const body = await parseJsonResponse<{ success?: boolean; data?: LabImportResult; remaining?: number; error?: string }>(response).catch(() => undefined);
    if (response.ok && body?.success && body.data) return { result: body.data, remaining: body.remaining };
    const errorCode = uploadFailure(response.status, body);
    return { result: null, error: FAILURE_TEXT[errorCode] ?? ((response.ok && body?.error) || 'Extraction failed'), errorCode };
  } catch (error) {
    // The error's kind only: a parse error can quote the body, lab text included.
    console.warn('Lab import error:', error instanceof Error ? error.name : typeof error);
    return { result: null, error: 'Network error', errorCode: 'network' };
  }
}
