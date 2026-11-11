import { describe, it, expect, vi, afterEach } from 'vitest';

// US-28 AC9 at the cron: each daily cron's tick with the real lock against a
// fake cron_lock table, across a restart (a fresh module graph, as a deploy
// gives). 2026-11-11: trending ran twice after a deploy, because the restarted
// machine re-won a day it had already finished. A finished day must stay done;
// a failed or killed run must still re-run the same day (AC3, AC6, AC7).

const { work, stamp, db } = vi.hoisted(() => ({
  work: vi.fn<() => Promise<unknown>>(),
  stamp: { before: null as null | (() => void) },
  db: { fake: null as null | import('./cron-lock-fake.test-helpers').FakeLockDb },
}));

function chain(answer: () => Promise<unknown>): unknown {
  return new Proxy(() => {}, {
    get: (_t, key) =>
      key === 'then'
        ? (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => answer().then(ok, fail)
        : () => chain(answer),
  });
}
const noRows = async () => ({ data: [], error: null });

vi.mock('./supabase-client.server', async () => {
  const helpers = await import('./cron-lock-fake.test-helpers');
  db.fake ??= helpers.makeFakeLockDb();
  // Chat purge's run starts with the match-events pass, so that query is its probe.
  db.fake.other = (table) => chain(table === 'chat_match_events' ? work : noRows);
  return { supabaseAdmin: helpers.fakeAdmin(db.fake), createUserClient: vi.fn() };
});
vi.mock('../shopify.server', () => ({ unauthenticated: { admin: vi.fn(() => work()) } }));
vi.mock('./reminder-v2.server', () => ({
  buildUnsubscribeUrl: vi.fn(),
  getOptinsBatch: vi.fn(() => work()),
  inQuietPeriod: vi.fn(() => false),
  purgeTombstones: vi.fn(async () => 0),
  recordSent: vi.fn(),
}));
vi.mock('./reminder-v2-day-stamp.server', () => ({
  stampReminderDay: vi.fn(async () => { stamp.before?.(); return 'stamped'; }),
}));
vi.mock('./email.server', () => ({ buildReminderV2EmailHtml: vi.fn(), sendReminderEmail: vi.fn(async () => true) }));
vi.mock('./chat-question-scrub.server', () => ({ scrubQuestion: vi.fn(), SCRUB_TIMEOUT_MS: 15_000 }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const HOUR_MS = 60 * 60 * 1000;
const HANG = () => new Promise<never>(() => {});

const okAdmin = {
  graphql: async (query: string, opts?: { variables?: any }) => {
    let body: unknown;
    if (query.includes('shopifyqlQuery')) {
      body = { data: { shopifyqlQuery: { parseErrors: [], tableData: {
        columns: [{ name: 'landing_page_path' }, { name: 'sessions' }], rows: [],
      } } } };
    } else if (query.includes('shop { id }')) {
      body = { data: { shop: { id: 'gid://shopify/Shop/1' } } };
    } else {
      const value = opts?.variables?.metafields?.[0]?.value;
      body = { data: { metafieldsSet: { userErrors: [], metafields: [
        { id: 'gid://shopify/Metafield/1', value, updatedAt: '2026-08-28T00:00:00Z' },
      ] } } };
    }
    return { json: async () => body };
  },
};

interface CronCase {
  name: string;
  load: () => Promise<{ start: () => void; stop: () => void }>;
  lockName: string;
  beforeTarget: string; // one hour before the first eligible tick
  later: string;        // the same day, after the restart
  stuckHours: number;   // the cron's stuck limit (cron-day.ts STUCK_AFTER_HOURS)
  ok: () => Promise<unknown>;
}

const crons: CronCase[] = [
  { name: 'trending',
    load: async () => { const m = await import('./trending-cron.server'); return { start: m.startTrendingCron, stop: m.stopTrendingCron }; },
    lockName: 'trending_cron', beforeTarget: '2026-08-27T14:30:00Z', later: '2026-08-27T16:30:00Z', stuckHours: 1, ok: async () => ({ admin: okAdmin }) },
  { name: 'reminder v2',
    load: async () => { const m = await import('./reminder-v2-cron.server'); return { start: m.startReminderV2Cron, stop: m.stopReminderV2Cron }; },
    lockName: 'reminder_v2_cron', beforeTarget: '2026-08-28T07:30:00Z', later: '2026-08-28T09:30:00Z', stuckHours: 6, ok: async () => [] },
  { name: 'chat purge',
    load: async () => { const m = await import('./chat-purge-cron.server'); return { start: m.startChatPurgeCron, stop: m.stopChatPurgeCron }; },
    lockName: 'chat_text_purge', beforeTarget: '2026-08-28T03:30:00Z', later: '2026-08-28T05:30:00Z', stuckHours: 6, ok: noRows },
];

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; vi.unstubAllEnvs(); vi.useRealTimers(); });

/** One process on `machine`: a fresh module graph, started at `at`. */
async function boot(c: CronCase, at: string, machine = 'pin-machine') {
  stop?.();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(at));
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('FLY_MACHINE_ID', machine);
  vi.stubEnv('SHOPIFY_SHOP_DOMAIN', '');
  const cron = await c.load(); // NODE_ENV=test: self-start is a no-op
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('RUN_SHARED_CRONS', 'true');
  stop = cron.stop;
  cron.start();
}
const tick = () => vi.advanceTimersByTimeAsync(HOUR_MS);

function seed(lockName: string) {
  db.fake!.rows = [{ lock_name: lockName, locked_by: null, locked_at: null, lock_date: '1970-01-01', run_state: null, finished_at: null }];
}

describe.each(crons)('$name cron across a restart (US-28 AC9)', (c) => {
  it('a restart after a finished day does not run it again', async () => {
    await boot(c, c.beforeTarget);
    seed(c.lockName);
    work.mockReset().mockImplementation(c.ok);
    await tick();
    expect(work).toHaveBeenCalledTimes(1);

    await boot(c, c.later); // the deploy
    await tick();
    expect(work).toHaveBeenCalledTimes(1);
    expect(db.fake!.rows[0].run_state).toBe('finished');
  });

  it('a restart after a failed run runs the day again', async () => {
    await boot(c, c.beforeTarget);
    seed(c.lockName);
    work.mockReset().mockRejectedValueOnce(new Error('run failed')).mockImplementation(c.ok);
    await tick();
    expect(work).toHaveBeenCalledTimes(1);

    await boot(c, c.later);
    await tick();
    expect(work).toHaveBeenCalledTimes(2);
    expect(db.fake!.rows[0].run_state).toBe('finished');
  });

  it('a restart after a run killed mid-way runs the day again', async () => {
    await boot(c, c.beforeTarget);
    seed(c.lockName);
    work.mockReset().mockImplementationOnce(HANG).mockImplementation(c.ok);
    await tick();
    expect(work).toHaveBeenCalledTimes(1);

    await boot(c, c.later); // the old process died with its run
    await tick();
    expect(work).toHaveBeenCalledTimes(2);
    expect(db.fake!.rows[0].run_state).toBe('finished');
  });
});

// US-28 AC9, the busy answer at the cron: a machine that meets another
// machine's FRESH run keeps its day open and tries every hourly tick, and
// takes the day over once that run passes the stuck limit, with no restart.
// (Every cron's first eligible tick claims lock_date 2026-08-28 on its clock.)
const DAY = '2026-08-28';

describe.each(crons)('$name cron meets another machine\'s run (US-28 AC9)', (c) => {
  const firstTick = () => Date.parse(c.beforeTarget) + HOUR_MS;

  it('retries hourly while that run is fresh, and takes the day over at the stuck cutoff', async () => {
    await boot(c, c.beforeTarget);
    // machine-a started today's run half an hour before this machine's first tick, and hangs.
    db.fake!.rows = [{ lock_name: c.lockName, locked_by: 'machine-a', lock_date: DAY, run_state: 'running',
      locked_at: new Date(firstTick() - HOUR_MS / 2).toISOString(), finished_at: null }];
    db.fake!.calls = [];
    work.mockReset().mockImplementation(c.ok);
    for (let h = 0; h < c.stuckHours; h++) {
      await tick(); // the run is h + 0.5 hours old: busy
      expect(work).not.toHaveBeenCalled();
      expect(db.fake!.rows[0].locked_by).toBe('machine-a');
    }
    expect(db.fake!.calls.length).toBe(2 * c.stuckHours); // one update + one verify per tick, every tick
    await tick(); // past the stuck limit: this machine takes the day
    expect(work).toHaveBeenCalledTimes(1);
    expect(db.fake!.rows[0]).toMatchObject({ locked_by: 'pin-machine', lock_date: DAY, run_state: 'finished' });
    await tick();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("another machine's finished row ends this machine's day at once", async () => {
    await boot(c, c.beforeTarget);
    db.fake!.rows = [{ lock_name: c.lockName, locked_by: 'machine-a', lock_date: DAY, run_state: 'finished',
      locked_at: new Date(firstTick() - HOUR_MS / 2).toISOString(), finished_at: new Date(firstTick() - HOUR_MS / 4).toISOString() }];
    db.fake!.calls = [];
    work.mockReset().mockImplementation(c.ok);
    await tick(); await tick(); await tick();
    expect(work).not.toHaveBeenCalled();
    expect(db.fake!.calls.length).toBe(2); // one acquire, then no more tries that day
  });
});

// The purge catch-up case end to end, both machines through the real cron:
// machine-a was down until after 22:00 UTC, so its day-D purge starts late, at
// 23:30, and hangs. machine-b boots at 03:30 on D+1: its 04:30 tick meets a
// fresh earlier-day run and gets busy; it keeps trying and takes D+1 once
// machine-a's run passes the 6 h limit.
describe('chat purge catch-up across midnight (US-28 AC9)', () => {
  it('B gets busy at 04:30 and 05:30, and takes D+1 at 06:30', async () => {
    const purge = crons.find((c) => c.lockName === 'chat_text_purge')!;
    await boot(purge, '2026-08-27T22:30:00Z', 'machine-a');
    seed(purge.lockName);
    work.mockReset().mockImplementationOnce(HANG).mockImplementation(purge.ok);
    await tick(); // 23:30 on D: machine-a's catch-up run starts and hangs
    expect(work).toHaveBeenCalledTimes(1);
    expect(db.fake!.rows[0]).toMatchObject({ locked_by: 'machine-a', lock_date: '2026-08-27', run_state: 'running' });

    await boot(purge, '2026-08-28T03:30:00Z', 'machine-b'); // machine-a's process is gone; its row stays running
    await tick(); // 04:30: 5 h old, fresh: busy
    await tick(); // 05:30: exactly 6 h, not past the limit: busy
    expect(work).toHaveBeenCalledTimes(1);
    expect(db.fake!.rows[0].locked_by).toBe('machine-a');
    await tick(); // 06:30: past the limit: machine-b runs D+1
    expect(work).toHaveBeenCalledTimes(2);
    expect(db.fake!.rows[0]).toMatchObject({ locked_by: 'machine-b', lock_date: '2026-08-28', run_state: 'finished' });
  });
});

// US-23 AC15, the fence through the real reminder cron and the real lock: the
// acquire's locked_at reaches the pass, which re-reads its row before each send.
describe('reminder v2 cron: the fence before each send (US-23 AC15)', () => {
  const reminder = crons.find((c) => c.lockName === 'reminder_v2_cron')!;
  const optin = { id: 'o1', email: 'o1@example.test', provider: 'typed', token: 'tok-o1', created_at: '2026-07-01T00:00:00Z',
    schedule: [{ category: 'blood_test_lipids', label: 'Lipid panel', dueAt: '2026-08-01' }], last_sent: {}, attempting_on: null };
  afterEach(() => { stamp.before = null; });

  it('a pass that keeps its lock sends, and its row ends finished', async () => {
    const { sendReminderEmail } = await import('./email.server');
    await boot(reminder, reminder.beforeTarget, 'machine-a');
    seed(reminder.lockName);
    work.mockReset().mockResolvedValue([optin]);
    vi.mocked(sendReminderEmail).mockClear();
    await tick();
    expect(sendReminderEmail).toHaveBeenCalledTimes(1);
    expect(db.fake!.rows[0]).toMatchObject({ locked_by: 'machine-a', lock_date: DAY, run_state: 'finished' });
  });

  it('a pass taken over after its stamp sends nothing, writes no end state, and reopens its day', async () => {
    const { sendReminderEmail } = await import('./email.server');
    await boot(reminder, reminder.beforeTarget, 'machine-a');
    seed(reminder.lockName);
    work.mockReset().mockResolvedValue([optin]);
    vi.mocked(sendReminderEmail).mockClear();
    const takenAt = new Date(Date.parse(reminder.beforeTarget) + HOUR_MS + 60_000).toISOString();
    // machine-b takes the row over while machine-a sits at the stamp.
    stamp.before = () => { Object.assign(db.fake!.rows[0], { locked_by: 'machine-b', locked_at: takenAt, run_state: 'running' }); };
    await tick();
    expect(sendReminderEmail).not.toHaveBeenCalled();
    const takenOver = { lock_name: reminder.lockName, locked_by: 'machine-b', locked_at: takenAt, lock_date: DAY, run_state: 'running', finished_at: null };
    expect(db.fake!.rows[0]).toEqual(takenOver);

    stamp.before = null;
    db.fake!.calls = [];
    await tick(); // the day reopened: machine-a asks the lock, meets machine-b's fresh run (busy)
    expect(db.fake!.calls.length).toBe(2);
    expect(work).toHaveBeenCalledTimes(1);
    expect(db.fake!.rows[0]).toEqual(takenOver);
  });
});
