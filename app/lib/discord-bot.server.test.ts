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
      assistantContent: 'Sorry',
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
    assistantContent: 'Hi', assistantDiscordMessageIds: ['m2'],
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
