/**
 * US-09 AC24: the index never hands out a signed app-proxy query. The storefront
 * proxy root lands here carrying Shopify's fresh `signature`; copying the query
 * into a redirect gave any anonymous visitor a signed query to reuse. The
 * admin launch (hmac, host, shop, timestamp, no `signature`) still redirects.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shopify.server', () => ({ login: vi.fn() }));

import { loader } from './route';

async function load(query: string): Promise<Response> {
  try {
    await loader({ request: new Request(`https://health-tool-app.fly.dev/${query}`), params: {}, context: {} } as never);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
  throw new Error('loader returned without throwing');
}

describe('index loader', () => {
  it('a proxied request (it carries signature) gets a 404, never a redirect', async () => {
    const res = await load('?logged_in_customer_id=&path_prefix=%2Fapps%2Fhealth-tool-1&shop=x.myshopify.com&timestamp=1780000000&signature=' + 'a'.repeat(64));
    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('the admin launch still redirects to /app with its own params', async () => {
    const res = await load('?embedded=1&hmac=abc&host=aG9zdA&shop=x.myshopify.com&timestamp=1780000000');
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location.startsWith('/app?')).toBe(true);
    const params = new URLSearchParams(location.slice('/app?'.length));
    expect(Object.fromEntries(params)).toEqual({ embedded: '1', hmac: 'abc', host: 'aG9zdA', shop: 'x.myshopify.com', timestamp: '1780000000' });
  });
});
