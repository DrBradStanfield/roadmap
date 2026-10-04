import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';
import { MAX_HISTORY_MESSAGES, MAX_HISTORY_TURN_CHARS } from '../../packages/health-core/src/chat-history';

// US-15 AC7: a widget turn (`localFirst: true`) stores no message content.
// The only row is the router telemetry row, with every number blanked.

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  auth: vi.fn(),
  buildConversationMessages: vi.fn(() => []),
  classify: vi.fn(async (..._args: unknown[]) => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 })),
  completion: {
    content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    isFallback: false as boolean, failureMode: undefined as string | undefined,
    isRefusal: undefined as boolean | undefined, refusalCategory: undefined as string | undefined, stopReason: 'end_turn' as string | undefined,
  },
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
// MAX_MESSAGE_LENGTH is the real one, so the length tests below pin the route
// to the shipped cap (US-15 AC26).
vi.mock('../lib/chat.server', async (original) => ({
  resolveChatContext: () => ({ healthDocuments: [], userContextJson: '{}' }),
  buildSystemBlocks: () => [], buildConversationMessages: mocks.buildConversationMessages,
  matchDocumentTitle: () => null, loadMatchedArticlesFromHandles: () => null,
  DOCTOR_POSTURE: '', BRAND_POSTURE: '',
  getChatCompletion: async () => mocks.completion,
  reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic title', CHAT_MODEL: 'test',
  MAX_MESSAGE_LENGTH: (await original<typeof import('../lib/chat.server')>()).MAX_MESSAGE_LENGTH,
}));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: vi.fn(), reportRouterFailure: vi.fn(),
}));
vi.mock('../lib/chat-classifier.server', () => ({ classifyMessage: mocks.classify, shouldFireRouter: () => false }));

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
  mocks.completion.isRefusal = undefined;
  mocks.completion.refusalCategory = undefined;
  mocks.completion.stopReason = 'end_turn';
  mocks.completion.content = 'Synthetic answer';
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
    expect(row.router_context).toEqual({ platform: 'widget' });
    expect(JSON.stringify(row)).not.toContain('HbA1c 41 last year');
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

  // US-15 AC14: a refusal is shown as an assistant turn, flagged so the widget
  // never re-serves it from its own dedup; telemetry carries only bounded fields.
  it('returns a refusal as the reply with isRefusal and isFallback, and logs only its stop reason and category', async () => {
    const line = "I can't help with that here. Please raise it with your doctor or pharmacist.";
    Object.assign(mocks.completion, { content: line, isRefusal: true, refusalCategory: 'bio', stopReason: 'refusal', failureMode: 'refusal' });
    const res = await post({ message: 'hello', localFirst: true });
    const body = await res.json();
    expect(body.content).toBe(line);
    expect(body.isRefusal).toBe(true);
    expect(body.isFallback).toBe(true); // the wire flag the client dedup reads
    expect(matchEvent().failure_mode).toBe('refusal');
    expect(matchEvent().is_fallback).toBe(false);
    const timing = consoleLog.mock.calls.map((c) => JSON.parse(String(c[0]))).find((l) => l.evt === 'chat_timing');
    expect(timing.stopReason).toBe('refusal');
    expect(timing.refusalCategory).toBe('bio');
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(line);
  });

  it('an ordinary answer carries no isRefusal and logs its stop reason', async () => {
    const res = await post({ message: 'hello', localFirst: true });
    expect(await res.json()).not.toHaveProperty('isRefusal');
    const timing = consoleLog.mock.calls.map((c) => JSON.parse(String(c[0]))).find((l) => l.evt === 'chat_timing');
    expect(timing.stopReason).toBe('end_turn');
    expect(timing.refusalCategory).toBeNull();
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

// US-15 AC26 (2026-10-04): a pasted lab panel or prompt template reaches the
// model whole up to 8,000 characters; past that the route refuses it.
describe('US-15 AC26 — the route takes a message up to 8,000 characters', () => {
  for (const n of [7999, 8000]) {
    it(`US-15 AC26: accepts ${n} characters and hands the model all of them`, async () => {
      const message = 'x'.repeat(n);
      const res = await post({ message, localFirst: true });
      expect(res.status).toBe(200);
      expect(mocks.buildConversationMessages).toHaveBeenCalledWith([], message);
    });
  }

  it('US-15 AC26: refuses 8,001 characters with a 400 and calls no model', async () => {
    const res = await post({ message: 'x'.repeat(8001), localFirst: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Message too long (max 8000 chars)');
    expect(mocks.buildConversationMessages).not.toHaveBeenCalled();
  });
});

// US-15 AC26 with AC7: the router still reads 2,000 characters, but the
// telemetry row keeps at most 500 of any question, as it did before the cap rose.
describe('US-15 AC26 — the match-event row does not grow with the message cap', () => {
  const long = (c: string) => c.repeat(3000);

  it('US-15 AC26: a 3,000-char widget message is routed with 2,000 chars and stored with 500', async () => {
    mocks.classify.mockClear();
    await post({ message: long('x'), localFirst: true });
    expect(mocks.classify.mock.calls[0][0]).toBe('x'.repeat(2000));
    expect(matchEvent().message).toBe('x'.repeat(500));
  });

  it('US-15 AC26: a stored-surface row caps the question and its router context at 500', async () => {
    const realFrom = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => {
      const query = realFrom(table);
      if (table === 'chat_messages') query.then = (resolve: any, reject: any) =>
        Promise.resolve({ data: [{ role: 'user', content: long('y'), created_at: new Date().toISOString() }], error: null }).then(resolve, reject);
      return query;
    });
    await post({ message: long('x'), conversationId: id });
    const row = matchEvent();
    expect(row.message).toBe('x'.repeat(500));
    expect(row.router_context.first).toBe('y'.repeat(500));
    expect(row.router_context.recent).toEqual(['y'.repeat(500)]);
  });
});
