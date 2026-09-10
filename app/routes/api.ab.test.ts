/**
 * Two holes in the A/B event route, pinned (K5).
 *
 * 1. The only rate-limit key was `visitorId`, which the caller sends in the
 *    body: rotating it bought an unlimited write. The IP is the key the caller
 *    cannot choose, so a second, generous limiter keys on it.
 * 2. `test_id` is held by a live foreign key; `variant_id` was held by nothing,
 *    so an invented variant would land in `ab_events` and skew a result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

const recordABEvent = vi.fn(async () => true);
const TEST_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('../shopify.server', () => ({
  authenticate: { public: { appProxy: vi.fn(async () => ({})) } },
}));
vi.mock('../lib/supabase.server', () => ({
  recordABEvent: (...a: unknown[]) => recordABEvent(...(a as [])),
  getActiveABTests: vi.fn(async () => [
    { id: TEST_ID, name: 't', status: 'active', target: 'heading', variants: [{ id: 'a', value: 'A', weight: 50 }], created_at: '', updated_at: '' },
  ]),
}));

import { action } from './api.ab';

const SHOPIFY_EGRESS = '35.1.2.3';
const proxied = (shopper: string) => ({
  'fly-client-ip': SHOPIFY_EGRESS,
  'x-forwarded-for': `${shopper}, ${SHOPIFY_EGRESS}`,
});

function impression(shopper: string, overrides: Record<string, unknown> = {}) {
  return action({
    request: new Request('https://drstanfield.com/api/ab', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...proxied(shopper) },
      body: JSON.stringify({
        impression: { testId: TEST_ID, variantId: 'a', visitorId: crypto.randomUUID(), ...overrides },
      }),
    }),
    params: {},
  } as unknown as Parameters<typeof action>[0]);
}

beforeEach(() => recordABEvent.mockClear());

describe('api.ab', () => {
  it('bounds a rotating visitorId per IP', async () => {
    const shopper = '198.51.100.20';
    for (let i = 0; i < 600; i++) {
      expect((await impression(shopper)).status).toBe(200);
    }
    expect((await impression(shopper)).status).toBe(429);
    // A different shopper behind the same Shopify egress is untouched.
    expect((await impression('198.51.100.21')).status).toBe(200);
  });

  it('refuses a variant the test does not have', async () => {
    const res = await impression('198.51.100.30', { variantId: 'zz' });
    expect(res.status).toBe(400);
    expect(recordABEvent).not.toHaveBeenCalled();
  });

  it('refuses a test id that is not running', async () => {
    const res = await impression('198.51.100.31', { testId: '22222222-2222-4222-8222-222222222222' });
    expect(res.status).toBe(400);
    expect(recordABEvent).not.toHaveBeenCalled();
  });

  it('records a valid variant', async () => {
    const res = await impression('198.51.100.32');
    expect(res.status).toBe(200);
    expect(recordABEvent).toHaveBeenCalledTimes(1);
  });
});
