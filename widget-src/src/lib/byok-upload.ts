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
  EXTRACTION_MODEL,
  UNIFIED_SYSTEM_PROMPT,
  extractJsonObject,
  pagesToContentBlocks,
  parseUnifiedResult,
  toUnifiedResult,
} from '@roadmap/health-core/lab-extraction';
import { getAnthropicKey } from './byok-chat';
import type { BatchPollResponse, LabImportResult, PageContent, UploadErrorCode } from './api';

const NO_KEY_MESSAGE =
  'Connect your Anthropic API key (in the "Ask about your plan" panel) to process documents on this page.';

export async function checkLabImportQuota(): Promise<{ allowed: boolean; remaining: number; message?: string }> {
  if (!getAnthropicKey()) return { allowed: false, remaining: 0, message: NO_KEY_MESSAGE };
  // The user's own key — any limits are theirs, enforced by Anthropic per call.
  return { allowed: true, remaining: Number.MAX_SAFE_INTEGER };
}

class ByokUploadError extends Error {
  constructor(message: string, readonly errorCode: UploadErrorCode) {
    super(message);
  }
}

/** One direct extraction call; retries once with a `{` prefill on bad JSON
 *  (same recovery as the server's extractOrClassifyOnce). */
async function extractDirect(apiKey: string, pages: PageContent[]): Promise<LabImportResult> {
  const content = pagesToContentBlocks(pages);
  const body = {
    model: EXTRACTION_MODEL,
    max_tokens: EXTRACTION_MAX_TOKENS,
    system: UNIFIED_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  };

  let responseText = await callAnthropicDirect(apiKey, body);
  try {
    return toResult(responseText);
  } catch {
    responseText = await callAnthropicDirect(apiKey, {
      ...body,
      messages: [
        { role: 'user', content },
        { role: 'assistant', content: [{ type: 'text', text: '{' }] },
      ],
    });
    return toResult('{' + responseText);
  }
}

function toResult(responseText: string): LabImportResult {
  const unified = toUnifiedResult(parseUnifiedResult(JSON.parse(extractJsonObject(responseText))));
  // Structurally identical; document.classification narrows string → DocumentType,
  // which the zod enum in parseUnifiedResult already guarantees.
  return unified as LabImportResult;
}

async function callAnthropicDirect(apiKey: string, body: Record<string, unknown>): Promise<string> {
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ByokUploadError('Network error reaching Anthropic. Check your connection.', 'network');
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new ByokUploadError(
        'Anthropic rejected your API key. Disconnect it (link below the chat box) and reconnect with a valid key.',
        'server_error',
      );
    }
    if (response.status === 429) {
      throw new ByokUploadError(
        'Your Anthropic account is rate-limited right now — wait a minute and try again.',
        'rate_limit',
      );
    }
    if (response.status === 400) {
      const errBody = await response.json().catch(() => null);
      const detail = errBody?.error?.message;
      throw new ByokUploadError(detail ? `Anthropic error: ${detail}` : 'Anthropic rejected the request.', 'server_error');
    }
    throw new ByokUploadError(`Anthropic error (${response.status}). Try again shortly.`, 'server_error');
  }

  const data = await response.json();
  const text = (data?.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('');
  if (!text) throw new ByokUploadError('Empty response from Anthropic. Try again.', 'server_error');
  return text;
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
    if (error instanceof ByokUploadError) {
      return { result: null, error: error.message, errorCode: error.errorCode };
    }
    console.warn('BYOK extraction error:', error);
    return { result: null, error: 'Could not read this document. Try again.', errorCode: 'server_error' };
  }
}

// --- client-side "batch": a queue of direct calls behind the batch interface ---

interface ByokBatch {
  total: number;
  completed: number;
  done: boolean;
  results: Array<LabImportResult & { fileName: string }>;
}

const activeBatches = new Map<string, ByokBatch>();
const BATCH_CONCURRENCY = 2;

export async function labImportBatch(
  files: Array<{ fileName: string; pages: PageContent[] }>,
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
  files: Array<{ fileName: string; pages: PageContent[] }>,
  batch: ByokBatch,
): Promise<void> {
  const results = new Array<LabImportResult & { fileName: string }>(files.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      let result: LabImportResult;
      try {
        result = await extractDirect(apiKey, file.pages);
      } catch (error) {
        // Per-file failure → empty 'other' result, matching the server batch
        // path (pollBatch in anthropic.server.ts) so review UI behaves the same.
        console.warn(`BYOK batch: ${file.fileName} failed:`, error);
        result = { classification: 'other', reportDate: null, values: [], additionalValues: [], document: null };
      }
      results[index] = { ...result, fileName: file.fileName };
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
