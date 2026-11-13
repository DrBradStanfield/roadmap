/**
 * C1 (US-15 AC59, US-52 AC15): every surface's assembled prompt carries its own
 * saved-chat sentence (chat-save-answers.ts), right after the posture, and none
 * of the other four. The real buildSystemBlocks and getChatCompletion run; the
 * classifier, the database, the Shopify check and the network are stubbed. The
 * old claims ("never to a Dr Brad / MicroVitamin server account", "never in a Dr
 * Brad server account", "migrates to your account") are gone from every prompt,
 * the brand bubble's included.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), init: vi.fn() }));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: vi.fn(async () => null),
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
// api.chat.ts imports these from their defining modules (S-14).
const supa = vi.hoisted(() => {
  const query: any = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'update', 'delete', 'insert']) query[method] = () => query;
  query.then = (resolve: any, reject: any) =>
    Promise.resolve({ data: { id: '12345678-1234-4234-8234-123456789abc' }, error: null }).then(resolve, reject);
  return {
    logAudit: vi.fn(), getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
    createUserClient: vi.fn(() => ({ from: () => query })),
    getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
    GuestRateLimitError: class extends Error {},
  };
});
vi.mock('../lib/supabase-identity.server', async (o) => ({ ...await o<object>(), logAudit: supa.logAudit }));
vi.mock('../lib/supabase-guest.server', async (o) => ({ ...await o<object>(), getOrCreateGuestSession: supa.getOrCreateGuestSession, GuestRateLimitError: supa.GuestRateLimitError }));
vi.mock('../lib/supabase-account.server', async (o) => ({ ...await o<object>(), getProfile: supa.getProfile, updateSubscriptionPlan: supa.updateSubscriptionPlan }));
vi.mock('../lib/supabase-client.server', () => ({ supabaseAdmin: null, createUserClient: supa.createUserClient }));
vi.mock('../lib/chat-classifier.server', () => ({
  classifyMessage: async () => ({ classification: 'SKIP', routerSkipped: true, latencyMs: 0, error: null }),
  shouldFireRouter: () => false,
  isUnreadableAnswer: () => false,
}));

process.env.ANTHROPIC_API_KEY ??= 'sk-test-dummy';

import { action } from './api.chat';
import { platformChatCompletion } from '../lib/platform-chat.server';
import { runPipeline } from '../lib/youtube-bot.server';
import { BRAND_POSTURE, DOCTOR_POSTURE } from '../lib/chat.server';
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

/** Claims no assembled prompt may carry: each contradicts a surface's SAVED-CHAT block (adversary R1, Fable 2026-11-11). */
const RETIRED = ['never to a Dr Brad / MicroVitamin server account', 'never in a Dr Brad server account', 'migrates to your account', 'chat-history.json'];
// The doctor posture's "where's my data" line, exactly as Fable ruled it (C1 fix round).
const WHERES_MY_DATA = "'Where's my data' questions → the user's health record lives in their OWN storage, not on our server. For what this chat leaves on our server, give the SAVED-CHAT block's text as written.";

describe('C1: one saved-chat sentence per surface in the assembled prompt (US-15 AC59, US-52 AC15)', () => {
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
    for (const claim of RETIRED) expect(system, `${surface} still says "${claim}"`).not.toContain(claim);
    expect(system).toContain(WHERES_MY_DATA);
    expect(system).toContain("give the SAVED-CHAT block's text as written, and add nothing about storage beyond it");
  });

  it('the brand bubble (microvitamin.com): the bubble sentence after the brand posture, and no retired claim', async () => {
    vi.stubEnv('CHAT_SURFACE', 'brand');
    try {
      await chat({ sessionToken: 'tok' });
    } finally {
      vi.unstubAllEnvs();
    }
    const texts = bodies()[0].system.map((b) => b.text);
    expect(texts[texts.indexOf(BRAND_POSTURE) + 1]).toBe(savedChatBlock(ALL.bubble));
    for (const claim of RETIRED) expect(texts.join('\n'), claim).not.toContain(claim);
  });

  it('the five sentences are distinct', () => {
    expect(new Set(Object.values(ALL)).size).toBe(5);
  });
});
