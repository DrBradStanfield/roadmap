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
  it('runs in Auckland, ahead of UTC', () => {
    expect(new Date('2026-06-15T12:00:00Z').getDate()).toBe(16);
  });

  it('re-sends a screening 90 UTC days after the last send, not a day early', () => {
    expect(dueItemsFor(optin, '2026-11-29').due).toEqual([]);
    expect(dueItemsFor(optin, '2026-11-30').due).toEqual(optin.schedule);
  });

  it('US-17 AC15: a follow-up to organize, due at its past screening month, goes on the next run, then waits out the 90 days', () => {
    const followup = { ...optin, schedule: [{ ...optin.schedule[0], dueAt: '2026-09-01' }], last_sent: {} };
    expect(dueItemsFor(followup, '2026-11-05').due).toHaveLength(1);
    const sent = { ...followup, last_sent: { screening_colorectal: '2026-11-05' } };
    expect(dueItemsFor(sent, '2027-02-02').due).toEqual([]);
    expect(dueItemsFor(sent, '2027-02-03').due).toHaveLength(1);
  });

  it('US-17 AC15: the cooldown is per category, so a routine send within 90 days holds the follow-up until it ends', () => {
    // A routine colonoscopy reminder went on 1 October; the abnormal result recorded since waits for 30 December.
    const followup = { ...optin, schedule: [{ ...optin.schedule[0], dueAt: '2026-09-01' }], last_sent: { screening_colorectal: '2026-10-01' } };
    expect(dueItemsFor(followup, '2026-11-05').due).toEqual([]);
    expect(dueItemsFor(followup, '2026-12-29').due).toEqual([]);
    expect(dueItemsFor(followup, '2026-12-30').due).toHaveLength(1);
  });
});
