/**
 * US-09 AC25 for the capped routes with no suite of their own: the Google
 * token exchange (cross-origin, no app proxy), the Resend webhook, which is
 * reachable straight on Fly and must cap before it checks the signature, and
 * Shopify's webhooks and /auth/login, whose library reads the body itself and
 * so is handed a capped, byte-identical copy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const verifyResendSignature = vi.hoisted(() => vi.fn(() => ({ ok: false, reason: 'no signature' })));
vi.mock('../lib/resend-webhook.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyResendSignature,
}));
vi.mock('../lib/klaviyo.server', () => ({ suppressInKlaviyo: vi.fn(async () => {}) }));
vi.mock('../lib/reminder-v2.server', () => ({ deleteByEmail: vi.fn(async () => {}) }));
vi.mock('../lib/product-events.server', () => ({ recordServerEvent: vi.fn(async () => {}) }));
const shopify = vi.hoisted(() => ({
  authenticate: { webhook: vi.fn(async (_r: Request) => ({ topic: 't', shop: 's', session: null, payload: { current: [] } })) },
  login: vi.fn(async (_r: Request) => ({})),
  sessionStorage: {},
}));
vi.mock('../shopify.server', () => shopify);
vi.mock('../lib/supabase.server', () => ({}));

import { SMALL_BODY_CAP } from '../lib/capped-body.server';
import { streamingPost } from '../lib/capped-body.test-helpers';
import { action as googleToken } from './api.google-token';
import { action as resendWebhook } from './api.resend-webhook';
import { action as ordersPaid } from './webhooks.orders-paid';
import { action as appUninstalled } from './webhooks.app.uninstalled';
import { action as scopesUpdate } from './webhooks.app.scopes_update';
import { action as authLogin } from './auth.login/route';

const SLACK = SMALL_BODY_CAP + 2 * 16 * 1024;
const RESEND_SLACK = 256 * 1024 + 2 * 16 * 1024;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('body cap (US-09 AC25)', () => {
  it('the Google token exchange answers 413, with its CORS headers, to a chunked body over 64 KB', async () => {
    vi.stubEnv('GOOGLE_DRIVE_CLIENT_ID', 'id');
    vi.stubEnv('GOOGLE_DRIVE_SECRET', 'secret');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { request, pulled } = streamingPost('https://health-tool-app.fly.dev/api/google-token', 100 * SMALL_BODY_CAP, {
      headers: { Origin: 'https://drstanfield.com', 'fly-client-ip': '203.0.113.50' },
    });
    const res = await googleToken({ request } as never);
    expect(res.status).toBe(413);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://drstanfield.com');
    expect(pulled.bytes).toBeLessThanOrEqual(SLACK);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the Resend webhook answers 413 to an unsigned body over 256 KB before it checks a signature', async () => {
    const { request, pulled } = streamingPost('https://health-tool-app.fly.dev/api/resend-webhook', 100 * SMALL_BODY_CAP);
    const res = await resendWebhook({ request } as never);
    expect(res.status).toBe(413);
    expect(pulled.bytes).toBeLessThanOrEqual(RESEND_SLACK);
    expect(verifyResendSignature).not.toHaveBeenCalled();
  });

  it('the Resend webhook refuses a lying Content-Length the same way', async () => {
    const { request, pulled } = streamingPost('https://health-tool-app.fly.dev/api/resend-webhook', 100 * SMALL_BODY_CAP, {
      headers: { 'content-length': '200' },
    });
    expect((await resendWebhook({ request } as never)).status).toBe(413);
    expect(pulled.bytes).toBeLessThanOrEqual(RESEND_SLACK);
    expect(verifyResendSignature).not.toHaveBeenCalled();
  });
});

describe('body cap before the Shopify library reads the body (US-09 AC25)', () => {
  const WEBHOOK_CAP = 5 * 1024 * 1024;
  const routes = [
    { name: 'webhooks/orders/paid', action: ordersPaid, lib: shopify.authenticate.webhook, cap: WEBHOOK_CAP },
    { name: 'webhooks/app/uninstalled', action: appUninstalled, lib: shopify.authenticate.webhook, cap: WEBHOOK_CAP },
    { name: 'webhooks/app/scopes_update', action: scopesUpdate, lib: shopify.authenticate.webhook, cap: WEBHOOK_CAP },
    { name: 'auth/login', action: authLogin, lib: shopify.login, cap: SMALL_BODY_CAP },
  ];

  // Multi-byte UTF-8 (é, 漢, 😀) and bytes that are not UTF-8 at all: a
  // decode-and-re-encode would change them, and the webhook HMAC with them.
  const exact = new Uint8Array([
    ...new TextEncoder().encode('{"a":"é漢😀"}'), 0xff, 0xfe, 0xc3, 0x28, 0x80,
  ]);

  for (const r of routes) {
    it(`${r.name} answers 413 to an unsigned chunked body over its cap, and never calls the library`, async () => {
      const { request, pulled } = streamingPost(`https://health-tool-app.fly.dev/${r.name}`, 2 * r.cap);
      const res = (await r.action({ request } as never)) as Response;
      expect(res.status).toBe(413);
      expect(await res.text()).toBe('');
      // The reader takes the chunk that crosses the cap; the stream queues one more.
      expect(pulled.bytes).toBeLessThanOrEqual(r.cap + 2 * 16 * 1024);
      expect(r.lib).not.toHaveBeenCalled();
    });

    it(`${r.name} hands the library a byte-identical body under its cap`, async () => {
      let seen: Uint8Array | null = null;
      r.lib.mockImplementationOnce(async (req: Request) => {
        seen = new Uint8Array(await req.arrayBuffer());
        return { topic: 't', shop: 's', session: null, payload: { current: [] } };
      });
      // Split mid-character, so a per-chunk decode would show too.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(exact.subarray(0, 9));
          c.enqueue(exact.subarray(9));
          c.close();
        },
      });
      const request = new Request(`https://health-tool-app.fly.dev/${r.name}`, {
        method: 'POST',
        body,
        headers: { 'x-shopify-hmac-sha256': 'sig', 'content-type': 'application/json' },
        duplex: 'half',
      } as RequestInit);
      await r.action({ request } as never);
      expect(r.lib).toHaveBeenCalledTimes(1);
      const handed = r.lib.mock.calls[0][0] as Request;
      expect(handed.method).toBe('POST');
      expect(handed.headers.get('x-shopify-hmac-sha256')).toBe('sig');
      expect(seen).toEqual(exact);
    });
  }
});
