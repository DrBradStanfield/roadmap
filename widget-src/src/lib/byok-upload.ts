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
 * Each file is one direct call; the upload sends 5 at a time (health-core
 * UPLOAD_LIMITS), and Cancel aborts the calls in flight (US-12 AC28).
 */
import {
  EXTRACTION_MAX_TOKENS,
  UNIFIED_SYSTEM_PROMPT,
  pagesToContentBlocks,
  parseExtractionJson,
  parseUnifiedResult,
  toUnifiedResult,
} from '@roadmap/health-core/lab-extraction';
import { EXTRACTION_MODEL, extractionStopCode, modelParams } from '@roadmap/health-core/models';
import { getAnthropicKey } from './byok-chat';
import { ByokAnthropicError, callAnthropicDirectRaw, type ByokErrorCode } from './byok-anthropic';
import type { RequestFlags } from '@roadmap/health-core/upload-rules';
import { KEY_TEXT } from '@roadmap/health-core/upload-text';
import type { LabImportResult, PageContent, QuotaCheck, UploadErrorCode } from './api-types';

const NO_KEY_MESSAGE = KEY_TEXT.missing;

export async function checkLabImportQuota(): Promise<QuotaCheck> {
  if (!getAnthropicKey()) return { allowed: false, remaining: 0, reason: 'no-key', message: NO_KEY_MESSAGE };
  // The user's own key — any limits are theirs, enforced by Anthropic per call.
  return { allowed: true, remaining: Number.MAX_SAFE_INTEGER };
}

/** Map the shared transport's error code → the upload modal's UploadErrorCode. */
const UPLOAD_ERROR_CODE: Record<ByokErrorCode, UploadErrorCode> = {
  network: 'network',
  rate_limit: 'key_rate_limit', // the person's own key's minute limit, never our daily limit (US-12 AC9)
  unauthorized: 'key_refused',
  bad_request: 'server_error',
  empty: 'server_error',
  server_error: 'server_error',
  refused: 'refused',
  too_long: 'too_long',
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
 *  (same recovery as the server's extractOrClassify; Haiku 5.5 400s on the
 *  `{` prefill this used to send, US-15 AC34). An answer cut off at
 *  max_tokens is never a set of values and is cut off again, so it is not
 *  re-sent; the transport already throws on a refusal. */
async function extractDirect(apiKey: string, pages: PageContent[], signal?: AbortSignal): Promise<LabImportResult> {
  const body = {
    ...modelParams(EXTRACTION_MODEL, EXTRACTION_MAX_TOKENS),
    system: UNIFIED_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: pagesToContentBlocks(pages) }],
  };
  const send = async () => {
    const { text, stopReason } = await callAnthropicDirectRaw(apiKey, body, signal);
    if (extractionStopCode(stopReason) === 'too_long') throw new ByokAnthropicError('too_long', 'The file is too long to read in one go.');
    return text;
  };

  const responseText = await send();
  try {
    return toResult(responseText);
  } catch {
    return toResult(await send());
  }
}

function toResult(responseText: string): LabImportResult {
  // toUnifiedResult returns UnifiedExtractionResult; LabImportResult is the same
  // shape minus `unrecognized` (which the review UI doesn't consume) and with
  // document.classification typed DocumentType instead of string. The widening
  // cast is safe because the review UI reads document.classification as a plain
  // string; the extra `unrecognized` field is harmless if present.
  return toUnifiedResult(parseUnifiedResult(parseExtractionJson(responseText)), 'full') as LabImportResult;
}

export async function labImport(
  pages: PageContent[],
  _unitSystem: 'si' | 'conventional',
  // The flags ask the server's prompt for its day rules; the person's own key reads with the shared prompt.
  { signal }: { signal?: AbortSignal; flags?: RequestFlags } = {},
): Promise<{ result: LabImportResult | null; remaining?: number; error?: string; errorCode?: UploadErrorCode }> {
  const apiKey = getAnthropicKey();
  if (!apiKey) return { result: null, error: NO_KEY_MESSAGE, errorCode: 'server_error' };
  try {
    return { result: await extractDirect(apiKey, pages, signal) };
  } catch (error) {
    if (error instanceof ByokAnthropicError) {
      return { result: null, error: error.message, errorCode: uploadErrorCode(error) };
    }
    // The error's kind only: a parse error can quote the report it failed on.
    console.warn('BYOK extraction error:', errorKind(error));
    return { result: null, error: 'Could not read this document. Try again.', errorCode: 'server_error' };
  }
}

// The Pages build swaps upload-api.ts for this module, so tsc fails here when this module stops standing in for it.
({ checkLabImportQuota, labImport }) satisfies typeof import('./upload-api');
