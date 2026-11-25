// The chat-row mappings shared by the web chat, the Discord bot and the YouTube
// bot, so their rows cannot drift apart again (US-15 AC37a, AC52).
// Kept out of chat-router.server.ts because several tests mock that module with
// ROUTER_VERSION alone.
import { ROUTER_VERSION, sanitizeForRouter, type RouterResult } from './chat-router.server';
import { CHAT_MODEL } from './chat.server';
import { cutText } from '../../packages/health-core/src/chat-history';

// The router columns of a chat_match_events row. When the router did not run
// (r is null) every column is null, router_version included, so a row is only
// tagged with a router version the router produced (US-15 AC37a).
function routerColumns(r: RouterResult | null | undefined) {
  return {
    router_version: r ? ROUTER_VERSION : null,
    router_latency_ms: r?.latencyMs ?? null,
    router_cache_hit: r?.cacheHit ?? null,
    router_input_tokens: r?.usage.inputTokens ?? null,
    router_cache_read_tokens: r?.usage.cacheReadTokens ?? null,
    router_output_tokens: r?.usage.outputTokens ?? null,
    router_raw: r?.error && r.rawJson != null ? cutText(r.rawJson, 500) : null,
    router_error: r?.error ?? null,
  };
}

// Question text on a chat_match_events row (`message`, `router_context.first`
// and `.recent`): the text the router saw, at most its first 500 characters.
// The row holds question text, which may carry health details, and CLAUDE.md
// keeps health values out of telemetry, so it never grows (US-15 AC26, AC52).
export function matchEventText(s: string): string {
  return cutText(sanitizeForRouter(s), 500);
}

// One chat_match_events row, the shape every surface writes (US-15 AC73, lead
// S-1). `context` holds the surface's own router_context fields, placed after
// `platform`; `replaced` and `reduced` (US-50 AC14) follow when non-empty.
// matched_handles are the router's picks, [] when the router did not run.
export function matchEventRow<C extends Record<string, unknown>>(e: {
  messageId: string | null;
  conversationId: string | null;
  userId: string;
  question: string;
  platform: string;
  context: C;
  replaced?: string[];
  reduced?: string[];
  routerResult: RouterResult | null | undefined;
  classification: string;
  routerSkipped: boolean;
  isFallback: boolean;
  failureMode?: string | null;
}) {
  return {
    message_id: e.messageId,
    conversation_id: e.conversationId,
    user_id: e.userId,
    message: matchEventText(e.question),
    router_context: {
      platform: e.platform,
      ...e.context,
      ...(e.replaced?.length ? { replaced: e.replaced } : {}),
      ...(e.reduced?.length ? { reduced: e.reduced } : {}),
    },
    matched_handles: e.routerResult?.handles ?? [],
    ...routerColumns(e.routerResult),
    classification: e.classification,
    router_skipped: e.routerSkipped,
    is_fallback: e.isFallback,
    failure_mode: e.failureMode ?? null,
  };
}

// The answer columns of an assistant chat_messages row, on success and on a
// failed turn alike (US-15 AC52). failure_mode and error_detail carry the cause
// of a fallback or refusal so the daily audit is self-diagnosing; both null on
// success. error_detail is the API's error message, first 500 characters.
export function answerColumns(a: {
  usage: { inputTokens: number; outputTokens: number };
  isFallback: boolean;
  failureMode?: string;
  errorDetail?: string;
  model?: string;
}) {
  return {
    input_tokens: a.usage.inputTokens,
    output_tokens: a.usage.outputTokens,
    // The model the turn ran on (YouTube: YOUTUBE_ANSWER_MODEL); a hand-built result is CHAT_MODEL's (US-15 AC77).
    model: a.model ?? CHAT_MODEL,
    is_fallback: a.isFallback,
    failure_mode: a.failureMode ?? null,
    error_detail: a.errorDetail != null ? cutText(a.errorDetail, 500) : null,
  };
}
