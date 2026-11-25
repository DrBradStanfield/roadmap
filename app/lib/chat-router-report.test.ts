/**
 * US-15 AC74: router failures on Discord and YouTube are reported with the
 * web's words and tags, plus the platform; a router that answers is not
 * reported. Discord reports once per failed turn. YouTube retries a failed
 * comment every tick, so it reports once per tick with a count (as US-15 AC58
 * does for main-model fallbacks). No chat text and no router error text.
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
import { reportTickFallbacks, runPipeline } from './youtube-bot.server';

const QUESTION = 'Should I take vitamin D at 4000 IU?';
const thread = { topLevelCommentId: 'c1', videoId: 'vid1', authorDisplayName: 'V', authorChannelId: null, text: QUESTION, publishedAt: '2026-11-26T00:00:00Z' };
const entry = { title: 'A video', handle: 'a-video', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z' };
const failed = { handles: [], rawJson: 'not json', usage, latencyMs: 7, cacheHit: true, error: `Unexpected token in ${QUESTION}` };
const answered = { handles: [], rawJson: '{"handles":[]}', usage, latencyMs: 7, cacheHit: false, error: null };
const routerReports = () => vi.mocked(Sentry.captureMessage).mock.calls.filter(([msg]) => msg === 'Router: request or output failure');
const youtubeTick = { level: 'warning', tags: { feature: 'chat', subsystem: 'router', platform: 'youtube' } };

beforeEach(() => {
  reportTickFallbacks(); // a fresh tick: earlier tests' counts are flushed
  vi.mocked(Sentry.captureMessage).mockClear();
  edge.route.mockReset();
  edge.complete.mockReset().mockResolvedValue({ content: 'An answer.', usage, isFallback: false });
});

describe('US-15 AC74: router failures are reported from every surface', () => {
  it('Discord: a failed router call is reported once, with the platform and no text', async () => {
    edge.route.mockResolvedValueOnce(failed);
    await platformChatCompletion({ message: QUESTION, history: [], purpose: 'DISCORD' });
    expect(edge.route).toHaveBeenCalledTimes(1);
    expect(routerReports()).toEqual([['Router: request or output failure', {
      level: 'warning', tags: { feature: 'chat', subsystem: 'router', platform: 'discord' }, extra: { latencyMs: 7, cacheHit: true },
    }]]);
    expect(JSON.stringify(routerReports())).not.toMatch(/vitamin|4000|Unexpected|not json/);
  });

  it('Discord: a router that answers is not reported', async () => {
    edge.route.mockResolvedValueOnce(answered);
    await platformChatCompletion({ message: QUESTION, history: [], purpose: 'DISCORD' });
    expect(edge.route).toHaveBeenCalledTimes(1);
    expect(routerReports()).toEqual([]);
  });

  it('YouTube: three failed comments in a tick give one report with the count at the tick\'s end; the next tick again one', async () => {
    edge.route.mockResolvedValue(failed);
    for (let i = 0; i < 3; i++) await runPipeline(thread, entry, 'The video body.');
    expect(edge.route).toHaveBeenCalledTimes(3);
    expect(routerReports()).toEqual([]); // nothing per comment: a failed comment is retried every tick
    reportTickFallbacks();
    expect(routerReports()).toEqual([['Router: request or output failure', { ...youtubeTick, extra: { count: 3 } }]]);
    expect(JSON.stringify(routerReports())).not.toMatch(/vitamin|4000|Unexpected|not json/);

    for (let i = 0; i < 2; i++) await runPipeline(thread, entry, 'The video body.');
    reportTickFallbacks();
    expect(routerReports()).toEqual([
      ['Router: request or output failure', { ...youtubeTick, extra: { count: 3 } }],
      ['Router: request or output failure', { ...youtubeTick, extra: { count: 2 } }],
    ]);
  });

  it('YouTube: a router that answers is not counted, so a quiet tick reports nothing', async () => {
    edge.route.mockResolvedValueOnce(answered);
    await runPipeline(thread, entry, 'The video body.');
    reportTickFallbacks();
    expect(edge.route).toHaveBeenCalledTimes(1);
    expect(routerReports()).toEqual([]);
  });
});
