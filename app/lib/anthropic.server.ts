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
  extractJsonObject,
  pagesToContentBlocks,
  type DocumentPromptMode,
  type PageContent,
  type UnifiedExtractionResult,
} from '../../packages/health-core/src/lab-extraction';
import { EXTRACTION_MODEL } from '../../packages/health-core/src/models';
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

/**
 * Unified extraction: classifies the document and either extracts lab values
 * or converts to markdown + metadata, in a single LLM call.
 *
 * `timeoutMs` bounds each HTTP call; `attempts` is the outer retry. The
 * connector's import (US-35 AC10) passes both — it runs inside a 40 s
 * tool-call budget, where a second full attempt cannot fit and a hung call
 * must fail fast.
 */
export async function extractOrClassify(
  pages: PageContent[],
  opts: { timeoutMs?: number; attempts?: number; httpAttempts?: number; documentMode?: DocumentPromptMode } = {},
): Promise<UnifiedExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const content = pagesToContentBlocks(pages);
  // One retry (2 attempts total) with 1s backoff. Catches schema-drift
  // failures (the LLM returned 200 but the JSON didn't match our shape) and
  // anything that bubbles up from fetchAnthropicRaw despite its own retry.
  // Transient API failures (5xx, network) are mostly absorbed by the inner
  // retry in fetchAnthropicRaw; worst-case compound here is ~3s of backoff
  // on a persistent capacity event, acceptable for an async upload path.
  const attempts = opts.attempts ?? 2;
  for (let attempt = 1; ; attempt++) {
    try {
      return await extractOrClassifyOnce(apiKey, content, opts.timeoutMs, opts.httpAttempts, opts.documentMode ?? 'full');
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(1000);
    }
  }
}

/** Plenty for a lab panel or a document's metadata; the 8192 default exists for markdown transcription. */
const METADATA_MAX_TOKENS = 2048;

/**
 * One attempt: the call, and a `{`-prefilled second call when the first did
 * not parse. `timeoutMs` is ONE deadline for the pair — the retry gets what
 * is left, never a fresh window — so a caller inside a budget (US-35 AC5)
 * cannot be run past it by a malformed first answer.
 */
async function extractOrClassifyOnce(
  apiKey: string,
  content: Array<Record<string, unknown>>,
  timeoutMs: number | undefined,
  httpAttempts: number | undefined,
  documentMode: DocumentPromptMode,
): Promise<UnifiedExtractionResult> {
  const body = {
    model: EXTRACTION_MODEL,
    max_tokens: documentMode === 'metadata' ? METADATA_MAX_TOKENS : EXTRACTION_MAX_TOKENS,
    system: unifiedSystemPrompt(documentMode),
    messages: [{ role: 'user', content }],
  };
  const until = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const left = () => {
    if (until === undefined) return undefined;
    const ms = until - Date.now();
    if (ms <= 0) throw new DOMException('extraction deadline passed', 'TimeoutError');
    return ms;
  };

  let responseText = await callAnthropic(apiKey, body, left(), httpAttempts);

  let parsed: ReturnType<typeof parseUnifiedResult>;
  try {
    parsed = parseUnifiedResult(JSON.parse(extractJsonObject(responseText)));
  } catch {
    // Prefill `{` to coerce malformed responses into valid JSON shape.
    const retryBody = {
      ...body,
      messages: [
        { role: 'user', content },
        { role: 'assistant', content: [{ type: 'text', text: '{' }] },
      ],
    };
    responseText = await callAnthropic(apiKey, retryBody, left(), httpAttempts);
    try {
      parsed = parseUnifiedResult(JSON.parse(extractJsonObject('{' + responseText)));
    } catch {
      // The error CLASS only: a SyntaxError quotes ~10 chars of the model's
      // answer and Zod names the values it received — both are document text,
      // and this error reaches console.error and Sentry (api.lab-import-v2).
      // No `cause` either: Sentry serialises it.
      throw new Error('extraction returned malformed JSON');
    }
  }

  return toUnifiedResult(parsed);
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

/** One block of an Anthropic Messages `content` array (text or tool_use). */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/**
 * `stop_details.category` on a refusal, bounded so it can go to telemetry.
 * Anthropic's set is open; anything new or missing is 'other'.
 */
const REFUSAL_CATEGORIES = ['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms', 'other'] as const;
export type RefusalCategory = typeof REFUSAL_CATEGORIES[number];

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
 * a broken bot — see chat-knowledge-map-v2-changelog 2026-06-05 entry for the
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
 * carry the user's own lab text there. Same reason the !ok paths cancel the
 * body. SyntaxError is deliberate: classifyChatError still tags it 'parse'.
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
    const refusalCategory = (REFUSAL_CATEGORIES as readonly string[]).includes(category as string) ? category as RefusalCategory : 'other';
    return { content: '', contentBlocks: [], usage, stopReason, refusalCategory };
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

/**
 * How a read tells the retry loop it has started consuming a stream (after
 * which nothing is retried), and the abort it uses for its idle timeout.
 */
interface ReadControl { began(): void; idle: AbortController }

/**
 * The one POST to /v1/messages: auth headers, the overall timeout, body
 * discard on error, and the retry policy above. `read` turns a 200 into the
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
        // Discard provider bodies: errors may echo uploaded or chat content.
        await response.body?.cancel();

        if (RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts) {
          console.warn(`Anthropic API ${response.status} on attempt ${attempt}/${maxAttempts}, retrying after ${RETRY_DELAY_MS}ms`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        const err = new Error(`Anthropic API error (status ${response.status})`);
        console.error(err.message);
        if (!TRANSIENT_CAPACITY_STATUSES.has(response.status)) {
          Sentry.captureException(err, { extra: { status: response.status, attempt } });
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
        // The type only, bounded: the message can echo the conversation.
        const type = String(event.error?.type ?? '').replace(/[^a-z_]/g, '').slice(0, 40) || 'unknown';
        throw new Error(`Anthropic stream error (${type})`);
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

/** Text-only wrapper for extraction, where a refusal is a failed call. */
async function callAnthropic(apiKey: string, body: Record<string, unknown>, timeoutMs?: number, maxAttempts?: number): Promise<string> {
  const result = await fetchAnthropicRaw(apiKey, body, timeoutMs, maxAttempts);
  if (result.stopReason === 'refusal') throw new Error('Anthropic refusal');
  return result.content;
}

/** Text + usage + raw content blocks wrapper — for chat (prompt caching
 *  metrics + tool_use parsing). */
export async function callAnthropicWithUsage(
  body: Record<string, unknown>, timeoutMs = 60_000,
): Promise<AnthropicResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  return fetchAnthropicRaw(apiKey, body, timeoutMs);
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

interface BatchFileInput {
  fileName: string;
  pages: PageContent[];
}

/** Create a batch of LLM requests — one per file. Returns the batch ID. */
export async function createBatch(
  files: BatchFileInput[],
): Promise<{ batchId: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const requests = files.map((file, index) => ({
    custom_id: `file-${index}`,
    params: {
      model: EXTRACTION_MODEL,
      max_tokens: EXTRACTION_MAX_TOKENS,
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
    const err = new Error(`Batch API error (status ${response.status})`);
    console.error(err.message);
    Sentry.captureException(err, { extra: { status: response.status } });
    throw err;
  }

  const data = await parseJsonBody(response);
  return { batchId: data.id };
}

/** Poll batch status. Returns completed count or full results when done. */
export async function pollBatch(
  batchId: string,
): Promise<{
  status: 'processing' | 'ended' | 'failed';
  completed: number;
  total: number;
  results?: UnifiedExtractionResult[];
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
  const ps = statusData.processing_status;
  const completed = (ps.succeeded || 0) + (ps.errored || 0) + (ps.expired || 0) + (ps.canceled || 0);
  const total = completed + (ps.in_progress || 0);

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

  // Parse JSONL — some entries contain literal newlines in markdown content,
  // so we can't simply split by \n. Reassemble split entries by checking for the custom_id prefix.
  const resultsText = await resultsResponse.text();
  const rawLines = resultsText.trim().split('\n');
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line.startsWith('{"custom_id":')) {
      lines.push(line);
    } else if (lines.length > 0) {
      lines[lines.length - 1] += line;
    }
  }

  // Parse each JSONL line and extract results, sorted by custom_id
  const resultMap = new Map<number, UnifiedExtractionResult>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const index = parseInt(entry.custom_id?.replace('file-', ''), 10);
      if (isNaN(index)) continue;

      if (entry.result?.type === 'succeeded') {
        const textBlock = entry.result.message?.content?.find((b: any) => b.type === 'text');
        if (textBlock?.text) {
          try {
            const parsed = parseUnifiedResult(JSON.parse(extractJsonObject(textBlock.text)));
            resultMap.set(index, toUnifiedResult(parsed));
            continue;
          } catch {
            // JSON parse or Zod validation failed
          }
        }
      }

      // Error or failed to parse — store error result
      resultMap.set(index, {
        classification: 'other',
        reportDate: null,
        values: [],
        additionalValues: [],
        unrecognized: [],
        document: null,
      });
    } catch {
      // Skip malformed JSONL lines
    }
  }

  // Sort by index and return
  const results = Array.from(resultMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => r);

  return { status: 'ended', completed, total, results };
}
