/**
 * Anthropic API wrapper for health document processing.
 * System prompt is hardcoded server-side — client sends only content.
 *
 * Two modes:
 *   extractLabResults()        — lab report → structured numeric values
 *   processHealthDocument()    — any document → markdown + metadata
 *
 * The unified extractOrClassify() function auto-classifies each file and
 * routes to the appropriate handler in a single LLM call.
 */
import { z } from 'zod';
import * as Sentry from '@sentry/react-router';
import {
  UNIFIED_SYSTEM_PROMPT,
  unifiedSystemPrompt,
  EXTRACTION_MODEL,
  EXTRACTION_MAX_TOKENS,
  resolveLabValues,
  parseUnifiedResult,
  toUnifiedResult,
  extractJsonObject,
  pagesToContentBlocks,
  type DocumentPromptMode,
  type PageContent,
  type ExtractedValue,
  type UnifiedExtractionResult,
} from '../../packages/health-core/src/lab-extraction';
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
// Types
// ---------------------------------------------------------------------------

/** What the LLM returns (raw, before unit resolution) */
const llmResultSchema = z.object({
  reportDate: z.string().nullable(),
  values: z.array(z.object({
    metric: z.string(),
    value: z.number(),
    unit: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    question: z.string().optional(),
  })),
  unrecognized: z.array(z.string()).optional(),
});

type LlmResult = z.infer<typeof llmResultSchema>;

export interface ExtractionResult {
  reportDate: string | null;
  values: ExtractedValue[];
  unrecognized: string[];
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a medical lab report data extractor. Extract blood test values from the provided document and return ONLY valid JSON.

TARGET METRICS (use these exact keys):
- "ldl" — LDL, LDL-C, LDL Cholesterol, Low Density Lipoprotein
- "hdl" — HDL, HDL-C, HDL Cholesterol, High Density Lipoprotein
- "total_cholesterol" — Total Cholesterol, TC, Cholesterol Total
- "triglycerides" — Triglycerides, TG, Trigs
- "hba1c" — HbA1c, Hemoglobin A1c, Glycated Hemoglobin, A1C, Glycated Haemoglobin
- "creatinine" — Creatinine, Creat, Cr, Serum Creatinine
- "apob" — ApoB, Apolipoprotein B, Apo B
- "psa" — PSA, Prostate Specific Antigen
- "lpa" — Lp(a), Lipoprotein(a), Lipoprotein little a
- "systolic_bp" — Systolic Blood Pressure, Systolic BP, SBP
- "diastolic_bp" — Diastolic Blood Pressure, Diastolic BP, DBP

CRITICAL RULES:
1. Extract ACTUAL measured result values ONLY. NEVER extract reference ranges, target values, or normal limits. Reference ranges often appear in parentheses, brackets, a "Reference" column, or after words like "Normal", "Ref", "Range".
2. If the report shows previous/historical results (in a "Previous" column, "Last visit" column, trend graph, or any side-by-side layout), IGNORE them completely. Extract ONLY values from the current report's primary column, even if those historical columns are dated. Return at most ONE entry per metric — never duplicate a metric in the output.
3. For the date: use the COLLECTION or SAMPLE date (when blood was drawn), NOT the report date, print date, or received date. Return as ISO format YYYY-MM-DD.
4. For ambiguous date formats (e.g. 03/04/2026): prefer DD/MM/YYYY if the lab address or language suggests non-US origin. Prefer MM/DD/YYYY for US labs. If uncertain, set confidence to "low".
5. For multi-page documents: the collection date may appear on the first page while results are on later pages. Correlate dates and results across all pages.
6. If a value could be a reference range or you are uncertain, set confidence to "low" and include a "question" explaining the ambiguity.
7. Skip any test not in the TARGET METRICS list. Include skipped tests in the "unrecognized" array as "test name: value unit".

RESPONSE FORMAT (strict JSON, no markdown):
{
  "reportDate": "YYYY-MM-DD" or null,
  "values": [
    { "metric": "ldl", "value": 2.8, "unit": "mmol/L", "confidence": "high" },
    { "metric": "hba1c", "value": 5.7, "unit": "%", "confidence": "low", "question": "Both 5.7% and 39 mmol/mol shown — using percentage" }
  ],
  "unrecognized": ["vitamin D: 45 ng/mL", "iron: 80 µg/dL"]
}`;

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

export async function extractLabResults(
  pages: PageContent[],
): Promise<ExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const content = pagesToContentBlocks(pages);

  const body = {
    model: EXTRACTION_MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  };

  let responseText = await callAnthropic(apiKey, body);

  // Parse + validate
  let parsed: LlmResult;
  try {
    parsed = llmResultSchema.parse(JSON.parse(extractJsonObject(responseText)));
  } catch {
    // Retry once with prefilled assistant turn to force JSON
    const retryBody = {
      ...body,
      messages: [
        { role: 'user', content },
        { role: 'assistant', content: [{ type: 'text', text: '{' }] },
      ],
    };
    responseText = await callAnthropic(apiKey, retryBody);
    parsed = llmResultSchema.parse(JSON.parse(extractJsonObject('{' + responseText)));
  }

  return {
    reportDate: parsed.reportDate,
    values: resolveLabValues(parsed.values),
    unrecognized: parsed.unrecognized || [],
  };
}

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
  timeoutMs?: number,
  httpAttempts?: number,
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
    parsed = parseUnifiedResult(JSON.parse(extractJsonObject('{' + responseText)));
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
 * Shared fetch + error handling. Returns text content + usage metrics.
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

/** `maxAttempts` below the default turns the inner retry off for a caller whose own deadline cannot absorb it (US-35 AC5). */
async function fetchAnthropicRaw(
  apiKey: string, body: Record<string, unknown>, timeoutMs = 60_000, maxAttempts = RETRY_MAX_ATTEMPTS,
): Promise<{ content: string; usage: AnthropicUsage; contentBlocks: AnthropicContentBlock[] }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');

        if (RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts) {
          console.warn(`Anthropic API ${response.status} on attempt ${attempt}/${maxAttempts}, retrying after ${RETRY_DELAY_MS}ms`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        const err = new Error(`Anthropic API error (status ${response.status})`);
        console.error(err.message, errorText);
        if (!TRANSIENT_CAPACITY_STATUSES.has(response.status)) {
          Sentry.captureException(err, { extra: { status: response.status, errorText, attempt } });
        }
        throw err;
      }

      const data = await response.json();
      const contentBlocks = (data.content as AnthropicContentBlock[]) ?? [];
      const text = contentBlocks
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('');
      const hasToolUse = contentBlocks.some(b => b.type === 'tool_use');
      // A response carrying ONLY tool_use blocks (the model proposed a form
      // edit with no prose) is valid — don't treat it as an empty failure.
      if (!text && !hasToolUse) throw new Error('No text in Anthropic response');

      return {
        content: text,
        contentBlocks,
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
          cacheCreationTokens: data.usage?.cache_creation_input_tokens ?? 0,
          cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
        },
      };
    } catch (err) {
      if (isNetworkOrTimeoutError(err) && attempt < maxAttempts) {
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

/** Text-only wrapper — existing callers unchanged. */
async function callAnthropic(apiKey: string, body: Record<string, unknown>, timeoutMs?: number, maxAttempts?: number): Promise<string> {
  const result = await fetchAnthropicRaw(apiKey, body, timeoutMs, maxAttempts);
  return result.content;
}

/** Text + usage + raw content blocks wrapper — for chat (prompt caching
 *  metrics + tool_use parsing). */
export async function callAnthropicWithUsage(
  body: Record<string, unknown>, timeoutMs = 60_000,
): Promise<{ content: string; usage: AnthropicUsage; contentBlocks: AnthropicContentBlock[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  return fetchAnthropicRaw(apiKey, body, timeoutMs);
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
    const errorText = await response.text().catch(() => 'Unknown error');
    const err = new Error(`Batch API error (status ${response.status})`);
    console.error(err.message, errorText);
    Sentry.captureException(err, { extra: { status: response.status, errorText } });
    throw err;
  }

  const data = await response.json();
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
    const errorText = await statusResponse.text().catch(() => 'Unknown error');
    const err = new Error(`Batch status error (${statusResponse.status})`);
    Sentry.captureException(err, { extra: { status: statusResponse.status, errorText } });
    throw err;
  }

  const statusData = await statusResponse.json();
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
    const errorText = await resultsResponse.text().catch(() => 'Unknown error');
    const err = new Error(`Batch results error (${resultsResponse.status})`);
    Sentry.captureException(err, { extra: { status: resultsResponse.status, errorText } });
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
