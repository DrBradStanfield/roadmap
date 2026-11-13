/**
 * US-15 AC65: with app/lib/chat-system-prompt.md absent or blank, the web and
 * iPhone chat answer 503 "Chat is temporarily disabled" and make no model call:
 * no main answer, no classifier, no router, no fetch at all. The fake file
 * system serves only the prompt path; every other read is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  read: (): string => 'synthetic prompt',
  callAnthropic: vi.fn(async () => { throw new Error('no model call in this test'); }),
  streamAnthropic: vi.fn(async () => { throw new Error('no model call in this test'); }),
  classify: vi.fn(async () => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 })),
  route: vi.fn(),
  dbCalls: [] as string[],
  audit: vi.fn(),
}));

const CONVERSATION = '12345678-1234-4234-8234-123456789abc';

vi.mock('fs', async (original) => {
  const real = await original<typeof import('fs')>();
  const readFileSync = ((file: string, ...rest: unknown[]) =>
    String(file).endsWith('app/lib/chat-system-prompt.md') ? spies.read() : (real.readFileSync as (...a: unknown[]) => unknown)(file, ...rest)) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('../lib/product-events.server', () => ({ recordServerEvent: vi.fn(async () => {}) }));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: vi.fn(async () => null),
}));
vi.mock('../lib/supabase.server', () => {
  const query: any = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'update', 'delete', 'insert']) {
    query[method] = (...args: unknown[]) => { spies.dbCalls.push(`${method}(${args.map(String).join(',')})`); return query; };
  }
  query.then = (resolve: any, reject: any) => Promise.resolve({ data: { id: CONVERSATION }, error: null }).then(resolve, reject);
  return {
    logAudit: spies.audit, getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
    createUserClient: vi.fn(() => ({ from: () => query })),
    getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
    GuestRateLimitError: class extends Error {},
  };
});
vi.mock('../lib/supabase-client.server', () => ({ supabaseAdmin: null }));
vi.mock('../lib/anthropic.server', async (original) => ({
  ...await original<typeof import('../lib/anthropic.server')>(),
  callAnthropicWithUsage: spies.callAnthropic,
  streamAnthropicWithUsage: spies.streamAnthropic,
}));
vi.mock('../lib/chat-classifier.server', () => ({ classifyMessage: spies.classify, shouldFireRouter: () => false }));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: spies.route, reportRouterFailure: vi.fn(),
}));

const fetchSpy = vi.fn(async () => { throw new Error('no network in this test'); });
beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  spies.dbCalls.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function post(read: () => string, body: Record<string, unknown>, app = false, method = 'POST') {
  spies.read = read;
  const { action } = await import('./api.chat');
  const request = new Request('https://drstanfield.com/api/chat', {
    method, body: JSON.stringify({ message: 'how am I doing?', localFirst: true, history: [], ...body }),
    headers: { 'content-type': 'application/json' },
  });
  const context = app ? { [Symbol.for('roadmap.us52.app-attested')]: true } : undefined;
  return action({ request, params: {}, context } as unknown as Parameters<typeof action>[0]);
}

const absent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

describe('US-15 AC65: chat refuses when its system prompt is missing', () => {
  it.each([
    ['absent, web', absent, {}, false],
    ['absent, web streamed', absent, { stream: true }, false],
    ['absent, iPhone app', absent, {}, true],
    ['empty, web', () => '', {}, false],
    ['empty, web streamed', () => '', { stream: true }, false],
    ['whitespace only, iPhone app', () => '  \n', {}, true],
  ])('%s: 503 and no model call', async (_case, read, body, app) => {
    const res = await post(read, body, app);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: 'Chat is temporarily disabled' });
    expect(spies.classify).not.toHaveBeenCalled();
    expect(spies.route).not.toHaveBeenCalled();
    expect(spies.callAnthropic).not.toHaveBeenCalled();
    expect(spies.streamAnthropic).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // F3 (review round 1): the refusal sits after DELETE, so a person can still delete stored chats.
  it.each([['absent', absent], ['empty', () => '']])('%s: DELETE still deletes the conversation', async (_case, read) => {
    const res = await post(read, { conversationId: CONVERSATION, sessionToken: 'tok', localFirst: undefined }, false, 'DELETE');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(spies.dbCalls).toContain('delete()');
    expect(spies.dbCalls).toContain(`eq(id,${CONVERSATION})`);
    expect(spies.audit).toHaveBeenCalledWith('87654321-4321-4321-8321-cba987654321', 'CHAT_CONVERSATION_DELETED', 'chat', CONVERSATION);
    expect(spies.classify).not.toHaveBeenCalled();
    expect(spies.callAnthropic).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('CHAT_ENABLED=false still refuses before anything, DELETE included, as on main', async () => {
    process.env.CHAT_ENABLED = 'false';
    try {
      const res = await post(() => 'synthetic prompt', { conversationId: CONVERSATION }, false, 'DELETE');
      expect(res.status).toBe(503);
      expect(spies.dbCalls).toEqual([]);
    } finally {
      delete process.env.CHAT_ENABLED;
    }
  });

  it('control: with the prompt loaded the turn gets past the guard', async () => {
    const res = await post(() => 'synthetic prompt', {});
    expect(res.status).not.toBe(503);
    expect(spies.classify).toHaveBeenCalledTimes(1);
  });
});
