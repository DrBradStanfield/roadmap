// US-09 AC25a: an authenticated app/scopes_update whose payload has no
// `current` array is acknowledged with 200 and leaves the stored scope alone.
//
// The route cast `payload.current as string[]` and called `current.toString()`.
// The library types the payload as `Record<string, any>` (no per-topic shape
// for app/scopes_update exists in @shopify), so nothing checked it: a missing
// or null `current` threw before storeSession whenever a session was stored,
// the handler never answered 200 and Shopify retried a delivery that can only
// fail the same way; an object was stored as the scope "[object Object]".
// A string or a number (not in Shopify's docs) was stored as-is; it is now
// refused like any other non-array.
// `authenticate.webhook` resolving stands for a delivery whose HMAC checked
// out. All values are synthetic.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shopify = vi.hoisted(() => ({
  authenticate: { webhook: vi.fn() },
  sessionStorage: { storeSession: vi.fn(async () => true) },
}));
vi.mock('../shopify.server', () => shopify);
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import * as Sentry from '@sentry/react-router';
import { action } from './webhooks.app.scopes_update';

const post = () =>
  action({ request: new Request('https://example.test/webhooks/app/scopes_update', { method: 'POST', body: '{}' }) } as never);

const session = () => ({ id: 'offline_synthetic-shop.myshopify.com', shop: 'synthetic-shop.myshopify.com', scope: 'read_old' });

const deliver = (payload: unknown, s: unknown) =>
  shopify.authenticate.webhook.mockResolvedValue({
    topic: 'APP_SCOPES_UPDATE', shop: 'synthetic-shop.myshopify.com', session: s, payload,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('US-09 AC25a: scopes_update without a `current` array', () => {
  it.each([
    ['no `current`', { id: 1, previous: ['read_old'] }],
    ['`current: null`', { id: 1, previous: ['read_old'], current: null }],
    ['`current` an object', { id: 1, previous: ['read_old'], current: { scopes: 'read_a' } }],
    ['`current` a string', { id: 1, previous: ['read_old'], current: 'read_a' }],
    ['`current` a number', { id: 1, previous: ['read_old'], current: 5 }],
  ])('%s: answers 200 and keeps the stored scope', async (_label, payload) => {
    const s = session();
    deliver(payload, s);
    const res = await post();
    expect(res.status).toBe(200);
    expect(shopify.sessionStorage.storeSession).not.toHaveBeenCalled();
    expect(s.scope).toBe('read_old');
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.captureMessage).mock.calls[0][1]).toMatchObject({ level: 'warning', tags: { feature: 'shopify_scopes_update' } });
  });

  it('control: a `current` array is stored as the scope string, as before', async () => {
    const s = session();
    deliver({ id: 1, previous: ['read_old'], current: ['read_a', 'write_b'] }, s);
    const res = await post();
    expect(res.status).toBe(200);
    expect(shopify.sessionStorage.storeSession).toHaveBeenCalledTimes(1);
    expect(shopify.sessionStorage.storeSession).toHaveBeenCalledWith(s);
    expect(s.scope).toBe('read_a,write_b');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('control: an empty `current` array is stored as an empty scope, as before', async () => {
    const s = session();
    deliver({ id: 1, previous: ['read_old'], current: [] }, s);
    expect((await post()).status).toBe(200);
    expect(shopify.sessionStorage.storeSession).toHaveBeenCalledWith(s);
    expect(s.scope).toBe('');
  });

  it('control: no stored session (the shop is gone) answers 200 and stores nothing', async () => {
    deliver({ id: 1, previous: ['read_old'], current: ['read_a'] }, null);
    expect((await post()).status).toBe(200);
    expect(shopify.sessionStorage.storeSession).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
