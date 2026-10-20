/**
 * US-49 AC5: the customer's own confirm. Commerce only, app-proxy signed,
 * logged in, JSON only, codes only, and the gateway makes the change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
const mocks = vi.hoisted(() => ({ appProxy: vi.fn(async () => ({})) }));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: mocks.appProxy } } }));
const events = vi.hoisted(() => ({ record: vi.fn(async () => {}) }));
vi.mock('../lib/product-events.server', () => ({ recordServerEvent: events.record }));

import { action } from './api.subscription-action';
import { SMALL_BODY_CAP } from '../lib/capped-body.server';
import { streamingPost } from '../lib/capped-body.test-helpers';
import { forgedQuery, proxyPairs, signedQuery, TEST_PROXY_SECRET } from '../lib/app-proxy.test-helpers';

const ENV = { SHOPIFY_API_SECRET: TEST_PROXY_SECRET, CHAT_SUBSCRIPTION_ACTIONS: 'on', CHAT_SURFACE: 'brand', CS_GATEWAY_CHAT_URL: 'http://gateway.test:8081', CHAT_GATEWAY_SECRET: 'g'.repeat(40) };
const TOKEN = 'tok-pause-S1-xxxxxxxxxxxxxxxx';
let saved: Record<string, string | undefined>;
let fetchMock: ReturnType<typeof vi.fn>;
let n = 0;

beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, status: 'done' }));
  vi.stubGlobal('fetch', fetchMock);
  mocks.appProxy.mockResolvedValue({});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function post(body: unknown, { customer = `80${++n}`, type = 'application/json', q = signedQuery(proxyPairs(customer)) } = {}) {
  const request = new Request(`https://health-tool-app.fly.dev/api/subscription-action${q}`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return action({ request, params: {} } as unknown as Parameters<typeof action>[0]);
}

describe('US-49 AC5 — POST /api/subscription-action', () => {
  it('is not there at all on the education app (or with the switch off)', async () => {
    delete process.env.CHAT_SURFACE;
    expect((await post({ token: TOKEN })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.appProxy).not.toHaveBeenCalled();
  });

  it('lets the app-proxy check reject an unsigned request', async () => {
    const rejection = new Response(null, { status: 400 });
    mocks.appProxy.mockRejectedValueOnce(rejection);
    await expect(post({ token: TOKEN })).rejects.toBe(rejection);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a duplicated logged_in_customer_id as not logged in (US-09 AC24)', async () => {
    for (const own of ['111', '']) {
      const res = await post({ token: TOKEN }, { q: forgedQuery('999', own) });
      expect(res.status).toBe(401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an id the signature does not cover (US-09 AC24)', async () => {
    expect((await post({ token: TOKEN }, { q: '?shop=microvitamin.myshopify.com&logged_in_customer_id=7001&timestamp=1&signature=abc' })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('needs a logged-in customer, JSON, a token and a known reason code', async () => {
    expect((await post({ token: TOKEN }, { customer: '' })).status).toBe(401);
    expect((await post(`token=${TOKEN}`, { type: 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await post({})).status).toBe(400);
    expect((await post({ token: TOKEN, reason: 'it gives me a rash' })).status).toBe(400);
    expect((await post({ token: TOKEN, customerId: '9999' })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the signed query and the token to the gateway and returns its outcome', async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true, status: 'done', newDate: '6 April 2027' }));
    const res = await post({ token: TOKEN, reason: 'have_enough' }, { customer: '7001' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status: 'done', newDate: '6 April 2027' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gateway.test:8081/chat/subscription-action');
    const body = JSON.parse(init.body);
    expect(Object.keys(body.proxy).sort()).toEqual(['logged_in_customer_id', 'path_prefix', 'shop', 'signature', 'timestamp']);
    expect(body.proxy.logged_in_customer_id).toEqual(['7001']);
    expect(body.proxy.signature[0]).toMatch(/^[0-9a-f]{64}$/);
    expect({ token: body.token, reason: body.reason }).toEqual({ token: TOKEN, reason: 'have_enough' });
    expect(init.headers['x-gateway-signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('forwards the signed query and records the usage signal only when the store took it', async () => {
    await post({ token: TOKEN });
    expect(events.record).toHaveBeenCalledWith('subscription_action_confirmed');
    events.record.mockClear();
    fetchMock.mockResolvedValue(Response.json({ ok: true, status: 'refused', code: 'off_policy' }));
    const res = await post({ token: TOKEN });
    expect(await res.json()).toEqual({ success: false, status: 'refused', code: 'off_policy' });
    expect(events.record).not.toHaveBeenCalled();
  });

  it('adversary R3 / Codex R1: a write whose answer is lost (timeout, network, 5xx) is unconfirmed, never refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The gateway made the change; the connection dropped before its answer arrived.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await (await post({ token: TOKEN })).json()).toEqual({ success: false, status: 'unconfirmed' });
    fetchMock.mockResolvedValue(new Response('upstream error', { status: 502 }));
    expect(await (await post({ token: TOKEN })).json()).toEqual({ success: false, status: 'unconfirmed' });
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await (await post({ token: TOKEN })).json()).toEqual({ success: false, status: 'unconfirmed' });
    // The gateway refusing the request itself (unsigned, logged out): nothing was written.
    fetchMock.mockResolvedValue(Response.json({ ok: false, error: 'not logged in' }, { status: 403 }));
    expect(await (await post({ token: TOKEN })).json()).toEqual({ success: false, status: 'refused', code: 'unavailable' });
    expect(events.record).not.toHaveBeenCalled();
  });
});

describe('api.subscription-action body cap (US-09 AC25)', () => {
  it('answers 413 to a chunked body over 64 KB and stops reading', async () => {
    const { request, pulled } = streamingPost(`https://health-tool-app.fly.dev/api/subscription-action${signedQuery(proxyPairs('8099'))}`,
      100 * SMALL_BODY_CAP, { headers: { 'content-type': 'application/json' } });
    const res = await action({ request, params: {} } as unknown as Parameters<typeof action>[0]);
    expect(res.status).toBe(413);
    expect(pulled.bytes).toBeLessThanOrEqual(SMALL_BODY_CAP + 2 * 16 * 1024);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
