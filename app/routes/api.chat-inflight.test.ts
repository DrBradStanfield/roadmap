import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimsState } from '../lib/single-use-claims.test-helpers';

// US-15 AC63: one answer per identical message while a turn runs. The bubble
// and the embed (retention 'transcript') claim each turn in single_use_claims;
// an identical POST while the first still runs answers 409 with the busy words
// before any stream opens. The model is a deferred fake: no paid call.

const claims = vi.hoisted(() => ({ state: null as null | ClaimsState }));
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  auth: vi.fn(),
  getChatCompletion: vi.fn(),
}));
vi.mock('../lib/supabase-client.server', async (actual) => {
  const helpers = await import('../lib/single-use-claims.test-helpers');
  claims.state ??= helpers.newClaimsState();
  return { ...(await actual<object>()), supabaseAdmin: helpers.claimsAdmin(claims.state), createUserClient: supa.createUserClient };
});
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: mocks.auth,
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
// api.chat.ts imports these from their defining modules (S-14).
const supa = vi.hoisted(() => ({
  logAudit: vi.fn(), getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
  createUserClient: vi.fn(() => ({ from: mocks.from })),
  getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
  GuestRateLimitError: class extends Error {},
}));
vi.mock('../lib/supabase-identity.server', async (o) => ({ ...await o<object>(), logAudit: supa.logAudit }));
vi.mock('../lib/supabase-guest.server', async (o) => ({ ...await o<object>(), getOrCreateGuestSession: supa.getOrCreateGuestSession, GuestRateLimitError: supa.GuestRateLimitError }));
vi.mock('../lib/supabase-account.server', async (o) => ({ ...await o<object>(), getProfile: supa.getProfile, updateSubscriptionPlan: supa.updateSubscriptionPlan }));
vi.mock('../lib/chat.server', async (original) => (await import('../lib/chat-server.test-helpers')).chatServerStub(await original<typeof import('../lib/chat.server')>(), {
  buildConversationMessages: (_history: unknown, message: string) => [{ role: 'user', content: message }],
  getChatCompletion: mocks.getChatCompletion,
}));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: vi.fn(),
  reportRouterFailure: vi.fn(),
}));
vi.mock('../lib/chat-classifier.server', async (original) => ({
  ...await original<typeof import('../lib/chat-classifier.server')>(),
  classifyMessage: async () => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 }),
  shouldFireRouter: () => false,
}));

import { action } from './api.chat';
import { newClaimsState, resetClaimsState } from '../lib/single-use-claims.test-helpers';

const BUSY = 'Still answering this question. Try sending it again in a moment.';
const conv = '12345678-1234-4234-8234-123456789abc';
const userId = '11111111-1111-4111-8111-111111111111';
const QUESTION = 'Synthetic question about sleep';
type Row = { table: string; row: Record<string, unknown> };
let inserts: Row[];
let messages: Array<Record<string, unknown>>;
let failUserInsert: boolean;

const completion = { content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, isFallback: false, stopReason: 'end_turn' };

/** The model call waits until the test lets it answer. */
function holdModel() {
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => { answer = resolve; });
  mocks.getChatCompletion.mockImplementation(async () => { await gate; return completion; });
  return answer;
}

beforeEach(() => {
  resetClaimsState(claims.state ??= newClaimsState());
  vi.stubEnv('SHOPIFY_API_SECRET', 'test-secret-good');
  inserts = [];
  messages = [];
  failUserInsert = false;
  mocks.getChatCompletion.mockReset().mockResolvedValue(completion);
  mocks.auth.mockResolvedValue({ client: { from: mocks.from }, userId, customerId: null, admin: null });
  mocks.from.mockReset().mockImplementation((table: string) => {
    const query: any = {};
    let inserted: Record<string, unknown> | null = null;
    for (const method of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'update', 'delete']) query[method] = () => query;
    query.insert = (row: Record<string, unknown>) => {
      inserted = row;
      inserts.push({ table, row });
      if (table === 'chat_messages' && !(failUserInsert && row.role === 'user')) messages.push({ is_fallback: false, failure_mode: null, ...row, created_at: new Date().toISOString() });
      return query;
    };
    query.then = (resolve: any, reject: any) => {
      const error = failUserInsert && inserted?.role === 'user' ? { code: 'XX000', message: 'synthetic' } : null;
      const data = table === 'chat_conversations' ? { id: conv } : table === 'chat_messages' ? messages : [];
      return Promise.resolve({ data, error }).then(resolve, reject);
    };
    return query;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function post(body: Record<string, unknown>, context?: Record<symbol, unknown>) {
  const request = new Request('https://drstanfield.com/api/chat?logged_in_customer_id=123', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  return action({ request, params: {}, context } as Parameters<typeof action>[0]);
}

const userRows = () => inserts.filter((i) => i.table === 'chat_messages' && i.row.role === 'user');
const modelStarted = () => vi.waitFor(() => expect(mocks.getChatCompletion).toHaveBeenCalled());
/** The fire-and-forget assistant insert and the release land after the reply. */
const settled = () => vi.waitFor(() => expect(claims.state!.rows.size).toBe(0));

describe('US-15 AC63 — an identical message while a turn runs', () => {
  it('two identical POSTs in one bubble thread: the second answers 409 busy, one model call, one user row', async () => {
    const answer = holdModel();
    const first = post({ message: QUESTION, conversationId: conv });
    await modelStarted();
    const second = await post({ message: QUESTION, conversationId: conv });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ success: false, error: BUSY });
    answer();
    expect((await first).status).toBe(200);
    expect(mocks.getChatCompletion).toHaveBeenCalledTimes(1);
    expect(userRows()).toHaveLength(1);
  });

  it('a streamed second POST gets the same plain JSON 409, before any stream opens', async () => {
    const answer = holdModel();
    const first = post({ message: QUESTION, conversationId: conv, stream: true });
    await modelStarted();
    const second = await post({ message: QUESTION, conversationId: conv, stream: true });
    expect(second.status).toBe(409);
    expect(second.headers.get('content-type')).toContain('application/json');
    expect(await second.json()).toEqual({ success: false, error: BUSY });
    answer();
    await (await first).text();
    expect(mocks.getChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('one conversation id in lower and upper case is one scope: one model call, one busy answer', async () => {
    const answer = holdModel();
    const first = post({ message: QUESTION, conversationId: conv });
    await modelStarted();
    const second = await post({ message: QUESTION, conversationId: conv.toUpperCase() });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ success: false, error: BUSY });
    answer();
    expect((await first).status).toBe(200);
    expect(mocks.getChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('a first message with no conversationId sent twice while running: one conversation, the second is busy', async () => {
    const answer = holdModel();
    const first = post({ message: QUESTION });
    await modelStarted();
    expect((await post({ message: QUESTION })).status).toBe(409);
    answer();
    expect((await first).status).toBe(200);
    expect(inserts.filter((i) => i.table === 'chat_conversations')).toHaveLength(1);
  });

  it('the claim is released when the turn fails (a 500), so an identical POST then runs', async () => {
    failUserInsert = true;
    expect((await post({ message: QUESTION, conversationId: conv })).status).toBe(500);
    await settled();
    failUserInsert = false;
    expect((await post({ message: QUESTION, conversationId: conv })).status).toBe(200);
    expect(mocks.getChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('the claim is released when a streamed turn throws', async () => {
    mocks.getChatCompletion.mockRejectedValueOnce(new Error('synthetic'));
    await (await post({ message: QUESTION, conversationId: conv, stream: true })).text();
    await settled();
    expect((await post({ message: QUESTION, conversationId: conv })).status).toBe(200);
  });

  it('widget and app turns never touch single_use_claims', async () => {
    await post({ message: QUESTION, localFirst: true });
    await post({ message: QUESTION, localFirst: true });
    await post({ message: QUESTION, history: [] }, { [Symbol.for('roadmap.us52.app-attested')]: true });
    expect(claims.state!.inserts).toBe(0);
    expect(claims.state!.deleteSignals).toHaveLength(0);
    expect(mocks.getChatCompletion).toHaveBeenCalledTimes(3);
  });

  it('a store that is down fails open: an identical POST while the first runs gets a second answer, as before', async () => {
    claims.state!.down = 'error';
    const answer = holdModel();
    const first = post({ message: QUESTION, conversationId: conv });
    await modelStarted();
    const second = post({ message: QUESTION, conversationId: conv });
    await vi.waitFor(() => expect(mocks.getChatCompletion).toHaveBeenCalledTimes(2));
    answer();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it('the stated limit: the web 5xx retry meets the claim, sees busy, and a resend within 60 s re-serves the stored answer; one model call in all', async () => {
    // Attempt 1 reached the handler; the edge answered the browser a 5xx; the client retried once.
    const answer = holdModel();
    const attempt1 = post({ message: QUESTION, conversationId: conv });
    await modelStarted();
    const retry = await post({ message: QUESTION, conversationId: conv });
    expect(retry.status).toBe(409);
    expect((await retry.json()).error).toBe(BUSY);
    answer();
    await attempt1;
    await settled();
    await vi.waitFor(() => expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1));
    // The person presses Send again.
    const resend = await post({ message: QUESTION, conversationId: conv });
    expect(resend.status).toBe(200);
    expect(await resend.json()).toMatchObject({ success: true, content: 'Synthetic answer', messageId: null });
    expect(mocks.getChatCompletion).toHaveBeenCalledTimes(1);
    expect(userRows()).toHaveLength(1);
  });
});
