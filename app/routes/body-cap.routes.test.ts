/**
 * US-09 AC25 for the two capped routes with no suite of their own: the Google
 * token exchange (cross-origin, no app proxy) and the Resend webhook, which is
 * reachable straight on Fly and must cap before it checks the signature.
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

import { SMALL_BODY_CAP } from '../lib/capped-body.server';
import { streamingPost } from '../lib/capped-body.test-helpers';
import { action as googleToken } from './api.google-token';
import { action as resendWebhook } from './api.resend-webhook';

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
