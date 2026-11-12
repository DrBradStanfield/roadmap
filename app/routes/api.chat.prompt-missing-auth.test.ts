/**
 * US-15 AC65 (review round 2): with the chat system prompt missing, a chat POST
 * is refused before authentication, so it creates no guest auth user, profile
 * or session and takes no dedup claim. DELETE still authenticates and still
 * enforces ownership. The real getAuthOrGuest, getOrCreateGuestSession and
 * claimChatTurn run; only the Supabase clients underneath are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GUEST = '87654321-4321-4321-8321-cba987654321';
const FOREIGN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Query = { client: 'admin' | 'user'; table: string; op: string; filters: Array<[string, unknown]> };
const h = vi.hoisted(() => {
  process.env.SHOPIFY_API_SECRET = 'test-secret-plain';
  return {
    read: (): string => 'synthetic prompt',
    queries: [] as Query[],
    createUser: vi.fn(async () => ({ data: { user: { id: '87654321-4321-4321-8321-cba987654321' } }, error: null })),
    parents: [] as Array<{ id: string; user_id: string }>,
    principal: '',
    callAnthropic: vi.fn(async () => { throw new Error('no model call in this test'); }),
    streamAnthropic: vi.fn(async () => { throw new Error('no model call in this test'); }),
    classify: vi.fn(async () => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 })),
    route: vi.fn(),
    getAuthenticatedUser: vi.fn(async () => null),
    appProxy: vi.fn(async () => ({})),
  };
});

/** One fake query builder for both clients; it records every finished query. */
function builder(client: 'admin' | 'user', table: string) {
  const filters: Array<[string, unknown]> = [];
  let op = 'select';
  let one = false;
  const q: any = {};
  for (const m of ['order', 'limit', 'select']) q[m] = () => q;
  for (const m of ['single', 'maybeSingle']) q[m] = () => { one = true; return q; };
  for (const m of ['insert', 'upsert', 'update', 'delete']) q[m] = () => { op = m; return q; };
  q.eq = (k: string, v: unknown) => { filters.push([k, v]); return q; };
  q.then = (resolve: any, reject: any) => Promise.resolve().then(() => {
    h.queries.push({ client, table, op, filters: [...filters] });
    if (table === 'guest_chat_sessions' && op === 'insert') return { data: { session_token: 'tok-new' }, error: null };
    if (client === 'user' && table === 'chat_conversations') {
      const match = (row: { id: string; user_id: string }) => row.user_id === h.principal && filters.every(([k, v]) => (row as any)[k] === v);
      if (op === 'delete') { h.parents = h.parents.filter((row) => !match(row)); return { data: null, error: null }; }
      const rows = h.parents.filter(match);
      return { data: one ? rows[0] ?? null : rows, error: null };
    }
    return { data: null, error: null };
  }).then(resolve, reject);
  return q;
}

vi.mock('../lib/supabase-client.server', () => ({
  supabaseAdmin: { from: (table: string) => builder('admin', table), auth: { admin: { createUser: h.createUser, deleteUser: vi.fn() } } },
  createUserClient: (userId: string) => { h.principal = userId; return { from: (table: string) => builder('user', table) }; },
}));
vi.mock('../lib/supabase.server', async (original) => {
  const real = await original<typeof import('../lib/supabase.server')>();
  return { ...real, getOrCreateGuestSession: vi.fn(real.getOrCreateGuestSession) };
});
vi.mock('../lib/chat-dedup.server', async (original) => {
  const real = await original<typeof import('../lib/chat-dedup.server')>();
  return { ...real, claimChatTurn: vi.fn(real.claimChatTurn) };
});
vi.mock('fs', async (original) => {
  const real = await original<typeof import('fs')>();
  const readFileSync = ((file: string, ...rest: unknown[]) =>
    String(file).endsWith('app/lib/chat-system-prompt.md') ? h.read() : (real.readFileSync as (...a: unknown[]) => unknown)(file, ...rest)) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: h.appProxy } } }));
vi.mock('../lib/product-events.server', () => ({ recordServerEvent: vi.fn(async () => {}) }));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: h.getAuthenticatedUser,
}));
vi.mock('../lib/anthropic.server', async (original) => ({
  ...await original<typeof import('../lib/anthropic.server')>(),
  callAnthropicWithUsage: h.callAnthropic,
  streamAnthropicWithUsage: h.streamAnthropic,
}));
vi.mock('../lib/chat-classifier.server', () => ({ classifyMessage: h.classify, shouldFireRouter: () => false }));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: h.route, reportRouterFailure: vi.fn(),
}));

const fetchSpy = vi.fn(async () => { throw new Error('no network in this test'); });
// One client IP per test: the guest-creation limit (10 per IP per hour) is process state.
let ipSeq = 0;
beforeEach(() => {
  ipSeq++;
  vi.stubGlobal('fetch', fetchSpy);
  h.queries.length = 0;
  h.parents = [{ id: GUEST, user_id: GUEST }, { id: FOREIGN, user_id: FOREIGN }];
  h.principal = '';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const absent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

async function send(read: () => string, method: 'POST' | 'DELETE', body: Record<string, unknown>) {
  h.read = read;
  const { action } = await import('./api.chat');
  const request = new Request('https://drstanfield.com/api/chat', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${ipSeq}` } });
  return action({ request, params: {} } as unknown as Parameters<typeof action>[0]);
}
async function spies() {
  const { getOrCreateGuestSession } = await import('../lib/supabase.server');
  const { claimChatTurn } = await import('../lib/chat-dedup.server');
  return { guestSession: vi.mocked(getOrCreateGuestSession), claim: vi.mocked(claimChatTurn) };
}
const writes = () => h.queries.filter((q) => q.op !== 'select');

describe('US-15 AC65: a refused chat POST creates nothing', () => {
  it.each([
    ['widget, no token (localFirst: true)', { localFirst: true }],
    ['transcript surface, no token (localFirst: false), the claimChatTurn path', { localFirst: false }],
    ['transcript surface with a token', { localFirst: false, sessionToken: 'tok-old' }],
  ])('%s: 503, no auth, no guest session, no claim, no write, no model call', async (_case, extra) => {
    const res = await send(absent, 'POST', { message: 'how am I doing?', history: [], ...extra });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: 'Chat is temporarily disabled' });
    const { guestSession, claim } = await spies();
    expect(h.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(h.appProxy).not.toHaveBeenCalled();
    expect(guestSession).not.toHaveBeenCalled();
    expect(h.createUser).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(h.queries).toEqual([]);
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
    expect(h.callAnthropic).not.toHaveBeenCalled();
    expect(h.streamAnthropic).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('eleven refused POSTs from one IP still answer 503, never the guest limit 429', async () => {
    for (let i = 0; i < 11; i++) {
      const res = await send(absent, 'POST', { message: 'hi', localFirst: false });
      expect(res.status).toBe(503);
    }
    expect(h.createUser).not.toHaveBeenCalled();
  });

  it('control: with the prompt loaded, the transcript POST authenticates and takes the claim', async () => {
    await send(() => 'synthetic prompt', 'POST', { message: 'how am I doing?', localFirst: false });
    const { guestSession, claim } = await spies();
    expect(h.getAuthenticatedUser).toHaveBeenCalledTimes(1);
    expect(guestSession).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

describe('US-15 AC65: DELETE with the prompt missing authenticates and enforces ownership', () => {
  it('deleting your own conversation works', async () => {
    const res = await send(absent, 'DELETE', { conversationId: GUEST });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const { guestSession } = await spies();
    expect(h.getAuthenticatedUser).toHaveBeenCalledTimes(1);
    expect(guestSession).toHaveBeenCalledTimes(1);
    expect(writes()).toContainEqual({ client: 'user', table: 'chat_conversations', op: 'delete', filters: [['id', GUEST], ['user_id', GUEST]] });
    expect(h.parents.map((p) => p.id)).toEqual([FOREIGN]);
  });

  it("deleting another user's conversation is refused, as on main", async () => {
    const res = await send(absent, 'DELETE', { conversationId: FOREIGN });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: 'Conversation not found' });
    const { guestSession } = await spies();
    expect(guestSession).toHaveBeenCalledTimes(1);
    expect(writes().filter((q) => q.table === 'chat_conversations')).toEqual([]);
    expect(h.parents.map((p) => p.id)).toEqual([GUEST, FOREIGN]);
  });
});

describe('US-15 AC65: GET history stays ungated on purpose', () => {
  it('prompt missing: a GET with a token returns 200 and the list, with no model call', async () => {
    h.read = absent;
    const { loader } = await import('./api.chat');
    const request = new Request('https://drstanfield.com/api/chat?sessionToken=tok-stale', { headers: { 'x-forwarded-for': `203.0.113.${ipSeq}` } });
    const res = await loader({ request, params: {} } as unknown as Parameters<typeof loader>[0]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, isGuest: true, sessionToken: 'tok-new' });
    expect(body.conversations.map((c: { id: string }) => c.id)).toEqual([GUEST]);
    const { guestSession } = await spies();
    expect(guestSession).toHaveBeenCalledTimes(1); // a stale token gets a new guest session, as with the prompt loaded
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.callAnthropic).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
