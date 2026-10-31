// The router columns of a chat_match_events row, shared by the web chat, the
// Discord bot and the YouTube bot so the router columns cannot drift apart again.
// When the router did not run (r is null) every column is null, router_version
// included, so a row is only tagged with a router version the router produced
// (US-15 AC37a). Kept out of chat-router.server.ts because several tests mock
// that module with ROUTER_VERSION alone.
import { ROUTER_VERSION, type RouterResult } from './chat-router.server';
import { cutText } from '../../packages/health-core/src/chat-history';

export function routerColumns(r: RouterResult | null | undefined) {
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
