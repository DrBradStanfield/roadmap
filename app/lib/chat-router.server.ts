/**
 * LLM retrieval router for the Health Roadmap chatbot.
 *
 * Reads the blog index (cached as a single Anthropic prompt cache block) and
 * returns 0-3 content handles for the current user turn. The entry count is
 * derived from the index at load time and substituted into the prompt via
 * {{ENTRY_COUNT}} — do not hard-code it here or in the .md, it drifts.
 *
 * Separate from chat.server.ts for single-responsibility and testability.
 */
import * as Sentry from '@sentry/react-router';
import fs from 'fs';
import path from 'path';
import * as z from '../../packages/health-core/src/zod';
import { callAnthropicWithUsage, type AnthropicUsage } from './anthropic.server';
import { loadBlogIndex } from './blog-index.server';
import { routerView, routerIndexBlock } from './router-view';
import { parseRouterReply } from './router-reply';
// The router's model lives with the other pins; modelParams gives its family's body shape.
import { PROMPT_CACHE, ROUTER_MODEL, modelParams } from '../../packages/health-core/src/models';
import { cutText } from '../../packages/health-core/src/chat-history';

// ---------------------------------------------------------------------------
// Version — bump when router prompt or index format changes so chat_match_events
// can segment pre/post-change analytics.
// ---------------------------------------------------------------------------

// 2: router model Haiku 4.5 -> Sonnet 5.5 and the rule 7 rework (2026-09-29).
// 3: the router view drops hidden posts whose masters are up to date (US-50 AC3).
// 4: third-party pathways removed: no pathway entries, rule 1 rewritten, no US→UK spelling step (2026-10-22).
export const ROUTER_VERSION = 4;

// The router's view, not the full index: the allow-list, the index block and
// {{ENTRY_COUNT}} all come from it (US-50 AC3). loadBlogIndex() stays whole.
const ROUTER_VIEW = routerView(loadBlogIndex());

// ---------------------------------------------------------------------------
// Valid handles allowlist — O(1) lookup to drop hallucinated handles
// ---------------------------------------------------------------------------

export const VALID_HANDLES = new Set(ROUTER_VIEW.map(e => e.handle));

/**
 * Repair the one handle malformation the router makes systematically: emitting
 * `guideline-diet` instead of `diet`, i.e. concatenating the bracketed TYPE
 * label onto the handle.
 *
 * It happens almost exclusively on the three guideline entries, whose handles
 * are single generic words (`diet`, `exercise`, `sleep`) and so read as concept
 * names rather than opaque identifiers. Router prompt Rule 7 forbids this
 * explicitly and it still occurs.
 *
 * Impact before this fix (2026-08-07): "what is a good daily protein target?"
 * returned ["guideline-exercise","guideline-diet"] — both correct choices —
 * which the allowlist then silently dropped, producing an EMPTY result. All
 * three protein failures in the supplement test category, and several protein
 * questions in production, were this bug, not missing content.
 *
 * Deliberately narrow: only strips a leading `<type>-` when the remainder is a
 * real handle. It can never invent or broaden a match.
 */
export function repairHandle(h: string): string {
  if (VALID_HANDLES.has(h)) return h;
  for (const t of ['guideline', 'reference', 'article']) {
    if (h.startsWith(`${t}-`)) {
      const stripped = h.slice(t.length + 1);
      if (VALID_HANDLES.has(stripped)) return stripped;
    }
  }
  return h;
}

// Router index block (router-view.ts): one line per entry, in a locked order.
const ROUTER_INDEX_BLOCK = routerIndexBlock(ROUTER_VIEW);

// ---------------------------------------------------------------------------
// Router system prompt — loaded from chat-router-prompt.md with 60s TTL so
// Brad can edit the prompt and see effects within a minute without restart.
// ---------------------------------------------------------------------------

let cachedPrompt: string | null = null;
let promptCachedAt = 0;
const PROMPT_TTL_MS = 60_000;
const PROMPT_PATH = path.join(process.cwd(), 'app/lib/chat-router-prompt.md');

function getRouterPrompt(): string {
  if (cachedPrompt && Date.now() - promptCachedAt < PROMPT_TTL_MS) {
    return cachedPrompt;
  }
  try {
    // {{ENTRY_COUNT}} is substituted from the loaded index so the prompt can't
    // drift from the data. It was a hard-coded "991" in the .md until
    // 2026-08-07, by which point the index held 1,015 — we were stating the
    // wrong size of the very list being handed to the model in the same prompt.
    cachedPrompt = fs
      .readFileSync(PROMPT_PATH, 'utf-8')
      .replace(/\{\{ENTRY_COUNT\}\}/g, String(ROUTER_VIEW.length));
    promptCachedAt = Date.now();
    return cachedPrompt;
  } catch {
    console.warn('chat-router: chat-router-prompt.md not found');
    return '';
  }
}

// ---------------------------------------------------------------------------
// Sanitization — strip control chars, cap per-string length
// ---------------------------------------------------------------------------

export function sanitizeForRouter(s: string): string {
  return cutText(s.replace(/[\u0000-\u001F\u007F]/g, ' '), 2000);
}

/** The columns a widget telemetry row may carry. A column not named here is
 *  dropped, so a new free-text column cannot reach the widget's row unseen. */
const WIDGET_ROW_COLUMNS = [
  'message_id', 'conversation_id', 'user_id', 'message', 'router_context', 'matched_handles',
  'router_version', 'router_latency_ms', 'router_cache_hit', 'router_input_tokens',
  'router_cache_read_tokens', 'router_output_tokens', 'router_raw', 'router_error', 'classification',
  'router_skipped', 'is_fallback', 'failure_mode',
] as const;

export interface MatchEventRow extends Record<string, unknown> {
  message: string;
  router_context: { platform: string; first: string | null; recent: string[]; replaced?: string[]; reduced?: string[] };
}

/** A number in a question: a run of digits in any script, with one decimal part ('4.1', '4,1', '４.１'). */
const NUMBER = /\p{Nd}+(?:[.,]\p{Nd}+)?/gu;
/** A closed list of topic names that hold a digit, kept whole when they stand alone ("HbA1c", "B12", "type 2"; never "HbA1c41"). */
const TOPIC = String.raw`(?<![\p{L}\p{Nd}])(?:HbA1c|B(?:1[0-2]|[1-9])|D[23]|K[12]|GLP-?1|SGLT-?2|omega[- ]?3|CoQ-?10|PCSK-?9|T[12]DM|type[- ]?[12]|zone[- ]?2)(?![\p{L}\p{Nd}]|[.,]\p{Nd})`;
const TOPIC_OR_NUMBER = new RegExp(`(${TOPIC})|${NUMBER.source}`, 'giu');
const maskNumbers = (s: string) => s.replace(TOPIC_OR_NUMBER, (m, topic) => (topic ? m : '#'));

/**
 * The widget's telemetry row (US-15 AC7): the assembled row with the surface
 * named and only the whitelisted columns kept. The current question stays so
 * article matching can be audited against it (Brad, 2026-09-10), with every
 * number masked to '#' and the topic names above kept (US-15 AC33, 2026-10-15),
 * so a health value typed into the chat never reaches the row; `router_raw` and
 * `router_error` get the same mask, since either can quote the question. The
 * earlier turns the router saw (`first`, `recent`) are dropped — the router
 * still gets them at call time; only the stored row loses them, so one widget
 * row can never hold a second question (2026-09-10). The context keeps only
 * US-50 AC14's `replaced` and `reduced`, index handles chosen by the server.
 */
export function redactForWidget(row: MatchEventRow): Record<string, unknown> {
  const kept = Object.fromEntries(WIDGET_ROW_COLUMNS.filter((c) => c in row).map((c) => [c, row[c]]));
  for (const c of ['router_raw', 'router_error']) if (typeof kept[c] === 'string') kept[c] = maskNumbers(kept[c]);
  const { replaced, reduced } = row.router_context;
  return { ...kept, message: maskNumbers(row.message), router_context: { platform: 'widget', ...(replaced ? { replaced } : {}), ...(reduced ? { reduced } : {}) } };
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface RouterResult {
  handles: string[];
  rawJson: string | null;
  usage: AnthropicUsage;
  latencyMs: number;
  cacheHit: boolean;
  error: string | null;
}

const EMPTY_USAGE: AnthropicUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

// Exported for tests (handle-sanitation invariants).
export const RouterOutput = z.object({
  handles: z.array(z.string().regex(/^[a-z0-9-]+$/).max(120)).max(3),
});

/**
 * Normalise the router's raw handle array before schema parse so malformed
 * output degrades gracefully instead of parse() throwing and dropping ALL
 * handles: coerce spaces/caps, drop non-strings/empties, and soft-truncate to
 * the schema's max of 3 — a 4th relevant handle must not void the first three
 * (W33: all 3 production router_errors were exactly that).
 */
export function sanitizeRawHandles(handles: unknown): unknown {
  if (!Array.isArray(handles)) return handles;
  return handles
    .filter((h): h is string => typeof h === 'string')
    .map(h => h.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter(h => h.length > 0)
    .slice(0, 3);
}

// ---------------------------------------------------------------------------
// Core routing function
// ---------------------------------------------------------------------------

export async function routeQuery(
  currentMessage: string,
  firstMessage?: string,
  recentUserMessages?: string[],
): Promise<RouterResult> {
  const t0 = Date.now();

  // Build the context block — all user-sourced strings stay inside a labeled
  // user-role block; no string concatenation that could let them escape context.
  const contextLines: string[] = [];
  if (firstMessage) contextLines.push(`First: ${firstMessage}`);
  if (recentUserMessages?.length) {
    contextLines.push(`Recent:\n${recentUserMessages.map(m => `    - ${m}`).join('\n')}`);
  }
  const contextBlock = contextLines.length > 0
    ? `Conversation context:\n${contextLines.map(l => `  ${l}`).join('\n')}\n\n`
    : '';

  // The prompt file ends with "Knowledge base index:" — the index entries go in
  // the second system block, each with its own cache marker. The cache is by
  // prefix, so an index change keeps the prompt entry, but a prompt edit also
  // rewrites the index entry behind it (about 75K tokens on Sonnet 5.5 by
  // count_tokens, 2026-09-29; about a third of that by character count since
  // the pathways left, 2026-10-22).
  const routerPrompt = getRouterPrompt();

  const body = {
    ...modelParams(ROUTER_MODEL, 200),
    system: [
      {
        type: 'text',
        text: routerPrompt,
        cache_control: PROMPT_CACHE,
      },
      {
        type: 'text',
        text: ROUTER_INDEX_BLOCK,
        cache_control: PROMPT_CACHE,
      },
    ],
    messages: [
      {
        role: 'user',
        content: `${contextBlock}Current query: ${currentMessage}`,
      },
    ],
  };

  let rawJson: string | null = null;
  // A reply that arrived but did not parse (cut off at max_tokens, a refusal)
  // keeps its real counts (US-15 AC37); only a missing reply reads 0.
  let usage = EMPTY_USAGE;

  try {
    const result = await callAnthropicWithUsage(body, 5_000);
    rawJson = result.content;
    usage = result.usage;

    const rawParsed = parseRouterReply(rawJson) as { handles?: unknown };
    rawParsed.handles = sanitizeRawHandles(rawParsed.handles);
    const parsed = RouterOutput.parse(rawParsed);

    // Allowlist: drop any handle the router hallucinated — but repair the ONE
    // systematic malformation first (see repairHandle).
    const validHandles = parsed.handles.map(repairHandle).filter(h => VALID_HANDLES.has(h));

    const latencyMs = Date.now() - t0;
    const cacheHit = result.usage.cacheReadTokens > 0;

    return {
      handles: validHandles,
      rawJson,
      usage: result.usage,
      latencyMs,
      cacheHit,
      error: null,
    };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.name === 'AbortError' ? 'timeout' : err.message : String(err);

    return {
      handles: [],
      rawJson,
      usage,
      latencyMs,
      cacheHit: usage.cacheReadTokens > 0,
      // JSON.parse quotes a snippet of the bad input that can end mid-pair
      // (US-15 AC27). This is toWellFormed(), which the ES2022 lib lacks.
      error: errorMsg.replace(/[\uD800-\uDFFF]/gu, '\uFFFD'),
    };
  }
}


/** Web-route telemetry excludes the raw parsing error kept in the result. */
export function reportRouterFailure(result: RouterResult | null): void {
  if (!result?.error) return;
  Sentry.captureMessage('Router: request or output failure', {
    level: 'warning',
    tags: { feature: 'chat', subsystem: 'router' },
    extra: { latencyMs: result.latencyMs, cacheHit: result.cacheHit },
  });
}
