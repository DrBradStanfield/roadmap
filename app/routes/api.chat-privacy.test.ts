import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  auth: vi.fn(),
  buildConversationMessages: vi.fn(() => []),
  /** Rows a `<table>:select` hands back, when a test needs stored history. */
  selectRows: {} as Record<string, unknown[]>,
}));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: mocks.auth,
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('../lib/supabase.server', () => ({
  logAudit: vi.fn(), getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
  createUserClient: vi.fn(), getOrCreateGuestSession: vi.fn(), GuestRateLimitError: class extends Error {},
}));
vi.mock('../lib/chat.server', () => ({
  resolveChatContext: () => ({ healthDocuments: [], userContextJson: '{}' }),
  buildSystemBlocks: () => [], buildConversationMessages: mocks.buildConversationMessages,
  matchDocumentTitle: () => null, loadMatchedArticlesFromHandles: () => [],
  DOCTOR_POSTURE: '', BRAND_POSTURE: '',
  getChatCompletion: async () => ({ content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, isFallback: false }),
  reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic title', CHAT_MODEL: 'test', MAX_MESSAGE_LENGTH: 4000,
}));
vi.mock('../lib/chat-router.server', () => ({ sanitizeForRouter: (text: string) => text, reportRouterFailure: vi.fn(), ROUTER_VERSION: 'test' }));
vi.mock('../lib/chat-classifier.server', () => ({ classifyMessage: async () => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 }), shouldFireRouter: () => false }));

import { action, loader } from './api.chat';

const id = '12345678-1234-4234-8234-123456789abc';
const marker = 'PHI_SENTINEL synthetic LDL 4.2';
let envelopes: unknown[];
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;
let failOperation = '';
let rejectFailure = false;

beforeEach(() => {
  envelopes = [];
  failOperation = '';
  rejectFailure = false;
  mocks.selectRows = {};
  mocks.buildConversationMessages.mockClear();
  mocks.auth.mockResolvedValue({ client: { from: mocks.from }, userId: id, customerId: null, admin: null });
  mocks.from.mockReset().mockImplementation((table: string) => {
    let operation = `${table}:select`;
    const query: any = {};
    for (const method of ['select', 'eq', 'order', 'limit', 'single']) query[method] = () => query;
    query.insert = (data: { role?: string }) => { operation = `${table}:insert:${data.role ?? ''}`; return query; };
    query.update = () => { operation = `${table}:update`; return query; };
    query.delete = () => { operation = `${table}:delete`; return query; };
    query.then = (resolve: any, reject: any) => {
      const failed = operation === failOperation;
      const echoedError = { code: '22P02', message: marker, details: marker, hint: marker };
      const result = failed && rejectFailure
        ? Promise.reject(Object.assign(new Error(marker), echoedError))
        : Promise.resolve({
            data: operation === 'chat_conversations:insert:' ? { id } : (mocks.selectRows[operation] ?? []),
            error: failed ? echoedError : null,
          });
      return result.then(resolve, reject);
    };
    return query;
  });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  Sentry.init({
    dsn: 'https://public@example.invalid/1', defaultIntegrations: false,
    transport: () => ({ send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }),
  });
});

afterEach(async () => { await Sentry.close(); vi.restoreAllMocks(); });

async function request(method: string, body: unknown, query = '') {
  const request = new Request(`https://drstanfield.com/api/chat?logged_in_customer_id=123${query}`, {
    method, ...(method === 'GET' ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  return method === 'GET'
    ? loader({ request, params: {} } as Parameters<typeof loader>[0])
    : action({ request, params: {} } as Parameters<typeof action>[0]);
}

async function assertPrivateDiagnostics() {
  // Detached persistence promises have their own rejection handlers.
  await new Promise((resolve) => setImmediate(resolve));
  await Sentry.flush();
  expect(envelopes.length).toBeGreaterThan(0);
  expect(JSON.stringify(envelopes)).not.toContain(marker);
  expect(JSON.stringify(envelopes)).not.toContain(id);
  expect(JSON.stringify(consoleError.mock.calls)).not.toContain(marker);
  expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(marker);
}

describe('US-15 AC4 — chat identifiers and persistence diagnostics', () => {
  it.each(['GET', 'POST', 'DELETE'])('rejects invalid %s IDs before database queries', async (method) => {
    const res = await request(method, { message: marker, conversationId: marker }, `&conversationId=${encodeURIComponent(marker)}`);
    expect(res.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
    await Sentry.flush();
    expect(envelopes).toEqual([]);
  });

  it.each([null, [], 'string', 1, true])('rejects a non-object JSON body: %j', async (body) => {
    expect((await request('POST', body)).status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
    await Sentry.flush();
    expect(envelopes).toEqual([]);
  });

  it.each(['', 1, {}, []])('rejects explicitly invalid POST conversationId: %j', async (conversationId) => {
    expect((await request('POST', { message: marker, conversationId })).status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('accepts uppercase UUIDs on an existing conversation', async () => {
    expect((await request('POST', { message: marker, conversationId: id.toUpperCase() })).status).toBe(200);
  });

  it.each([undefined, null])('keeps new-conversation compatibility for %j', async (conversationId) => {
    expect((await request('POST', { message: marker, conversationId })).status).toBe(200);
  });

  it.each(['GET', 'DELETE'])('rejects an explicitly empty %s ID', async (method) => {
    expect((await request(method, { conversationId: '' }, '&conversationId=')).status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', 'chat_messages:select'], ['GET', 'chat_conversations:select'], ['POST', 'chat_messages:select'],
    ['DELETE', 'chat_conversations:delete'], ['POST', 'chat_conversations:insert:'],
    ['POST', 'chat_messages:insert:user'], ['POST', 'chat_messages:insert:assistant'],
    ['POST', 'chat_match_events:insert:'], ['POST', 'chat_conversations:update'],
  ])('does not report returned DB text: %s %s', async (method, operation) => {
    failOperation = operation;
    const existing = operation !== 'chat_conversations:insert:';
    const res = await request(method, { message: marker, conversationId: existing ? id : null }, operation === 'chat_messages:select' ? `&conversationId=${id}` : '');
    const fatal = method !== 'POST' || ['chat_conversations:insert:', 'chat_messages:insert:user'].includes(operation);
    expect(res.status).toBe(fatal ? 500 : 200);
    await assertPrivateDiagnostics();
  });

  it.each([
    ['GET', 'chat_messages:select'], ['DELETE', 'chat_conversations:delete'],
    ['POST', 'chat_messages:insert:user'], ['POST', 'chat_messages:insert:assistant'],
    ['POST', 'chat_match_events:insert:'], ['POST', 'chat_conversations:update'],
  ])('does not report rejected DB errors: %s %s', async (method, operation) => {
    failOperation = operation;
    rejectFailure = true;
    const res = await request(method, { message: marker, conversationId: id }, `&conversationId=${id}`);
    expect(res.status).toBe(method !== 'POST' || operation === 'chat_messages:insert:user' ? 500 : 200);
    await assertPrivateDiagnostics();
  });
});

describe('US-15 AC8 — a transcript past the 30-day purge', () => {
  const purged = { id: 'a', role: 'user', content: null, created_at: '2026-01-01T00:00:00Z', is_fallback: false };
  const live = { id: 'b', role: 'user', content: 'live turn', created_at: '2026-09-09T00:00:00Z', is_fallback: false };

  it('GET shows the placeholder where the words used to be', async () => {
    mocks.selectRows['chat_messages:select'] = [purged, live];
    const res = await request('GET', null, `&conversationId=${id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: { id: string; content: string }[] };
    expect(body.messages).toEqual([
      { id: 'a', role: 'user', content: '[removed after 30 days]', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', role: 'user', content: 'live turn', createdAt: '2026-09-09T00:00:00Z' },
    ]);
  });

  it('POST answers from the live turns only, never a blank one', async () => {
    mocks.selectRows['chat_messages:select'] = [purged, live];
    expect((await request('POST', { message: marker, conversationId: id })).status).toBe(200);
    expect(mocks.buildConversationMessages).toHaveBeenCalledWith([live], marker);
  });

  it('POST drops a leading assistant turn whose question was purged', async () => {
    // The purge is per row, so the cutoff can fall between a question and its
    // reply: the history then opens on an orphaned assistant turn.
    const orphanReply = { id: 'c', role: 'assistant', content: 'orphaned reply', created_at: '2026-01-01T00:01:00Z', is_fallback: false };
    mocks.selectRows['chat_messages:select'] = [purged, orphanReply, live];
    expect((await request('POST', { message: marker, conversationId: id })).status).toBe(200);
    expect(mocks.buildConversationMessages).toHaveBeenCalledWith([live], marker);
  });
});
