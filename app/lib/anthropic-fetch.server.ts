/**
 * The raw HTTP layer for Anthropic's Messages API: the one POST, its retry
 * policy, and the result shape both the JSON and streamed reads return.
 * Split from anthropic.server.ts (file budget); behaviour unchanged.
 */
import * as Sentry from '@sentry/react-router';
import { toRefusalCategory, type RefusalCategory } from '../../packages/health-core/src/models';
import { sleep } from './cron-helpers.server';

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
export async function parseJsonBody(response: Response): Promise<any> {
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
export function toResult(
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

export function toUsage(u: Record<string, number | undefined> | undefined): AnthropicUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
  };
}

export async function readJson(response: Response): Promise<AnthropicResult> {
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
export function toErrorType(type: unknown): string {
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
export interface ReadControl { began(): void; idle: AbortController }

/**
 * The one POST to /v1/messages: auth headers, the overall timeout, body
 * discard on a retried error (only the type is read from a final one), and
 * the retry policy above. `read` turns a 200 into the
 * result; a retryable network or timeout error is retried only while nothing
 * has been read (`began` not called).
 * `maxAttempts` below the default turns the inner retry off for a caller whose own deadline cannot absorb it (US-35 AC5).
 * `deadline` (epoch ms) bounds the retries too: each attempt gets what is left, and a retry starts only
 * with a useful window, 5 s after its 1 s wait (US-52 AC7c).
 */
export async function fetchAnthropicRaw(
  apiKey: string, body: Record<string, unknown>, timeoutMs = 60_000, maxAttempts = RETRY_MAX_ATTEMPTS,
  read: (response: Response, control: ReadControl) => Promise<AnthropicResult> = readJson, deadline?: number,
): Promise<AnthropicResult> {
  const left = () => (deadline === undefined ? Infinity : deadline - Date.now());
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let began = false;
    const retry = () => attempt < maxAttempts && left() > RETRY_DELAY_MS + 5_000;
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
        signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, left()))), idle.signal]),
      });

      if (!response.ok) {
        if (RETRYABLE_STATUSES.has(response.status) && retry()) {
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
      if (!began && isNetworkOrTimeoutError(err) && retry()) {
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
