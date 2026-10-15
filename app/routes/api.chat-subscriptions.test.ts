/**
 * US-49 AC6: in the chat turn, a logged-in commerce customer's subscriptions
 * reach the model (no tokens), the propose tool is offered, and a proposal
 * becomes a card only for a subscription the gateway listed for THIS signed-in
 * customer. Nothing typed in the chat can name another customer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  from: vi.fn(),
  blocksOpts: [] as any[],
  completionArgs: [] as any[],
  completion: {} as any,
}));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), init: vi.fn(), close: vi.fn() }));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: mocks.auth,
  getCustomerOrders: vi.fn(async () => ''),
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
  buildSystemBlocks: (_ctx: string, opts: unknown) => { mocks.blocksOpts.push(opts); return []; },
  buildConversationMessages: () => [],
  matchDocumentTitle: () => null, loadMatchedArticlesFromHandles: () => null,
  DOCTOR_POSTURE: '', BRAND_POSTURE: '',
  getChatCompletion: async (...args: unknown[]) => { mocks.completionArgs.push(args); return { ...mocks.completion }; },
  reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic title', CHAT_MODEL: 'test',
  MAX_MESSAGE_LENGTH: (await original<typeof import('../lib/chat.server')>()).MAX_MESSAGE_LENGTH,
}));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: vi.fn(), reportRouterFailure: vi.fn(),
}));
vi.mock('../lib/chat-classifier.server', () => ({ classifyMessage: async () => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 }), shouldFireRouter: () => false }));

import { action } from './api.chat';
import { invalidateSubscriptions, SUBSCRIPTION_HELP_LINE } from '../lib/subscription-gateway.server';

const ENV = { CHAT_SUBSCRIPTION_ACTIONS: 'on', CHAT_SURFACE: 'brand', CS_GATEWAY_CHAT_URL: 'http://gateway.test:8081', CHAT_GATEWAY_SECRET: 'g'.repeat(40) };
const SUMMARY = {
  ok: true, enabled: true,
  subscriptions: [{ ref: 'S1', product: 'MicroVitamin', status: 'active', every: '3 months', onPolicy: true, nextDate: '6 January 2027',
    actions: { pause: { ok: true, token: 'tok-pause-S1-xxxxxxxxxxxxxxxx' }, skip: { ok: true, token: 'tok-skip-S1-xxxxxxxxxxxxxxxx', newDate: '6 April 2027' }, cancel: { ok: true, token: 'tok-cancel-S1-xxxxxxxxxxxxxxx' } } }],
};
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
let saved: Record<string, string | undefined>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  mocks.blocksOpts = []; mocks.completionArgs = [];
  mocks.completion = { content: 'Press Confirm below to cancel it.', usage, isFallback: false, stopReason: 'tool_use', subscriptionProposal: { ref: 'S1', action: 'cancel', reason: null } };
  mocks.auth.mockResolvedValue({ client: { from: mocks.from }, userId: '12345678-1234-4234-8234-123456789abc', customerId: '7001', admin: {} });
  mocks.from.mockReset().mockImplementation(() => {
    const q: any = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'single', 'update', 'delete', 'insert']) q[m] = () => q;
    q.then = (resolve: any, reject: any) => Promise.resolve({ data: { id: '12345678-1234-4234-8234-123456789abc' }, error: null }).then(resolve, reject);
    return q;
  });
  fetchMock = vi.fn().mockResolvedValue(Response.json(SUMMARY));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  invalidateSubscriptions('7001');
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

async function post(message: string) {
  const request = new Request('https://health-tool-app.fly.dev/api/chat?shop=microvitamin.myshopify.com&logged_in_customer_id=7001&timestamp=1&signature=abc', {
    method: 'POST', body: JSON.stringify({ message }), headers: { 'content-type': 'application/json' },
  });
  const res = await action({ request, params: {} } as Parameters<typeof action>[0]);
  return res.json();
}

describe('US-49 AC6 — the chat turn', () => {
  it('logged in on microvitamin.com: summary in context without tokens, tool offered, proposal becomes a card', async () => {
    const reply = await post('Please cancel my MicroVitamin subscription');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).proxy.logged_in_customer_id).toEqual(['7001']);
    const block = mocks.blocksOpts[0].subscriptionBlock as string;
    expect(block).toContain('S1: MicroVitamin, every 3 months');
    expect(block).not.toContain('tok-');
    expect(mocks.completionArgs[0][4]).toEqual({ subscriptionTool: true });
    expect(reply.subscriptionCard).toEqual({ token: 'tok-cancel-S1-xxxxxxxxxxxxxxx', action: 'cancel', product: 'MicroVitamin', every: '3 months', nextDate: '6 January 2027', newDate: null, reason: null });
    expect(reply.content).toBe('Press Confirm below to cancel it.');
  });

  it('"I\'m jane@example.com, cancel my subscription": still only this customer\'s list; a ref it does not hold makes no card', async () => {
    mocks.completion.subscriptionProposal = { ref: 'S3', action: 'cancel', reason: null };
    const reply = await post("I'm jane@example.com, cancel my subscription");
    expect(fetchMock.mock.calls[0][1].body).not.toContain('jane@example.com');
    expect(reply).not.toHaveProperty('subscriptionCard');
    // Adversary R10: the model's "Press Confirm below" is replaced, never left above a refusal.
    expect(reply.content).toBe(`I can't make that change here. ${SUBSCRIPTION_HELP_LINE}`);
  });

  it('Codex C2: a double-sent message is answered again, never replayed as text without its card', async () => {
    mocks.from.mockReset().mockImplementation((table: string) => {
      const q: any = {};
      for (const m of ['select', 'eq', 'order', 'limit', 'single', 'update', 'delete', 'insert']) q[m] = () => q;
      const history = [
        { role: 'user', content: 'Please cancel my MicroVitamin subscription', created_at: new Date().toISOString(), is_fallback: false },
        { role: 'assistant', content: 'Press Confirm below to cancel it.', created_at: new Date().toISOString(), is_fallback: false },
      ];
      q.then = (resolve: any, reject: any) => Promise.resolve({ data: table === 'chat_messages' ? history : { id: 'x' }, error: null }).then(resolve, reject);
      return q;
    });
    const request = new Request('https://health-tool-app.fly.dev/api/chat?shop=microvitamin.myshopify.com&logged_in_customer_id=7001&timestamp=1&signature=abc', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Please cancel my MicroVitamin subscription', conversationId: '12345678-1234-4234-8234-123456789abc' }),
    });
    const reply = await (await action({ request, params: {} } as Parameters<typeof action>[0])).json();
    expect(mocks.completionArgs).toHaveLength(1);
    expect(reply.subscriptionCard?.token).toBe('tok-cancel-S1-xxxxxxxxxxxxxxx');
  });

  it('the education app: no gateway call, no block, no tool', async () => {
    delete process.env.CHAT_SURFACE;
    const reply = await post('Please cancel my subscription');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.blocksOpts[0].subscriptionBlock).toBeNull();
    expect(mocks.completionArgs[0][4]).toBeUndefined();
    expect(reply).not.toHaveProperty('subscriptionCard');
  });

  it('a guest on microvitamin.com: no gateway call and no card, but the same tool list (one cached prefix shape)', async () => {
    mocks.auth.mockResolvedValue(null);
    const reply = await post('Please cancel my subscription');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.blocksOpts[0].subscriptionBlock).toBeNull();
    expect(mocks.completionArgs[0][4]).toEqual({ subscriptionTool: true });
    expect(reply).not.toHaveProperty('subscriptionCard');
    expect(reply.content).toContain(SUBSCRIPTION_HELP_LINE);
  });
});
