import { describe, expect, it, vi } from 'vitest';

// US-09 AC27: an orders/paid for a customer with no proven principal is retried
// (500) and logs nothing that names the customer.
const CUSTOMER = '987654321';
vi.mock('../lib/message-packs', () => ({ VARIANT_CREDIT_MAP: { '111': 50 } }));
vi.mock('../shopify.server', () => ({
  authenticate: { webhook: vi.fn(async () => ({
    topic: 'ORDERS_PAID', shop: 's',
    payload: { id: 5, customer: { id: Number(CUSTOMER) }, line_items: [{ variant_id: 111, quantity: 1 }] },
  })) },
}));
const lib = vi.hoisted(() => ({ getUserIdByCustomerId: vi.fn(async () => null), addMessageCredits: vi.fn(), logAudit: vi.fn() }));
vi.mock('../lib/supabase.server', () => lib);

import { action } from './webhooks.orders-paid';

describe('orders/paid without a proven principal', () => {
  it('answers 500 for a retry, credits nothing, and never logs the customer id', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const res = await action({ request: new Request('https://x/webhooks/orders/paid', { method: 'POST', body: '{}' }) } as any);
    expect(res.status).toBe(500);
    expect(lib.addMessageCredits).not.toHaveBeenCalled();
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(CUSTOMER);
  });
});
