import { describe, it, expect, vi } from 'vitest';

const supa = vi.hoisted(() => {
  // Read at module load: persistConversation is a no-op without it.
  process.env.DISCORD_BOT_PROFILE_ID = 'bot-profile';
  return { inserts: [] as Array<{ table: string; row: Record<string, unknown> }> };
});

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const ok = { data: { id: 'conv-1' }, error: null };
      const query = {
        insert: (row: Record<string, unknown>) => { supa.inserts.push({ table, row }); return query; },
        update: () => query,
        eq: () => query,
        select: () => query,
        single: () => Promise.resolve(ok),
        then: (onOk: (v: unknown) => unknown) => Promise.resolve(ok).then(onOk),
      };
      return query;
    },
  },
}));

import { persistConversation } from './discord-bot.server';
import { ROUTER_VERSION } from './chat-router.server';
import { CHAT_MODEL } from './chat.server';

describe('US-15 AC27: stored text cuts keep surrogate pairs whole (Sentry 6Y)', () => {
  // JSON.stringify writes a lone surrogate as a \udXXX escape; PostgREST then
  // rejects the whole body (PGRST102 "Empty or invalid json").
  const LONE_SURROGATE = /\\u[dD][89a-fA-F]/;

  it('cuts the Discord title, router_raw and error_detail before a split emoji', async () => {
    supa.inserts.length = 0;
    await persistConversation({
      conversationId: null,
      authorId: 'u1',
      userMessage: 'hi ' + 'x'.repeat(76) + '😀' + ' and more',
      userDiscordMessageId: 'm1',
      assistantContent: 'Sorry', silent: false,
      assistantDiscordMessageIds: ['m2'],
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      isFallback: true,
      failureMode: 'api-error',
      errorDetail: 'e'.repeat(499) + '😀',
      routerResult: {
        handles: [],
        rawJson: 'r'.repeat(499) + '😀',
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        latencyMs: 1,
        cacheHit: false,
        error: 'parse',
      },
      classifier: { classification: 'ROUTE', routerSkipped: false },
      contextRecent: [],
    });

    const row = (table: string, role?: string) =>
      supa.inserts.find((i) => i.table === table && (!role || i.row.role === role))?.row;
    expect(row('chat_conversations')?.title).toBe('hi ' + 'x'.repeat(76) + '…');
    expect(row('chat_messages', 'assistant')?.error_detail).toBe('e'.repeat(499));
    expect(row('chat_match_events')?.router_raw).toBe('r'.repeat(499));
    for (const { row: r } of supa.inserts) expect(JSON.stringify(r)).not.toMatch(LONE_SURROGATE);
  });
});

// US-15 AC37 (Sentry 6Z): the row carries the router's output token count,
// and null when the router did not run.
describe('US-15 AC37: router_output_tokens on the Discord row', () => {
  const turn = {
    conversationId: null, authorId: 'u1', userMessage: 'hello', userDiscordMessageId: 'm1',
    assistantContent: 'Hi', silent: false, assistantDiscordMessageIds: ['m2'],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    isFallback: false, contextRecent: [],
  };
  const row = () => supa.inserts.find((i) => i.table === 'chat_match_events')?.row;

  it('US-15 AC37: carries the count when the router ran', async () => {
    supa.inserts.length = 0;
    await persistConversation({
      ...turn,
      routerResult: {
        handles: [], rawJson: '{"handles":[]}', latencyMs: 1, cacheHit: false, error: null,
        usage: { inputTokens: 900, outputTokens: 37, cacheCreationTokens: 0, cacheReadTokens: 0 },
      },
      classifier: { classification: 'ROUTE', routerSkipped: false },
    });
    expect(row()?.router_output_tokens).toBe(37);
  });

  it('US-50 AC14: the row records replaced picks and reduced masters in router_context', async () => {
    supa.inserts.length = 0;
    await persistConversation({ ...turn, routerResult: null, classifier: { classification: 'ROUTE', routerSkipped: false }, replaced: ['old-post'], reduced: ['a-master'] });
    expect(row()?.router_context).toMatchObject({ platform: 'discord', replaced: ['old-post'], reduced: ['a-master'] });
    supa.inserts.length = 0;
    await persistConversation({ ...turn, routerResult: null, classifier: { classification: 'ROUTE', routerSkipped: false } });
    expect(row()?.router_context).not.toHaveProperty('replaced');
  });

  it('US-15 AC37: reads null when the router did not run', async () => {
    supa.inserts.length = 0;
    await persistConversation({ ...turn, routerResult: null, classifier: { classification: 'GREETING', routerSkipped: true } });
    expect(row()?.router_output_tokens).toBeNull();
  });
});

// US-15 AC37a: every chat row a Discord turn writes, pinned column for column,
// so moving the router columns into one shared mapping changes nothing else.
describe('US-15 AC37a: the Discord turn rows, column for column', () => {
  const turn = {
    conversationId: null, authorId: 'u1', userMessage: 'What is a good ApoB?', userDiscordMessageId: 'm1',
    assistantContent: 'An answer.', silent: false, assistantDiscordMessageIds: ['m2', 'm3'],
    usage: { inputTokens: 11, outputTokens: 22, cacheCreationTokens: 0, cacheReadTokens: 0 },
    isFallback: false, contextFirst: 'first question', contextRecent: ['earlier'],
  };
  const routerResult = {
    handles: ['apob'], rawJson: '{"handles":["apob"]}', latencyMs: 15, cacheHit: true, error: null,
    usage: { inputTokens: 900, outputTokens: 37, cacheCreationTokens: 0, cacheReadTokens: 120 },
  };
  const rows = (asstId: unknown, event: Record<string, unknown>) => [
    { table: 'chat_conversations', row: { user_id: 'bot-profile', title: expect.any(String), platform: 'discord', external_id: 'u1' } },
    { table: 'chat_messages', row: { conversation_id: 'conv-1', user_id: 'bot-profile', role: 'user', content: 'What is a good ApoB?', discord_message_id: 'm1' } },
    { table: 'chat_messages', row: { id: asstId, conversation_id: 'conv-1', user_id: 'bot-profile', role: 'assistant', content: 'An answer.',
      input_tokens: 11, output_tokens: 22, model: CHAT_MODEL, discord_message_id: 'm2', is_fallback: false, failure_mode: null, error_detail: null } },
    { table: 'chat_match_events', row: {
      message_id: asstId, conversation_id: 'conv-1', user_id: 'bot-profile', message: 'What is a good ApoB?',
      router_context: { platform: 'discord', first: 'first question', recent: ['earlier'] },
      router_raw: null, is_fallback: false, failure_mode: null, ...event,
    } },
  ];

  it('a turn the router ran for', async () => {
    supa.inserts.length = 0;
    await persistConversation({ ...turn, routerResult, classifier: { classification: 'ROUTE', routerSkipped: false } });
    expect(supa.inserts).toEqual(rows(supa.inserts[2].row.id, {
      matched_handles: ['apob'], router_version: ROUTER_VERSION, router_latency_ms: 15, router_cache_hit: true,
      router_input_tokens: 900, router_cache_read_tokens: 120, router_output_tokens: 37, router_error: null,
      classification: 'ROUTE', router_skipped: false,
    }));
  });

  // routeQuery's catch path (a timeout or an API error): the router ran, so the
  // row keeps its version, a 0 token count reads 0 and a cache miss reads false.
  it('a turn the router ran for but failed (timeout)', async () => {
    supa.inserts.length = 0;
    const failed = {
      handles: [], rawJson: 'x'.repeat(600), latencyMs: 8000, cacheHit: false, error: 'timeout',
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    };
    await persistConversation({ ...turn, routerResult: failed, classifier: { classification: 'ROUTE', routerSkipped: false } });
    expect(supa.inserts).toEqual(rows(supa.inserts[2].row.id, {
      matched_handles: [], router_version: ROUTER_VERSION, router_latency_ms: 8000, router_cache_hit: false,
      router_input_tokens: 0, router_cache_read_tokens: 0, router_output_tokens: 0,
      router_raw: 'x'.repeat(500), router_error: 'timeout',
      classification: 'ROUTE', router_skipped: false,
    }));
  });

  it('a turn the router did not run for: every router column is null', async () => {
    supa.inserts.length = 0;
    await persistConversation({ ...turn, routerResult: null, classifier: { classification: 'GREETING', routerSkipped: true } });
    expect(supa.inserts).toEqual(rows(supa.inserts[2].row.id, {
      matched_handles: [], router_version: null, router_latency_ms: null, router_cache_hit: null,
      router_input_tokens: null, router_cache_read_tokens: null, router_output_tokens: null, router_error: null,
      classification: 'GREETING', router_skipped: true,
    }));
  });
});
