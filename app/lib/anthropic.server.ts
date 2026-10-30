/**
 * Anthropic API wrapper for health document processing.
 * System prompt is hardcoded server-side — client sends only content.
 *
 * extractOrClassify() auto-classifies each file and either extracts lab
 * values or converts it to markdown + metadata, in a single LLM call, under
 * the prompt health-core renders from its own alias and unit tables.
 */
import * as Sentry from '@sentry/react-router';
import {
  UNIFIED_SYSTEM_PROMPT,
  unifiedSystemPrompt,
  EXTRACTION_MAX_TOKENS,
  parseUnifiedResult,
  toUnifiedResult,
  parseExtractionJson,
  pagesToContentBlocks,
  type DocumentPromptMode,
  type PageContent,
  type UnifiedExtractionResult,
} from '../../packages/health-core/src/lab-extraction';
import {
  EXTRACTION_MODEL, extractionStopCode, modelParams, toRefusalCategory, type ExtractionStopCode, type RefusalCategory,
} from '../../packages/health-core/src/models';
import { sleep } from './cron-helpers.server';

// The pure extraction pieces (prompt, schema parsing, unit resolution) live in
// health-core/lab-extraction.ts — shared with the standalone BYOK upload path
// so the two can never drift. Re-exported here so existing importers + tests
// keep their import paths.
export {
  resolveUnit,
  resolveLabValues,
  parseUnifiedResult,
  stripCodeFences,
  extractJsonObject,
} from '../../packages/health-core/src/lab-extraction';
export type {
  ExtractedValue,
  PageContent,
  DocumentResult,
  AdditionalLabValue,
  UnifiedExtractionResult,
} from '../../packages/health-core/src/lab-extraction';

// ---------------------------------------------------------------------------
// Unified document processing (classify + extract/convert in one call)
// ---------------------------------------------------------------------------

/** Plenty for a lab panel or a document's metadata; the larger caps exist for markdown transcription. */
const METADATA_MAX_TOKENS = 3072;

/**
 * The website's single file, below the batch's EXTRACTION_MAX_TOKENS: the call
 * is not streamed and times out at 60 s. Haiku 5.5 wrote 219 tokens/s in one
 * measurement (2026-10-16), so 10000 takes ~46 s and 12288 ~56 s (US-15 AC34).
 */
const SINGLE_FILE_MAX_TOKENS = 10000;

/**
 * Thrown by `extractOrClassify` on a refusal or a max_tokens stop. The same
 * request stops the same way again, so nothing re-sends it (US-15 AC34).
 */
export class ExtractionStopError extends Error {
  constructor(readonly code: ExtractionStopCode, readonly refusalCategory?: RefusalCategory) {
    super(code === 'refused' ? 'Anthropic refusal' : 'Anthropic answer hit max_tokens');
    this.name = 'ExtractionStopError';
  }
}

/** One bounded Sentry signal per stopped file: the code and refusal category, never text. */
export function reportExtractionStop(
  code: ExtractionStopCode, refusalCategory: RefusalCategory | undefined, path: 'single' | 'batch' | 'connector',
): void {
  Sentry.captureMessage(`Lab import: extraction ${code}`, {
    level: 'warning',
    tags: { feature: 'lab_import_v2', path, stopCode: code, ...(refusalCategory ? { refusalCategory } : {}) },
  });
}

/**
 * The stop check, then the parse: one step for the single call and the batch.
 * Throws ExtractionStopError on a refusal or a max_tokens stop; `undefined`
 * means the answer will not parse.
 */
function readExtraction(result: AnthropicResult, mode: DocumentPromptMode): UnifiedExtractionResult | undefined {
  const stop = extractionStopCode(result.stopReason);
  if (stop) throw new ExtractionStopError(stop, result.refusalCategory);
  try {
    return toUnifiedResult(parseUnifiedResult(parseExtractionJson(result.content)), mode);
  } catch {
    // The error CLASS only, never its message: a SyntaxError quotes ~10 chars
    // of the model's answer and Zod names the values it received — both are
    // document text, and the callers' errors reach console.error and Sentry.
    return undefined;
  }
}

/**
 * Unified extraction: classifies the document and either extracts lab values
 * or converts to markdown + metadata, in a single LLM call.
 *
 * At most two calls (US-15 AC34). A refusal or a max_tokens stop fails the
 * file at once: the same request stops the same way again. Only an answer
 * that ended normally but did not parse is re-sent, once, as the SAME request
 * (Haiku 5.5 400s on the `{` prefill this used to send). `timeoutMs` is ONE
 * deadline for both calls, the re-send getting what is left, so the
 * connector's import (US-35 AC5, AC10) cannot be run past its tool-call
 * budget; it also passes `httpAttempts: 1` so a hung call fails fast.
 */
export async function extractOrClassify(
  pages: PageContent[],
  opts: { timeoutMs?: number; httpAttempts?: number; documentMode?: DocumentPromptMode } = {},
): Promise<UnifiedExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const documentMode = opts.documentMode ?? 'full';
  const body = {
    ...modelParams(EXTRACTION_MODEL, documentMode === 'metadata' ? METADATA_MAX_TOKENS : SINGLE_FILE_MAX_TOKENS),
    system: unifiedSystemPrompt(documentMode),
    messages: [{ role: 'user', content: pagesToContentBlocks(pages) }],
  };
  const until = opts.timeoutMs === undefined ? undefined : Date.now() + opts.timeoutMs;
  const left = () => {
    if (until === undefined) return undefined;
    const ms = until - Date.now();
    if (ms <= 0) throw new DOMException('extraction deadline passed', 'TimeoutError');
    return ms;
  };

  for (let call = 1; ; call++) {
    const parsed = readExtraction(await fetchAnthropicRaw(apiKey, body, left(), opts.httpAttempts), documentMode);
    if (parsed) return parsed;
    // A fixed message and no `cause`: Sentry serialises it (api.lab-import-v2).
    if (call >= 2) throw new Error('extraction returned malformed JSON');
  }
}

// ---------------------------------------------------------------------------
// Low-level API call
// ---------------------------------------------------------------------------

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** One block of an Anthropic Messages `content` array (text, thinking or tool_use), kept whole so a tool round can replay it unmodified. */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  /** tool_use: the id its tool_result answers. */
  id?: string;
  name?: string;
  input?: unknown;
  /** thinking: the summary and the signature the API checks on replay. */
  thinking?: string;
  signature?: string;
}

export interface AnthropicResult {
  content: string;
  usage: AnthropicUsage;
  contentBlocks: AnthropicContentBlock[];
  /** `stop_reason` as sent: 'end_turn', 'tool_use', 'max_tokens', 'refusal', … */
  stopReason?: string;
  /** Set only on a refusal. */
  refusalCategory?: RefusalCategory;
}

/**
 * Shared fetch + error handling. Returns text content + usage metrics.
 *
 * A refusal (HTTP 200, `stop_reason: 'refusal'`, usually no text) is its own
 * result, not "No text in Anthropic response": content and blocks come back
 * empty, because text written before the model declined is not an answer.
 *
 * Retry policy: one retry with 1s backoff on transient infrastructure errors
 * (HTTP 502, 503, 504, 529, plus network/timeout failures from fetch()). These
 * cost nothing on Anthropic's side (the request didn't execute end-to-end), and
 * a single-tick capacity blip routinely clears in the next second. Without this
 * retry, a single Anthropic overload during a customer's chat turn produced a
 * fallback ("Sorry — I'm having trouble responding") that the customer saw as
 * a broken bot — see claude_business docs/chat-knowledge-map-v2-changelog.md 2026-06-05 entry for the
 * precedent (a customer asked the same question twice in 30s and got fallback
 * both times during a brief 01:50 UTC June 4 outage). Real persistent errors
 * (auth, 4xx validation, malformed responses, 429 structural rate-limit) throw
 * immediately so the chat handler returns the fallback without compounding
 * latency.
 *
 * 429 is treated as structural (account tier too low, runaway caller, or a real
 * outage requiring intervention) — not retried, surfaced via Sentry.
 *
 * 503 and 529 are transient capacity signals — retried, and (if both attempts
 * fail) the final throw is silenced from Sentry to avoid flooding alerts during
 * capacity spikes. Other 5xx (502, 504) are retried but Sentry-alerted if they
 * persist past the retry, because persistent 502/504 often indicates a real
 * issue with the request path rather than just capacity.
 */
const RETRY_MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;
const RETRYABLE_STATUSES = new Set([502, 503, 504, 529]);
const TRANSIENT_CAPACITY_STATUSES = new Set([503, 529]); // silenced from Sentry on final failure

/**
 * Network/timeout errors thrown by Node's fetch(): TypeError "fetch failed"
 * on connection-level failures, DOMException name=TimeoutError when
 * AbortSignal.timeout fires, AbortError if the signal was manually aborted.
 * Errors our own code throws after `response.ok` ("Anthropic API error",
 * "No text in Anthropic response") are NOT in scope — those are status-coded
 * via the inner retry path or won't fix themselves.
 */
export function isNetworkOrTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return err instanceof TypeError && err.message === 'fetch failed';
}

/**
 * Parse a provider body without ever quoting it back. Node's JSON.parse puts a
 * fragment of the offending body in its SyntaxError message, and lab-import
 * hands that error straight to console.error and Sentry — a malformed 200 can
 * carry the user's own lab text there. Same reason the !ok paths keep only the
 * closed-list error type (US-15 AC40). SyntaxError is deliberate: classifyChatError still tags it 'parse'.
 * No `cause`, so nothing of the body survives serialisation either.
 */
async function parseJsonBody(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch (err) {
    // Only a parse failure gets the fixed message. A body read aborted by
    // AbortSignal.timeout rejects with DOMException TimeoutError — rethrow it
    // so fetchAnthropicRaw still retries it and Sentry still tags it 'timeout'.
    if (err instanceof SyntaxError) throw new SyntaxError('Anthropic response was not JSON');
    throw err;
  }
}

/** Refusal handling and the empty-answer check, shared by the JSON and streamed reads. */
function toResult(
  blocks: AnthropicContentBlock[], usage: AnthropicUsage, stopReason: string | undefined, category: unknown,
): AnthropicResult {
  if (stopReason === 'refusal') {
    return { content: '', contentBlocks: [], usage, stopReason, refusalCategory: toRefusalCategory(category) };
  }
  const text = blocks
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('');
  const hasToolUse = blocks.some(b => b.type === 'tool_use');
  // A response carrying ONLY tool_use blocks (the model proposed a form
  // edit with no prose) is valid — don't treat it as an empty failure. Nor is
  // a max_tokens stop with no text (thinking used the budget): the caller
  // logs its stop reason and answers with the fallback.
  if (!text && !hasToolUse && stopReason !== 'max_tokens') throw new Error('No text in Anthropic response');

  return { content: text, contentBlocks: blocks, usage, stopReason };
}

function toUsage(u: Record<string, number | undefined> | undefined): AnthropicUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
  };
}

async function readJson(response: Response): Promise<AnthropicResult> {
  const data = await parseJsonBody(response);
  return toResult((data.content as AnthropicContentBlock[]) ?? [], toUsage(data.usage), data.stop_reason ?? undefined, data.stop_details?.category);
}

/** Anthropic's error types, a closed set: the one part of an error body we keep. */
const ANTHROPIC_ERROR_TYPES = new Set([
  'invalid_request_error', 'authentication_error', 'billing_error', 'permission_error', 'not_found_error',
  'request_too_large', 'rate_limit_error', 'api_error', 'timeout_error', 'overloaded_error',
]);
const ERROR_BODY_MAX_BYTES = 4096;

/** A type off the closed list is 'other'; a missing one 'unknown'. Never the raw value. */
function toErrorType(type: unknown): string {
  if (typeof type !== 'string' || !type) return 'unknown';
  return ANTHROPIC_ERROR_TYPES.has(type) ? type : 'other';
}

/**
 * The error body's `error.type`, and nothing else from it (US-15 AC40): the
 * message may echo uploaded or chat content. Reads at most 4 KB under the
 * request's own timeout; past the cap, unparseable, or a failed read is
 * 'unknown'. Never throws.
 */
async function readErrorType(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return 'unknown';
  try {
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      bytes += chunk.value.byteLength;
      if (bytes > ERROR_BODY_MAX_BYTES) return 'unknown';
      text += decoder.decode(chunk.value, { stream: true });
    }
    return toErrorType(JSON.parse(text + decoder.decode())?.error?.type);
  } catch {
    return 'unknown';
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * How a read tells the retry loop it has started consuming a stream (after
 * which nothing is retried), and the abort it uses for its idle timeout.
 */
interface ReadControl { began(): void; idle: AbortController }

/**
 * The one POST to /v1/messages: auth headers, the overall timeout, body
 * discard on a retried error (only the type is read from a final one), and
 * the retry policy above. `read` turns a 200 into the
 * result; a retryable network or timeout error is retried only while nothing
 * has been read (`began` not called).
 * `maxAttempts` below the default turns the inner retry off for a caller whose own deadline cannot absorb it (US-35 AC5).
 */
async function fetchAnthropicRaw(
  apiKey: string, body: Record<string, unknown>, timeoutMs = 60_000, maxAttempts = RETRY_MAX_ATTEMPTS,
  read: (response: Response, control: ReadControl) => Promise<AnthropicResult> = readJson,
): Promise<AnthropicResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let began = false;
    const idle = new AbortController();
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), idle.signal]),
      });

      if (!response.ok) {
        if (RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts) {
          // Discard provider bodies: errors may echo uploaded or chat content.
          await response.body?.cancel();
          console.warn(`Anthropic API ${response.status} on attempt ${attempt}/${maxAttempts}, retrying after ${RETRY_DELAY_MS}ms`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        const errorType = await readErrorType(response);
        const err = new Error(`Anthropic API error (status ${response.status}) (${errorType})`);
        console.error(err.message);
        if (!TRANSIENT_CAPACITY_STATUSES.has(response.status)) {
          Sentry.captureException(err, {
            tags: { anthropic_error_type: errorType },
            extra: { status: response.status, attempt, errorType },
          });
        }
        throw err;
      }

      return await read(response, { began: () => { began = true; }, idle });
    } catch (err) {
      if (!began && isNetworkOrTimeoutError(err) && attempt < maxAttempts) {
        const e = err as Error;
        console.warn(`Anthropic API ${e.name} on attempt ${attempt}/${maxAttempts}: ${e.message} — retrying after ${RETRY_DELAY_MS}ms`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }

  // Unreachable — the loop body always returns, continues, or throws on the
  // final attempt. TypeScript requires an exit; this satisfies it without an
  // error path that can actually execute.
  throw new Error('fetchAnthropicRaw: retry loop exited unexpectedly');
}

// ---------------------------------------------------------------------------
// Streaming (US-15 AC16/AC17): the web chat shows the answer and the thinking
// summary as they are written. Discord and YouTube stay on the JSON call.
// ---------------------------------------------------------------------------

/** A delta the web chat forwards: the thinking summary or the answer text. */
export interface AnthropicStreamEvent { type: 'thinking' | 'text'; text: string }

/** Longest silence between chunks once a stream has begun. */
const STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * Read the SSE body into the same result the JSON read returns: text,
 * thinking and tool_use blocks (tool input parsed at its block's end), usage
 * from message_start merged with message_delta, and the stop reason. A
 * refusal returns the empty refusal result even though text already went to
 * `onEvent` — the client replaces it with the refusal line. A tool input that
 * is not whole JSON (max_tokens cut it) drops that block. An `error` event, a
 * malformed line, or a stream that ends before message_stop throws; none of
 * them quote the provider's text.
 */
async function readEventStream(
  response: Response, onEvent: (event: AnthropicStreamEvent) => void, control: ReadControl,
): Promise<AnthropicResult> {
  const blocks: Array<AnthropicContentBlock & Record<string, any>> = [];
  const toolJson = new Map<number, string>();
  let rawUsage: Record<string, number> = {};
  let stopReason: string | undefined;
  let category: unknown;
  let stopped = false;

  const handle = (event: any) => {
    switch (event.type) {
      case 'message_start':
        rawUsage = { ...event.message?.usage };
        break;
      case 'content_block_start':
        blocks[event.index] = { ...event.content_block };
        if (event.content_block?.type === 'tool_use') toolJson.set(event.index, '');
        break;
      case 'content_block_delta': {
        const block = blocks[event.index];
        const delta = event.delta ?? {};
        if (!block) break;
        if (delta.type === 'text_delta') {
          block.text = (block.text ?? '') + delta.text;
          onEvent({ type: 'text', text: delta.text });
        } else if (delta.type === 'thinking_delta') {
          block.thinking = (block.thinking ?? '') + delta.thinking;
          onEvent({ type: 'thinking', text: delta.thinking });
        } else if (delta.type === 'signature_delta') {
          block.signature = (block.signature ?? '') + delta.signature;
        } else if (delta.type === 'input_json_delta') {
          toolJson.set(event.index, (toolJson.get(event.index) ?? '') + delta.partial_json);
        }
        break;
      }
      case 'content_block_stop': {
        const json = toolJson.get(event.index);
        if (json === undefined || !blocks[event.index]) break;
        // max_tokens can cut a tool's input mid-JSON: drop that block, keep the text.
        try { blocks[event.index].input = json ? JSON.parse(json) : {}; } catch { delete blocks[event.index]; }
        break;
      }
      case 'message_delta':
        Object.assign(rawUsage, event.usage);
        stopReason = event.delta?.stop_reason ?? undefined;
        category = event.delta?.stop_details?.category;
        break;
      case 'message_stop':
        stopped = true;
        break;
      case 'error': {
        // The type only, from the closed set: the message can echo the conversation.
        throw new Error(`Anthropic stream error (${toErrorType(event.error?.type)})`);
      }
    }
  };

  if (!response.body) throw new Error('Anthropic stream ended early');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => control.idle.abort(new DOMException('Anthropic stream idle', 'TimeoutError')), STREAM_IDLE_TIMEOUT_MS);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      control.began();
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        // One JSON object per `data:` line; `event:` names repeat its type.
        if (!line.startsWith('data:')) continue;
        handle(JSON.parse(line.slice(5)));
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    // A `data:` line that failed JSON.parse: same fixed message as parseJsonBody.
    if (err instanceof SyntaxError) throw new SyntaxError('Anthropic response was not JSON');
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }
  if (!stopped) throw new Error('Anthropic stream ended early');

  return toResult(blocks.filter(Boolean), toUsage(rawUsage), stopReason, category);
}

/** Text + usage + raw content blocks wrapper — for chat (prompt caching
 *  metrics + tool_use parsing). `maxAttempts: 1` turns the retry off (US-15 AC44's scrub). */
export async function callAnthropicWithUsage(
  body: Record<string, unknown>, timeoutMs = 60_000, maxAttempts?: number,
): Promise<AnthropicResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  return fetchAnthropicRaw(apiKey, body, timeoutMs, maxAttempts);
}

/** callAnthropicWithUsage, streamed: deltas go to `onEvent`, the result is the same shape. */
export async function streamAnthropicWithUsage(
  body: Record<string, unknown>, onEvent: (event: AnthropicStreamEvent) => void, timeoutMs = 60_000,
): Promise<AnthropicResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  return fetchAnthropicRaw(apiKey, { ...body, stream: true }, timeoutMs, undefined,
    (response, control) => readEventStream(response, onEvent, control));
}

// stripCodeFences / extractJsonObject moved to health-core/lab-extraction.ts
// (re-exported at the top of this file).

// ---------------------------------------------------------------------------
// Batch API — processes all files in a single batch request
// ---------------------------------------------------------------------------

/** A batch Anthropic certainly did not create: no key, or a non-OK answer. Any
 *  other failure (timeout, network, unreadable 200) may have left one behind. */
export class BatchRefusedError extends Error {}

/** Create a batch of LLM requests — one per file, named by its index alone
 *  (`file-N`): the browser keeps the file names. Returns the batch ID. */
export async function createBatch(
  files: Array<{ pages: PageContent[] }>,
): Promise<{ batchId: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new BatchRefusedError('ANTHROPIC_API_KEY not configured');

  const requests = files.map((file, index) => ({
    custom_id: `file-${index}`,
    params: {
      ...modelParams(EXTRACTION_MODEL, EXTRACTION_MAX_TOKENS),
      system: UNIFIED_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: pagesToContentBlocks(file.pages) }],
    },
  }));

  const response = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    // Discard provider bodies: a 400 can echo the request, i.e. the user's lab pages.
    await response.body?.cancel();
    const err = new BatchRefusedError(`Batch API error (status ${response.status})`);
    console.error(err.message);
    Sentry.captureException(err, { extra: { status: response.status } });
    throw err;
  }

  const data = await parseJsonBody(response);
  return { batchId: data.id };
}

/** One batch result, named by its request index (`file-N`): the client maps
 *  it back to the file it sent at that position. `errorCode` marks a file the
 *  provider did not read. */
type BatchFileResult = { index: number } & (UnifiedExtractionResult | { errorCode: 'server_error' | ExtractionStopCode });

/**
 * Poll batch status. Returns completed count or full results when done.
 * `stops` names each refused or cut-off file for the caller to report: this
 * runs on every poll, so it reports nothing itself (US-15 AC34).
 */
export async function pollBatch(
  batchId: string,
): Promise<{
  status: 'processing' | 'ended' | 'failed';
  completed: number;
  total: number;
  results?: BatchFileResult[];
  stops?: ExtractionStopError[];
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  // Check batch status
  const statusResponse = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });

  if (!statusResponse.ok) {
    await statusResponse.body?.cancel();
    const err = new Error(`Batch status error (${statusResponse.status})`);
    Sentry.captureException(err, { extra: { status: statusResponse.status } });
    throw err;
  }

  const statusData = await parseJsonBody(statusResponse);
  const counts = statusData.request_counts ?? {};
  const completed = (counts.succeeded || 0) + (counts.errored || 0) + (counts.expired || 0) + (counts.canceled || 0);
  const total = completed + (counts.processing || 0);

  if (!statusData.ended_at) {
    return { status: 'processing', completed, total };
  }

  // Batch is done — fetch results
  const resultsResponse = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}/results`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });

  if (!resultsResponse.ok) {
    await resultsResponse.body?.cancel();
    const err = new Error(`Batch results error (${resultsResponse.status})`);
    Sentry.captureException(err, { extra: { status: resultsResponse.status } });
    throw err;
  }

  // Parse complete JSONL records independently of whitespace/property order.
  // Retain the legacy repair for records split by literal newlines: a new
  // complete record always wins, so a damaged neighbor cannot swallow it.
  const entries = [];
  let pending = '';
  for (const line of (await resultsResponse.text()).split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (!pending || (entry && typeof entry === 'object' && 'custom_id' in entry)) {
        entries.push(entry);
        pending = '';
        continue;
      }
    } catch { /* try the legacy split-record repair below */ }
    pending = /^\s*\{\s*"custom_id"\s*:/.test(line) ? line : pending + line;
    try {
      entries.push(JSON.parse(pending));
      pending = '';
    } catch { /* still incomplete or malformed; a complete record resynchronizes */ }
  }

  // Extract results, sorted by their exact request identity (US-12 AC9).
  const resultMap = new Map<number, BatchFileResult>();
  const stops: ExtractionStopError[] = [];

  for (const entry of entries) {
    try {
      if (typeof entry?.custom_id !== 'string') continue;
      const index = Number(entry.custom_id.slice(5));
      if (!Number.isSafeInteger(index) || index < 0 || entry.custom_id !== `file-${index}`) continue;

      // Read as the single call reads: a refused or cut-off request still
      // comes back 'succeeded', maybe with partial text, and is never parsed
      // as values but marked as such (US-15 AC34).
      if (entry.result?.type === 'succeeded') {
        const m = entry.result.message ?? {};
        try {
          const parsed = readExtraction(toResult(m.content ?? [], toUsage(m.usage), m.stop_reason ?? undefined, m.stop_details?.category), 'full');
          if (parsed) {
            resultMap.set(index, { ...parsed, index });
            continue;
          }
        } catch (err) {
          if (err instanceof ExtractionStopError) {
            stops.push(err);
            resultMap.set(index, { index, errorCode: err.code });
            continue;
          }
          // toResult's "No text": a server error, below.
        }
      }

      // Errored, expired or unparseable: marked, so the file is not reported
      // as one with no values (US-12 AC9).
      resultMap.set(index, { index, errorCode: 'server_error' });
    } catch {
      // Skip malformed JSONL lines; the index each result carries keeps the
      // rest on their own files, and the client names the missing one.
    }
  }

  const results = Array.from(resultMap.values()).sort((a, b) => a.index - b.index);

  return { status: 'ended', completed, total, results, stops };
}

/**
 * Delete a batch at Anthropic, which otherwise keeps what we sent and what came
 * back for up to 29 days (US-12 AC18). Only an ended batch can be deleted, so
 * one that is not is cancelled, for a later call to delete. Never throws: true
 * once the batch is gone (now, or already), false otherwise. A failure logs its
 * status alone; a provider body can echo the request, i.e. the user's pages.
 */
export async function deleteBatch(batchId: string): Promise<boolean> {
  const url = `https://api.anthropic.com/v1/messages/batches/${batchId}`;
  const headers = { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' };
  try {
    const response = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    if (response.ok || response.status === 404) return true;
    console.error(`Batch delete error (status ${response.status})`);
    Sentry.captureMessage('Lab import: batch delete failed', { level: 'warning', tags: { feature: 'lab_import_v2', status: String(response.status) } });
    const cancel = await fetch(`${url}/cancel`, { method: 'POST', headers, signal: AbortSignal.timeout(10_000) });
    await cancel.body?.cancel();
  } catch (err) {
    console.error(`Batch delete error (${(err as Error)?.name ?? 'unknown'})`);
  }
  return false;
}
