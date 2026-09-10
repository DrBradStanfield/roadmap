/**
 * Rate-limit identity, pinned at the ROUTE level.
 *
 * Feedback is reached browser -> Shopify app proxy -> Fly, so `Fly-Client-IP`
 * is SHOPIFY's egress: keying on it put every shopper in one 3-per-hour
 * bucket. The route now reads the trusted hop for the app-proxy shape
 * (`getClientIp(request, 'shopify')`) — the XFF entry Shopify added, one to
 * the left of the entry Fly saw. These pin both halves: a forged leading entry
 * cannot split the bucket, and two real shoppers do not share one.
 */
import { describe, it, expect, vi } from 'vitest';

const sendFeedbackEmail = vi.fn(async () => true);

vi.mock('../shopify.server', () => ({
  authenticate: { public: { appProxy: vi.fn(async () => ({})) } },
}));
vi.mock('../lib/email.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendFeedbackEmail: (...a: unknown[]) => sendFeedbackEmail(...(a as [])),
}));
vi.mock('../lib/product-events.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordFeedbackSubmission: vi.fn(async () => {}),
}));

import { action } from './api.feedback';

let n = 0;
function submit(headers: Record<string, string>, body?: Record<string, unknown>) {
  return action({
    request: new Request('https://drstanfield.com/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? { email: `f${n++}@example.com`, message: 'hello' }),
    }),
    params: {},
  } as unknown as Parameters<typeof action>[0]);
}

/** Shopify's egress: fixed for every shopper, so it can never be the key. */
const SHOPIFY_EGRESS = '35.1.2.3';
const proxied = (shopper: string, forged: string) => ({
  'fly-client-ip': SHOPIFY_EGRESS,
  'x-forwarded-for': `${forged}, ${shopper}, ${SHOPIFY_EGRESS}`,
});

describe('api.feedback rate limit', () => {
  it('a rotating forged X-Forwarded-For entry does not bypass the limiter', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await submit(proxied('198.51.100.7', `6.6.6.${i}`));
      expect(res.status).toBe(200);
    }
    // Fourth attempt, a fresh forged leading hop — still the same shopper.
    const blocked = await submit(proxied('198.51.100.7', '6.6.6.200'));
    expect(blocked.status).toBe(429);
  });

  it('a different shopper behind the same Shopify egress is a different bucket', async () => {
    const res = await submit(proxied('198.51.100.8', '6.6.6.1'));
    expect(res.status).toBe(200);
  });
});

describe('api.feedback counts the request before it can fail', () => {
  it('a Resend outage does not buy an attacker unlimited inserts', async () => {
    // Resend down: the send throws, so the old ordering never reached the
    // counter and an attacker got unlimited inserts for the whole outage.
    sendFeedbackEmail.mockRejectedValue(new Error('resend unreachable'));
    try {
      for (let i = 0; i < 3; i++) {
        const res = await submit(proxied('198.51.100.9', '6.6.6.1'));
        expect(res.status).toBe(500);
      }
      // The failures still spent the budget.
      const blocked = await submit(proxied('198.51.100.9', '6.6.6.1'));
      expect(blocked.status).toBe(429);
    } finally {
      sendFeedbackEmail.mockReset();
      sendFeedbackEmail.mockResolvedValue(true);
    }
  });
});

describe('api.feedback honeypot', () => {
  it('a filled honeypot is rejected by the schema, not silently accepted', async () => {
    const res = await submit(proxied('198.51.100.10', '6.6.6.1'), {
      email: 'bot@example.com',
      message: 'spam',
      website: 'http://spam.example',
    });
    expect(res.status).toBe(400);
    expect(sendFeedbackEmail).not.toHaveBeenCalledWith(
      'bot@example.com',
      expect.anything(),
      expect.anything(),
    );
  });
});
