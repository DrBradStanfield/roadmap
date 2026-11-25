import { beforeEach, describe, expect, it, vi } from 'vitest';

// US-15 AC75: one rule builds the router's input from a turn on every surface
// (routerTurn): the question, the conversation's first user turn and its last
// three user turns, each sanitized. For the same conversation the web chat,
// Discord and YouTube hand the classifier and the router identical input. On
// YouTube the conversation is the thread the follow-up replies to
// (buildThreadHistory). Both are fakes: no model call.

const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
const mocks = vi.hoisted(() => ({ from: vi.fn(), auth: vi.fn(), route: vi.fn(), classify: vi.fn() }));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: mocks.auth,
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('../lib/supabase-identity.server', async (o) => ({ ...await o<object>(), logAudit: vi.fn() }));
vi.mock('../lib/supabase-guest.server', async (o) => ({ ...await o<object>(),
  getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })) }));
vi.mock('../lib/supabase-account.server', async (o) => ({ ...await o<object>(), getProfile: vi.fn(async () => null) }));
vi.mock('../lib/supabase-client.server', async (o) => ({ ...await o<object>(), createUserClient: vi.fn(() => ({ from: mocks.from })) }));
vi.mock('../lib/chat.server', async (original) => (await import('../lib/chat-server.test-helpers')).chatServerStub(await original<typeof import('../lib/chat.server')>()));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: mocks.route,
}));
vi.mock('@sentry/react-router', async (original) => ({ ...await original<object>(), captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('../lib/chat-classifier.server', async (original) => ({
  ...await original<typeof import('../lib/chat-classifier.server')>(),
  classifyMessage: mocks.classify,
}));

import { action } from './api.chat';
import { platformChatCompletion } from '../lib/platform-chat.server';
import { buildThreadHistory, runPipeline } from '../lib/youtube-bot-pipeline.server';

type Turn = { role: 'user' | 'assistant'; content: string };
const entry = { title: 'A video', handle: 'a-video', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z' };
const thread = (text: string) => ({ topLevelCommentId: 'c1', videoId: 'vid1', authorDisplayName: 'Viewer', authorChannelId: 'viewer', text, publishedAt: '2026-11-26T00:00:00Z' });

beforeEach(() => {
  mocks.classify.mockReset().mockResolvedValue({ classification: 'ROUTE', routerSkipped: false, latencyMs: 0, cacheHit: false, raw: 'ROUTE', usage, error: null });
  mocks.route.mockReset().mockResolvedValue({ handles: [], rawJson: '{"handles":[]}', usage, latencyMs: 1, cacheHit: false, error: null });
  mocks.auth.mockResolvedValue({ client: { from: mocks.from }, userId: '12345678-1234-4234-8234-123456789abc', customerId: null, admin: null });
  mocks.from.mockReset().mockImplementation(() => {
    const query: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'update', 'delete', 'insert']) query[m] = () => query;
    query.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return query;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** The classifier's and the router's input (question, first, recent) each surface sends for one turn. */
const seen = () => ({ classifier: mocks.classify.mock.calls.at(-1)!.slice(0, 3), router: mocks.route.mock.calls.at(-1)!.slice(0, 3) });
async function web(message: string, history: Turn[]) {
  const request = new Request('https://drstanfield.com/api/chat?logged_in_customer_id=123', {
    method: 'POST', body: JSON.stringify({ message, localFirst: true, history }), headers: { 'content-type': 'application/json' },
  });
  expect((await action({ request, params: {} } as Parameters<typeof action>[0])).status).toBe(200);
  return seen();
}
async function discord(message: string, history: Turn[]) {
  await platformChatCompletion({ message, history, purpose: 'DISCORD' });
  return seen();
}
async function youtube(message: string, history: Turn[]) {
  await runPipeline(thread(message), entry, 'The video body.', history);
  return seen();
}

describe('US-15 AC75: the classifier and router read a turn by one rule on every surface', () => {
  const history: Turn[] = [
    { role: 'user', content: 'Does magnesium help sleep?' },
    { role: 'assistant', content: 'It may help a little.' },
    { role: 'user', content: 'Which\u0007 form?' },
    { role: 'assistant', content: 'Glycinate is common.' },
    { role: 'user', content: 'How much?' },
    { role: 'assistant', content: 'Check the label.' },
    { role: 'user', content: 'Morning or night?' },
    { role: 'assistant', content: 'Night suits most.' },
  ];

  it('for the same conversation, web, Discord and YouTube hand the classifier and router identical input', async () => {
    const input = ['And with food?', 'Does magnesium help sleep?', ['Which  form?', 'How much?', 'Morning or night?']];
    const expected = { classifier: input, router: input };
    expect(await web('And with food?', history)).toEqual(expected);
    expect(await discord('And with food?', history)).toEqual(expected);
    expect(await youtube('And with food?', history)).toEqual(expected);
  });

  it('a first turn has no earlier messages on any surface', async () => {
    const input = ['Does magnesium help sleep?', undefined, []];
    const expected = { classifier: input, router: input };
    expect(await web('Does magnesium help sleep?', [])).toEqual(expected);
    expect(await discord('Does magnesium help sleep?', [])).toEqual(expected);
    expect(await youtube('Does magnesium help sleep?', [])).toEqual(expected);
  });

  it('a YouTube follow-up gives the classifier and router the parent comment and earlier replies, oldest first, the bot\'s replies left out', async () => {
    const replies = [
      { id: 'r1', authorChannelId: 'bot', authorDisplayName: 'Bot', text: 'It may help a little.', publishedAt: '2026-11-26T01:00:00Z' },
      { id: 'r2', authorChannelId: 'viewer', authorDisplayName: 'Viewer', text: 'Glycinate or citrate?', publishedAt: '2026-11-26T02:00:00Z' },
      { id: 'r3', authorChannelId: 'bot', authorDisplayName: 'Bot', text: 'Glycinate is common.', publishedAt: '2026-11-26T03:00:00Z' },
      { id: 'r4', authorChannelId: 'viewer', authorDisplayName: 'Viewer', text: 'Which form is best for that?', publishedAt: '2026-11-26T04:00:00Z' },
    ];
    const threadHistory = buildThreadHistory({ author: 'Viewer', text: 'Does magnesium help sleep?' }, replies, 'bot', 'r4');
    const input = [
      'Which form is best for that?',
      'Viewer: Does magnesium help sleep?',
      ['Viewer: Does magnesium help sleep?', 'Viewer: Glycinate or citrate?'],
    ];
    expect(await youtube('Which form is best for that?', threadHistory)).toEqual({ classifier: input, router: input });
  });
});
