/**
 * A Shopify admin session proves a merchant, not Brad — the app is AppStore
 * distributed. ADMIN_SHOP_DOMAIN narrows it to one shop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const adminAuth = vi.fn(async () => ({ session: { shop: 'drstanfield.myshopify.com' } }));
vi.mock('../shopify.server', () => ({ authenticate: { admin: (r: Request) => adminAuth(r) } }));

const { authenticateOwnerAdmin } = await import('./admin-shop.server');

const request = () => new Request('https://health-tool-app.fly.dev/app/trending-test');

beforeEach(() => {
  vi.clearAllMocks();
  adminAuth.mockResolvedValue({ session: { shop: 'drstanfield.myshopify.com' } });
  delete process.env.ADMIN_SHOP_DOMAIN;
});
afterEach(() => { delete process.env.ADMIN_SHOP_DOMAIN; });

describe('authenticateOwnerAdmin', () => {
  it('allows any authenticated admin while the variable is unset', async () => {
    adminAuth.mockResolvedValue({ session: { shop: 'someone-else.myshopify.com' } });
    await expect(authenticateOwnerAdmin(request())).resolves.toBeUndefined();
  });

  it('allows the named shop', async () => {
    process.env.ADMIN_SHOP_DOMAIN = 'drstanfield.myshopify.com';
    await expect(authenticateOwnerAdmin(request())).resolves.toBeUndefined();
  });

  it('403s any other shop', async () => {
    process.env.ADMIN_SHOP_DOMAIN = 'drstanfield.myshopify.com';
    adminAuth.mockResolvedValue({ session: { shop: 'attacker.myshopify.com' } });
    const thrown = await authenticateOwnerAdmin(request()).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
  });

  it('still requires a Shopify admin session first', async () => {
    adminAuth.mockRejectedValue(new Response('', { status: 302 }));
    await expect(authenticateOwnerAdmin(request())).rejects.toBeInstanceOf(Response);
  });
});
