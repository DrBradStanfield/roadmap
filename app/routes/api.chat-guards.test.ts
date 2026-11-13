import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// C1 (Fable after the build): the audit row and the run_roadmap event now read
// `retention !== 'none'` in place of `!app`. The iPhone app's turn writes neither
// (US-52 AC5, D9, US-67 AC1); the tool page's widget and the bubble write both,
// as on main (US-15 AC33).

const mocks = vi.hoisted(() => ({ logAudit: vi.fn(), recordServerEvent: vi.fn(async () => {}) }));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: vi.fn(async () => null),
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('../lib/product-events.server', () => ({ recordServerEvent: mocks.recordServerEvent }));
// api.chat.ts imports these from their defining modules (S-14).
const supa = vi.hoisted(() => {
  const query: any = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'update', 'delete', 'insert']) query[method] = () => query;
  query.then = (resolve: any, reject: any) =>
    Promise.resolve({ data: { id: '12345678-1234-4234-8234-123456789abc' }, error: null }).then(resolve, reject);
  return {
    logAudit: mocks.logAudit, getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
    createUserClient: vi.fn(() => ({ from: () => query })),
    getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
    GuestRateLimitError: class extends Error {},
  };
});
vi.mock('../lib/supabase-identity.server', async (o) => ({ ...await o<object>(), logAudit: supa.logAudit }));
vi.mock('../lib/supabase-guest.server', async (o) => ({ ...await o<object>(), getOrCreateGuestSession: supa.getOrCreateGuestSession, GuestRateLimitError: supa.GuestRateLimitError }));
vi.mock('../lib/supabase-account.server', async (o) => ({ ...await o<object>(), getProfile: supa.getProfile, updateSubscriptionPlan: supa.updateSubscriptionPlan }));
vi.mock('../lib/supabase-client.server', () => ({ supabaseAdmin: null, createUserClient: supa.createUserClient }));
vi.mock('../lib/chat.server', async (original) => ({
  resolveChatContext: () => ({ userContextJson: '{}' }),
  buildSystemBlocks: () => [], buildConversationMessages: () => [],
  loadMatchedArticlesFromHandles: () => null,
  DOCTOR_POSTURE: '', BRAND_POSTURE: '',
  getChatCompletion: async () => ({
    content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    isFallback: false, stopReason: 'end_turn', roadmapRun: { applied: 2, rejected: 1 },
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

import { action } from './api.chat';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

async function post(body: Record<string, unknown>, context?: Record<symbol, unknown>) {
  const request = new Request('https://drstanfield.com/api/chat', {
    method: 'POST', body: JSON.stringify({ message: 'how am I doing?', ...body }), headers: { 'content-type': 'application/json' },
  });
  const res = await action({ request, params: {}, context } as unknown as Parameters<typeof action>[0]);
  await new Promise((resolve) => setImmediate(resolve));
  expect(res.status).toBe(200);
}

describe('C1: the audit row and the run_roadmap event, per surface', () => {
  it("the iPhone app's turn writes no audit row and no run_roadmap event (US-52 AC5, D9)", async () => {
    await post({ history: [] }, { [Symbol.for('roadmap.us52.app-attested')]: true });
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.recordServerEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['the tool page widget', { localFirst: true, sessionToken: 'tok' }],
    ['the bubble', { sessionToken: 'tok' }],
  ])('%s writes the audit row and the run_roadmap event, as main does (US-15 AC33)', async (_surface, body) => {
    await post(body);
    expect(mocks.logAudit).toHaveBeenCalledWith('87654321-4321-4321-8321-cba987654321', 'CHAT_MESSAGE', 'chat', expect.any(String), { cacheRead: 0, cacheCreation: 0 });
    expect(mocks.recordServerEvent).toHaveBeenCalledWith('chat_run_roadmap', { count: 2, rejected: 1 });
  });
});
