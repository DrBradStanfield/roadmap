import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// US-28 AC2 at the caller: a lock-acquire REJECTION leaves the day unmarked
// so the machine retries on the next hourly tick; a `false` (lost the race /
// permanent misconfig) still ends its day. reminder_v2_cron is the caller
// whose acquire sat OUTSIDE its try/catch — the one Sentry showed skipping
// (JAVASCRIPT-REMIX-68, 2026-08-28 08:11Z).

vi.mock('./supabase.server', () => ({ tryAcquireCronLock: vi.fn() }));
vi.mock('./email.server', () => ({
  buildReminderV2EmailHtml: vi.fn(() => '<html></html>'),
  sendReminderEmail: vi.fn(),
}));
vi.mock('./reminder-v2.server', () => ({
  buildUnsubscribeUrl: vi.fn(() => 'https://example.com/unsub'),
  getOptinsBatch: vi.fn(async () => []),
  inTypedQuietPeriod: vi.fn(() => false),
  recordSent: vi.fn(),
}));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn() }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn() }));

const HOUR_MS = 60 * 60 * 1000;

// vi.resetModules gives the cron a fresh module graph (fresh lastRunDate);
// mock instances PERSIST across resets, so import them from the graph and
// reset their state here rather than trusting top-level imports.
async function loadCron() {
  vi.resetModules();
  // Import under NODE_ENV=test so the module's import-time self-start is a
  // no-op, THEN pose as production so the explicit start in the test runs.
  const cron = await import('./reminder-v2-cron.server');
  vi.stubEnv('NODE_ENV', 'production');
  const { tryAcquireCronLock } = await import('./supabase.server');
  const { getOptinsBatch } = await import('./reminder-v2.server');
  const lockMock = vi.mocked(tryAcquireCronLock);
  const optinsMock = vi.mocked(getOptinsBatch);
  lockMock.mockReset();
  optinsMock.mockClear();
  return { cron, lockMock, optinsMock };
}

// US-17 (usage signal): a reminder SEND was invisible — the first genuine send
// (2026-08-28) was evidenced only by its last_sent stamp. Every successful send
// now records a `reminder_sent` server event (anonymous counter: provider +
// due-item count, never labels or addresses); a failed send records nothing.
describe('reminder v2 send observability — US-17: reminder_sent event', () => {
  const optinRow = {
    id: 'row-1',
    email: 'user@example.com',
    provider: 'typed' as const,
    schedule: [
      { category: 'blood_test_lipids', label: 'Lipid panel', dueAt: '2026-08-01' },
      { category: 'screening_colorectal', label: 'Colonoscopy', dueAt: '2027-05-01' },
    ],
    last_sent: {},
    token: 'tok',
    created_at: '2026-08-20T00:00:00Z',
  };

  async function loadForSend() {
    vi.resetModules();
    const cron = await import('./reminder-v2-cron.server');
    const { getOptinsBatch } = await import('./reminder-v2.server');
    const { sendReminderEmail } = await import('./email.server');
    const { recordServerEvent } = await import('./product-events.server');
    const optinsMock = vi.mocked(getOptinsBatch);
    const sendMock = vi.mocked(sendReminderEmail);
    const eventMock = vi.mocked(recordServerEvent);
    optinsMock.mockClear();
    optinsMock.mockResolvedValueOnce([optinRow]);
    sendMock.mockReset();
    eventMock.mockReset();
    return { cron, sendMock, eventMock };
  }

  it('records one reminder_sent with provider + due-count on a successful send', async () => {
    const { cron, sendMock, eventMock } = await loadForSend();
    sendMock.mockResolvedValue(true);

    const sent = await cron.processV2Reminders('2026-08-30');

    expect(sent).toBe(1);
    expect(eventMock).toHaveBeenCalledTimes(1);
    // Only the arrived item counts (dueAt 2026-08-01), not the 2027 one.
    expect(eventMock).toHaveBeenCalledWith('reminder_sent', { provider: 'typed', count: 1 });
  });

  it('records nothing when the email send fails', async () => {
    const { cron, sendMock, eventMock } = await loadForSend();
    sendMock.mockResolvedValue(false);

    const sent = await cron.processV2Reminders('2026-08-30');

    expect(sent).toBe(0);
    expect(eventMock).not.toHaveBeenCalled();
  });
});

describe('reminder v2 cron tick — US-28 AC2: lock errors retry same day, losses end it', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    // Past the 08:00 UTC target hour so every tick is eligible.
    vi.setSystemTime(new Date('2026-08-28T09:30:00Z'));
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('re-attempts the lock next tick after a transient acquire error, then runs', async () => {
    const { cron, lockMock, optinsMock } = await loadCron();
    stop = cron.stopReminderV2Cron;
    lockMock
      .mockRejectedValueOnce(new Error('cron lock acquire failed (reminder_v2_cron)'))
      .mockResolvedValue(true);

    cron.startReminderV2Cron();
    await vi.advanceTimersByTimeAsync(HOUR_MS); // tick 1: acquire throws → day NOT marked done
    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(optinsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOUR_MS); // tick 2: retried, acquired → job runs
    expect(lockMock).toHaveBeenCalledTimes(2);
    expect(optinsMock).toHaveBeenCalled();
  });

  it('does not re-attempt the same day after losing the race (false)', async () => {
    const { cron, lockMock, optinsMock } = await loadCron();
    stop = cron.stopReminderV2Cron;
    lockMock.mockResolvedValue(false);

    cron.startReminderV2Cron();
    await vi.advanceTimersByTimeAsync(HOUR_MS); // tick 1: lost → day marked done
    await vi.advanceTimersByTimeAsync(HOUR_MS); // tick 2: short-circuits on lastRunDate
    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(optinsMock).not.toHaveBeenCalled();
  });
});
