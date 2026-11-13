/**
 * US-23 AC16: a reminder send has a deadline (untangle lead C6).
 *
 * A send that never settles used to hold the whole pass: no later chunk ran,
 * the cron_lock row stayed `running`, and this machine's day stayed running
 * too, so every later tick skipped until a restart (US-28 AC7 only reports it,
 * after 6 h). Now each send's request is aborted at the deadline and counts as
 * a failed send, exactly as a Resend error does today.
 *
 * Drives the real reminder cron, the real daily runner, the real cron lock
 * (against the fake cron_lock table), the real email.server and the real Resend
 * SDK. Only `fetch` is stubbed: one recipient's request never answers unless
 * its signal aborts, as Node's fetch rejects on abort. Fake timers, no real
 * waits. All values are synthetic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { db, stamps } = vi.hoisted(() => ({
  db: { fake: null as null | import('./cron-lock-fake.test-helpers').FakeLockDb },
  stamps: new Map<string, string>(),
}));

vi.mock('./supabase-client.server', async () => {
  const helpers = await import('./cron-lock-fake.test-helpers');
  db.fake ??= helpers.makeFakeLockDb();
  return { supabaseAdmin: helpers.fakeAdmin(db.fake), createUserClient: vi.fn() };
});
vi.mock('./reminder-v2.server', () => ({
  buildUnsubscribeUrl: () => 'https://example.test/reminders-v2/unsubscribe?token=synthetic',
  getOptinsBatch: vi.fn(async () => []),
  inQuietPeriod: () => false,
  purgeTombstones: async () => 0,
  recordSent: vi.fn(async () => {}),
}));
// The day-stamp (US-23 AC15) in memory, with the real rule.
vi.mock('./reminder-v2-day-stamp.server', () => ({
  stampReminderDay: vi.fn(async (id: string, today: string) => {
    const at = stamps.get(id);
    if (at !== undefined && at >= today) return 'attempted-today';
    stamps.set(id, today);
    return 'stamped';
  }),
}));
vi.mock('./supabase-guest.server', () => ({ hashClientIp: () => 'synthetic-ip' }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn(async () => {}) }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const HOUR_MS = 60 * 60 * 1000;
const DAY = '2026-08-28';
const HUNG = 'hung.reader@example.test';

const optin = (n: number, email = `reader${n}@example.test`) => ({
  id: `o${n}`, email, provider: 'typed', token: `synthetic-token-${n}`, created_at: '2026-07-01T00:00:00Z',
  schedule: [{ category: 'blood_test_lipids', label: 'Lipid panel blood test', dueAt: '2026-08-01' }],
  last_sent: {}, attempting_on: null,
});

/** Node's fetch, for Resend: accepts every email but HUNG's, which never
 *  answers and rejects only when its signal aborts. */
const fetchStub = vi.fn((_url: string, init: RequestInit) => {
  const to = JSON.parse(String(init.body)).to;
  if (to === HUNG) {
    return new Promise<Response>((_ok, fail) => init.signal?.addEventListener('abort', () => fail(init.signal!.reason)));
  }
  return Promise.resolve(new Response(JSON.stringify({ id: `re_${to}` }), { status: 200, headers: { 'content-type': 'application/json' } }));
});
const sentTo = () => fetchStub.mock.calls.map(([, init]) => JSON.parse(String(init.body)).to);

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.(); stop = null;
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks();
  stamps.clear();
});

/** One process on machine-a, its interval started at 07:30 UTC. */
async function boot() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-08-28T07:30:00Z'));
  vi.resetModules();
  vi.stubEnv('FLY_MACHINE_ID', 'machine-a');
  vi.stubEnv('RESEND_API_KEY', 'synthetic-not-a-real-key');
  vi.stubGlobal('fetch', fetchStub);
  const cron = await import('./reminder-v2-cron.server'); // NODE_ENV=test: self-start is a no-op
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('RUN_SHARED_CRONS', 'true');
  stop = cron.stopReminderV2Cron;
  cron.startReminderV2Cron();
  return cron;
}

describe('US-23 AC16: a send that never settles', () => {
  it('ends at the deadline as a failed send; the next person is still sent and the lock is released', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { SEND_TIMEOUT_MS } = await boot();
    const { getOptinsBatch, recordSent } = await import('./reminder-v2.server');
    const Sentry = await import('@sentry/react-router');
    db.fake!.rows = [{ lock_name: 'reminder_v2_cron', locked_by: null, locked_at: null, lock_date: '1970-01-01', run_state: null, finished_at: null }];
    // Six people: the hung one in the first chunk of five, reader6 in the second.
    const people = [optin(1, HUNG), optin(2), optin(3), optin(4), optin(5), optin(6)];
    vi.mocked(getOptinsBatch).mockReset().mockResolvedValueOnce(people as never).mockResolvedValue([] as never);
    fetchStub.mockClear();

    // 08:30 tick: the pass starts; the first chunk's four good sends go out.
    // One millisecond short of the deadline, the hung send still holds the pass.
    await vi.advanceTimersByTimeAsync(HOUR_MS + SEND_TIMEOUT_MS - 1);
    expect(sentTo()).toEqual([HUNG, 'reader2@example.test', 'reader3@example.test', 'reader4@example.test', 'reader5@example.test']);
    expect(db.fake!.rows[0]).toMatchObject({ locked_by: 'machine-a', lock_date: DAY, run_state: 'running' });

    // The deadline: the hung request is aborted, the next chunk runs, the run ends.
    await vi.advanceTimersByTimeAsync(1);
    expect(sentTo()).toContain('reader6@example.test');
    expect(db.fake!.rows[0]).toMatchObject({ locked_by: 'machine-a', lock_date: DAY, run_state: 'finished' });

    // Today's failure path: no cooldown armed for the hung person, the stamp
    // stands (no second try today), and the summary counts one failed send.
    expect(vi.mocked(recordSent).mock.calls.map(([id]) => id).sort()).toEqual(['o2', 'o3', 'o4', 'o5', 'o6']);
    expect(stamps.get('o1')).toBe(DAY);
    const summary = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('Reminder v2 cron summary'));
    expect(summary).toContain('sent=5');
    expect(summary).toContain('"email-send-failed":1');
    expect(vi.mocked(Sentry.captureException).mock.calls.map((c) => (c[1] as { tags?: { feature?: string } })?.tags?.feature))
      .toEqual(['reminder_email']);

    // No address, label or token in any log line or Sentry report.
    const said = [...log.mock.calls, ...err.mock.calls, ...warn.mock.calls,
      ...vi.mocked(Sentry.captureException).mock.calls, ...vi.mocked(Sentry.captureMessage).mock.calls]
      .flat().map((a) => (a instanceof Error ? a.message : JSON.stringify(a))).join('\n');
    expect(said).not.toMatch(/example\.test|Lipid|synthetic-token/);
  });

  it('a send that answers inside the deadline is sent as before', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { SEND_TIMEOUT_MS } = await boot();
    const { getOptinsBatch, recordSent } = await import('./reminder-v2.server');
    db.fake!.rows = [{ lock_name: 'reminder_v2_cron', locked_by: null, locked_at: null, lock_date: '1970-01-01', run_state: null, finished_at: null }];
    vi.mocked(getOptinsBatch).mockReset().mockResolvedValueOnce([optin(7)] as never).mockResolvedValue([] as never);
    vi.mocked(recordSent).mockClear();
    fetchStub.mockClear();
    // Answers one millisecond before the deadline.
    fetchStub.mockImplementationOnce((_url, init) => new Promise<Response>((ok, fail) => {
      init.signal?.addEventListener('abort', () => fail(init.signal!.reason));
      setTimeout(() => ok(new Response(JSON.stringify({ id: 're_slow' }), { status: 200 })), SEND_TIMEOUT_MS - 1);
    }));

    await vi.advanceTimersByTimeAsync(HOUR_MS + SEND_TIMEOUT_MS);
    expect(recordSent).toHaveBeenCalledWith('o7', { blood_test_lipids: DAY });
    expect(db.fake!.rows[0].run_state).toBe('finished');
  });
});
