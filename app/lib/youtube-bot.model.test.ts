/**
 * US-15 AC78: the YouTube bot runs its router and its answer on YOUTUBE_MODEL
 * (Haiku 5.5). runPipeline is real; the classifier, router call and answer call
 * are stubbed so the test reads which model each was asked for.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase-client.server', () => ({ supabaseAdmin: null }));
vi.mock('./chat-classifier.server', async (orig) => ({
  ...(await orig<typeof import('./chat-classifier.server')>()),
  classifyMessage: vi.fn(async () => ({ classification: 'ROUTE' })),
}));
vi.mock('./chat-router.server', async (orig) => ({
  ...(await orig<typeof import('./chat-router.server')>()),
  routeQuery: vi.fn(async () => ({ handles: [], rawJson: '{"handles":[]}', usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, latencyMs: 1, cacheHit: false, error: null })),
}));
vi.mock('./chat.server', async (orig) => ({
  ...(await orig<typeof import('./chat.server')>()),
  getChatCompletion: vi.fn(async () => ({ content: 'An answer.', usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, isFallback: false })),
}));

import { runPipeline } from './youtube-bot.server';
import { routeQuery } from './chat-router.server';
import { getChatCompletion } from './chat.server';

describe('US-15 AC78: the YouTube bot routes and answers on Haiku 5.5', () => {
  it('asks routeQuery and getChatCompletion for claude-haiku-5-5', async () => {
    const thread = { topLevelCommentId: 'c1', videoId: 'vid1', authorDisplayName: 'V', authorChannelId: null, text: 'What dose of vitamin D is safe?', publishedAt: '2026-11-20T00:00:00Z' };
    const entry = { title: 'A video', handle: 'a-video', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z' };
    const outcome = await runPipeline(thread, entry, 'The video body.');
    expect(outcome).toMatchObject({ posted: true, replyText: 'An answer.' });
    expect(vi.mocked(routeQuery)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(routeQuery).mock.calls[0][3]).toBe('YOUTUBE');
    expect(vi.mocked(routeQuery).mock.calls[0][4]).toBe('claude-haiku-5-5');
    expect(vi.mocked(getChatCompletion).mock.calls[0][4]).toMatchObject({ purpose: 'YOUTUBE', model: 'claude-haiku-5-5' });
  });
});
