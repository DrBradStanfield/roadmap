import { describe, it, expect, vi, afterEach } from 'vitest';

// US-28 AC9 at the cron: each daily cron's tick with the real lock against a
// fake cron_lock table, across a restart (a fresh module graph, as a deploy
// gives). 2026-11-11: trending ran twice after a deploy, because the restarted
// machine re-won a day it had already finished. A finished day must stay done;
// a failed or killed run must still re-run the same day (AC3, AC6, AC7).

const { work, db } = vi.hoisted(() => ({
  work: vi.fn<() => Promise<unknown>>(),
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
vi.mock('./email.server', () => ({ buildReminderV2EmailHtml: vi.fn(), sendReminderEmail: vi.fn() }));
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
  ok: () => Promise<unknown>;
}

const crons: CronCase[] = [
  { name: 'trending',
    load: async () => { const m = await import('./trending-cron.server'); return { start: m.startTrendingCron, stop: m.stopTrendingCron }; },
    lockName: 'trending_cron', beforeTarget: '2026-08-27T14:30:00Z', later: '2026-08-27T16:30:00Z', ok: async () => ({ admin: okAdmin }) },
  { name: 'reminder v2',
    load: async () => { const m = await import('./reminder-v2-cron.server'); return { start: m.startReminderV2Cron, stop: m.stopReminderV2Cron }; },
    lockName: 'reminder_v2_cron', beforeTarget: '2026-08-28T07:30:00Z', later: '2026-08-28T09:30:00Z', ok: async () => [] },
  { name: 'chat purge',
    load: async () => { const m = await import('./chat-purge-cron.server'); return { start: m.startChatPurgeCron, stop: m.stopChatPurgeCron }; },
    lockName: 'chat_text_purge', beforeTarget: '2026-08-28T03:30:00Z', later: '2026-08-28T05:30:00Z', ok: noRows },
];

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; vi.unstubAllEnvs(); vi.useRealTimers(); });

/** One process on machine pin-machine: a fresh module graph, started at `at`. */
async function boot(c: CronCase, at: string) {
  stop?.();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(at));
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('FLY_MACHINE_ID', 'pin-machine');
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
