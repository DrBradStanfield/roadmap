/**
 * Pre-router classifier for the Health Roadmap chatbot.
 *
 * Decides whether the v2 LLM router needs to fire for a given user turn.
 * For ~59% of observed traffic (greetings, product/account questions,
 * meta-questions, drug-dosing questions) the router returns empty handles
 * anyway — this short-circuits those, saving ~$0.004 + ~1.3-1.9s per skip.
 *
 * That latency figure read ~250-400ms here until 2026-08-07. It was a
 * pre-launch estimate production never matched. Measured over 200
 * chat_match_events rows: router_latency_ms median 1615ms overall
 * (cache HIT median 1311ms n=78; cache MISS median 1889ms n=122),
 * p90 3063ms, max 8406ms. The skip is worth ~4-6x more than was
 * documented — which strengthens the case for the serial classifier.
 *
 * Design docs:
 *   - chat-architecture.md § Pre-router classifier (full spec)
 *   - chat-knowledge-map-v2.md § Pre-router classifier (the "why")
 *   - chat-overview.html Diagram 6 (the picture)
 *
 * Failure mode is fail-safe: any classifier error → router still fires
 * (matches today's behavior). The classifier can only OMIT a router call,
 * never substitute one.
 *
 * Separate file from chat-router.server.ts so the two prompts evolve
 * independently and the router cache stays untouched.
 */
import fs from 'fs';
import path from 'path';
import * as Sentry from '@sentry/react-router';
import { callAnthropicWithUsage, type AnthropicUsage } from './anthropic.server';
import { sanitizeForRouter } from './chat-router.server';

// Bump when the classifier prompt or rules change so chat_match_events can
// segment pre/post-change analytics.
export const CLASSIFIER_VERSION = 1;

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Classification taxonomy
// ---------------------------------------------------------------------------

// Const-object so consumers compare against `Classification.ROUTE` instead of
// the literal `'ROUTE'`. Typos become compile errors; rename-refactors work.
export const Classification = {
  ROUTE: 'ROUTE',
  GREETING: 'GREETING',
  PRODUCT: 'PRODUCT',
  ACCOUNT: 'ACCOUNT',
  /**
   * Reading back / correcting the user's OWN recorded numbers. Added 2026-08-07:
   * router prompt Rule 6 already said these should return empty handles, but the
   * classifier had no label for them, so every "What is my BMI?" fired a ~1.6s
   * router call that came back empty. Measured on 143 empty-handle turns, this
   * was the single largest bucket (50, 35%) — of which 33 are pure lookup.
   * Interpretation ("is my Lp(a) a concern?") stays ROUTE by design.
   */
  MEASUREMENT: 'MEASUREMENT',
  ERROR: 'ERROR',
} as const;

export type Classification = typeof Classification[keyof typeof Classification];

const VALID_CLASSIFICATIONS: ReadonlyArray<Classification> = [
  Classification.ROUTE,
  Classification.GREETING,
  Classification.PRODUCT,
  Classification.ACCOUNT,
  Classification.MEASUREMENT,
];

function parseClassification(raw: string): Classification {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z]/g, '');
  for (const valid of VALID_CLASSIFICATIONS) {
    if (cleaned === valid) return valid;
  }
  return Classification.ERROR;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  classification: Classification;
  /** True iff classification is one of the three SKIP states. Caller uses this
   *  to decide whether to invoke routeQuery() at all. */
  routerSkipped: boolean;
  latencyMs: number;
  cacheHit: boolean;
  raw: string;
  usage: AnthropicUsage;
  error: string | null;
}

const EMPTY_USAGE: AnthropicUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

/**
 * Single source of truth for "should the v2 router fire on this turn?"
 * True on ROUTE (real health query) and ERROR (fail-safe — preserves today's
 * behavior on classifier failure). False on SKIP (GREETING / PRODUCT / ACCOUNT).
 */
export function shouldFireRouter(result: ClassificationResult): boolean {
  return result.classification === Classification.ROUTE || result.classification === Classification.ERROR;
}

// ---------------------------------------------------------------------------
// Classifier prompt — loaded from chat-classifier-prompt.md with a 60s TTL,
// mirroring chat-router.server.ts. Lets Brad edit the prompt and see effects
// within a minute without a redeploy. The same file is read by
// tools/test-classifier.ts so the regression suite can never drift.
// ---------------------------------------------------------------------------

let cachedPrompt: string | null = null;
let promptCachedAt = 0;
const PROMPT_TTL_MS = 60_000;
const PROMPT_PATH = path.join(process.cwd(), 'app/lib/chat-classifier-prompt.md');

function getClassifierPrompt(): string {
  if (cachedPrompt && Date.now() - promptCachedAt < PROMPT_TTL_MS) return cachedPrompt;
  try {
    cachedPrompt = fs.readFileSync(PROMPT_PATH, 'utf-8');
    promptCachedAt = Date.now();
    return cachedPrompt;
  } catch {
    console.warn('chat-classifier: chat-classifier-prompt.md not found');
    return '';
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function classifyMessage(
  currentMessage: string,
  firstMessage?: string,
  recentUserMessages?: string[],
): Promise<ClassificationResult> {
  const t0 = Date.now();

  // Same input sanitization as the router — strip control chars, cap length.
  const safeCurrent = sanitizeForRouter(currentMessage);
  const safeFirst = firstMessage ? sanitizeForRouter(firstMessage) : undefined;
  const safeRecent = recentUserMessages?.map(sanitizeForRouter) ?? [];

  const contextLines: string[] = [];
  if (safeFirst) contextLines.push(`First user message in this conversation: ${safeFirst}`);
  if (safeRecent.length > 0) {
    contextLines.push(`Recent user turns:\n${safeRecent.slice(-2).map(m => `  - ${m}`).join('\n')}`);
  }
  if (contextLines.length === 0) contextLines.push('(new conversation, no prior turns)');

  const body = {
    model: CLASSIFIER_MODEL,
    // 8, not 5: 'MEASUREMENT' (added 2026-08-07) is the longest label and a
    // truncated word fails the exact-match parse, degrading to ERROR — which
    // fail-safes to firing the router, i.e. silently undoing the saving this
    // label exists to create. Unused output tokens are not billed.
    max_tokens: 8,
    temperature: 0,
    system: [
      {
        type: 'text',
        text: getClassifierPrompt(),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `${contextLines.join('\n\n')}\n\nCurrent message: ${safeCurrent}\n\nClassification:`,
      },
    ],
  };

  let raw = '';

  try {
    const result = await callAnthropicWithUsage(body, 5_000);
    raw = result.content;
    const classification = parseClassification(raw);
    const latencyMs = Date.now() - t0;
    const cacheHit = result.usage.cacheReadTokens > 0;

    if (classification === Classification.ERROR) {
      Sentry.captureMessage('Chat classifier: unparseable output', {
        level: 'warning',
        tags: { feature: 'chat', subsystem: 'classifier' },
        extra: { raw, latencyMs },
      });
    }

    return {
      classification,
      routerSkipped: classification !== Classification.ROUTE && classification !== Classification.ERROR,
      latencyMs,
      cacheHit,
      raw,
      usage: result.usage,
      error: classification === Classification.ERROR ? `unparseable: ${raw.slice(0, 60)}` : null,
    };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const errorMsg = err instanceof Error
      ? err.name === 'AbortError' ? 'timeout' : err.message
      : String(err);
    return {
      classification: Classification.ERROR,
      // routerSkipped=false is critical — on classifier error the caller MUST
      // still fire the router to preserve today's correctness. Fail open.
      routerSkipped: false,
      latencyMs,
      cacheHit: false,
      raw,
      usage: EMPTY_USAGE,
      error: errorMsg,
    };
  }
}
