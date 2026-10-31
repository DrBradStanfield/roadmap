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
  isUnreadableAnswer: () => false,
}));

process.env.ANTHROPIC_API_KEY ??= 'sk-test-dummy';

import { platformChatCompletion } from './platform-chat.server';
import { runPipeline } from './youtube-bot.server';

// US-15 AC33: even a reply carrying a run_roadmap block gets no tool round here.
const RUN_ROADMAP_USE = { type: 'tool_use', id: 'toolu_1', name: 'run_roadmap', input: { values: [{ field: 'ldlC', value: 3.8, unit: 'mmol/L' }] } };

function stubAnthropic(content: unknown[] = [{ type: 'text', text: 'An answer.' }]) {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
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

  it('Discord never runs run_roadmap (US-15 AC33)', async () => {
    const bodies = stubAnthropic([{ type: 'text', text: 'An answer.' }, RUN_ROADMAP_USE]);
    const result = await platformChatCompletion({ message: 'analyse: LDL 3.8 mmol/L', history: [] });
    expect(result.content).toBe('An answer.');
    expect(bodies()).toHaveLength(1);
  });

  it('YouTube never runs run_roadmap (US-15 AC33)', async () => {
    const bodies = stubAnthropic([{ type: 'text', text: 'An answer.' }, RUN_ROADMAP_USE]);
    const thread = { topLevelCommentId: 't1', videoId: 'v1', authorDisplayName: 'A', authorChannelId: null, text: 'LDL 3.8 mmol/L, analyse it', publishedAt: '2026-09-29T00:00:00Z' };
    const entry = { title: 'LDL', handle: 'ldl', url: 'https://drstanfield.com/blogs/news/ldl', tags: [], publishedAt: '2026-09-01' };
    await runPipeline(thread, entry, 'Video body');
    expect(bodies()).toHaveLength(1);
  });

  // US-15 AC29 (Brad, 2026-10-14): Discord and YouTube get the answer bank too.
  it('Discord gets the writing style and the answer bank (US-15 AC29)', async () => {
    const bodies = stubAnthropic();
    await platformChatCompletion({ message: 'Can the biotin interfere with blood tests?', history: [] });
    const system = bodies()[0].system.map((b: { text: string }) => b.text).join('\n');
    expect(system).toContain('## WRITING STYLE');
    expect(system).toContain('## ANSWER BANK');
  });

  it('YouTube', async () => {
    const bodies = stubAnthropic();
    const thread = { topLevelCommentId: 't1', videoId: 'v1', authorDisplayName: 'A', authorChannelId: null, text: 'my LDL was 3.8', publishedAt: '2026-09-29T00:00:00Z' };
    const entry = { title: 'LDL', handle: 'ldl', url: 'https://drstanfield.com/blogs/news/ldl', tags: [], publishedAt: '2026-09-01' };
    const outcome = await runPipeline(thread, entry, 'Video body');
    expect(outcome.llmOutput).toBe('An answer.');
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).not.toHaveProperty('tools');
    // US-15 AC29: YouTube gets the writing style and the answer bank.
    const system = bodies()[0].system.map((b: { text: string }) => b.text).join('\n');
    expect(system).toContain('## WRITING STYLE');
    expect(system).toContain('## ANSWER BANK');
  });
});
