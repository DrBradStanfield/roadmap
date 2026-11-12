import { describe, it, expect, vi, afterEach } from 'vitest';

// Pins for the three daily crons' tick (untangle S-4, US-28): which lock each
// takes, at what hour and on which clock, with which machine id, at most once a
// day, what a held lock, a lock error and a failed run do, and whether a run
// still going blocks the next tick. Each cron's day's work is routed to one
// probe, `work`, so a test can make it succeed, fail or hang.

const { work, db } = vi.hoisted(() => ({
  work: vi.fn<() => Promise<unknown>>(),
  // When set, the chat tables answer from this fake instead (the restart pin).
  db: { from: null as null | ((table: string) => unknown) },
}));

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
  endCronLock: vi.fn(),
  supabaseAdmin: { from: (table: string) => db.from?.(table) ?? chain(table === 'chat_match_events' ? work : noRows) },
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
  feature: string;               // Sentry tag on a stuck report
  stuckHours: number;            // the cron's stuck limit
  beforeTarget: string;          // one hour before the first eligible tick (a tick fires an hour after start)
  day: string;                   // lock_date the first eligible tick claims
  nextDay: string;
  ineligibleOnThisClock: string; // hour clears target on the other clock (UTC vs NZ), not this one
  ok: () => Promise<unknown>;
  hang: () => Promise<unknown>;
}

const crons: CronCase[] = [
  { name: 'trending',
    load: async () => { const m = await import('./trending-cron.server'); return { start: m.startTrendingCron, stop: m.stopTrendingCron }; },
    lockName: 'trending_cron', feature: 'trending_cron', stuckHours: 1, beforeTarget: '2026-08-27T14:30:00Z', day: '2026-08-28', nextDay: '2026-08-29',
    ineligibleOnThisClock: '2026-08-27T13:30:00Z',
    ok: async () => ({ admin: okAdmin }), hang: HANG },
  { name: 'reminder v2',
    load: async () => { const m = await import('./reminder-v2-cron.server'); return { start: m.startReminderV2Cron, stop: m.stopReminderV2Cron }; },
    lockName: 'reminder_v2_cron', feature: 'reminder_v2_cron', stuckHours: 6, beforeTarget: '2026-08-28T07:30:00Z', day: '2026-08-28', nextDay: '2026-08-29',
    ineligibleOnThisClock: '2026-08-28T06:30:00Z',
    ok: async () => [], hang: HANG },
  { name: 'chat purge',
    load: async () => { const m = await import('./chat-purge-cron.server'); return { start: m.startChatPurgeCron, stop: m.stopChatPurgeCron }; },
    lockName: 'chat_text_purge', feature: 'chat_text_purge_cron', stuckHours: 6, beforeTarget: '2026-08-28T03:30:00Z', day: '2026-08-28', nextDay: '2026-08-29',
    ineligibleOnThisClock: '2026-08-28T02:30:00Z',
    ok: noRows, hang: HANG }, // US-28 AC7
];

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; db.from = null; vi.unstubAllEnvs(); vi.useRealTimers(); });

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
  vi.stubEnv('RUN_SHARED_CRONS', 'true'); // health-tool-app's flag (US-28 AC8, US-23 AC14)
  const { tryAcquireCronLock } = await import('./supabase.server');
  const lock = vi.mocked(tryAcquireCronLock).mockReset();
  work.mockReset().mockImplementation(c.ok);
  stop = cron.stop;
  cron.start();
  return { lock };
}
const tick = () => vi.advanceTimersByTimeAsync(HOUR_MS);
// The lock's clock for a tick at `ms` (US-28 AC9): that now, less the cron's stuck limit.
const clockAt = (ms: number, stuckHours: number) => ({ now: new Date(ms), stuckCutoff: new Date(ms - stuckHours * HOUR_MS) });

describe.each(crons)('$name cron tick (untangle S-4 pins, US-28)', (c) => {
  it('takes its own lock with this machine id and its own day, first at the target hour', async () => {
    const { lock } = await boot(c, c.beforeTarget);
    lock.mockResolvedValue('won');
    await tick();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith('pin-machine', c.day, c.lockName, clockAt(Date.parse(c.beforeTarget) + HOUR_MS, c.stuckHours));
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('does not tick before the target hour on its own clock', async () => {
    const { lock } = await boot(c, c.ineligibleOnThisClock);
    lock.mockResolvedValue('won');
    await tick();
    expect(lock).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
  it('runs at most once a day, then again the next day', async () => {
    const { lock } = await boot(c, c.beforeTarget);
    lock.mockResolvedValue('won');
    await tick(); await tick(); await tick();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DAY_MS - 2 * HOUR_MS);
    expect(lock).toHaveBeenCalledTimes(2);
    expect(lock).toHaveBeenLastCalledWith('pin-machine', c.nextDay, c.lockName, clockAt(Date.parse(c.beforeTarget) + DAY_MS + HOUR_MS, c.stuckHours));
    expect(work).toHaveBeenCalledTimes(2);
  });
  it('a closed lock means no run and no retry that day', async () => {
    const { lock } = await boot(c, c.beforeTarget);
    lock.mockResolvedValue('closed');
    await tick(); await tick();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
  });
  it('a busy lock leaves the day open: every hourly tick tries again, and the run starts once won (US-28 AC9)', async () => {
    const { lock } = await boot(c, c.beforeTarget);
    lock.mockResolvedValueOnce('busy').mockResolvedValueOnce('busy').mockResolvedValue('won');
    await tick(); await tick();
    expect(lock).toHaveBeenCalledTimes(2);
    expect(work).not.toHaveBeenCalled();
    await tick();
    expect(lock).toHaveBeenCalledTimes(3);
    expect(work).toHaveBeenCalledTimes(1);
    await tick();
    expect(lock).toHaveBeenCalledTimes(3);
  });
  it('a lock error retries on the next tick (US-28 AC2)', async () => {
    const { lock } = await boot(c, c.beforeTarget);
    lock.mockRejectedValueOnce(new Error('cron lock acquire failed')).mockResolvedValue('won');
    await tick();
    expect(work).not.toHaveBeenCalled();
    await tick();
    expect(lock).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('a failed run leaves the day open, so the next tick runs it again (US-28 AC3, AC6)', async () => {
    const { lock } = await boot(c, c.beforeTarget);
    lock.mockResolvedValue('won');
    work.mockRejectedValueOnce(new Error('run failed'));
    await tick();
    expect(work).toHaveBeenCalledTimes(1);
    await tick();
    expect(lock).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(2);
    await tick();
    expect(work).toHaveBeenCalledTimes(2);
  });
  it('a run still going blocks the next tick on this machine (US-28 AC3, AC6, AC7)', async () => {
    const { lock } = await boot(c, c.beforeTarget, true);
    lock.mockResolvedValue('won');
    work.mockImplementation(c.hang);
    await tick(); await tick();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it("a run still going at the next day's eligible hour blocks that tick (US-28 AC7)", async () => {
    const { lock } = await boot(c, c.beforeTarget, true);
    lock.mockResolvedValue('won');
    work.mockImplementation(c.hang);
    await tick();                              // the day's run starts and never ends
    await vi.advanceTimersByTimeAsync(DAY_MS); // every tick through the next day's eligible hour
    expect(lock).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('a run past its stuck limit is reported once, with the cron and the hours only (US-28 AC7)', async () => {
    const { lock } = await boot(c, c.beforeTarget, true);
    lock.mockResolvedValue('won');
    work.mockImplementation(c.hang);
    const { captureMessage } = await import('@sentry/react-router');
    vi.mocked(captureMessage).mockClear();
    await tick();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    // Fake timers fire exactly on the hour, so the first tick strictly past the limit is an hour over it.
    // In production a tick lands a few ms late, so the report usually comes at the limit itself.
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith('Daily cron run still going', {
      level: 'warning', tags: { feature: c.feature, hours: c.stuckHours + 1 },
    });
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
    const lock = vi.mocked(tryAcquireCronLock).mockReset().mockResolvedValue('closed');
    stop = m.stopTrendingCron;
    m.startTrendingCron();
    await tick();
    expect(lock).toHaveBeenCalledWith('pin-machine', '2026-08-28', 'trending_cron_edu', clockAt(Date.parse(crons[0].beforeTarget) + HOUR_MS, 1));
  });
});

// US-28 AC7, the restart case: the run mark lives in memory, so a process that
// dies mid-purge loses it, and the lock row names the same FLY_MACHINE_ID, so
// the new process wins it and runs the day again. That second run must not
// archive the dead run's questions: they were held only in the dead process's
// memory, their rows were blanked by the first pass, and the archive insert is
// the last step, one statement, after every blanking pass.
describe('chat purge restart mid-run (US-28 AC7)', () => {
  interface Row { id: string; created_at: string; message: string | null; classification: string; router_context: Record<string, unknown>; conversation_id: null }
  const old = (id: string): Row => ({
    id, created_at: '2026-07-01T00:00:00Z', message: `question ${id}`, classification: 'ROUTE',
    router_context: { platform: 'widget' }, conversation_id: null,
  });

  it('a fresh process re-runs the day and archives only questions still on their rows', async () => {
    const events: Row[] = [old('dead-run-1'), old('dead-run-2')];
    const inserts: { question: string }[][] = [];
    const selectFilters: string[] = [];
    let messagesPass: () => Promise<unknown> = HANG; // the first process dies here
    db.from = (table) => {
      const q: { op: string; payload?: any; id?: string; holds?: string[]; blank?: string[] } = { op: 'select' };
      const answer = async (): Promise<unknown> => {
        if (table === 'chat_match_events' && q.op === 'select') {
          // Honour the `.or()` the purge gave: a row qualifies if any named column holds text.
          // The blank check's `.is(col, null)` filters instead: a row qualifies if every named column is null.
          const holds = q.holds ?? [];
          const rows = q.blank
            ? events.filter((r) => q.blank!.every((col) => (r as any)[col] == null))
            : events.filter((r) => holds.some((col) => (r as any)[col] != null));
          return { data: rows.map((r) => ({ ...r })), error: null };
        }
        if (table === 'chat_match_events' && q.op === 'update') {
          Object.assign(events.find((r) => r.id === q.id)!, { message: q.payload.message });
          return { error: null };
        }
        if (table === 'chat_question_archive') { inserts.push(q.payload); return { error: null }; }
        if (table === 'chat_messages') return messagesPass();
        return noRows();
      };
      const builder: unknown = new Proxy({}, {
        get: (_t, key) => key === 'then'
          ? (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => answer().then(ok, fail)
          : (...args: any[]) => {
            if (key === 'update' || key === 'insert') { q.op = key; q.payload = args[0]; }
            if (key === 'eq') q.id = args[1];
            if (key === 'is') q.blank = [...(q.blank ?? []), args[0]];
            if (key === 'or' && table === 'chat_match_events') {
              selectFilters.push(args[0]);
              q.holds = String(args[0]).split(',').map((f) => f.replace(/\.not\.is\.null$/, ''));
            }
            return builder;
          },
      });
      return builder;
    };

    // Process one: wins the lock, blanks both rows, holds both questions, then hangs.
    const first = await boot(crons[2], crons[2].beforeTarget, true);
    vi.stubEnv('CHAT_QUESTION_ARCHIVE', 'on');
    first.lock.mockResolvedValue('won');
    await tick();
    expect(events.map((r) => r.message)).toEqual([null, null]);
    expect(inserts).toEqual([]);
    stop?.(); // the process dies; its held questions die with it

    // Process two, same machine, same day: a new row has aged past the window meanwhile.
    events.push(old('still-held'));
    messagesPass = noRows;
    const second = await boot(crons[2], '2026-08-28T05:30:00Z', true);
    vi.stubEnv('CHAT_QUESTION_ARCHIVE', 'on');
    const { scrubQuestion } = await import('./chat-question-scrub.server');
    vi.mocked(scrubQuestion).mockImplementation(async (text: string) => `scrubbed: ${text}`);
    second.lock.mockResolvedValue('won');
    await tick();
    await vi.waitFor(() => expect(inserts).toHaveLength(1));

    expect(second.lock).toHaveBeenCalledWith('pin-machine', '2026-08-28', 'chat_text_purge', clockAt(Date.parse('2026-08-28T06:30:00Z'), 6));
    expect(selectFilters.length).toBeGreaterThan(0);
    expect(selectFilters.every((f) => f.includes('message.not.is.null'))).toBe(true);
    expect(vi.mocked(scrubQuestion).mock.calls.map(([text]) => text)).toEqual(['question still-held']);
    expect(inserts[0].map((r) => r.question)).toEqual(['scrubbed: question still-held']);
  });
});
