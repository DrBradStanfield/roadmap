import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// US-15 AC45: every web chat turn counts against its IP's day and the
// machine's day. A guest that keeps its session token never meets the new
// session limit (supabase.server.ts), so before this nothing counted its turns.
// The model calls are mocked; synthetic addresses only (TEST-NET ranges).

const mocks = vi.hoisted(() => ({
  classify: vi.fn(async (..._args: unknown[]) => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 })),
  completion: vi.fn(async () => ({
    content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    isFallback: false, stopReason: 'end_turn',
  })),
  guestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
}));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: vi.fn(async () => null),
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('../lib/supabase.server', () => {
  const query: any = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'update', 'delete', 'insert']) query[method] = () => query;
  query.then = (resolve: any, reject: any) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
  return {
    logAudit: vi.fn(), getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
    createUserClient: vi.fn(() => ({ from: () => query })),
    getOrCreateGuestSession: mocks.guestSession,
    GuestRateLimitError: class extends Error {},
    supabaseAdmin: null,
  };
});
vi.mock('../lib/chat.server', async (original) => ({
  resolveChatContext: () => ({ healthDocuments: [], userContextJson: '{}' }),
  buildSystemBlocks: () => [], buildConversationMessages: () => [],
  matchDocumentTitle: () => null, loadMatchedArticlesFromHandles: () => null,
  DOCTOR_POSTURE: '', BRAND_POSTURE: '',
  getChatCompletion: mocks.completion,
  reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic title', CHAT_MODEL: 'test',
  MAX_MESSAGE_LENGTH: (await original<typeof import('../lib/chat.server')>()).MAX_MESSAGE_LENGTH,
}));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: vi.fn(), reportRouterFailure: vi.fn(),
}));
vi.mock('../lib/chat-classifier.server', () => ({ classifyMessage: mocks.classify, shouldFireRouter: () => false }));

type Action = typeof import('./api.chat').action;
let action: Action;

/** Load the route afresh, so the per-machine counter reads the env just set. */
async function load(cap?: string) {
  vi.resetModules();
  if (cap === undefined) vi.stubEnv('WEB_CHAT_DAILY_CAP', undefined as unknown as string);
  else vi.stubEnv('WEB_CHAT_DAILY_CAP', cap);
  action = (await import('./api.chat')).action;
}

/** A returning guest's widget turn from one shopper IP, as the Shopify proxy forwards it. */
async function post(ip: string, context?: Record<symbol, unknown>) {
  const request = new Request('https://drstanfield.com/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'what is a good LDL', localFirst: true, sessionToken: 'tok' }),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 192.0.2.250`, 'fly-client-ip': '192.0.2.250' },
  });
  const res = await action({ request, params: {}, context } as unknown as Parameters<Action>[0]);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('US-15 AC45: web chat turns are capped per IP and per machine', () => {
  it('a returning guest gets 200 turns a day from one IP; the 201st is refused before any model call', async () => {
    await load();
    for (let i = 0; i < 200; i++) expect((await post('198.51.100.7')).status).toBe(200);
    const calls = mocks.completion.mock.calls.length;
    const classified = mocks.classify.mock.calls.length;
    const refused = await post('198.51.100.7');
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ success: false, error: 'rate_limited' });
    expect(mocks.completion.mock.calls.length).toBe(calls);
    expect(mocks.classify.mock.calls.length).toBe(classified);
    // Another shopper is not refused for it.
    expect((await post('198.51.100.8')).status).toBe(200);
  });

  it('a new session token does not reset the IP count', async () => {
    await load();
    for (let i = 0; i < 200; i++) await post('198.51.100.9');
    mocks.guestSession.mockResolvedValueOnce({ sessionId: '11111111-1111-4111-8111-111111111111', sessionToken: 'fresh' });
    expect((await post('198.51.100.9')).status).toBe(429);
  });

  it('an IP past its cap spends none of the machine cap', async () => {
    await load('201');
    for (let i = 0; i < 200; i++) await post('198.51.100.10');
    for (let i = 0; i < 5; i++) expect((await post('198.51.100.10')).status).toBe(429);
    expect((await post('198.51.100.11')).status).toBe(200);
    expect((await post('198.51.100.12')).status).toBe(429);
  });

  it('a turn the machine refuses costs the IP nothing', async () => {
    await load('1');
    expect((await post('198.51.100.13')).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await post('198.51.100.14')).status).toBe(429);
    const { webChatTurns } = await import('../lib/rate-limiter');
    const { ipBucket } = await import('../lib/app-gate.server');
    webChatTurns.machine.reset();
    expect(webChatTurns.ip.remaining(ipBucket('198.51.100.14'))).toBe(200);
    expect(webChatTurns.ip.remaining(ipBucket('198.51.100.13'))).toBe(199);
  });

  it('the route reads WEB_CHAT_DAILY_CAP through the env rule: "abc" warns and caps at 2000, never at no cap', async () => {
    await load('abc');
    const { webChatTurns } = await import('../lib/rate-limiter');
    expect(webChatTurns.machine.remaining('machine')).toBe(2000);
    expect(vi.mocked(console.warn).mock.calls.some(([m]) => String(m).startsWith('WEB_CHAT_DAILY_CAP'))).toBe(true);
    expect((await post('198.51.100.15')).status).toBe(200);
    expect(webChatTurns.machine.remaining('machine')).toBe(1999);
  });

  it('WEB_CHAT_DAILY_CAP caps the machine across IPs', async () => {
    await load('3');
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) expect((await post(ip)).status).toBe(200);
    const calls = mocks.completion.mock.calls.length;
    expect((await post('198.51.100.4')).status).toBe(429);
    expect(mocks.completion.mock.calls.length).toBe(calls);
  });

  it('WEB_CHAT_DAILY_CAP=0 means no web turns', async () => {
    await load('0');
    expect((await post('198.51.100.5')).status).toBe(429);
    expect(mocks.completion).not.toHaveBeenCalled();
  });

  for (const raw of ['2,000', 'abc', '-1']) {
    it(`a WEB_CHAT_DAILY_CAP of ${JSON.stringify(raw)} falls back to the default 2000, never to no cap`, async () => {
      const { envCap } = await import('../lib/rate-limiter');
      const warn = vi.fn();
      expect(envCap('WEB_CHAT_DAILY_CAP', raw, 2000, warn)).toBe(2000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).not.toContain(raw);
    });
  }

  it('the iPhone app turn is not counted here: its own gate counted it (US-52 AC4)', async () => {
    await load('1');
    const app = { [Symbol.for('roadmap.us52.app-attested')]: true };
    for (let i = 0; i < 3; i++) expect((await post('198.51.100.6', app)).status).toBe(200);
    expect((await post('198.51.100.6')).status).toBe(200);
    expect((await post('198.51.100.6')).status).toBe(429);
  });
});
