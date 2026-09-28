/**
 * US-15 AC19: Discord and YouTube have no form to apply an edit to, so their
 * pipelines never send the form tools. The real getChatCompletion runs; only
 * the classifier, the database and the network are stubbed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: null }));
vi.mock('./chat-classifier.server', () => ({
  classifyMessage: async () => ({ classification: 'SKIP', routerSkipped: true, latencyMs: 0, error: null }),
  shouldFireRouter: () => false,
}));

process.env.ANTHROPIC_API_KEY ??= 'sk-test-dummy';

import { platformChatCompletion } from './platform-chat.server';
import { runPipeline } from './youtube-bot.server';

function stubAnthropic() {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    content: [{ type: 'text', text: 'An answer.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('US-15 AC19: Discord and YouTube never send the form tools', () => {
  it('Discord', async () => {
    const bodies = stubAnthropic();
    const result = await platformChatCompletion({ message: 'my LDL was 3.8 on June 1', history: [] });
    expect(result.content).toBe('An answer.');
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).not.toHaveProperty('tools');
  });

  it('YouTube', async () => {
    const bodies = stubAnthropic();
    const thread = { topLevelCommentId: 't1', videoId: 'v1', authorDisplayName: 'A', authorChannelId: null, text: 'my LDL was 3.8', publishedAt: '2026-09-29T00:00:00Z' };
    const entry = { title: 'LDL', handle: 'ldl', url: 'https://drstanfield.com/blogs/news/ldl', tags: [], publishedAt: '2026-09-01' };
    const outcome = await runPipeline(thread, entry, 'Video body');
    expect(outcome.llmOutput).toBe('An answer.');
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).not.toHaveProperty('tools');
  });
});
