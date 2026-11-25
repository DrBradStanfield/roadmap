// US-15 AC70 (lead S-2): every write a web chat turn makes, on success and on
// each failed write, pinned row for row, beside the bots' pins in
// app/lib/chat-persist-pins.test.ts. The web writes the conversation and the
// question before the model call and fails the turn when either fails; it writes
// the answer, the event and the timestamp after, fire-and-forget.
// US-15 AC73 (lead S-1): its event row is the one matchEventRow builds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Write =
  | { op: 'insert'; table: string; row: Record<string, unknown> }
  | { op: 'update'; table: string; patch: Record<string, unknown>; eq: [string, unknown] };

const mocks = vi.hoisted(() => ({
  from: vi.fn(), auth: vi.fn(), getChatCompletion: vi.fn(),
  writes: [] as Write[], fail: new Set<string>(),
}));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: mocks.auth,
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
const supa = vi.hoisted(() => ({
  logAudit: vi.fn(), getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
  createUserClient: vi.fn(() => ({ from: mocks.from })),
  getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
  GuestRateLimitError: class extends Error {},
}));
vi.mock('../lib/supabase-identity.server', async (o) => ({ ...await o<object>(), logAudit: supa.logAudit }));
vi.mock('../lib/supabase-guest.server', async (o) => ({ ...await o<object>(), getOrCreateGuestSession: supa.getOrCreateGuestSession, GuestRateLimitError: supa.GuestRateLimitError }));
vi.mock('../lib/supabase-account.server', async (o) => ({ ...await o<object>(), getProfile: supa.getProfile, updateSubscriptionPlan: supa.updateSubscriptionPlan }));
vi.mock('../lib/supabase-client.server', async (o) => ({ ...await o<object>(), createUserClient: supa.createUserClient }));
vi.mock('../lib/chat.server', async (original) => (await import('../lib/chat-server.test-helpers')).chatServerStub(
  await original<typeof import('../lib/chat.server')>(), { getChatCompletion: mocks.getChatCompletion }));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(), routeQuery: vi.fn(), reportRouterFailure: vi.fn(),
}));
// The real builder, watched, so a web turn that builds its own event row fails AC73's tests.
vi.mock('../lib/chat-persist.server', async (original) => {
  const real = await original<typeof import('../lib/chat-persist.server')>();
  return { ...real, matchEventRow: vi.fn(real.matchEventRow) };
});
vi.mock('../lib/chat-classifier.server', () => ({
  classifyMessage: async () => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 }), shouldFireRouter: () => false,
}));

import { action } from './api.chat';
import { matchEventRow } from '../lib/chat-persist.server';
import { redactForWidget } from '../lib/chat-router.server';

const id = '12345678-1234-4234-8234-123456789abc';
const guest = '87654321-4321-4321-8321-cba987654321';

beforeEach(() => {
  mocks.writes = [];
  mocks.fail = new Set();
  mocks.getChatCompletion.mockReset().mockResolvedValue({
    content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    isFallback: false, stopReason: 'end_turn',
  });
  mocks.auth.mockResolvedValue({ client: { from: mocks.from }, userId: id, customerId: null, admin: null });
  mocks.from.mockReset().mockImplementation((table: string) => {
    let res: { data: unknown; error: unknown } = { data: table === 'chat_conversations' ? { id } : [], error: null };
    const query: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'limit', 'single', 'delete']) query[m] = () => query;
    query.insert = (row: Record<string, unknown>) => {
      mocks.writes.push({ op: 'insert', table, row });
      if (mocks.fail.has(table) || mocks.fail.has(`${table}:${String(row.role ?? '')}`)) res = { data: null, error: { message: 'boom' } };
      return query;
    };
    let patch: Record<string, unknown> | null = null;
    query.update = (p: Record<string, unknown>) => { patch = p; return query; };
    query.eq = (col: string, val: unknown) => {
      if (patch) mocks.writes.push({ op: 'update', table, patch, eq: [col, val] });
      return query;
    };
    query.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(res).then(ok, bad);
    return query;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

async function post(body: Record<string, unknown>) {
  const request = new Request('https://drstanfield.com/api/chat?logged_in_customer_id=123', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const res = await action({ request, params: {} } as Parameters<typeof action>[0]);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

const NOT_RUN = {
  matched_handles: [], router_version: null, router_latency_ms: null, router_cache_hit: null, router_input_tokens: null,
  router_cache_read_tokens: null, router_output_tokens: null, router_raw: null, router_error: null,
};
const conv = { op: 'insert', table: 'chat_conversations', row: { user_id: id, title: 'Synthetic title' } };
const user = { op: 'insert', table: 'chat_messages', row: { conversation_id: id, user_id: id, role: 'user', content: 'hello' } };
const asstId = () => (mocks.writes.find((w) => w.op === 'insert' && w.row.role === 'assistant') as { row: { id: unknown } }).row.id;
const asst = () => ({ op: 'insert', table: 'chat_messages', row: { id: asstId(), conversation_id: id, user_id: id, role: 'assistant',
  content: 'Synthetic answer', input_tokens: 1, output_tokens: 1, model: 'test', is_fallback: false, failure_mode: null, error_detail: null } });
const event = () => ({ op: 'insert', table: 'chat_match_events', row: { message_id: asstId(), conversation_id: id, user_id: id, message: 'hello',
  router_context: { platform: 'shopify', first: null, recent: [] }, ...NOT_RUN, classification: 'SKIP', router_skipped: true, is_fallback: false, failure_mode: null } });
const touch = { op: 'update', table: 'chat_conversations', patch: { updated_at: expect.any(String) }, eq: ['id', id] };

// The answer, the timestamp and the event are fire-and-forget, so their order
// among themselves is not pinned; the event after the answer row it names is.
const sorted = (ws: unknown[]) => [...ws].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('US-15 AC70: every write a web chat turn makes', () => {
  it('a stored-surface turn: conversation, question, answer, event and timestamp', async () => {
    expect((await post({ message: 'hello' })).status).toBe(200);
    expect(mocks.writes.slice(0, 2)).toEqual([conv, user]);
    expect(sorted(mocks.writes)).toEqual(sorted([conv, user, asst(), event(), touch]));
    const tables = mocks.writes.map((w) => (w.op === 'insert' ? `${w.table}:${String(w.row.role ?? '')}` : w.table));
    expect(tables.indexOf('chat_match_events:')).toBeGreaterThan(tables.indexOf('chat_messages:assistant'));
  });

  it('a widget turn: one redacted event, nothing else (AC7)', async () => {
    expect((await post({ message: 'hello', localFirst: true })).status).toBe(200);
    expect(mocks.writes).toEqual([{ op: 'insert', table: 'chat_match_events', row: {
      message_id: null, conversation_id: expect.any(String), user_id: guest, message: 'hello',
      router_context: { platform: 'widget' }, ...NOT_RUN, classification: 'SKIP', router_skipped: true, is_fallback: false, failure_mode: null,
    } }]);
  });

  it('the conversation insert fails: 500, no model call, nothing more', async () => {
    mocks.fail = new Set(['chat_conversations']);
    expect((await post({ message: 'hello' })).status).toBe(500);
    expect(mocks.getChatCompletion).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([conv]);
  });

  it('the question insert fails: 500, no model call, nothing more', async () => {
    mocks.fail = new Set(['chat_messages:user']);
    expect((await post({ message: 'hello' })).status).toBe(500);
    expect(mocks.getChatCompletion).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([conv, user]);
  });

  it('the answer insert fails: no event; the timestamp still moves', async () => {
    mocks.fail = new Set(['chat_messages:assistant']);
    expect((await post({ message: 'hello' })).status).toBe(200);
    expect(sorted(mocks.writes)).toEqual(sorted([conv, user, asst(), touch]));
  });

  it('the event insert fails: the turn still answers', async () => {
    mocks.fail = new Set(['chat_match_events']);
    expect((await post({ message: 'hello' })).status).toBe(200);
    expect(sorted(mocks.writes)).toEqual(sorted([conv, user, asst(), event(), touch]));
  });

  it('AC73: the stored event row is the one matchEventRow built; the widget redacts that same row', async () => {
    await post({ message: 'hello' });
    expect(matchEventRow).toHaveBeenCalledTimes(1);
    const written = mocks.writes.find((w) => w.op === 'insert' && w.table === 'chat_match_events') as { row: unknown };
    expect(written.row).toBe(vi.mocked(matchEventRow).mock.results[0].value);
    vi.mocked(matchEventRow).mockClear();
    mocks.writes = [];
    await post({ message: 'hello', localFirst: true });
    expect(matchEventRow).toHaveBeenCalledTimes(1);
    const built = vi.mocked(matchEventRow).mock.results[0].value;
    expect(mocks.writes).toEqual([{ op: 'insert', table: 'chat_match_events', row: redactForWidget(built) }]);
  });
});
