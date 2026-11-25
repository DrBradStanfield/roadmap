/**
 * US-15 AC74: a router failure on Discord or YouTube is reported to Sentry
 * once, with the web's words and tags plus the surface; a router that answers
 * is not reported. The report carries no chat text and no router error text.
 * The web's report: api.chat-masters.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/react-router';

const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
const edge = vi.hoisted(() => ({ route: vi.fn(), complete: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase-client.server', () => ({ supabaseAdmin: null }));
vi.mock('./chat-classifier.server', async (orig) => ({
  ...(await orig<typeof import('./chat-classifier.server')>()),
  classifyMessage: vi.fn(async () => ({ classification: 'ROUTE', routerSkipped: false, latencyMs: 1, cacheHit: false, raw: 'ROUTE', usage, error: null })),
}));
vi.mock('./chat-router.server', async (orig) => ({
  ...(await orig<typeof import('./chat-router.server')>()),
  routeQuery: edge.route,
}));
vi.mock('./chat.server', async (orig) => ({
  ...(await orig<typeof import('./chat.server')>()),
  getChatCompletion: edge.complete,
}));

import { platformChatCompletion } from './platform-chat.server';
import { runPipeline } from './youtube-bot.server';

const QUESTION = 'Should I take vitamin D at 4000 IU?';
const thread = { topLevelCommentId: 'c1', videoId: 'vid1', authorDisplayName: 'V', authorChannelId: null, text: QUESTION, publishedAt: '2026-11-26T00:00:00Z' };
const entry = { title: 'A video', handle: 'a-video', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z' };
const surfaces: Array<[string, 'DISCORD' | 'YOUTUBE', () => Promise<unknown>]> = [
  ['Discord', 'DISCORD', () => platformChatCompletion({ message: QUESTION, history: [], purpose: 'DISCORD' })],
  ['YouTube', 'YOUTUBE', () => runPipeline(thread, entry, 'The video body.')],
];
const routerReports = () => vi.mocked(Sentry.captureMessage).mock.calls.filter(([msg]) => msg === 'Router: request or output failure');

beforeEach(() => {
  vi.mocked(Sentry.captureMessage).mockClear();
  edge.route.mockReset();
  edge.complete.mockReset().mockResolvedValue({ content: 'An answer.', usage, isFallback: false });
});

describe('US-15 AC74: router failures are reported from every surface', () => {
  it.each(surfaces)('%s: a failed router call is reported once, with the surface and no text', async (_name, surface, run) => {
    edge.route.mockResolvedValueOnce({ handles: [], rawJson: 'not json', usage, latencyMs: 7, cacheHit: true, error: `Unexpected token in ${QUESTION}` });
    await run();
    expect(edge.route).toHaveBeenCalledTimes(1);
    expect(routerReports()).toEqual([['Router: request or output failure', {
      level: 'warning',
      tags: { feature: 'chat', subsystem: 'router', surface },
      extra: { latencyMs: 7, cacheHit: true },
    }]]);
    expect(JSON.stringify(routerReports())).not.toMatch(/vitamin|4000|Unexpected|not json/);
  });

  it.each(surfaces)('%s: a router that answers is not reported', async (_name, _surface, run) => {
    edge.route.mockResolvedValueOnce({ handles: [], rawJson: '{"handles":[]}', usage, latencyMs: 7, cacheHit: false, error: null });
    await run();
    expect(edge.route).toHaveBeenCalledTimes(1);
    expect(routerReports()).toEqual([]);
  });
});
