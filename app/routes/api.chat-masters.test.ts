import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// US-50 AC14: on the storefront chat, an article the router picks is replaced
// by its topic masters before content loads, unless the chat is open on that
// article (`articleHandle`) or the message gives its URL or handle. The match
// row records the replaced handles and the masters that loaded reduced.

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  auth: vi.fn(),
  route: vi.fn(),
  load: vi.fn((..._args: unknown[]) => ({ content: 'loaded', titles: [] as string[], skipped: [] as string[], reduced: ['tm-d'] })),
  fakes: [
    { title: 'Vitamin D', handle: 'tm-d', url: 'u', tags: [], publishedAt: '2024-01-01T00:00:00Z', type: 'reference' as const, reviewed: '2026-10-20' },
    { title: 'Old D video', handle: 'tm-d-video', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z', topics: ['tm-d'],
      commerceUrl: 'https://microvitamin.com/blogs/articles/tm-d-video-commerce' },
  ],
}));
vi.mock('../lib/blog-index.server', async (original) => {
  const real = await original<typeof import('../lib/blog-index.server')>();
  return { ...real, loadBlogIndex: () => [...real.loadBlogIndex(), ...mocks.fakes] };
});
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: mocks.auth,
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('../lib/supabase.server', () => ({
  logAudit: vi.fn(), getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
  createUserClient: vi.fn(() => ({ from: mocks.from })),
  getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
  GuestRateLimitError: class extends Error {},
}));
vi.mock('../lib/chat.server', async (original) => ({
  resolveChatContext: () => ({ healthDocuments: [], userContextJson: '{}' }),
  buildSystemBlocks: () => [], buildConversationMessages: () => [],
  matchDocumentTitle: () => null, loadMatchedArticlesFromHandles: mocks.load,
  DOCTOR_POSTURE: '', BRAND_POSTURE: '',
  getChatCompletion: async () => ({ content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, isFallback: false, stopReason: 'end_turn' }),
  reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic title', CHAT_MODEL: 'test',
  MAX_MESSAGE_LENGTH: (await original<typeof import('../lib/chat.server')>()).MAX_MESSAGE_LENGTH,
}));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: mocks.route, reportRouterFailure: vi.fn(),
}));
vi.mock('../lib/chat-classifier.server', () => ({
  classifyMessage: async (text: string) => (text.startsWith('Thanks')
    ? { routerSkipped: true, classification: 'SKIP', latencyMs: 0 }
    : { routerSkipped: false, classification: 'ROUTE', latencyMs: 0 }),
  shouldFireRouter: (r: { routerSkipped: boolean }) => !r.routerSkipped,
}));

import { action } from './api.chat';

const id = '12345678-1234-4234-8234-123456789abc';
let inserts: Array<{ table: string; row: Record<string, unknown> }>;

beforeEach(() => {
  inserts = [];
  mocks.load.mockClear();
  mocks.route.mockClear();
  mocks.route.mockResolvedValue({ handles: ['tm-d-video'], rawJson: null, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, latencyMs: 1, cacheHit: false, error: null });
  mocks.auth.mockResolvedValue({ client: { from: mocks.from }, userId: id, customerId: null, admin: null });
  mocks.from.mockReset().mockImplementation((table: string) => {
    const query: any = {};
    for (const method of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'update', 'delete']) query[method] = () => query;
    query.insert = (row: Record<string, unknown>) => { inserts.push({ table, row }); return query; };
    query.then = (resolve: any, reject: any) =>
      Promise.resolve({ data: table === 'chat_conversations' ? { id } : [], error: null }).then(resolve, reject);
    return query;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); });

async function post(body: Record<string, unknown>) {
  const request = new Request('https://drstanfield.com/api/chat?logged_in_customer_id=123', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const res = await action({ request, params: {} } as Parameters<typeof action>[0]);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

const loaded = () => mocks.load.mock.calls.at(-1)![0];
const matchEvent = () => inserts.find((i) => i.table === 'chat_match_events')!.row as any;

describe('US-50 AC14: the storefront chat loads the master, not the older post', () => {
  it('replaces the routed post with its master, and logs the replaced and reduced handles', async () => {
    expect((await post({ message: 'Is vitamin D worth taking?' })).status).toBe(200);
    expect(loaded()).toEqual(['tm-d']);
    const row = matchEvent();
    expect(row.matched_handles).toEqual(['tm-d-video']);
    expect(row.router_context).toEqual({ platform: 'shopify', first: null, recent: [], replaced: ['tm-d-video'], reduced: ['tm-d'] });
  });

  it('the widget row keeps the replaced and reduced handles, nothing else', async () => {
    await post({ message: 'Is vitamin D worth taking?', localFirst: true });
    expect(matchEvent().router_context).toEqual({ platform: 'widget', replaced: ['tm-d-video'], reduced: ['tm-d'] });
  });

  it('the post the chat is open on stays, with its master beside it (articleHandle)', async () => {
    await post({ message: 'What dose does this post suggest?', localFirst: true, articleHandle: 'tm-d-video-commerce' });
    expect(loaded()).toEqual(['tm-d-video', 'tm-d']);
    expect(matchEvent().router_context).toEqual({ platform: 'widget', reduced: ['tm-d'] });
    expect(JSON.stringify(matchEvent())).not.toContain('tm-d-video-commerce');
  });

  it('the open post loads after its master when the router picked the master', async () => {
    mocks.route.mockResolvedValueOnce({ handles: ['tm-d'], rawJson: null, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, latencyMs: 1, cacheHit: false, error: null });
    await post({ message: 'What dose?', localFirst: true, articleHandle: 'tm-d-video-commerce' });
    expect(loaded()).toEqual(['tm-d', 'tm-d-video']);
  });

  it('the open post is not forced in when the question routed elsewhere', async () => {
    mocks.route.mockResolvedValueOnce({ handles: ['apob-explained-x'], rawJson: null, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, latencyMs: 1, cacheHit: false, error: null });
    await post({ message: 'What is ApoB?', localFirst: true, articleHandle: 'tm-d-video-commerce' });
    expect(loaded()).toEqual(['apob-explained-x']);
  });

  it('a URL in the message names the post', async () => {
    await post({ message: 'About microvitamin.com/blogs/articles/tm-d-video-commerce: is it still right?' });
    expect(loaded()).toEqual(['tm-d-video', 'tm-d']);
  });

  it('a URL after the router\'s first 2,000 characters still names the post (Codex C2)', async () => {
    await post({ message: `${'Some context. '.repeat(200)}About microvitamin.com/blogs/articles/tm-d-video-commerce: still right?`, localFirst: true });
    expect(loaded()).toEqual(['tm-d-video', 'tm-d']);
  });

  it('a post the message names is not forced in when the router did not run (round 2, N3)', async () => {
    await post({ message: 'Thanks! microvitamin.com/blogs/articles/tm-d-video-commerce was great', localFirst: true, articleHandle: 'tm-d-video-commerce' });
    expect(mocks.route).not.toHaveBeenCalled();
    expect(loaded()).toEqual([]);
  });

  it('an articleHandle that is not an index handle is ignored and never stored', async () => {
    await post({ message: 'Is vitamin D worth taking?', articleHandle: 'not-a-real-post-x9' });
    expect(loaded()).toEqual(['tm-d']);
    expect(JSON.stringify(inserts)).not.toContain('not-a-real-post-x9');
  });
});
