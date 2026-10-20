import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';
import { MAX_HISTORY_MESSAGES, MAX_HISTORY_TURN_CHARS } from '../../packages/health-core/src/chat-history';

// US-15 AC7: a widget turn (`localFirst: true`) stores no message content.
// The only row is the router telemetry row, with every number blanked.

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  auth: vi.fn(),
  audit: vi.fn(),
  guestSession: vi.fn(),
  GuestRateLimitError: class extends Error {},
  buildConversationMessages: vi.fn(() => []),
  classify: vi.fn(async (..._args: unknown[]) => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 })),
  complete: vi.fn(),
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
  logAudit: mocks.audit, getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
  createUserClient: vi.fn(() => ({ from: mocks.from })),
  getOrCreateGuestSession: mocks.guestSession,
  GuestRateLimitError: mocks.GuestRateLimitError,
}));
// MAX_MESSAGE_LENGTH is the real one, so the length tests below pin the route
// to the shipped cap (US-15 AC26).
vi.mock('../lib/chat.server', async (original) => ({
  resolveChatContext: () => ({ healthDocuments: [], userContextJson: '{}' }),
  buildSystemBlocks: () => [], buildConversationMessages: mocks.buildConversationMessages,
  matchDocumentTitle: () => null, loadMatchedArticlesFromHandles: () => null,
  DOCTOR_POSTURE: '', BRAND_POSTURE: '',
  getChatCompletion: async () => { mocks.complete(); return mocks.completion; },
  reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic title', CHAT_MODEL: 'test',
  MAX_MESSAGE_LENGTH: (await original<typeof import('../lib/chat.server')>()).MAX_MESSAGE_LENGTH,
}));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: vi.fn(), reportRouterFailure: vi.fn(),
}));
vi.mock('../lib/chat-classifier.server', () => ({ classifyMessage: mocks.classify, shouldFireRouter: () => false }));

import { action, loader } from './api.chat';

// US-15 AC6/AC7: blog bubble and embed omit localFirst and store transcripts.
const owner = '12345678-1234-4234-8234-123456789abc';
const guest = '87654321-4321-4321-8321-cba987654321';
const foreign = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const missing = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let principal: string;
let parents: Array<Record<string, unknown>>;
let messages: Array<Record<string, unknown>>;
let reads: string[];
let writes: string[];
let dbError: boolean;
let queries: Array<{ table: string; operation: string; filters: Array<[string, unknown]> }>;
beforeEach(() => {
  principal = owner; dbError = false; reads = []; writes = []; messages = []; queries = [];
  parents = [{ id: owner, user_id: owner }, { id: guest, user_id: guest }, { id: foreign, user_id: foreign }];
  mocks.classify.mockClear(); mocks.complete.mockClear();
  mocks.audit.mockClear();
  mocks.guestSession.mockReset().mockImplementation(async () => ({ sessionId: guest, sessionToken: 'tok' }));
  mocks.auth.mockImplementation(async () => principal === guest ? null : ({ client: { from: mocks.from }, userId: principal, customerId: '123', admin: null }));
  mocks.from.mockImplementation((table: string) => {
    const filters: Array<[string, unknown]> = [];
    let operation = 'select'; let payload: Record<string, unknown>; let oneRow = false;
    const q: any = {};
    for (const method of ['select', 'order', 'limit']) q[method] = () => q;
    for (const method of ['single', 'maybeSingle']) q[method] = () => { oneRow = true; return q; };
    q.eq = (key: string, value: unknown) => { filters.push([key, value]); return q; };
    q.insert = (row: Record<string, unknown>) => { operation = 'insert'; payload = row; return q; };
    q.update = () => { operation = 'update'; return q; };
    q.delete = () => { operation = 'delete'; return q; };
    q.then = (resolve: any, reject: any) => Promise.resolve().then(() => {
      queries.push({ table, operation, filters: [...filters] });
      if (operation !== 'select') {
        writes.push(table);
        if (table === 'chat_conversations' && operation === 'delete') {
          const removed = parents.filter(row => row.user_id === principal && filters.every(([k,v]) => row[k] === v));
          parents = parents.filter(row => !removed.includes(row));
          messages = messages.filter(row => !removed.some(parent => parent.id === row.conversation_id));
          return { data: null, error: null };
        }
        if (table === 'chat_conversations' && operation === 'insert') { const row = { ...payload, id: missing }; parents.push(row); return { data: row, error: null }; }
        if (table === 'chat_messages') {
          // Existing FK + child-only RLS, intentionally NOT the proposed parent guard.
          if (payload.user_id !== principal || !parents.some(p => p.id === payload.conversation_id)) return { error: { code: '23503' }, data: null };
          messages.push(payload); return { data: { id: missing }, error: null };
        }
        return { data: null, error: null };
      }
      reads.push(table);
      if (dbError && table === 'chat_conversations') return { data: null, error: { code: '08006' } };
      const rows = (table === 'chat_conversations' ? parents : messages).filter(row => row.user_id === principal && filters.every(([k,v]) => row[k] === v));
      return { data: oneRow ? rows[0] ?? null : rows, error: null };
    }).then(resolve, reject);
    return q;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
async function post(conversationId?: string, extra: Record<string, unknown> = {}) {
  return action({ request: new Request('https://example.invalid/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello', conversationId, ...extra }) }), params: {} } as Parameters<typeof action>[0]);
}
async function get(conversationId?: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ sessionToken: 'tok', ...extra });
  if (conversationId) params.set('conversationId', conversationId);
  return loader({ request: new Request(`https://example.invalid/api/chat?${params}`), params: {} } as Parameters<typeof loader>[0]);
}
// A guest's 404 carries its own session token, so the client keeps one session
// when it resends (US-15 AC6a); a customer's carries nothing extra.
const notFound = (userId: string) => ({ success: false, error: 'Conversation not found', ...(userId === guest ? { sessionToken: 'tok', isGuest: true } : {}) });
function expectScopedParent(id: string) {
  expect(queries[0]).toEqual({ table: 'chat_conversations', operation: 'select', filters: [['id', id], ['user_id', principal]] });
}
async function remove(conversationId: string, extra: Record<string, unknown> = {}) {
  return action({ request: new Request('https://example.invalid/api/chat', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId, ...extra }) }), params: {} } as Parameters<typeof action>[0]);
}
describe('stored parent ownership', () => {
  it.each([[owner, foreign], [owner, missing], [guest, foreign], [guest, missing]])('rejects inaccessible parent before history or model work: %s -> %s', async (userId, id) => {
    principal = userId;
    const res = await post(id, { stream: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(notFound(userId));
    expect(reads).toEqual(['chat_conversations']); expect(writes).toEqual([]);
    expectScopedParent(id);
    expect(mocks.classify).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('distinguishes a database failure from an inaccessible parent', async () => {
    dbError = true; const res = await post(owner);
    expect(res.status).toBe(500); expect(reads).toEqual(['chat_conversations']);
    expect(mocks.classify).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it.each([owner, guest])('continues a parent owned by the authenticated principal: %s', async id => {
    principal = id; const res = await post(id);
    expect(res.status).toBe(200); expect((await res.json()).conversationId).toBe(id);
    expect(reads.slice(0,2)).toEqual(['chat_conversations', 'chat_messages']);
    expectScopedParent(id);
    expect(messages).toHaveLength(2); expect(messages.every(m => m.user_id === id && m.conversation_id === id)).toBe(true);
  });
  it('creates an owned parent only when no id was supplied', async () => {
    const res = await post(); expect(res.status).toBe(200);
    expect(parents.find(p => p.id === missing)?.user_id).toBe(owner);
    expect(messages.every(m => m.conversation_id === missing && m.user_id === owner)).toBe(true);
  });
  it('keeps widget grouping ids without a stored parent lookup', async () => {
    const res = await post(missing, { localFirst: true });
    expect(res.status).toBe(200); expect((await res.json()).conversationId).toBe(missing);
    expect(reads).toEqual([]); expect(writes).toEqual(['chat_match_events']);
  });
  // US-15 AC6: historic child-only RLS allowed caller-owned rows under a foreign parent.
  it.each([owner, guest])('refuses historic caller-owned children under a foreign parent on GET: %s', async userId => {
    principal = userId;
    messages.push({ id: missing, conversation_id: foreign, user_id: userId, role: 'user', content: 'Synthetic historic child', created_at: '2026-01-01' });
    const res = await get(foreign, userId === guest ? { localFirst: '1' } : {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(notFound(userId));
    expect(reads).toEqual(['chat_conversations']); expect(writes).toEqual([]);
    expectScopedParent(foreign);
  });
  it.each([owner, guest])('returns the same 404 for a missing GET parent: %s', async userId => {
    principal = userId; const res = await get(missing);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(notFound(userId));
    expect(reads).toEqual(['chat_conversations']); expectScopedParent(missing);
  });
  it.each([owner, guest])('loads an owned transcript after the scoped parent check: %s', async userId => {
    principal = userId;
    messages.push({ id: missing, conversation_id: userId, user_id: userId, role: 'user', content: 'Synthetic owned child', created_at: '2026-01-01' });
    const res = await get(userId);
    expect(res.status).toBe(200);
    expect((await res.json()).messages).toEqual([{ id: missing, role: 'user', content: 'Synthetic owned child', createdAt: '2026-01-01' }]);
    expect(reads).toEqual(['chat_conversations', 'chat_messages']); expectScopedParent(userId);
  });
  it.each([owner, guest])('fails closed on GET parent lookup failure: %s', async userId => {
    principal = userId; dbError = true; const res = await get(userId);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'Failed to check conversation' });
    expect(reads).toEqual(['chat_conversations']); expect(writes).toEqual([]);
  });
  it.each([[owner, foreign], [owner, missing], [guest, foreign], [guest, missing]])('refuses inaccessible DELETE parent without mutation or audit: %s -> %s', async (userId, id) => {
    principal = userId;
    const before = [...parents];
    const res = await remove(id, userId === guest ? { localFirst: true } : {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(notFound(userId));
    expect(reads).toEqual(['chat_conversations']); expect(writes).toEqual([]);
    expect(parents).toEqual(before); expect(mocks.audit).not.toHaveBeenCalled();
    expectScopedParent(id);
  });
  it.each([owner, guest])('deletes an owned parent and its children: %s', async userId => {
    principal = userId;
    messages.push({ conversation_id: userId, user_id: userId });
    const res = await remove(userId);
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ success: true });
    expectScopedParent(userId);
    expect(queries[1]).toEqual({ table: 'chat_conversations', operation: 'delete', filters: [['id', userId], ['user_id', userId]] });
    expect(parents.map(p => p.id)).not.toContain(userId); expect(messages).toEqual([]);
    expect(parents.some(p => p.id === foreign)).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith(userId, 'CHAT_CONVERSATION_DELETED', 'chat', userId);
  });
  it.each([owner, guest])('fails closed on DELETE parent lookup failure: %s', async userId => {
    principal = userId; dbError = true; const res = await remove(userId);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'Failed to check conversation' });
    expect(reads).toEqual(['chat_conversations']); expect(writes).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each([owner, guest])('keeps list GET without an id unchanged: %s', async userId => {
    principal = userId; const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).conversations.map((c: { id: string }) => c.id)).toEqual([userId]);
    expect(queries).toEqual([{ table: 'chat_conversations', operation: 'select', filters: [] }]);
  });
  // US-15 AC6a: with no token and no customer nothing can own the id, so the
  // route answers 404 without minting a guest session to find that out.
  it('answers a sessionless guest transcript GET with 404 and creates no guest session', async () => {
    principal = guest;
    const res = await loader({ request: new Request(`https://example.invalid/api/chat?conversationId=${foreign}`), params: {} } as Parameters<typeof loader>[0]);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'Conversation not found' });
    expect(mocks.guestSession).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });
  // US-15 AC6a: a guest is its token plus its IP. Mirrors getOrCreateGuestSession:
  // a token counts only from its own IP; otherwise a new guest is minted, at
  // most GUEST_IP_RATE_MAX (10) per IP per hour.
  describe('a guest whose IP changed', () => {
    const oldIp = '198.51.100.1'; const newIp = '203.0.113.9';
    const newGuest = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    function guestSessions(alreadyMinted: number) {
      const sessions = new Map([['old-tok', { id: guest, ip: oldIp }]]);
      const minted = { [newIp]: alreadyMinted } as Record<string, number>;
      mocks.auth.mockImplementation(async () => null);
      mocks.guestSession.mockImplementation(async (ip: string, token?: string) => {
        const known = token ? sessions.get(token) : undefined;
        if (known && known.ip === ip) { principal = known.id; return { sessionId: known.id, sessionToken: token }; }
        if ((minted[ip] ?? 0) >= 10) throw new mocks.GuestRateLimitError('Too many requests');
        minted[ip] = (minted[ip] ?? 0) + 1;
        const sessionToken = `tok-${minted[ip]}`;
        sessions.set(sessionToken, { id: newGuest, ip });
        principal = newGuest;
        return { sessionId: newGuest, sessionToken };
      });
      return minted;
    }
    const send = (body: Record<string, unknown>) => action({ request: new Request('https://example.invalid/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': newIp }, body: JSON.stringify({ message: 'hello', ...body }),
    }), params: {} } as Parameters<typeof action>[0]);

    it.each([0, 9])('the 404 hands back the new session, so the resend mints nothing more (%s minted before)', async (before) => {
      principal = guest;
      const minted = guestSessions(before);
      const first = await send({ conversationId: guest, sessionToken: 'old-tok' });
      expect(first.status).toBe(404);
      const refused = await first.json();
      expect(refused).toEqual({ success: false, error: 'Conversation not found', sessionToken: `tok-${before + 1}`, isGuest: true });
      expect(writes).toEqual([]); expect(mocks.complete).not.toHaveBeenCalled();

      const resent = await send({ sessionToken: refused.sessionToken });
      expect(resent.status).toBe(200);
      expect(await resent.json()).toMatchObject({ conversationId: missing, sessionToken: refused.sessionToken });
      expect(minted[newIp]).toBe(before + 1);
      expect(mocks.guestSession.mock.calls.map(([, token]) => token)).toEqual(['old-tok', refused.sessionToken]);
      expect(mocks.complete).toHaveBeenCalledTimes(1);
      expect(messages.every(m => m.user_id === newGuest && m.conversation_id === missing)).toBe(true);
    });

    it('at the hourly cap, a resend that dropped the handed-back token would be refused', async () => {
      principal = guest;
      guestSessions(9);
      expect((await send({ conversationId: guest, sessionToken: 'old-tok' })).status).toBe(404);
      expect((await send({})).status).toBe(429);
    });
  });
  it('keeps the sessionless list GET empty without database access', async () => {
    const res = await loader({ request: new Request('https://example.invalid/api/chat'), params: {} } as Parameters<typeof loader>[0]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, conversations: [], isGuest: true });
    expect(queries).toEqual([]);
  });
});
