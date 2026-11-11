/**
 * C1: every surface's assembled prompt carries its own saved-chat sentence
 * (chat-save-answers.ts), right after the posture, and none of the other four.
 * The real buildSystemBlocks and getChatCompletion run; the classifier, the
 * database, the Shopify check and the network are stubbed. The old scripted
 * answer ("never to a Dr Brad / MicroVitamin server account") is gone from all five.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), init: vi.fn() }));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: vi.fn(async () => null),
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('../lib/supabase.server', () => {
  const query: any = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'update', 'delete', 'insert']) query[method] = () => query;
  query.then = (resolve: any, reject: any) =>
    Promise.resolve({ data: { id: '12345678-1234-4234-8234-123456789abc' }, error: null }).then(resolve, reject);
  return {
    logAudit: vi.fn(), getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
    createUserClient: vi.fn(() => ({ from: () => query })),
    getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
    GuestRateLimitError: class extends Error {},
    supabaseAdmin: null,
  };
});
vi.mock('../lib/chat-classifier.server', () => ({
  classifyMessage: async () => ({ classification: 'SKIP', routerSkipped: true, latencyMs: 0, error: null }),
  shouldFireRouter: () => false,
  isUnreadableAnswer: () => false,
}));

process.env.ANTHROPIC_API_KEY ??= 'sk-test-dummy';

import { action } from './api.chat';
import { platformChatCompletion } from '../lib/platform-chat.server';
import { runPipeline } from '../lib/youtube-bot.server';
import { DOCTOR_POSTURE } from '../lib/chat.server';
import { DISCORD_SAVED_CHAT, SAVED_CHAT_BY_RETENTION, YOUTUBE_SAVED_CHAT, savedChatBlock } from '../lib/chat-save-answers';

let bodies: () => Array<{ system: Array<{ text: string }> }>;
beforeEach(() => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    content: [{ type: 'text', text: 'An answer.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  bodies = () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function chat(body: Record<string, unknown>, context?: Record<symbol, unknown>) {
  const request = new Request('https://drstanfield.com/api/chat', {
    method: 'POST', body: JSON.stringify({ message: 'is this chat saved?', ...body }), headers: { 'content-type': 'application/json' },
  });
  const res = await action({ request, params: {}, context } as unknown as Parameters<typeof action>[0]);
  expect(res.status).toBe(200);
}

const ALL = {
  app: SAVED_CHAT_BY_RETENTION.none,
  widget: SAVED_CHAT_BY_RETENTION['question-rows'],
  bubble: SAVED_CHAT_BY_RETENTION.transcript,
  discord: DISCORD_SAVED_CHAT,
  youtube: YOUTUBE_SAVED_CHAT,
};
const thread = { topLevelCommentId: 't1', videoId: 'v1', authorDisplayName: 'A', authorChannelId: null, text: 'is this saved anywhere?', publishedAt: '2026-09-29T00:00:00Z' };
const entry = { title: 'LDL', handle: 'ldl', url: 'https://drstanfield.com/blogs/news/ldl', tags: [], publishedAt: '2026-09-01' };

const surfaces: Array<[keyof typeof ALL, () => Promise<unknown>]> = [
  ['app', () => chat({ history: [] }, { [Symbol.for('roadmap.us52.app-attested')]: true })],
  ['widget', () => chat({ localFirst: true, sessionToken: 'tok' })],
  ['bubble', () => chat({ sessionToken: 'tok' })],
  ['discord', () => platformChatCompletion({ message: 'is this chat saved?', history: [] })],
  ['youtube', () => runPipeline(thread, entry, 'Video body')],
];

describe('C1: one saved-chat sentence per surface in the assembled prompt', () => {
  it.each(surfaces)('%s: its own sentence, right after the posture, and none of the other four', async (surface, run) => {
    await run();
    expect(bodies()).toHaveLength(1);
    const texts = bodies()[0].system.map((b) => b.text);
    const system = texts.join('\n');
    const posture = texts.indexOf(DOCTOR_POSTURE);
    expect(posture).toBeGreaterThan(0);
    expect(texts[posture + 1]).toBe(savedChatBlock(ALL[surface]));
    for (const [other, sentence] of Object.entries(ALL)) {
      if (other !== surface) expect(system, `${surface} carries the ${other} sentence`).not.toContain(sentence);
    }
    expect(system).not.toContain('never to a Dr Brad / MicroVitamin server account');
    expect(system).not.toContain('chat-history.json');
    expect(system).toContain("give the SAVED-CHAT block's text as written, and add nothing about storage beyond it");
  });

  it('the five sentences are distinct', () => {
    expect(new Set(Object.values(ALL)).size).toBe(5);
  });
});
