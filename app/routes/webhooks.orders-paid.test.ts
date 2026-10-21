import { beforeEach, describe, expect, it, vi } from 'vitest';

// US-09 AC27: orders/paid credits only a proven principal and never logs the customer.
const CUSTOMER = '987654321';
vi.mock('../lib/message-packs', () => ({ VARIANT_CREDIT_MAP: { '111': 50 } }));
vi.mock('../shopify.server', () => ({
  authenticate: { webhook: vi.fn(async () => ({
    topic: 'ORDERS_PAID', shop: 's',
    payload: { id: 5, customer: { id: Number(CUSTOMER) }, line_items: [{ variant_id: 111, quantity: 1 }] },
  })) },
}));
const lib = vi.hoisted(() => ({ getUserIdByCustomerId: vi.fn(), addMessageCredits: vi.fn(), logAudit: vi.fn(), warn: vi.fn() }));
vi.mock('../lib/supabase.server', () => lib);
vi.mock('@sentry/react-router', () => ({ captureMessage: lib.warn, captureException: vi.fn() }));

import { action } from './webhooks.orders-paid';

const post = () => action({ request: new Request('https://x/webhooks/orders/paid', { method: 'POST', body: '{}' }) } as any);
let logs: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  vi.clearAllMocks();
  logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
});
const nothingNamesTheCustomer = () => {
  for (const spy of [...logs, lib.warn, lib.logAudit]) expect(JSON.stringify(spy.mock.calls)).not.toContain(CUSTOMER);
};

describe('orders/paid without a proven principal', () => {
  it('no profile yet: answers 500 for a retry, credits nothing, and never logs the customer id', async () => {
    lib.getUserIdByCustomerId.mockResolvedValue(null);
    expect((await post()).status).toBe(500);
    expect(lib.addMessageCredits).not.toHaveBeenCalled();
    nothingNamesTheCustomer();
  });
  it('an unproven link: answers 200, credits nothing, and leaves a value-free audit row and a warning to credit by hand', async () => {
    lib.getUserIdByCustomerId.mockResolvedValue({ userId: 'legacy', proven: false });
    expect((await post()).status).toBe(200);
    expect(lib.addMessageCredits).not.toHaveBeenCalled();
    expect(lib.logAudit).toHaveBeenCalledWith('legacy', 'PAID_ORDER_UNPROVEN_LINK', 'chat', 'gid://shopify/Order/5');
    expect(lib.warn).toHaveBeenCalledTimes(1);
    nothingNamesTheCustomer();
  });
  it('a proven link is credited', async () => {
    lib.getUserIdByCustomerId.mockResolvedValue({ userId: 'own', proven: true });
    lib.addMessageCredits.mockResolvedValue(50);
    expect((await post()).status).toBe(200);
    expect(lib.addMessageCredits).toHaveBeenCalledWith('own', 50, 'gid://shopify/Order/5');
  });
});
