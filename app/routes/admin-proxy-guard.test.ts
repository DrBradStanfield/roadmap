/**
 * US-09 AC24 (adversary R1): the app proxy maps the whole app root, so a
 * proxied request can reach the admin routes. `authenticate.admin`'s bounce
 * page copies the whole query, `signature` included, into its Location header
 * (@shopify/shopify-app-react-router 1.2.0, redirect-to-bounce-page.js). Every
 * admin route refuses a request carrying `signature` before that runs. The
 * admin launch signs with `hmac` and never carries `signature`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  // Stand-in for the bounce: echo the query into a redirect, as the library does.
  admin: vi.fn(async (request: Request) => {
    throw new Response(null, { status: 302, headers: { Location: `/auth/session-token${new URL(request.url).search}` } });
  }),
}));
vi.mock('../shopify.server', () => ({ authenticate: { admin: mocks.admin } }));
vi.mock('../lib/supabase.server', () => ({ getDashboardStats: vi.fn(async () => ({})) }));

import { loader as appLoader } from './app';
import { loader as appIndexLoader } from './app._index';
import { loader as authLoader } from './auth.$';

const SIGNED = '?logged_in_customer_id=&path_prefix=%2Fapps%2Fhealth-tool-1&shop=x.myshopify.com&timestamp=1780000000&signature=' + 'a'.repeat(64);
const ADMIN = '?embedded=1&hmac=abc&host=aG9zdA&shop=x.myshopify.com&timestamp=1780000000';

async function load(loader: (args: never) => unknown, path: string): Promise<Response> {
  try {
    await loader({ request: new Request(`https://health-tool-app.fly.dev${path}`), params: {}, context: {} } as never);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
  throw new Error('loader returned without throwing');
}

beforeEach(() => { mocks.admin.mockClear(); });

describe.each([
  ['/app', appLoader],
  ['/app (index)', appIndexLoader],
  ['/auth/x', authLoader],
] as const)('%s', (name, loader) => {
  const path = name.startsWith('/auth') ? '/auth/x' : '/app';

  it('a signed proxy request gets a 404 with no Location, before authenticate.admin', async () => {
    const res = await load(loader as never, `${path}${SIGNED}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('the admin hmac launch still reaches authenticate.admin', async () => {
    const res = await load(loader as never, `${path}${ADMIN}`);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
  });
});
