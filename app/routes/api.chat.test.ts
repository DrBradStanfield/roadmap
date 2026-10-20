import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

const mocks = vi.hoisted(() => ({ appProxy: vi.fn(async () => ({})) }));
vi.mock('../shopify.server', () => ({
  authenticate: { public: { appProxy: mocks.appProxy } },
}));

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
