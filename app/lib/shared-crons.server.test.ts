import { describe, it, expect, vi, afterEach } from 'vitest';

// US-28 AC8 (chat purge) and US-23 AC14 (reminders): the crons that share one
// cron_lock row across both Fly apps start only where RUN_SHARED_CRONS is
// exactly 'true' (fly.toml, health-tool-app). Trending runs per store, so it
// starts either way. Each machine says once, at boot, which way it went.

vi.mock('./supabase.server', () => ({ tryAcquireCronLock: vi.fn(), supabaseAdmin: null }));
vi.mock('../shopify.server', () => ({ unauthenticated: { admin: vi.fn() } }));
vi.mock('./reminder-v2.server', () => ({
  buildUnsubscribeUrl: vi.fn(),
  getOptinsBatch: vi.fn(async () => []),
  inQuietPeriod: vi.fn(() => false),
  purgeTombstones: vi.fn(async () => 0),
  recordSent: vi.fn(),
}));
vi.mock('./email.server', () => ({ buildReminderV2EmailHtml: vi.fn(), sendReminderEmail: vi.fn() }));
vi.mock('./chat-question-scrub.server', () => ({ scrubQuestion: vi.fn(), SCRUB_TIMEOUT_MS: 15_000 }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const ON_LINE = 'Shared crons (reminders, chat purge): on';
const OFF_LINE = "Shared crons (reminders, chat purge): off (RUN_SHARED_CRONS is not 'true')";

let stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Boots all three crons as production would, and counts the intervals each start() opened. */
async function bootAll(flag: string | undefined) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.resetModules();
  vi.stubEnv('SHOPIFY_SHOP_DOMAIN', '');
  vi.stubEnv('RUN_SHARED_CRONS', flag);
  // Imported under NODE_ENV=test, so the self-start on import is a no-op.
  const trending = await import('./trending-cron.server');
  const reminders = await import('./reminder-v2-cron.server');
  const purge = await import('./chat-purge-cron.server');
  vi.stubEnv('NODE_ENV', 'production');
  stops = [trending.stopTrendingCron, reminders.stopReminderV2Cron, purge.stopChatPurgeCron];
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const opened = (start: () => void) => {
    const before = vi.getTimerCount();
    start();
    return vi.getTimerCount() - before;
  };
  const intervals = {
    trending: opened(trending.startTrendingCron),
    reminders: opened(reminders.startReminderV2Cron),
    purge: opened(purge.startChatPurgeCron),
  };
  const lines = log.mock.calls.map((args) => args[0]);
  return { intervals, lines };
}

describe('shared crons run only where RUN_SHARED_CRONS is exactly "true" (US-28 AC8, US-23 AC14)', () => {
  it.each([[undefined], ['TRUE'], ['1'], [''], ['false']])('flag %s: neither shared cron starts, trending does, the off line logs once', async (flag) => {
    const { intervals, lines } = await bootAll(flag);
    expect(intervals).toEqual({ trending: 1, reminders: 0, purge: 0 });
    expect(lines.filter((l) => l === OFF_LINE)).toHaveLength(1);
    expect(lines).not.toContain(ON_LINE);
    expect(lines.filter((l) => typeof l === 'string' && /^(Reminder v2|Chat text purge) cron started/.test(l))).toEqual([]);
  });

  it("flag 'true': both shared crons start, trending too, the on line logs once", async () => {
    const { intervals, lines } = await bootAll('true');
    expect(intervals).toEqual({ trending: 1, reminders: 1, purge: 1 });
    expect(lines.filter((l) => l === ON_LINE)).toHaveLength(1);
    expect(lines).not.toContain(OFF_LINE);
  });
});
