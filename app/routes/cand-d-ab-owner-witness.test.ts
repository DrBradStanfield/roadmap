/**
 * Intended-safe witness for the CONFIRMED lead `app/ab-testing owner-shop
 * gate` (US-09 AC12; route inventory per US-09 AC24).
 *
 * `/app/ab-testing` lists the owner's shared experiments, pauses and
 * completes them, and writes the calling shop's `ab_config` metafield — a
 * route that changes something. US-09 AC12 gates such routes on
 * ADMIN_SHOP_DOMAIN: "when it is set, a shop that is not the named one
 * cannot reach them at all." US-09 AC24's wrapper (`authenticateAdmin`)
 * proves a merchant, not THIS merchant, and the route never called the owner
 * gate. Intended-safe, mirroring the repo's own owner-gate pattern
 * (`authenticateOwnerAdmin`, the app.trending-test.tsx 403 semantics):
 * an other-shop admin is refused by the loader before it lists and by the
 * action before any mutation; the named owner still passes; a Shopify
 * authentication failure (401) still is respected.
 *
 * Dummy data only, no real providers: every shop name, test id and mutation
 * below is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), update: vi.fn(), list: vi.fn() }));
vi.mock('../shopify.server', () => ({ authenticate: { admin: mocks.auth } }));
vi.mock('../lib/supabase.server', () => ({
  getABTests: mocks.list, getActiveABTests: vi.fn(async () => []),
  getABTestById: vi.fn(), createABTest: vi.fn(), updateABTestStatus: mocks.update,
  getABTestResults: vi.fn(async () => null)
}));
import { action, loader } from './app.ab-testing';
import { authenticateOwnerAdmin } from '../lib/admin-shop.server';

const OWNER = 'dummy-owner.myshopify.com';
const OTHER = 'dummy-other.myshopify.com';
const req = () => new Request('https://example.invalid/app/ab-testing', { method: 'POST', body: new URLSearchParams({ intent: 'pause', testId: 'dummy-shared-test' }) });
const adminOf = () => ({ graphql: async (query: string) => ({ json: async () => query.startsWith('query') ? { data: { shop: { id: 'gid://shopify/Shop/2' } } } : { data: { metafieldsDelete: { userErrors: [] } } } }) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_SHOP_DOMAIN = OWNER;
  mocks.list.mockResolvedValue([{ id: 'dummy-shared-test', name: 'dummy experiment', status: 'draft' }]);
  mocks.update.mockResolvedValue(null);
  // The default caller: an authenticated admin of ANOTHER installing shop.
  mocks.auth.mockResolvedValue({ session: { shop: OTHER }, admin: adminOf() });
});

describe('US-09 AC12: /app/ab-testing is owner-gated like the routes that change something', () => {
  it('control: the owner helper itself still refuses the other shop', async () => {
    const thrown = await authenticateOwnerAdmin(req()).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
  });

  it('the loader refuses an other-shop admin before it lists the shared experiments', async () => {
    const thrown = await loader({ request: new Request('https://example.invalid/app/ab-testing') } as never).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('the action refuses an other-shop admin before any shared mutation', async () => {
    const thrown = await action({ request: req() } as never).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('control: the named owner still lists and pauses the shared experiment', async () => {
    mocks.auth.mockResolvedValue({ session: { shop: OWNER }, admin: adminOf() });
    const loaded: any = await loader({ request: new Request('https://example.invalid/app/ab-testing') } as never);
    expect(loaded.data.tests[0].id).toBe('dummy-shared-test');
    const result: any = await action({ request: req() } as never);
    expect(mocks.update).toHaveBeenCalledWith('dummy-shared-test', 'paused');
    expect(result.data.success).toBe(true);
  });

  it('control: a Shopify authentication failure still refuses before any mutation', async () => {
    mocks.auth.mockRejectedValueOnce(new Response('unauthenticated', { status: 401 }));
    const thrown = await action({ request: req() } as never).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
