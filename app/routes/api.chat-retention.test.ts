import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// C1: what each chat surface leaves on our server, pinned before the storage
// branches move into retentionOf (chat-retention.ts). The iPhone app's turn
// stores nothing (US-52 AC5, D9); the widget's turn keeps only its masked
// question row (US-15 AC7); the bubble and embed keep the transcript (US-15 AC8).

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  logAudit: vi.fn(),
  guestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
}));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: vi.fn(async () => null),
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
// api.chat.ts imports these from their defining modules (S-14).
const supa = vi.hoisted(() => ({
  logAudit: mocks.logAudit, getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
  createUserClient: vi.fn(() => ({ from: mocks.from })),
  getOrCreateGuestSession: mocks.guestSession,
  GuestRateLimitError: class extends Error {},
}));
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

import { action } from './api.chat';

const convId = '12345678-1234-4234-8234-123456789abc';
let writes: Array<{ table: string; op: 'insert' | 'update'; row: Record<string, unknown> }>;

beforeEach(() => {
  writes = [];
  mocks.from.mockImplementation((table: string) => {
    const query: any = {};
    for (const method of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'delete']) query[method] = () => query;
    query.insert = (row: Record<string, unknown>) => { writes.push({ table, op: 'insert', row }); return query; };
    query.update = (row: Record<string, unknown>) => { writes.push({ table, op: 'update', row }); return query; };
    query.then = (resolve: any, reject: any) =>
      Promise.resolve({ data: table === 'chat_conversations' ? { id: convId } : [], error: null }).then(resolve, reject);
    return query;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

async function post(body: Record<string, unknown>, context?: Record<symbol, unknown>) {
  const request = new Request('https://drstanfield.com/api/chat', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const res = await action({ request, params: {}, context } as unknown as Parameters<typeof action>[0]);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

const written = () => writes.map((w) => `${w.op} ${w.table}${w.table === 'chat_messages' ? ` ${w.row.role}` : ''}`);

describe('C1 storage per surface, before and after retentionOf', () => {
  it("'none': the iPhone app's turn writes nothing to our server (US-52 AC5)", async () => {
    const app = { [Symbol.for('roadmap.us52.app-attested')]: true };
    const res = await post({ message: 'what is a good LDL', history: [] }, app);
    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe('Synthetic answer');
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.guestSession).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("'question-rows': the widget's turn writes only its question row, no chat_messages (US-15 AC7)", async () => {
    const res = await post({ message: 'what is a good LDL', localFirst: true, sessionToken: 'tok' });
    expect(res.status).toBe(200);
    expect(written()).toEqual(['insert chat_match_events']);
    expect(mocks.from).not.toHaveBeenCalledWith('chat_messages');
    expect(mocks.from).not.toHaveBeenCalledWith('chat_conversations');
  });

  it("'transcript': the bubble or embed turn writes the conversation and both chat_messages (US-15 AC8)", async () => {
    const res = await post({ message: 'what is a good LDL', sessionToken: 'tok' });
    expect(res.status).toBe(200);
    expect((await res.json()).conversationId).toBe(convId);
    expect(written()).toEqual([
      'insert chat_conversations',
      'insert chat_messages user',
      'insert chat_messages assistant',
      'update chat_conversations',
      'insert chat_match_events',
    ]);
    expect(writes.find((w) => w.table === 'chat_messages' && w.row.role === 'user')!.row.content).toBe('what is a good LDL');
  });
});
