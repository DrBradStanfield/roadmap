import { describe, it, expect, vi, afterEach } from 'vitest';

// Pins for what the trending and reminder v2 crons say when they move onto the
// shared daily runner (untangle S-4, US-28): the startup line, the
// test/development guard, the error prefix and Sentry tag on a failed tick, and
// the completion line, logged once after a successful run and never after a
// failed one. Expected strings come from origin/main's cron files before S-4.

const { work } = vi.hoisted(() => ({ work: vi.fn<() => Promise<unknown>>() }));

vi.mock('./supabase-cron-lock.server', () => ({ tryAcquireCronLock: vi.fn(), endCronLock: vi.fn() }));
vi.mock('../shopify.server', () => ({ unauthenticated: { admin: vi.fn(() => work()) } }));
vi.mock('./reminder-v2.server', () => ({
  buildUnsubscribeUrl: vi.fn(),
  getOptinsBatch: vi.fn(() => work()),
  inQuietPeriod: vi.fn(() => false),
  purgeTombstones: vi.fn(async () => 0),
  recordSent: vi.fn(),
}));
vi.mock('./email.server', () => ({ buildReminderV2EmailHtml: vi.fn(), sendReminderEmail: vi.fn() }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const HOUR_MS = 60 * 60 * 1000;

// Answers the trending run's three Shopify calls: no sessions, so 0 entries.
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

interface LogCase {
  name: string;
  load: () => Promise<{ start: () => void; stop: () => void }>;
  atTarget: string; // an hour before a tick that clears the target hour
  ok: () => Promise<unknown>;
  label: string;
  feature: string;
  startLine: string;
  /** Lock-shared (US-23 AC14): the shared-crons line logs before the startup line. */
  shared: boolean;
  completedLine: string;
}

const crons: LogCase[] = [
  { name: 'trending',
    load: async () => { const m = await import('./trending-cron.server'); return { start: m.startTrendingCron, stop: m.stopTrendingCron }; },
    atTarget: '2026-08-27T14:30:00Z',
    ok: async () => ({ admin: okAdmin }),
    label: 'Trending cron',
    feature: 'trending_cron',
    shared: false,
    startLine: 'Trending cron started (will run on first tick ≥ 3:00 NZ daily, machine: pin-machine, shop: microvitamin.myshopify.com, lock: trending_cron)',
    completedLine: 'Trending cron: completed, wrote 0 entries' },
  { name: 'reminder v2',
    load: async () => { const m = await import('./reminder-v2-cron.server'); return { start: m.startReminderV2Cron, stop: m.stopReminderV2Cron }; },
    atTarget: '2026-08-28T07:30:00Z',
    ok: async () => [],
    label: 'Reminder v2 cron',
    feature: 'reminder_v2_cron',
    shared: true,
    startLine: 'Reminder v2 cron started (first tick ≥ 8:00 UTC daily, machine: pin-machine)',
    completedLine: 'Reminder v2 cron: completed, sent 0 emails' },
];

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.(); stop = null;
  vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks();
});

async function load(c: LogCase, nodeEnv: string) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(c.atTarget));
  vi.resetModules();
  vi.stubEnv('FLY_MACHINE_ID', 'pin-machine');
  vi.stubEnv('SHOPIFY_SHOP_DOMAIN', '');
  const cron = await c.load();
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('RUN_SHARED_CRONS', 'true'); // health-tool-app's flag (US-23 AC14)
  const { tryAcquireCronLock } = await import('./supabase-cron-lock.server');
  const lock = vi.mocked(tryAcquireCronLock).mockReset().mockResolvedValue('won');
  const Sentry = await import('@sentry/react-router');
  const captured = vi.mocked(Sentry.captureException).mockReset();
  work.mockReset().mockImplementation(c.ok);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  stop = cron.stop;
  return { cron, lock, captured, log, error };
}
const tick = () => vi.advanceTimersByTimeAsync(HOUR_MS);
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((args) => args[0]);

describe.each(crons)('$name cron logs (untangle S-4 pins, US-28)', (c) => {
  it.each(['test', 'development'])('start() in %s logs that it is disabled and starts no interval', async (env) => {
    const { cron, lock, log } = await load(c, env);
    cron.start();
    expect(lines(log)).toEqual([`${c.label} disabled in ${env}`]);
    expect(vi.getTimerCount()).toBe(0);
    await tick();
    expect(lock).not.toHaveBeenCalled();
  });

  it('logs its exact startup line once and starts the hourly interval', async () => {
    const { cron, log } = await load(c, 'production');
    cron.start();
    expect(lines(log)).toEqual(c.shared ? ['Shared crons (reminders, chat purge): on', c.startLine] : [c.startLine]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a tick error logs "<label> error:" and reports it to Sentry with its feature tag', async () => {
    const { cron, lock, captured, error } = await load(c, 'production');
    const boom = new Error('lock down');
    lock.mockRejectedValue(boom);
    cron.start();
    await tick();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe(`${c.label} error:`);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith(boom, { tags: { feature: c.feature } });
  });

  it('logs the completion line once after a successful run', async () => {
    const { cron, log, error } = await load(c, 'production');
    cron.start();
    await tick();
    expect(lines(log).filter((l) => l === c.completedLine)).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('a failed run logs no completion line, only the error', async () => {
    const { cron, log, error, captured } = await load(c, 'production');
    work.mockRejectedValue(new Error('job down'));
    cron.start();
    await tick();
    expect(lines(log).filter((l) => typeof l === 'string' && l.includes('completed'))).toEqual([]);
    expect(error.mock.calls.map((args) => args[0])).toContain(`${c.label} error:`);
    expect(captured).toHaveBeenCalledWith(expect.any(Error), { tags: { feature: c.feature } });
  });
});
