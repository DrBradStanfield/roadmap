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
  unifiedSystemPrompt,
  parseUnifiedResult,
  toUnifiedResult,
  parseExtractionJson,
  pagesToContentBlocks,
  type DocumentPromptMode,
  type PageContent,
  type UnifiedExtractionResult,
} from '../../packages/health-core/src/lab-extraction';
import {
  EXTRACTION_MODEL, extractionStopCode, modelParams, type ExtractionStopCode, type RefusalCategory,
} from '../../packages/health-core/src/models';
import {
  ANTHROPIC_TIMEOUT_MS, fetchAnthropicRaw, readJson, toErrorType, toResult, toUsage,
  type AnthropicContentBlock, type AnthropicResult, type ReadControl,
} from './anthropic-fetch.server';
// The HTTP layer moved to anthropic-fetch.server.ts; its public names keep this import path.
export { isNetworkOrTimeoutError, type AnthropicUsage, type AnthropicResult } from './anthropic-fetch.server';

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
 * The website's single file, below the BYOK read's EXTRACTION_MAX_TOKENS: the call
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
  code: ExtractionStopCode, refusalCategory: RefusalCategory | undefined, path: 'single' | 'connector',
): void {
  Sentry.captureMessage(`Lab import: extraction ${code}`, {
    level: 'warning',
    tags: { feature: 'lab_import_v2', path, stopCode: code, ...(refusalCategory ? { refusalCategory } : {}) },
  });
}

/**
 * The stop check, then the parse, for one call.
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
 * `oneDeadline` puts the HTTP retries on that deadline too: a timed-out attempt
 * is not retried, and a capacity retry gets what is left (US-52 AC7c).
 * `retryRateLimit` retries an Anthropic 429 once inside the deadline (lab reads only, US-12 AC1a).
 */
export async function extractOrClassify(
  pages: PageContent[],
  opts: { timeoutMs?: number; httpAttempts?: number; oneDeadline?: true; retryRateLimit?: true; documentMode?: DocumentPromptMode; onRetry?: () => void } = {},
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
    const parsed = readExtraction(await fetchAnthropicRaw(apiKey, body, left(), opts.httpAttempts, readJson, opts.oneDeadline && until, opts.onRetry, opts.retryRateLimit && until), documentMode);
    if (parsed) return parsed;
    // A fixed message and no `cause`: Sentry serialises it (api.lab-import-v2).
    if (call >= 2) throw new Error('extraction returned malformed JSON');
  }
}

// ---------------------------------------------------------------------------
// Streaming (US-15 AC16/AC17): the web chat shows the answer and the thinking
// summary as they are written. Discord and YouTube stay on the JSON call.
// ---------------------------------------------------------------------------

/** A delta the web chat forwards: the thinking summary or the answer text. */
export interface AnthropicStreamEvent { type: 'thinking' | 'text'; text: string }

/** Longest silence between chunks once a stream has begun. */
const STREAM_IDLE_TIMEOUT_MS = 30_000;

/** One delta's fields that readEventStream reads. The last member is a missing delta (the `?? {}` below). */
type StreamDelta =
  | { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string } | { type: 'input_json_delta'; partial_json: string }
  | { type?: undefined };

/**
 * The fields readEventStream reads from one SSE event, by `type`. It describes
 * what the code reads; nothing checks it: each `data:` line goes in as parsed.
 */
type StreamEvent =
  | { type: 'message_start'; message?: { usage?: Record<string, number> } }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | { type: 'content_block_delta'; index: number; delta?: StreamDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; usage?: Record<string, number>; delta?: { stop_reason?: string | null; stop_details?: { category?: unknown } } }
  | { type: 'message_stop' | 'ping' }
  | { type: 'error'; error?: { type?: unknown } };

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
  const blocks: AnthropicContentBlock[] = [];
  const toolJson = new Map<number, string>();
  let rawUsage: Record<string, number> = {};
  let stopReason: string | undefined;
  let category: unknown;
  let stopped = false;

  const handle = (event: StreamEvent) => {
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
        const delta: StreamDelta = event.delta ?? {};
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
  body: Record<string, unknown>, timeoutMs = ANTHROPIC_TIMEOUT_MS, maxAttempts?: number,
): Promise<AnthropicResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  return fetchAnthropicRaw(apiKey, body, timeoutMs, maxAttempts);
}

/** callAnthropicWithUsage, streamed: deltas go to `onEvent`, the result is the same shape. */
export async function streamAnthropicWithUsage(
  body: Record<string, unknown>, onEvent: (event: AnthropicStreamEvent) => void, timeoutMs = ANTHROPIC_TIMEOUT_MS,
): Promise<AnthropicResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  return fetchAnthropicRaw(apiKey, { ...body, stream: true }, timeoutMs, undefined,
    (response, control) => readEventStream(response, onEvent, control));
}

// stripCodeFences / extractJsonObject moved to health-core/lab-extraction.ts
// (re-exported at the top of this file).
