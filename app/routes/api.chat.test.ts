import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

const mocks = vi.hoisted(() => ({ appProxy: vi.fn(async () => ({})) }));
vi.mock('../shopify.server', () => ({
  authenticate: { public: { appProxy: mocks.appProxy } },
}));

// US-15 AC44: the DELETE's two clients, recorded call by call. Only the
// DELETE suite gives them behaviour; elsewhere the real module stands.
const db = vi.hoisted(() => ({
  calls: [] as { client: 'user' | 'admin'; table: string; op: string; args: unknown[] }[],
  owned: true,
  matchEvents: [] as { id: string; router_context: Record<string, unknown> }[],
  adminUpdateError: null as { message: string; details?: string } | null,
  active: false,
}));
function fakeClient(client: 'user' | 'admin') {
  return {
    from(table: string) {
      const record = (op: string, ...args: unknown[]) => db.calls.push({ client, table, op, args });
      let op = 'select';
      const chain: any = {
        select: (...a: unknown[]) => { record('select', ...a); return chain; },
        eq: (...a: unknown[]) => { record(`${op}.eq`, ...a); return op === 'update' ? Promise.resolve({ error: db.adminUpdateError }) : chain; },
        or: (...a: unknown[]) => { record('or', ...a); return chain; },
        limit: async () => ({ data: db.adminUpdateError ? db.matchEvents : db.matchEvents.splice(0), error: null }),
        maybeSingle: async () => ({ data: db.owned ? { id: 'x' } : null, error: null }),
        delete: () => { op = 'delete'; record('delete'); return { eq: () => ({ eq: async () => ({ error: null }) }) }; },
        update: (patch: unknown) => {
          op = 'update';
          record('update', patch);
          return chain;
        },
      };
      return chain;
    },
  };
}
vi.mock('../lib/supabase.server', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/supabase.server')>();
  const admin = fakeClient('admin');
  return {
    ...real,
    get supabaseAdmin() { return db.active ? admin : real.supabaseAdmin; },
    createUserClient: (id: string) => (db.active ? fakeClient('user') : real.createUserClient(id)),
    getOrCreateGuestSession: async (...a: Parameters<typeof real.getOrCreateGuestSession>) =>
      (db.active ? { sessionId: 'guest-1', sessionToken: 'tok' } : real.getOrCreateGuestSession(...a)),
    logAudit: (...a: Parameters<typeof real.logAudit>) => (db.active ? undefined : real.logAudit(...a)),
  };
});

import { action, loader } from './api.chat';
import { streamingPost } from '../lib/capped-body.test-helpers';

// US-15 AC4: a malformed body is the client's error. Node's SyntaxError quotes
// the offending text, so the outer catch must never see it.
const marker = 'PHI_SENTINEL';
let envelopes: unknown[];

beforeEach(() => {
  envelopes = [];
  Sentry.init({
    dsn: 'https://public@example.invalid/1',
    defaultIntegrations: false,
    transport: () => ({
      send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
});

afterEach(async () => {
  await Sentry.close();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('api.chat malformed body', () => {
  it('returns 400 and reports nothing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await action({
      request: new Request('https://drstanfield.com/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{"message": ${marker} synthetic LDL 4.2`,
      }),
      params: {},
    } as unknown as Parameters<typeof action>[0]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain(marker);
    await Sentry.flush();
    expect(envelopes).toEqual([]);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(marker);
  });
});

// US-15 AC9 (Sentry JAVASCRIPT-REMIX-6E): a request without a valid app-proxy
// signature gets the framework's own 400, not a 500, and is never a Sentry
// error. `authenticate.public.appProxy` rejects by THROWING a Response
// (@shopify/shopify-app-react-router 3.0.2, authenticate.js:17), which the
// route's catch-all used to swallow as "Chat: Action failed".
// react-router returns a thrown Response from a resource route as-is, without
// calling handleError (7.18.3, handleQueryRouteError) — so the route must let
// it propagate rather than answer 500.
describe('api.chat unsigned request', () => {
  const url = 'https://health-tool-app.fly.dev/api/chat';
  const args = (request: Request) => ({ request, params: {} }) as unknown as Parameters<typeof action>[0];

  it.each([
    ['POST', () => action(args(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })))],
    ['GET with a session token', () => loader(args(new Request(`${url}?sessionToken=synthetic`)))],
  ])('%s lets the 400 the proxy check threw through and reports nothing', async (_, call) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejection = new Response(null, { status: 400 });
    mocks.appProxy.mockRejectedValueOnce(rejection);
    await expect(call()).rejects.toBe(rejection);
    await Sentry.flush();
    expect(envelopes).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

// US-09 AC24: a duplicated logged_in_customer_id never identifies a customer.
// Shopify's own check kept the LAST copy (shopify-api 13) while the route read the FIRST, so a
// signed query with another customer's id put in front passed as that
// customer. A GET naming a customer still meets the framework check first
// (Codex R1), so an unsigned one gets its 400; a duplicate that passes it is
// the empty guest answer. A bare GET with no id stays US-15 AC9's guest list.
describe('api.chat customer id on a GET', () => {
  const get = (query: string) => loader({
    request: new Request(`https://health-tool-app.fly.dev/api/chat${query}`),
    params: {},
  } as unknown as Parameters<typeof loader>[0]);
  let saved: string | undefined;
  beforeEach(async () => {
    const { TEST_PROXY_SECRET } = await import('../lib/app-proxy.test-helpers');
    saved = process.env.SHOPIFY_API_SECRET;
    process.env.SHOPIFY_API_SECRET = TEST_PROXY_SECRET;
  });
  afterEach(() => { process.env.SHOPIFY_API_SECRET = saved; });

  it('a forged first id passes the framework check and is still the empty guest list', async () => {
    const { forgedQuery } = await import('../lib/app-proxy.test-helpers');
    mocks.appProxy.mockResolvedValueOnce({});
    const res = await get(forgedQuery('999', ''));
    expect(await res.json()).toEqual({ success: true, conversations: [], isGuest: true });
    expect(mocks.appProxy).toHaveBeenCalledTimes(1);
  });

  it('an unsigned id gets the framework 400, never a guest list', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejection = new Response(null, { status: 400 });
    mocks.appProxy.mockRejectedValueOnce(rejection);
    await expect(get('?logged_in_customer_id=999')).rejects.toBe(rejection);
    await Sentry.flush();
    expect(envelopes).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  // US-09 AC24 (Codex R2, adversary R2): presence, not the first value's
  // truthiness. An empty first copy must not skip the check for a second one.
  it('an unsigned empty-then-real id pair gets the framework 400, never a guest list', async () => {
    const rejection = new Response(null, { status: 400 });
    mocks.appProxy.mockRejectedValueOnce(rejection);
    await expect(get('?logged_in_customer_id=&logged_in_customer_id=999')).rejects.toBe(rejection);
    expect(mocks.appProxy).toHaveBeenCalledTimes(1);
  });

  it('a bare GET with no id is the empty guest list without the framework check (US-15 AC9)', async () => {
    const res = await get('');
    expect(await res.json()).toEqual({ success: true, conversations: [], isGuest: true });
    expect(mocks.appProxy).not.toHaveBeenCalled();
  });
});

describe('api.chat body cap (US-09 AC25)', () => {
  it('answers 413 to a chunked body over 2 MB, stops reading, and reports nothing', async () => {
    const { request, pulled } = streamingPost('https://drstanfield.com/api/chat', 4 * 1024 * 1024, { chunkBytes: 64 * 1024 });
    const res = await action({ request, params: {} } as unknown as Parameters<typeof action>[0]);
    expect(res.status).toBe(413);
    expect(pulled.bytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 2 * 64 * 1024);
    await Sentry.flush();
    expect(envelopes).toEqual([]);
  });
});

// US-15 AC44: a deleted conversation's router rows are blanked at once,
// through the service role (the user's client has no UPDATE grant on
// chat_match_events), filtered by this user, after the owner check and the
// delete. A failure there is reported without text; the delete stands.
describe('api.chat DELETE blanks the conversation’s match events (US-15 AC44)', () => {
  const conversationId = '0b6f4c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';
  const LEAK = ['DB', 'ERROR', 'TEXT', 'MARKER'].join('_');
  const del = () => action({
    request: new Request('https://drstanfield.com/api/chat', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, localFirst: true }),
    }),
    params: {},
  } as unknown as Parameters<typeof action>[0]);

  beforeEach(() => {
    mocks.appProxy.mockResolvedValue({});
    db.active = true;
    db.calls = [];
    db.owned = true;
    db.adminUpdateError = null;
    db.matchEvents = [{ id: 'evt-1', router_context: { platform: 'shopify', first: LEAK, recent: [LEAK] } }];
  });
  afterEach(() => { db.active = false; });

  it('deletes with the user’s client, then blanks the rows with the service role', async () => {
    const res = await del();
    expect(await res.json()).toEqual({ success: true });
    const user = db.calls.filter((c) => c.client === 'user');
    const admin = db.calls.filter((c) => c.client === 'admin');
    expect(user.some((c) => c.table === 'chat_conversations' && c.op === 'delete')).toBe(true);
    // The user's client never touches the router rows.
    expect(user.filter((c) => c.table === 'chat_match_events')).toEqual([]);
    // The service role selects only this conversation's rows, for this user.
    expect(admin.filter((c) => c.op === 'select.eq').map((c) => c.args).slice(0, 2)).toEqual([
      ['conversation_id', conversationId],
      ['user_id', 'guest-1'],
    ]);
    expect(admin.find((c) => c.op === 'update')?.args[0]).toEqual({
      message: null, router_raw: null, router_error: null, router_context: { platform: 'shopify' },
    });
    expect(admin.find((c) => c.op === 'update.eq')?.args).toEqual(['id', 'evt-1']);
    // Blanked after the delete, not before.
    const order = db.calls.map((c) => `${c.client}:${c.op}`);
    expect(order.indexOf('admin:update')).toBeGreaterThan(order.indexOf('user:delete'));
  });

  it('a blanking failure is reported without text and the delete still succeeds', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.adminUpdateError = { message: LEAK, details: LEAK };
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(consoleError).toHaveBeenCalledWith('Chat: Failed to clear match events');
    await Sentry.flush();
    // Sentry's context lines quote this file, so the marker is built, never written out.
    expect(JSON.stringify(envelopes)).not.toContain(LEAK);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(LEAK);
  });

  it('touches no router rows when the conversation is not this user’s', async () => {
    db.owned = false;
    const res = await del();
    expect(res.status).toBe(404);
    expect(db.calls.filter((c) => c.client === 'admin')).toEqual([]);
  });
});
