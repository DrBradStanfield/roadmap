/**
 * US-09 AC12 (GHSA-8wm5-f7ch-c868): the `/app` dashboard shows the
 * owner store's business stats and the live A/B test's name and results, the
 * same headline data `/app/ab-testing` gates on ADMIN_SHOP_DOMAIN. Another
 * installing shop's admin must get the same 403 here. Dummy shops only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), stats: vi.fn() }));
vi.mock('../shopify.server', () => ({ authenticate: { admin: mocks.auth } }));
vi.mock('../lib/supabase.server', () => ({ getDashboardStats: mocks.stats }));
import { loader } from './app._index';

const OWNER = 'dummy-owner.myshopify.com';
const OTHER = 'dummy-other.myshopify.com';
const load = () => loader({ request: new Request('https://example.invalid/app') } as never);
let saved: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  saved = process.env.ADMIN_SHOP_DOMAIN;
  process.env.ADMIN_SHOP_DOMAIN = OWNER;
  mocks.stats.mockResolvedValue({ activeTest: { name: 'dummy experiment' } });
  mocks.auth.mockResolvedValue({ session: { shop: OTHER } });
});
afterEach(() => { process.env.ADMIN_SHOP_DOMAIN = saved; });

describe('US-09 AC12: the /app dashboard is owner-gated like /app/ab-testing', () => {
  it('refuses an other-shop admin with 403 before it reads the stats', async () => {
    const thrown = await load().catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
    expect(mocks.stats).not.toHaveBeenCalled();
  });

  it('control: the named owner still sees the stats', async () => {
    mocks.auth.mockResolvedValue({ session: { shop: OWNER } });
    const loaded: any = await load();
    expect(loaded.data.stats.activeTest.name).toBe('dummy experiment');
  });

  it('control: unset ADMIN_SHOP_DOMAIN leaves the gate open, as AC12 states', async () => {
    delete process.env.ADMIN_SHOP_DOMAIN;
    const loaded: any = await load();
    expect(loaded.data.stats.activeTest.name).toBe('dummy experiment');
  });

  it('control: a Shopify authentication failure still answers 401', async () => {
    mocks.auth.mockRejectedValueOnce(new Response('unauthenticated', { status: 401 }));
    const thrown = await load().catch((e) => e);
    expect((thrown as Response).status).toBe(401);
    expect(mocks.stats).not.toHaveBeenCalled();
  });
});
