/**
 * US-15 AC48 (Brad, 2026-10-31): Discord stays silent on SPAM. The classifier's
 * SPAM label ends the turn before the router or the answer call, flagged so
 * the bot sends nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
const edge = vi.hoisted(() => ({ classify: vi.fn(), route: vi.fn(), complete: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: null }));
vi.mock('./chat-classifier.server', async (orig) => ({
  ...(await orig<typeof import('./chat-classifier.server')>()),
  classifyMessage: edge.classify,
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

describe('platformChatCompletion on spam (US-15 AC48)', () => {
  beforeEach(() => { edge.route.mockReset(); edge.complete.mockReset(); });

  it('US-15 AC48: a SPAM message returns silent with no content, never routing or answering', async () => {
    edge.classify.mockResolvedValueOnce({ classification: 'SPAM', routerSkipped: true, latencyMs: 3, cacheHit: true, raw: 'SPAM', usage, error: null });
    const result = await platformChatCompletion({ message: 'Got my peptides from VendorX, best shop around.', history: [] });
    expect(result).toMatchObject({
      silent: true, content: '', isFallback: false, routerResult: null,
      classifier: { classification: 'SPAM', routerSkipped: true, latencyMs: 3, error: null },
    });
    expect(edge.route).not.toHaveBeenCalled();
    expect(edge.complete).not.toHaveBeenCalled();
  });

  it('US-15 AC48: a GREETING still gets an answer', async () => {
    edge.classify.mockResolvedValueOnce({ classification: 'GREETING', routerSkipped: true, latencyMs: 3, cacheHit: true, raw: 'GREETING', usage, error: null });
    edge.complete.mockResolvedValueOnce({ content: 'Hello!', usage, isFallback: false });
    const result = await platformChatCompletion({ message: 'hi there', history: [] });
    expect(result.content).toBe('Hello!');
    expect(result.silent).toBeFalsy();
    expect(edge.complete).toHaveBeenCalledTimes(1);
  });
});
