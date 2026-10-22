import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 'synthetic-not-a-real-key';
  const rows: Array<Record<string, unknown>> = [];
  const sent: Array<{ html: string }> = [];
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    insert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; },
  };
  return { rows, sent, db: { from: () => chain } };
});
vi.mock('resend', () => ({ Resend: class {
  emails = { send: async (payload: { html: string }) => {
    fixture.sent.push(payload);
    return { data: { id: 'synthetic-message' }, error: null };
  } };
} }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: fixture.db, hashClientIp: () => 'synthetic-ip' }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn(async () => {}) }));
vi.mock('./klaviyo.server', () => ({ subscribeToKlaviyo: vi.fn(async () => {}) }));
import { buildPlanReadyEmailHtml } from './email.server';
import { action } from '../routes/api.reminders-v2';

beforeEach(() => { fixture.rows.length = 0; fixture.sent.length = 0; });

describe('US-22 AC12a / US-23 AC6: every enrolled confirmation has its cancel link', () => {
  it('keeps unsubscribe in the actual empty-schedule opt-in confirmation', async () => {
    const request = new Request('https://health-tool-app.fly.dev/api/reminders-v2', {
      method: 'POST', headers: { Origin: 'https://drstanfield.com', 'fly-client-ip': '192.0.2.1' },
      body: JSON.stringify({ op: 'optin', provider: 'typed', email: 'synthetic@example.test', schedule: [] }),
    });
    const response = await action({ request } as Parameters<typeof action>[0]);
    expect(response.status).toBe(200);
    expect(fixture.rows).toHaveLength(1);
    expect(fixture.rows[0].schedule).toEqual([expect.objectContaining({ category: 'annual_checkin' })]);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0].html).toContain('/reminders-v2/unsubscribe?');
  });

  it.each(['cloud', 'guest'] as const)('keeps an explicitly supplied link without a schedule for %s', (lane) => {
    const url = 'https://example.test/reminders-v2/unsubscribe?token=synthetic';
    expect(buildPlanReadyEmailHtml(lane, { unsubscribeUrl: url })).toContain(url);
  });

  it('does not invent a cancel link when none was supplied', () => {
    expect(buildPlanReadyEmailHtml('cloud', { schedule: [] })).not.toContain('Unsubscribe from reminders');
  });
});
