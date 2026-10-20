/**
 * US-23 AC6b — the cron's re-send cooldown counts UTC days, so it gives the
 * same answer whatever zone the machine runs in (Fly runs in UTC; a laptop
 * running the cron or this suite need not). Pinned to Pacific/Auckland, whose
 * daylight saving starts inside a 90-day cooldown from 1 September; a local
 * `setDate` there lands an hour short, on the previous UTC day.
 */
process.env.TZ = 'Pacific/Auckland';

import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase.server', () => ({ tryAcquireCronLock: vi.fn() }));
vi.mock('./email.server', () => ({ buildReminderV2EmailHtml: vi.fn(), sendReminderEmail: vi.fn() }));
vi.mock('./reminder-v2.server', () => ({
  buildUnsubscribeUrl: vi.fn(), getOptinsBatch: vi.fn(), inQuietPeriod: vi.fn(),
  purgeTombstones: vi.fn(), recordSent: vi.fn(),
}));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn() }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn() }));

import { dueItemsFor } from './reminder-v2-cron.server';
import type { ReminderV2Optin } from './reminder-v2.server';

const optin: ReminderV2Optin = {
  id: 'o1', email: 'synthetic@example.com', provider: 'typed', token: 't', created_at: '2026-01-01T00:00:00Z',
  schedule: [{ category: 'screening_colorectal', label: 'Colonoscopy', dueAt: '2026-08-01' }],
  last_sent: { screening_colorectal: '2026-09-01' },
};

describe('the cron cooldown counts UTC days (US-23 AC6b)', () => {
  it('re-sends a screening 90 UTC days after the last send, not a day early', () => {
    expect(dueItemsFor(optin, '2026-11-29').due).toEqual([]);
    expect(dueItemsFor(optin, '2026-11-30').due).toEqual(optin.schedule);
  });
});
