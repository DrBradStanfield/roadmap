/**
 * US-23 AC10 — the unsubscribe page every reminder and plan-ready email links
 * to makes no storage claim that is false for a lane. It said "it lives only
 * in your own cloud storage", false for a guest who kept the plan in one
 * browser (the typed lane, 169 of 183 rows on 2026-09-24), after the emails
 * themselves had stopped saying it (adversarial review of 950844e).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/reminder-v2.server', () => ({ unsubscribeByToken: vi.fn() }));
vi.mock('../lib/product-events.server', () => ({ recordServerEvent: vi.fn() }));

import { loader } from './reminders-v2.unsubscribe';

const confirmPage = async () => {
  const request = new Request('https://health-tool-edu.fly.dev/reminders-v2/unsubscribe?token=abc');
  const response = await loader({ request, params: {}, context: {} } as Parameters<typeof loader>[0]);
  return response.text();
};

describe('reminders-v2 unsubscribe confirm page (US-23 AC10)', () => {
  it('says the health data is unaffected, with no storage claim and no em dash', async () => {
    const html = await confirmPage();
    expect(html).toContain('Your health data is unaffected.');
    expect(html).not.toContain('cloud storage');
    expect(html).not.toMatch(/—/);
  });
});
