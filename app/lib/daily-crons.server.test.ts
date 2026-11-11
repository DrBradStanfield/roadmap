import { describe, it, expect, vi, afterEach } from 'vitest';

// Pins for the three daily crons' tick (untangle S-4, US-28): which lock each
// takes, at what hour and on which clock, with which machine id, at most once a
// day, what a held lock, a lock error and a failed run do, and whether a run
// still going blocks the next tick. Each cron's day's work is routed to one
// probe, `work`, so a test can make it succeed, fail or hang.

const { work } = vi.hoisted(() => ({ work: vi.fn<() => Promise<unknown>>() }));

// A query builder whose every method returns itself and whose await is `answer`.
function chain(answer: () => Promise<unknown>): unknown {
  return new Proxy(() => {}, {
    get: (_t, key) =>
      key === 'then'
        ? (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => answer().then(ok, fail)
        : () => chain(answer),
  });
}
const noRows = async () => ({ data: [], error: null });

// Chat purge's run starts with the match-events pass, so that query is its probe.
vi.mock('./supabase.server', () => ({
  tryAcquireCronLock: vi.fn(),
  supabaseAdmin: { from: (table: string) => chain(table === 'chat_match_events' ? work : noRows) },
}));
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
const DAY_MS = 24 * HOUR_MS;
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
  beforeTarget: string;          // one hour before the first eligible tick (a tick fires an hour after start)
  day: string;                   // lock_date the first eligible tick claims
  nextDay: string;
  ineligibleOnThisClock: string; // hour clears target on the other clock (UTC vs NZ), not this one
  ok: () => Promise<unknown>;
  hang: () => Promise<unknown>;
  blocksWhileRunning: boolean;
}

const crons: CronCase[] = [
  { name: 'trending',
    load: async () => { const m = await import('./trending-cron.server'); return { start: m.startTrendingCron, stop: m.stopTrendingCron }; },
    lockName: 'trending_cron', beforeTarget: '2026-08-27T14:30:00Z', day: '2026-08-28', nextDay: '2026-08-29',
    ineligibleOnThisClock: '2026-08-27T13:30:00Z',
    ok: async () => ({ admin: okAdmin }), hang: HANG, blocksWhileRunning: true },
  { name: 'reminder v2',
    load: async () => { const m = await import('./reminder-v2-cron.server'); return { start: m.startReminderV2Cron, stop: m.stopReminderV2Cron }; },
    lockName: 'reminder_v2_cron', beforeTarget: '2026-08-28T07:30:00Z', day: '2026-08-28', nextDay: '2026-08-29',
    ineligibleOnThisClock: '2026-08-28T06:30:00Z',
    ok: async () => [], hang: HANG, blocksWhileRunning: true },
  { name: 'chat purge',
    load: async () => { const m = await import('./chat-purge-cron.server'); return { start: m.startChatPurgeCron, stop: m.stopChatPurgeCron }; },
    lockName: 'chat_text_purge', beforeTarget: '2026-08-28T03:30:00Z', day: '2026-08-28', nextDay: '2026-08-29',
    ineligibleOnThisClock: '2026-08-28T02:30:00Z',
    ok: noRows, hang: HANG,
    blocksWhileRunning: false }, // marks its day only after the run returns
];

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; vi.unstubAllEnvs(); vi.useRealTimers(); });

// `onlyTheTick` fakes the hourly interval and the clock but leaves setTimeout
// real, so a run's own withTimeout guards cannot end a hanging run mid-test.
async function boot(c: CronCase, at: string, onlyTheTick = false) {
  vi.useFakeTimers(onlyTheTick ? { toFake: ['setInterval', 'clearInterval', 'Date'] } : undefined);
  vi.setSystemTime(new Date(at));
  vi.resetModules();
  vi.stubEnv('FLY_MACHINE_ID', 'pin-machine');
  vi.stubEnv('SHOPIFY_SHOP_DOMAIN', '');
  const cron = await c.load();            // NODE_ENV=test: self-start is a no-op
  vi.stubEnv('NODE_ENV', 'production');
  const { tryAcquireCronLock } = await import('./supabase.server');
  const lock = vi.mocked(tryAcquireCronLock).mockReset();
  work.mockReset().mockImplementation(c.ok);
  stop = cron.stop;
  cron.start();
  return { lock };
}
const tick = () => vi.advanceTimersByTimeAsync(HOUR_MS);

describe.each(crons)('$name cron tick (untangle S-4 pins, US-28)', (c) => {
  it('takes its own lock with this machine id and its own day, first at the target hour', async () => {
    const { lock } = await boot(c, c.beforeTarget);
    lock.mockResolvedValue(true);
    await tick();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith('pin-machine', c.day, c.lockName);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('does not tick before the target hour on its own clock', async () => {
    const { lock } = await boot(c, c.ineligibleOnThisClock);
    lock.mockResolvedValue(true);
    await tick();
    expect(lock).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
  it('runs at most once a day, then again the next day', async () => {
    const { lock } = await boot(c, c.beforeTarget);
    lock.mockResolvedValue(true);
    await tick(); await tick(); await tick();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DAY_MS - 2 * HOUR_MS);
    expect(lock).toHaveBeenCalledTimes(2);
    expect(lock).toHaveBeenLastCalledWith('pin-machine', c.nextDay, c.lockName);
    expect(work).toHaveBeenCalledTimes(2);
  });
  it('a lock another machine holds means no run and no retry that day', async () => {
    const { lock } = await boot(c, c.beforeTarget);
    lock.mockResolvedValue(false);
    await tick(); await tick();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
  });
  it('a lock error retries on the next tick (US-28 AC2)', async () => {
    const { lock } = await boot(c, c.beforeTarget);
    lock.mockRejectedValueOnce(new Error('cron lock acquire failed')).mockResolvedValue(true);
    await tick();
    expect(work).not.toHaveBeenCalled();
    await tick();
    expect(lock).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('a failed run leaves the day open, so the next tick runs it again (US-28 AC3, AC6)', async () => {
    const { lock } = await boot(c, c.beforeTarget);
    lock.mockResolvedValue(true);
    work.mockRejectedValueOnce(new Error('run failed'));
    await tick();
    expect(work).toHaveBeenCalledTimes(1);
    await tick();
    expect(lock).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(2);
    await tick();
    expect(work).toHaveBeenCalledTimes(2);
  });
  it(c.blocksWhileRunning ? 'a run still going blocks the next tick on this machine'
    : "a run still going does not block the next tick (today's behaviour)", async () => {
    const { lock } = await boot(c, c.beforeTarget, true);
    lock.mockResolvedValue(true);
    work.mockImplementation(c.hang);
    await tick(); await tick();
    const n = c.blocksWhileRunning ? 1 : 2;
    expect(lock).toHaveBeenCalledTimes(n);
    expect(work).toHaveBeenCalledTimes(n);
  });
});

describe('trending cron lock per store', () => {
  it('the education store takes its own lock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(crons[0].beforeTarget));
    vi.resetModules();
    vi.stubEnv('FLY_MACHINE_ID', 'pin-machine');
    vi.stubEnv('SHOPIFY_SHOP_DOMAIN', 'sz5utw-1r.myshopify.com');
    const m = await import('./trending-cron.server');
    vi.stubEnv('NODE_ENV', 'production');
    const { tryAcquireCronLock } = await import('./supabase.server');
    const lock = vi.mocked(tryAcquireCronLock).mockReset().mockResolvedValue(false);
    stop = m.stopTrendingCron;
    m.startTrendingCron();
    await tick();
    expect(lock).toHaveBeenCalledWith('pin-machine', '2026-08-28', 'trending_cron_edu');
  });
});
