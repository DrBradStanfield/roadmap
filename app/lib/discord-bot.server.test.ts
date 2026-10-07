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
