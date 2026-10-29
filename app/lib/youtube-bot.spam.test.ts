/**
 * US-15 AC41: a YouTube comment the classifier labels SPAM gets no reply, the
 * same silent skip as GREETING, with no router or answer call.
 */
import { describe, it, expect, vi } from 'vitest';

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

import { runPipeline } from './youtube-bot.server';
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
