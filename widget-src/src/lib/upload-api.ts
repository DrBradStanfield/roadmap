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
import { parseJsonResponse, PROXY_PATH } from './api';
import type { BatchPollResponse, LabImportResult, PageContent, UploadErrorCode } from './api';

const LAB_IMPORT_V2_URL = `${PROXY_PATH}/api/lab-import-v2`;

export async function checkLabImportQuota(): Promise<{ allowed: boolean; remaining: number; message?: string }> {
  try {
    const response = await fetch(LAB_IMPORT_V2_URL);
    if (!response.ok) return { allowed: false, remaining: 0 };
    return (await parseJsonResponse<{ allowed: boolean; remaining: number }>(response)) ?? { allowed: true, remaining: 0 };
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
      body: JSON.stringify({ pages, unitSystem }),
    });
    if (response.status === 429) {
      return { result: null, error: 'Daily upload limit reached. You can upload more tomorrow.', errorCode: 'rate_limit' };
    }
    if (!response.ok) return { result: null, error: 'Extraction failed', errorCode: 'server_error' };
    const data = await parseJsonResponse<{ success: boolean; data?: LabImportResult; remaining?: number; error?: string }>(response);
    if (!data?.success || !data.data) return { result: null, error: data?.error || 'Extraction failed', errorCode: 'server_error' };
    return { result: data.data, remaining: data.remaining };
  } catch (error) {
    console.warn('Lab import error:', error);
    return { result: null, error: 'Network error', errorCode: 'network' };
  }
}

export async function labImportBatch(
  files: Array<{ fileName: string; pages: PageContent[] }>,
): Promise<{ batchId: string | null; error?: string; errorCode?: UploadErrorCode }> {
  try {
    const response = await fetch(LAB_IMPORT_V2_URL, {
      method: 'POST',
      body: JSON.stringify({ batch: true, files }),
    });
    if (response.status === 429) {
      return { batchId: null, error: 'Daily upload limit reached. You can upload more tomorrow.', errorCode: 'rate_limit' };
    }
    if (!response.ok) return { batchId: null, error: 'Failed to start batch processing', errorCode: 'server_error' };
    const data = await parseJsonResponse<{ success: boolean; batchId?: string; error?: string }>(response);
    if (!data?.success || !data.batchId) return { batchId: null, error: data?.error || 'Batch creation failed', errorCode: 'server_error' };
    return { batchId: data.batchId };
  } catch (error) {
    console.warn('Batch import error:', error);
    return { batchId: null, error: 'Network error', errorCode: 'network' };
  }
}

export async function pollBatchStatus(batchId: string): Promise<BatchPollResponse> {
  try {
    const response = await fetch(`${LAB_IMPORT_V2_URL}?batchId=${encodeURIComponent(batchId)}`);
    if (response.status === 404) {
      return { status: 'ended', completed: 0, total: 0, error: 'Batch not found — server may have restarted.', errorCode: 'server_restart' };
    }
    if (!response.ok) return { status: 'processing', completed: 0, total: 0 };
    return (await parseJsonResponse<BatchPollResponse>(response)) ?? { status: 'processing', completed: 0, total: 0 };
  } catch {
    return { status: 'processing', completed: 0, total: 0 };
  }
}
