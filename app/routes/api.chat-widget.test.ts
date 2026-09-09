import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';
import { MAX_HISTORY_MESSAGES, MAX_HISTORY_TURN_CHARS } from '../../packages/health-core/src/chat-history';

// US-15 AC7: a widget turn (`localFirst: true`) stores no message content.
// The only row is the router telemetry row, with every number blanked.

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  auth: vi.fn(),
  buildConversationMessages: vi.fn(() => []),
  completion: { content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, isFallback: false as boolean, failureMode: undefined as string | undefined },
}));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: mocks.auth,
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
// localFirst forces the guest path (api.chat.ts getAuthOrGuest), so the
// widget's rows are always guest-owned; give it a session to land on.
vi.mock('../lib/supabase.server', () => ({
  logAudit: vi.fn(), getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
  createUserClient: vi.fn(() => ({ from: mocks.from })),
  getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
  GuestRateLimitError: class extends Error {},
}));
vi.mock('../lib/chat.server', () => ({
  resolveChatContext: () => ({ healthDocuments: [], userContextJson: '{}' }),
  buildSystemBlocks: () => [], buildConversationMessages: mocks.buildConversationMessages,
  matchDocumentTitle: () => null, loadMatchedArticlesFromHandles: () => [],
  DOCTOR_POSTURE: '', BRAND_POSTURE: '',
  getChatCompletion: async () => mocks.completion,
  reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic title', CHAT_MODEL: 'test', MAX_MESSAGE_LENGTH: 500,
}));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: vi.fn(), reportRouterFailure: vi.fn(),
}));
vi.mock('../lib/chat-classifier.server', () => ({ classifyMessage: async () => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 }), shouldFireRouter: () => false }));

import { action } from './api.chat';

const id = '12345678-1234-4234-8234-123456789abc';
const question = 'my LDL is 4.2 and BP 140/90, I take metformin 500mg and B12';
let inserts: Array<{ table: string; row: Record<string, unknown> }>;
let envelopes: unknown[];
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  inserts = [];
  envelopes = [];
  mocks.completion.isFallback = false;
  mocks.completion.failureMode = undefined;
  mocks.buildConversationMessages.mockClear();
  mocks.auth.mockResolvedValue({ client: { from: mocks.from }, userId: id, customerId: null, admin: null });
  mocks.from.mockReset().mockImplementation((table: string) => {
    const query: any = {};
    for (const method of ['select', 'eq', 'order', 'limit', 'single', 'update', 'delete']) query[method] = () => query;
    query.insert = (row: Record<string, unknown>) => { inserts.push({ table, row }); return query; };
    query.then = (resolve: any, reject: any) =>
      Promise.resolve({ data: table === 'chat_conversations' ? { id } : [], error: null }).then(resolve, reject);
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

async function post(body: Record<string, unknown>) {
  const request = new Request('https://drstanfield.com/api/chat?logged_in_customer_id=123', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const res = await action({ request, params: {} } as Parameters<typeof action>[0]);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

const tables = () => inserts.map((i) => i.table);
const matchEvent = () => inserts.find((i) => i.table === 'chat_match_events')!.row as any;

describe('US-15 AC7 — widget turns store no message content', () => {
  it('writes only a chat_match_events row, the question verbatim', async () => {
    const res = await post({ message: question, localFirst: true, history: [{ role: 'user', content: 'HbA1c 41 last year' }, { role: 'assistant', content: 'noted' }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe('Synthetic answer');
    expect(body.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tables()).toEqual(['chat_match_events']);
    expect(mocks.from).not.toHaveBeenCalledWith('chat_messages');
    expect(mocks.from).not.toHaveBeenCalledWith('chat_conversations');
    const row = matchEvent();
    expect(row.message).toBe(question);
    expect(row.message_id).toBeNull();
    expect(row.conversation_id).toBe(body.conversationId);
    expect(row.router_context).toEqual({ platform: 'widget', first: 'HbA1c 41 last year', recent: ['HbA1c 41 last year'] });
    expect(row.is_fallback).toBe(false);
    expect(row.failure_mode).toBeNull();
    expect(body.isFallback).toBe(false);
  });

  it('echoes an existing conversationId back and never reads the database', async () => {
    const res = await post({ message: 'hello', localFirst: true, conversationId: id });
    expect((await res.json()).conversationId).toBe(id);
    expect(mocks.from.mock.calls.map((c) => c[0])).toEqual(['chat_match_events']);
  });

  it('records the fallback flag and category on the telemetry row', async () => {
    mocks.completion.isFallback = true;
    mocks.completion.failureMode = 'api-error';
    const res = await post({ message: 'hello', localFirst: true });
    expect((await res.json()).isFallback).toBe(true);
    expect(matchEvent().is_fallback).toBe(true);
    expect(matchEvent().failure_mode).toBe('api-error');
  });

  it('builds the prompt from the client history, cleaned', async () => {
    const history = [
      { role: 'assistant', content: 'leading assistant turn is dropped' },
      { role: 'system', content: 'not a role we accept' },
      { role: 'user', content: '' },
      { role: 'user', content: 'first real turn' },
      { role: 'assistant', content: 42 },
      { role: 'assistant', content: 'reply' },
    ];
    await post({ message: 'next', localFirst: true, history });
    expect(mocks.buildConversationMessages).toHaveBeenCalledWith(
      [{ role: 'user', content: 'first real turn' }, { role: 'assistant', content: 'reply' }],
      'next',
    );
  });

  it('cuts a forged turn at MAX_HISTORY_TURN_CHARS but lets a real reply through uncut', async () => {
    const reply = 'point 3: '.padEnd(800, 'x');
    await post({ message: 'expand point 3', localFirst: true, history: [{ role: 'user', content: 'x'.repeat(200_000) }, { role: 'assistant', content: reply }] });
    const kept = mocks.buildConversationMessages.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(kept[0].content).toHaveLength(MAX_HISTORY_TURN_CHARS);
    expect(kept[1].content).toBe(reply);
    expect(reply.length).toBeGreaterThan(500);
  });

  it('caps the client history at the BYOK bound and treats junk as empty', async () => {
    const long = Array.from({ length: MAX_HISTORY_MESSAGES + 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
    await post({ message: 'next', localFirst: true, history: long });
    const kept = mocks.buildConversationMessages.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(kept).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(kept[0]).toEqual({ role: 'user', content: 'turn 6' });
    for (const junk of ['not an array', 7, { role: 'user', content: 'x' }, null]) {
      mocks.buildConversationMessages.mockClear();
      await post({ message: 'next', localFirst: true, history: junk });
      expect(mocks.buildConversationMessages).toHaveBeenCalledWith([], 'next');
    }
  });

  it('never lets the question reach Sentry or the console', async () => {
    await post({ message: question, localFirst: true });
    await Sentry.flush();
    expect(JSON.stringify(envelopes)).not.toContain('LDL');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('LDL');
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('LDL');
  });

  it('keeps storing messages on the other surfaces (no flag)', async () => {
    await post({ message: question, history: [{ role: 'user', content: 'ignored on stored surfaces' }] });
    expect(tables()).toEqual(['chat_conversations', 'chat_messages', 'chat_messages', 'chat_match_events']);
    const row = matchEvent();
    expect(row.message).toBe(question);
    expect(row.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.router_context).toEqual({ platform: 'shopify', first: null, recent: [] });
    expect(mocks.buildConversationMessages).toHaveBeenCalledWith([], question);
  });
});
