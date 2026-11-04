/**
 * US-15 AC52, end to end: an Anthropic overload (529 on both attempts) through
 * the real runPipeline and getChatCompletion ends in an api-error fallback, and
 * persistYouTubeTurn stores the web chat's assistant fallback row for it. Only
 * the classifier, the database, the retry sleep and the network are stubbed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const supa = vi.hoisted(() => {
  // Read at module load: persistYouTubeTurn is a no-op without it.
  process.env.YOUTUBE_BOT_PROFILE_ID = 'bot-profile';
  return { inserts: [] as Array<{ table: string; row: Record<string, unknown> }> };
});

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./cron-helpers.server', async (orig) => ({ ...(await orig<typeof import('./cron-helpers.server')>()), sleep: async () => {} }));
vi.mock('./chat-classifier.server', () => ({
  classifyMessage: async () => ({ classification: 'SKIP', routerSkipped: true, latencyMs: 0, error: null }),
  shouldFireRouter: () => false,
  isUnreadableAnswer: () => false,
}));
vi.mock('./supabase.server', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const ok = { data: table === 'chat_conversations' ? { id: 'conv-1' } : null, error: null };
      const query = {
        insert: (row: Record<string, unknown>) => { supa.inserts.push({ table, row }); return query; },
        select: () => query,
        eq: () => query,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => Promise.resolve(ok),
        then: (onOk: (v: unknown) => unknown) => Promise.resolve(ok).then(onOk),
      };
      return query;
    },
  },
}));

process.env.ANTHROPIC_API_KEY ??= 'sk-test-dummy';

import { runPipeline, persistYouTubeTurn, shouldUnclaim } from './youtube-bot.server';
import { FALLBACK_RESPONSE, CHAT_MODEL } from './chat.server';

afterEach(() => { vi.unstubAllGlobals(); });

describe('US-15 AC52: a 529 on YouTube stores the assistant fallback row', () => {
  it('runPipeline ends in api-error and the row carries failure_mode and error_detail', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
      { status: 529, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const thread = { topLevelCommentId: 't1', videoId: 'v1', authorDisplayName: 'A', authorChannelId: null, text: 'What is a good ApoB?', publishedAt: '2026-11-03T00:00:00Z' };
    const entry = { title: 'ApoB', handle: 'apob', url: 'https://drstanfield.com/blogs/news/apob', tags: [], publishedAt: '2026-09-01' };

    const outcome = await runPipeline(thread, entry, 'Video body');
    expect(fetchMock).toHaveBeenCalledTimes(2); // one retry, then the fallback
    expect(outcome.completion?.failureMode).toBe('api-error');
    expect(outcome).toMatchObject({ posted: false, isFallback: true, failureMode: 'api-error' });
    expect(shouldUnclaim(outcome)).toBe(true);

    supa.inserts.length = 0;
    await persistYouTubeTurn({ thread, outcome, postedYoutubeId: null });
    const asst = supa.inserts.find((i) => i.table === 'chat_messages' && i.row.role === 'assistant')?.row;
    expect(asst).toMatchObject({
      content: FALLBACK_RESPONSE, model: CHAT_MODEL, is_fallback: true, failure_mode: 'api-error',
      error_detail: expect.stringContaining('529'),
    });
    expect(supa.inserts.find((i) => i.table === 'chat_match_events')?.row)
      .toMatchObject({ message_id: asst?.id, is_fallback: true, failure_mode: 'api-error' });
  });
});
