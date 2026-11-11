/**
 * US-17 AC14: a reminder counts as sent only when Resend accepts it with an id.
 *
 * The Resend SDK reports every failure in `error`; on a 2xx it hands back the
 * parsed body as `data` unchecked. `sendEmail` already throws when there is no
 * error and no id ("unexpected SDK response shape"). The reminder and feedback
 * wrappers read only `error`, so that same answer read as a delivered email,
 * and the cron then counted a `reminder_sent` and armed the 90/180/365-day
 * cooldown for mail that may never have gone out.
 *
 * These tests drive the real email.server functions and the real reminder
 * cron against a stubbed Resend client. All values are synthetic.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

const send = vi.fn();
vi.mock('resend', () => ({ Resend: class { emails = { send }; } }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn(async () => {}) }));
vi.mock('./supabase.server', () => ({
  supabaseAdmin: null,
  tryAcquireCronLock: vi.fn(async () => true),
  endCronLock: vi.fn(),
  hashClientIp: () => 'synthetic-ip',
}));
// The day-stamp (US-23 AC15) held in memory with the real rule: a stamp on
// today or later skips the row. It outlives a module reload, as the column does.
const stamps = vi.hoisted(() => new Map<string, string>());
vi.mock('./reminder-v2-day-stamp.server', () => ({
  stampReminderDay: vi.fn(async (id: string, today: string) => {
    const at = stamps.get(id);
    if (at !== undefined && at >= today) return 'attempted-today';
    stamps.set(id, today);
    return 'stamped';
  }),
}));
vi.mock('./reminder-v2.server', () => ({
  buildUnsubscribeUrl: () => 'https://example.test/reminders-v2/unsubscribe?token=synthetic',
  getOptinsBatch: vi.fn(async () => []),
  inQuietPeriod: () => false,
  purgeTombstones: async () => 0,
  recordSent: vi.fn(async () => {}),
}));

process.env.RESEND_API_KEY = 'synthetic-not-a-real-key';
const { sendEmail, sendReminderEmail, sendFeedbackEmail } = await import('./email.server');
const { processV2Reminders } = await import('./reminder-v2-cron.server');
const { getOptinsBatch, recordSent } = await import('./reminder-v2.server');
const { recordServerEvent } = await import('./product-events.server');
const Sentry = await import('@sentry/react-router');

const ACCEPTED = { data: { id: 're_synthetic_1' }, error: null, headers: null };
/** A 2xx whose body has no id: no error, nothing to show it was accepted. */
const NO_ID_BODY = { data: {}, error: null, headers: null };
const NO_DATA = { data: null, error: null, headers: null };

const optin = (id: string) => ({
  id,
  email: 'synthetic.reader@example.test',
  provider: 'typed',
  schedule: [{ category: 'blood_test_lipids', label: 'Lipid panel blood test', dueAt: '2026-01-01' }],
  last_sent: {},
  token: 'synthetic-token',
  created_at: '2025-06-01T00:00:00.000Z',
});

const sentryFeatures = () =>
  vi.mocked(Sentry.captureException).mock.calls.map((c) => (c[1] as { tags?: { feature?: string } })?.tags?.feature);

beforeEach(() => {
  vi.clearAllMocks();
  stamps.clear();
  send.mockResolvedValue(ACCEPTED);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('US-17 AC14: a send with no error and no id is not a sent reminder', () => {
  it('control: an accepted send (with an id) is a success for all three senders', async () => {
    await expect(sendReminderEmail('synthetic.reader@example.test', '<p>due</p>', 'https://u', 'S')).resolves.toBe(true);
    await expect(sendFeedbackEmail('synthetic.reader@example.test', 'nice tool', null)).resolves.toBe(true);
    await expect(sendEmail('synthetic.reader@example.test', 'subject', '<p>x</p>')).resolves.toEqual({ id: 're_synthetic_1' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it.each([['a 2xx body with no id', NO_ID_BODY], ['no data at all', NO_DATA]])(
    'sendReminderEmail returns false and reports to Sentry on %s',
    async (_label, result) => {
      send.mockResolvedValue(result);
      await expect(sendReminderEmail('synthetic.reader@example.test', '<p>due</p>', 'https://u', 'S')).resolves.toBe(false);
      expect(sentryFeatures()).toEqual(['reminder_email']);
      const reported = vi.mocked(Sentry.captureException).mock.calls[0][0] as Error;
      expect(reported.message).toMatch(/no error and no id/);
    },
  );

  it('US-19: sendFeedbackEmail returns false and reports to Sentry on the same answer', async () => {
    send.mockResolvedValue(NO_ID_BODY);
    await expect(sendFeedbackEmail('synthetic.reader@example.test', 'nice tool', null)).resolves.toBe(false);
    expect(sentryFeatures()).toEqual(['feedback_email']);
  });

  it('sendEmail still throws on the same answer', async () => {
    send.mockResolvedValue(NO_ID_BODY);
    await expect(sendEmail('synthetic.reader@example.test', 'subject', '<p>x</p>')).rejects.toThrow(/no error and no id/);
  });

  it('the cron counts no reminder_sent and arms no cooldown for it, and sends again the next day', async () => {
    const row = optin('optin-no-id');
    vi.mocked(getOptinsBatch).mockResolvedValue([row] as never);
    send.mockResolvedValue(NO_ID_BODY);

    expect(await processV2Reminders('2026-10-23')).toBe(0);
    expect(recordSent).not.toHaveBeenCalled();
    expect(recordServerEvent).not.toHaveBeenCalledWith('reminder_sent', expect.anything());

    // Nothing was stamped, so the next day's pass is due again and, once
    // Resend accepts it, records it as usual.
    send.mockResolvedValue(ACCEPTED);
    expect(await processV2Reminders('2026-10-24')).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(recordSent).toHaveBeenCalledWith('optin-no-id', { blood_test_lipids: '2026-10-24' });
  });

  it('control: the cron records an accepted send', async () => {
    vi.mocked(getOptinsBatch).mockResolvedValue([optin('optin-accepted')] as never);
    expect(await processV2Reminders('2026-10-25')).toBe(1);
    expect(recordSent).toHaveBeenCalledWith('optin-accepted', { blood_test_lipids: '2026-10-25' });
    expect(recordServerEvent).toHaveBeenCalledWith('reminder_sent', { provider: 'typed', count: 1 });
  });
});
