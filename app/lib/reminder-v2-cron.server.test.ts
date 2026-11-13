import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// US-28 AC2 at the caller: a lock-acquire REJECTION leaves the day unmarked
// so the machine retries on the next hourly tick; a 'closed' answer (the day
// is not this machine's, or a permanent misconfig) still ends its day. reminder_v2_cron is the caller
// whose acquire sat OUTSIDE its try/catch — the one Sentry showed skipping
// (JAVASCRIPT-REMIX-68, 2026-08-28 08:11Z).

vi.mock('./supabase-cron-lock.server', () => ({ tryAcquireCronLock: vi.fn(), endCronLock: vi.fn(), stillHoldsLock: vi.fn(async () => true) }));
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
vi.mock('./email.server', () => ({
  buildReminderV2EmailHtml: vi.fn(() => '<html></html>'),
  sendReminderEmail: vi.fn(),
}));
vi.mock('./reminder-v2.server', () => ({
  buildUnsubscribeUrl: vi.fn(() => 'https://example.com/unsub'),
  getOptinsBatch: vi.fn(async () => []),
  inQuietPeriod: vi.fn(() => false),
  purgeTombstones: vi.fn(async () => 0),
  recordSent: vi.fn(),
}));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn() }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn() }));

const HOUR_MS = 60 * 60 * 1000;
/** The fence (US-23 AC15): this pass keeps its lock. */
const held = async () => true;

// vi.resetModules gives the cron a fresh module graph (a fresh day state);
// mock instances PERSIST across resets, so import them from the graph and
// reset their state here rather than trusting top-level imports.
async function loadCron() {
  vi.resetModules();
  stamps.clear();
  // Import under NODE_ENV=test so the module's import-time self-start is a
  // no-op, THEN pose as production so the explicit start in the test runs.
  const cron = await import('./reminder-v2-cron.server');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('RUN_SHARED_CRONS', 'true'); // health-tool-app's flag (US-23 AC14)
  const { tryAcquireCronLock } = await import('./supabase-cron-lock.server');
  const { getOptinsBatch } = await import('./reminder-v2.server');
  const { sendReminderEmail } = await import('./email.server');
  const { recordServerEvent } = await import('./product-events.server');
  const lockMock = vi.mocked(tryAcquireCronLock);
  const optinsMock = vi.mocked(getOptinsBatch);
  lockMock.mockReset();
  optinsMock.mockClear();
  // Hermetic across describes: the send-observability tests set resolved
  // values on these persistent mock instances (adversarial review 2026-08-30).
  vi.mocked(sendReminderEmail).mockReset();
  vi.mocked(recordServerEvent).mockReset();
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
    stamps.clear();
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

    const sent = await cron.processV2Reminders('2026-08-30', held);

    expect(sent).toBe(1);
    expect(eventMock).toHaveBeenCalledTimes(1);
    // Only the arrived item counts (dueAt 2026-08-01), not the 2027 one.
    expect(eventMock).toHaveBeenCalledWith('reminder_sent', { provider: 'typed', count: 1 });
  });

  it('records nothing when the email send fails', async () => {
    const { cron, sendMock, eventMock } = await loadForSend();
    sendMock.mockResolvedValue(false);

    const sent = await cron.processV2Reminders('2026-08-30', held);

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
      .mockResolvedValue('won');

    cron.startReminderV2Cron();
    await vi.advanceTimersByTimeAsync(HOUR_MS); // tick 1: acquire throws → day NOT marked done
    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(optinsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOUR_MS); // tick 2: retried, acquired → job runs
    expect(lockMock).toHaveBeenCalledTimes(2);
    expect(optinsMock).toHaveBeenCalled();
  });

  it('does not re-attempt the same day after a closed answer', async () => {
    const { cron, lockMock, optinsMock } = await loadCron();
    stop = cron.stopReminderV2Cron;
    lockMock.mockResolvedValue('closed');

    cron.startReminderV2Cron();
    await vi.advanceTimersByTimeAsync(HOUR_MS); // tick 1: closed → day marked done
    await vi.advanceTimersByTimeAsync(HOUR_MS); // tick 2: skips, the day is done
    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(optinsMock).not.toHaveBeenCalled();
  });
});

// US-17 AC1b: a row switched off keeps its address and token; the daily run is
// what stops "kept" meaning "forever".
describe('reminder v2 cron — tombstone retention', () => {
  it('purges tombstones once per run, after the sends', async () => {
    const { cron } = await loadCron();
    const { purgeTombstones } = await import('./reminder-v2.server');
    vi.mocked(purgeTombstones).mockClear().mockResolvedValue(3);

    await cron.processV2Reminders('2026-08-30', held);
    expect(purgeTombstones).toHaveBeenCalledTimes(1);
  });

  it('never fails the day over a purge error — the mail has already gone out', async () => {
    const { cron } = await loadCron();
    const { purgeTombstones } = await import('./reminder-v2.server');
    const Sentry = await import('@sentry/react-router');
    vi.mocked(purgeTombstones).mockClear().mockRejectedValue(new Error('PGRST303'));
    vi.mocked(Sentry.captureException).mockClear();

    await expect(cron.processV2Reminders('2026-08-30', held)).resolves.toBe(0);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

// US-28 AC3: the day is done only once a pass has finished. A read error after
// the lock is won (the same platform fault AC1/AC2 were written for) used to
// end the day on this machine, and the lock row, which names this machine,
// ended it on the other one too: nobody due that day was emailed.
describe('reminder v2 cron tick — US-28 AC3: a failed pass leaves the day open', () => {
  let stop: (() => void) | null = null;
  const dueRow = {
    id: 'row-due',
    email: 'due@example.com',
    provider: 'typed' as const,
    schedule: [{ category: 'blood_test_lipids', label: 'Lipid panel', dueAt: '2026-08-01' }],
    last_sent: {},
    token: 'tok',
    created_at: '2026-08-01T00:00:00Z',
  };

  async function loadTick() {
    // The retention tests above leave NODE_ENV stubbed to production, which
    // would let the import self-start a second interval beside ours.
    vi.unstubAllEnvs();
    const loaded = await loadCron();
    stop = loaded.cron.stopReminderV2Cron;
    const { sendReminderEmail } = await import('./email.server');
    const { purgeTombstones } = await import('./reminder-v2.server');
    const sendMock = vi.mocked(sendReminderEmail);
    sendMock.mockResolvedValue(true);
    vi.mocked(purgeTombstones).mockReset().mockResolvedValue(0);
    loaded.optinsMock.mockReset();
    // The lock row names this machine for today, so its own re-acquire wins.
    loaded.lockMock.mockResolvedValue('won');
    return { ...loaded, sendMock };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T07:30:00Z'));
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('re-runs the day on the next tick after an opt-in read error, and the due user is emailed', async () => {
    const { cron, lockMock, optinsMock, sendMock } = await loadTick();
    optinsMock
      .mockRejectedValueOnce(new Error('reminder_optin_v2 select failed: fetch failed'))
      .mockResolvedValueOnce([dueRow])
      .mockResolvedValue([]);

    const Sentry = await import('@sentry/react-router');
    vi.mocked(Sentry.captureException).mockClear();

    cron.startReminderV2Cron();
    await vi.advanceTimersByTimeAsync(HOUR_MS); // 08:30: lock won, first read fails
    expect(sendMock).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1); // still reported

    await vi.advanceTimersByTimeAsync(HOUR_MS); // 09:30: the day is still open
    expect(lockMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe('due@example.com');
  });

  it('a failure on a later page re-runs the day too', async () => {
    const { cron, optinsMock, sendMock } = await loadTick();
    const page = Array.from({ length: 50 }, (_, i) => ({ ...dueRow, id: `p1-${i}`, email: `p1-${i}@example.com` }));
    optinsMock
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new Error('reminder_optin_v2 select failed: fetch failed'))
      .mockResolvedValueOnce([dueRow])
      .mockResolvedValue([]);

    cron.startReminderV2Cron();
    await vi.advanceTimersByTimeAsync(HOUR_MS); // page 1 sent, page 2 read fails
    await vi.advanceTimersByTimeAsync(HOUR_MS); // retried
    const emailed = sendMock.mock.calls.map((c) => c[0]);
    expect(emailed).toContain('due@example.com');
  });

  it('after a pass that finished, the rest of the day does nothing', async () => {
    const { cron, lockMock, optinsMock, sendMock } = await loadTick();
    optinsMock.mockResolvedValueOnce([dueRow]).mockResolvedValue([]);

    cron.startReminderV2Cron();
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(optinsMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('a pass still running at the next tick is not started a second time on this machine', async () => {
    const { cron, lockMock, optinsMock } = await loadTick();
    // The first read never answers within the hour (a stalled send or read):
    // the next tick must not start a second pass over rows not yet stamped.
    optinsMock.mockImplementationOnce(() => new Promise(() => {}));

    cron.startReminderV2Cron();
    await vi.advanceTimersByTimeAsync(HOUR_MS); // pass starts and hangs
    await vi.advanceTimersByTimeAsync(HOUR_MS); // next tick
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(optinsMock).toHaveBeenCalledTimes(1);
  });

  // Adversarial review of PR #434: page 1 is emailed, its last_sent writes
  // fail, then a page-2 read throws. The retried pass re-reads page 1 with
  // last_sent still empty; without a per-day record it emailed them again,
  // every hour until a pass finished.
  it('a retried pass never emails the same optin twice in a day, but reaches the rest', async () => {
    const { cron, optinsMock, sendMock } = await loadTick();
    const { recordSent } = await import('./reminder-v2.server');
    vi.mocked(recordSent).mockReset().mockRejectedValue(new Error('reminder_optin_v2 update failed'));
    const page1 = Array.from({ length: 50 }, (_, i) => ({ ...dueRow, id: `p1-${i}`, email: `p1-${i}@example.com` }));
    const page2Row = { ...dueRow, id: 'p2-0', email: 'p2-0@example.com' };
    optinsMock
      .mockResolvedValueOnce(page1)
      .mockRejectedValueOnce(new Error('reminder_optin_v2 select failed: fetch failed'))
      .mockResolvedValueOnce(page1) // last_sent never stamped
      .mockResolvedValueOnce([page2Row])
      .mockResolvedValue([]);

    cron.startReminderV2Cron();
    await vi.advanceTimersByTimeAsync(HOUR_MS); // page 1 sent, stamps fail, page 2 read fails
    await vi.advanceTimersByTimeAsync(HOUR_MS); // retried
    await vi.advanceTimersByTimeAsync(HOUR_MS); // the pass finished: nothing more
    const emailed = sendMock.mock.calls.map((c) => c[0]);
    for (const row of page1) expect(emailed.filter((e) => e === row.email)).toHaveLength(1);
    expect(emailed.filter((e) => e === 'p2-0@example.com')).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledTimes(51);
  });

  it('the once-a-day record resets on a new day', async () => {
    const { cron, optinsMock, sendMock } = await loadTick();
    const { recordSent } = await import('./reminder-v2.server');
    vi.mocked(recordSent).mockReset().mockRejectedValue(new Error('reminder_optin_v2 update failed'));
    const page1 = Array.from({ length: 50 }, (_, i) => ({ ...dueRow, id: `p1-${i}`, email: `p1-${i}@example.com` }));
    optinsMock
      .mockResolvedValueOnce(page1)
      .mockRejectedValueOnce(new Error('reminder_optin_v2 select failed: fetch failed'))
      .mockResolvedValueOnce(page1) // same-day retry: already attempted
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(page1) // next day: still due, last_sent never stamped
      .mockResolvedValue([]);

    cron.startReminderV2Cron();
    await vi.advanceTimersByTimeAsync(HOUR_MS); // 08-28 08:30: page 1 sent, page 2 read fails
    await vi.advanceTimersByTimeAsync(HOUR_MS); // 08-28 09:30: retried, nobody re-sent
    expect(sendMock).toHaveBeenCalledTimes(50);

    await vi.advanceTimersByTimeAsync(23 * HOUR_MS); // through 08-29 08:30
    expect(sendMock).toHaveBeenCalledTimes(100);
    expect(sendMock.mock.calls[50][0]).toBe('p1-0@example.com');
  });

  // Review of 5fb9f7e5: a pass from an earlier day that is still running must
  // not reset a newer day's record, or that day's retry emails people twice.
  it("an earlier day's pass never resets a newer day's record", async () => {
    const { cron, optinsMock, sendMock } = await loadTick();
    const { recordSent } = await import('./reminder-v2.server');
    vi.mocked(recordSent).mockReset().mockRejectedValue(new Error('reminder_optin_v2 update failed'));
    optinsMock
      .mockResolvedValueOnce([dueRow]).mockResolvedValueOnce([]) // 08-29 pass
      .mockResolvedValueOnce([dueRow]).mockResolvedValueOnce([]) // a stalled 08-28 pass resumes
      .mockResolvedValueOnce([dueRow]).mockResolvedValue([]); // 08-29 retry, last_sent never stamped

    await cron.processV2Reminders('2026-08-29', held);
    await cron.processV2Reminders('2026-08-28', held);
    const before = sendMock.mock.calls.length;
    await cron.processV2Reminders('2026-08-29', held);
    expect(sendMock).toHaveBeenCalledTimes(before);
  });
});

// US-28 AC4 (Brad 2026-11-03): the reminder pass runs only behind the day lock.
// The admin "run now" page called processV2Reminders directly, skipping the lock,
// so a press during the 08:00 UTC run could email the same people twice.
describe('US-28 AC4: nothing outside the locked cron runs the reminder pass', () => {
  it('no source file in app/ but the cron itself calls processV2Reminders', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const appDir = path.resolve(__dirname, '..');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test(-helpers)?\./.test(name) ? [full] : [];
    });
    const callers = walk(appDir)
      .filter((f) => readFileSync(f, 'utf8').includes('processV2Reminders'))
      .map((f) => path.relative(appDir, f));
    expect(callers).toEqual(['lib/reminder-v2-cron.server.ts']);
  });
});
