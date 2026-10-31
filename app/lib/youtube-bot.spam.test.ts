/**
 * US-15 AC41: a YouTube comment the classifier labels SPAM gets no reply, the
 * same silent skip as GREETING, with no router or answer call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: null }));
vi.mock('./chat-classifier.server', async (orig) => ({
  ...(await orig<typeof import('./chat-classifier.server')>()),
  classifyMessage: vi.fn(async () => ({ classification: 'SPAM' })),
}));
vi.mock('./chat-router.server', async (orig) => ({
  ...(await orig<typeof import('./chat-router.server')>()),
  routeQuery: vi.fn(),
}));
vi.mock('./chat.server', async (orig) => ({
  ...(await orig<typeof import('./chat.server')>()),
  getChatCompletion: vi.fn(),
}));

import { runPipeline, shouldUnclaim } from './youtube-bot.server';
import { classifyMessage } from './chat-classifier.server';
import { routeQuery } from './chat-router.server';
import { getChatCompletion } from './chat.server';

describe('runPipeline on spam (US-15 AC41)', () => {
  it('skips a SPAM comment without routing or answering', async () => {
    const thread = { topLevelCommentId: 'c1', videoId: 'vid1', authorDisplayName: 'V', authorChannelId: null, text: 'VendorX is the only vendor I trust.', publishedAt: '2026-10-21T00:00:00Z' };
    const entry = { title: 'A video', handle: 'a-video', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z' };
    const outcome = await runPipeline(thread, entry, 'The video body.');
    expect(outcome).toMatchObject({ posted: false, classification: 'SPAM', skipReason: 'classifier=SPAM', routerSkipped: true });
    expect(routeQuery).not.toHaveBeenCalled();
    expect(getChatCompletion).not.toHaveBeenCalled();
  });
});

// US-15 AC48 (Brad, 2026-10-31): a classifier answer the bot cannot read (a
// refusal, or a word that is no label) is skipped silently like SPAM. A
// transport failure still fails open, so an outage ends in a retried fallback.
describe('runPipeline on an unreadable classifier answer (US-15 AC48)', () => {
  const thread = { topLevelCommentId: 'c2', videoId: 'vid1', authorDisplayName: 'V', authorChannelId: null, text: 'Great channel, check my page for deals.', publishedAt: '2026-10-21T00:00:00Z' };
  const entry = { title: 'A video', handle: 'a-video', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z' };
  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  beforeEach(() => { vi.mocked(routeQuery).mockReset(); vi.mocked(getChatCompletion).mockReset(); });

  it.each([
    ['refusal', 'classifier=ERROR (refusal)'],
    ['unparseable: PROMOTION', 'classifier=ERROR (unparseable)'],
  ])('US-15 AC48: skips error %s silently, keeping the claim', async (error, skipReason) => {
    vi.mocked(classifyMessage).mockResolvedValueOnce({ classification: 'ERROR', routerSkipped: false, latencyMs: 1, cacheHit: false, raw: '', usage, error });
    const outcome = await runPipeline(thread, entry, 'The video body.');
    expect(outcome).toMatchObject({ posted: false, classification: 'ERROR', skipReason, routerSkipped: true });
    expect(shouldUnclaim(outcome)).toBe(false);
    expect(routeQuery).not.toHaveBeenCalled();
    expect(getChatCompletion).not.toHaveBeenCalled();
  });

  it('US-15 AC48: a classifier timeout still fails open to the router and the answer, and a failed answer unclaims', async () => {
    vi.mocked(classifyMessage).mockResolvedValueOnce({ classification: 'ERROR', routerSkipped: false, latencyMs: 5000, cacheHit: false, raw: '', usage, error: 'timeout' });
    vi.mocked(routeQuery).mockResolvedValueOnce({ handles: [], rawJson: '{"handles":[]}', usage, latencyMs: 1, cacheHit: false, error: null });
    vi.mocked(getChatCompletion).mockResolvedValueOnce({ content: 'Sorry', usage, isFallback: true, failureMode: 'api-error' } as Awaited<ReturnType<typeof getChatCompletion>>);
    const outcome = await runPipeline(thread, entry, 'The video body.');
    expect(routeQuery).toHaveBeenCalledTimes(1);
    expect(getChatCompletion).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ posted: false, classification: 'ERROR', routerSkipped: false, isFallback: true });
    expect(shouldUnclaim(outcome)).toBe(true);
  });
});
