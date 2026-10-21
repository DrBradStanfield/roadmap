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
const lib = vi.hoisted(() => ({
  getUserIdByCustomerId: vi.fn(), addMessageCredits: vi.fn(), logAudit: vi.fn(), recordUnprovenPaidOrder: vi.fn(), warn: vi.fn(),
}));
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
  for (const spy of [...logs, lib.warn, lib.logAudit, lib.recordUnprovenPaidOrder]) expect(JSON.stringify(spy.mock.calls)).not.toContain(CUSTOMER);
};

describe('orders/paid without a proven principal', () => {
  it('no profile yet: answers 500 for a retry, credits nothing, and never logs the customer id', async () => {
    lib.getUserIdByCustomerId.mockResolvedValue(null);
    expect((await post()).status).toBe(500);
    expect(lib.addMessageCredits).not.toHaveBeenCalled();
    nothingNamesTheCustomer();
  });
  it('an unproven link: stores the audit row before answering 200, credits nothing, and warns with order and profile ids', async () => {
    lib.getUserIdByCustomerId.mockResolvedValue({ userId: 'legacy', proven: false });
    lib.recordUnprovenPaidOrder.mockResolvedValue(true);
    expect((await post()).status).toBe(200);
    expect(lib.addMessageCredits).not.toHaveBeenCalled();
    expect(lib.recordUnprovenPaidOrder).toHaveBeenCalledWith('legacy', 'gid://shopify/Order/5');
    expect(lib.warn).toHaveBeenCalledTimes(1);
    expect(lib.warn.mock.calls[0][1]).toMatchObject({ extra: { orderId: 'gid://shopify/Order/5', profileId: 'legacy' } });
    nothingNamesTheCustomer();
  });
  it('an unproven link whose audit row cannot be stored: 500 so Shopify retries, no credit', async () => {
    lib.getUserIdByCustomerId.mockResolvedValue({ userId: 'legacy', proven: false });
    lib.recordUnprovenPaidOrder.mockResolvedValue(false);
    expect((await post()).status).toBe(500);
    expect(lib.addMessageCredits).not.toHaveBeenCalled();
    nothingNamesTheCustomer();
  });
  it('a proven link is credited', async () => {
    lib.getUserIdByCustomerId.mockResolvedValue({ userId: 'own', proven: true });
    lib.addMessageCredits.mockResolvedValue(50);
    expect((await post()).status).toBe(200);
    expect(lib.addMessageCredits).toHaveBeenCalledWith('own', 50, 'gid://shopify/Order/5');
  });
});
