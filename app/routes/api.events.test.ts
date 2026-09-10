/**
 * The product-event route limited only on the body-supplied `visitorId`, so a
 * script that rotated it had no limit at all. The second limiter keys on the
 * shopper's IP — the one key the caller cannot choose (K5).
 */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../shopify.server', () => ({
  authenticate: { public: { appProxy: vi.fn(async () => ({})) } },
}));
vi.mock('../lib/product-events.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordProductEvent: vi.fn(async () => {}),
}));

import { action } from './api.events';

const SHOPIFY_EGRESS = '35.1.2.3';

function emit(shopper: string) {
  return action({
    request: new Request('https://drstanfield.com/api/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'fly-client-ip': SHOPIFY_EGRESS,
        'x-forwarded-for': `${shopper}, ${SHOPIFY_EGRESS}`,
      },
      body: JSON.stringify({ eventName: 'results_viewed', visitorId: crypto.randomUUID() }),
    }),
    params: {},
  } as unknown as Parameters<typeof action>[0]);
}

describe('api.events', () => {
  it('bounds a rotating visitorId per IP, and only that IP', async () => {
    const shopper = '198.51.100.40';
    for (let i = 0; i < 600; i++) {
      expect((await emit(shopper)).status).toBe(200);
    }
    expect((await emit(shopper)).status).toBe(429);
    expect((await emit('198.51.100.41')).status).toBe(200);
  });
});
