import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// US-15 AC7b: a widget turn (`localFirst`) runs as a guest whatever the
// customer, so the server checks the app-proxy signature and nothing more. It
// makes no Shopify customer lookup and no Supabase user link, read or write.
// The Shopify chat, which does use the customer, keeps both.

const mocks = vi.hoisted(() => ({
  appProxy: vi.fn(),
  graphql: vi.fn(),
  getOrCreateSupabaseUser: vi.fn(),
  from: vi.fn(),
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: mocks.appProxy } } }));
// The customer id is read only from a query our own verifier accepts (US-09 AC24).
vi.mock('../lib/local-first-route.server', async (original) => ({
  ...await original<typeof import('../lib/local-first-route.server')>(),
  verifyAppProxySignature: () => true,
}));
vi.mock('../lib/supabase.server', () => ({
  logAudit: vi.fn(), getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
  getOrCreateSupabaseUser: mocks.getOrCreateSupabaseUser,
  createUserClient: vi.fn(() => ({ from: mocks.from })),
  getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
  GuestRateLimitError: class extends Error {},
}));
vi.mock('../lib/chat.server', async (original) => ({
  resolveChatContext: () => ({ healthDocuments: [], userContextJson: '{}' }),
  buildSystemBlocks: () => [], buildConversationMessages: () => [],
  matchDocumentTitle: () => null, loadMatchedArticlesFromHandles: () => null,
  DOCTOR_POSTURE: '', BRAND_POSTURE: '',
  getChatCompletion: async () => ({
    content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    isFallback: false, stopReason: 'end_turn',
  }),
  reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic title', CHAT_MODEL: 'test',
  MAX_MESSAGE_LENGTH: (await original<typeof import('../lib/chat.server')>()).MAX_MESSAGE_LENGTH,
}));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: vi.fn(), reportRouterFailure: vi.fn(),
}));
vi.mock('../lib/chat-classifier.server', () => ({
  classifyMessage: async () => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 }),
  shouldFireRouter: () => false,
}));

import { action, loader } from './api.chat';

const SIGNED_IN = 'https://drstanfield.com/api/chat?logged_in_customer_id=123&signature=synthetic';

beforeEach(() => {
  mocks.graphql.mockResolvedValue({ json: async () => ({ data: { customer: { email: 'synthetic@example.invalid', firstName: 'Syn', lastName: 'Thetic' } } }) });
  mocks.appProxy.mockResolvedValue({ admin: { graphql: mocks.graphql } });
  mocks.getOrCreateSupabaseUser.mockResolvedValue('12345678-1234-4234-8234-123456789abc');
  mocks.from.mockImplementation(() => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'update', 'delete', 'insert']) query[method] = () => query;
    query.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return query;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

function post(body: Record<string, unknown>) {
  const request = new Request(SIGNED_IN, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return action({ request, params: {} } as Parameters<typeof action>[0]);
}

describe('US-15 AC7b: a widget turn checks the proxy signature only', () => {
  it('a signed-in customer\'s widget turn makes no Admin lookup and no user link', async () => {
    const res = await post({ message: 'hello', localFirst: true });
    expect(res.status).toBe(200);
    expect((await res.json()).isGuest).toBe(true);
    expect(mocks.appProxy).toHaveBeenCalledTimes(1);
    expect(mocks.graphql).not.toHaveBeenCalled();
    expect(mocks.getOrCreateSupabaseUser).not.toHaveBeenCalled();
  });

  it('the widget\'s history GET makes no Admin lookup and no user link either', async () => {
    const request = new Request(`${SIGNED_IN}&localFirst=1&sessionToken=tok`);
    const res = await loader({ request, params: {} } as Parameters<typeof loader>[0]);
    expect(res.status).toBe(200);
    expect(mocks.appProxy).toHaveBeenCalledTimes(1);
    expect(mocks.graphql).not.toHaveBeenCalled();
    expect(mocks.getOrCreateSupabaseUser).not.toHaveBeenCalled();
  });

  it('a widget turn with a bad proxy signature is still refused', async () => {
    mocks.appProxy.mockRejectedValue(new Response('Unauthorized', { status: 401 }));
    await expect(post({ message: 'hello', localFirst: true })).rejects.toMatchObject({ status: 401 });
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it('the Shopify chat still looks the customer up and links the user', async () => {
    const res = await post({ message: 'hello' });
    expect(res.status).toBe(200);
    expect((await res.json()).isGuest).not.toBe(true); // a signed-in reply carries no guest flag
    expect(mocks.graphql).toHaveBeenCalled();
    expect(mocks.getOrCreateSupabaseUser).toHaveBeenCalledWith('123', 'synthetic@example.invalid', 'Syn', 'Thetic');
  });
});
