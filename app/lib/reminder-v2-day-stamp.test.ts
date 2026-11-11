import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// US-23 AC15 (2026-11-11): the reminder day-stamp. Before each send the pass
// reads the row's attempting_on; if it already names today (or a later day) it
// skips; else it stamps today, reads the stamp back, sends, and records
// last_sent. The stamp is not a mutex: the cron lock decides who runs. It
// guards a later re-run the same day, after a restart, against anyone whose
// send was in flight when the old process died.
//
// Real processV2Reminders, getOptinsBatch and recordSent over a fake
// reminder_optin_v2 table; a fresh module graph stands for a restart.

interface Row {
  id: string; email: string; provider: string; token: string; created_at: string;
  schedule: { category: string; label: string; dueAt: string }[];
  last_sent: Record<string, string>; attempting_on: string | null;
}

const db = vi.hoisted(() => ({
  rows: [] as Row[],
  log: [] as string[],         // reads, writes and sends, in order
  builders: [] as string[][],  // each builder's method names
  send: null as null | ((email: string) => Promise<boolean>),
  // Runs once just before a stamp write lands: another writer racing in
  // between a pass's read and its write.
  beforeStampWrite: null as null | (() => void),
}));

vi.mock('./supabase.server', () => {
  function from(table: string) {
    if (table !== 'reminder_optin_v2') throw new Error(`fake: unexpected table ${table}`);
    const calls: string[] = [];
    db.builders.push(calls);
    const preds: ((r: Row) => boolean)[] = [];
    let cols = '';
    let patch: Partial<Row> | null = null;
    let limit = Infinity;
    let single = false;
    const run = async () => {
      if (patch) {
        if ('attempting_on' in patch && db.beforeStampWrite) { const race = db.beforeStampWrite; db.beforeStampWrite = null; race(); }
        const hit = db.rows.filter((r) => preds.every((p) => p(r)));
        db.log.push(`update ${Object.keys(patch).filter((k) => k !== 'updated_at').join(',')}`);
        for (const r of hit) Object.assign(r, patch);
        return { data: null, error: null };
      }
      const hit = db.rows.filter((r) => preds.every((p) => p(r)));
      if (cols === 'attempting_on') db.log.push('select attempting_on');
      const out = hit.sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit).map((r) => structuredClone(r));
      return { data: single ? out[0] ?? null : out, error: null };
    };
    const b: Record<string, unknown> = {
      select: (c: string) => { calls.push('select'); cols = c; return b; },
      update: (p: Partial<Row>) => { calls.push('update'); patch = p; return b; },
      eq: (c: keyof Row, v: unknown) => { calls.push('eq'); preds.push((r) => r[c] === v); return b; },
      // Only the stamp guard's shape: `col.is.null,col.lt.value`.
      or: (f: string) => {
        calls.push('or');
        const terms = f.split(',').map((t) => t.split('.') as [keyof Row, string, string]);
        preds.push((r) => terms.some(([c, op, v]) => (op === 'is' && v === 'null' ? r[c] === null : op === 'lt' ? r[c] !== null && String(r[c]) < v : false)));
        return b;
      },
      gt: (c: keyof Row, v: string) => { calls.push('gt'); preds.push((r) => String(r[c]) > v); return b; },
      order: () => { calls.push('order'); return b; },
      limit: (n: number) => { calls.push('limit'); limit = n; return b; },
      maybeSingle: () => { calls.push('maybeSingle'); single = true; return run(); },
      then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => run().then(ok, fail),
    };
    return b;
  }
  return { supabaseAdmin: { from }, tryAcquireCronLock: vi.fn(), endCronLock: vi.fn() };
});
vi.mock('./reminder-v2.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reminder-v2.server')>()),
  purgeTombstones: vi.fn(async () => 0),
}));
vi.mock('./email.server', () => ({
  APP_BASE_URL: 'https://example.test',
  buildReminderV2EmailHtml: vi.fn(() => '<html></html>'),
  sendReminderEmail: vi.fn(async (email: string) => {
    db.log.push(`send ${email}`);
    return db.send ? db.send(email) : true;
  }),
}));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const D = '2026-08-28';
const NEXT = '2026-08-29';
const due = (id: string, over: Partial<Row> = {}): Row => ({
  id, email: `${id}@example.test`, provider: 'typed', token: `tok-${id}`, created_at: '2026-07-01T00:00:00Z',
  schedule: [{ category: 'blood_test_lipids', label: 'Lipid panel', dueAt: '2026-08-01' }],
  last_sent: {}, attempting_on: null, ...over,
});

/** A fresh module graph: a new process, with nothing in memory. */
async function freshProcess() {
  vi.resetModules();
  return (await import('./reminder-v2-cron.server')).processV2Reminders;
}
const sends = () => db.log.filter((l) => l.startsWith('send '));
const sendsTo = (id: string) => sends().filter((l) => l === `send ${id}@example.test`).length;

beforeEach(() => {
  db.rows = [];
  db.log = [];
  db.builders = [];
  db.send = null;
  db.beforeStampWrite = null;
});

describe('US-23 AC15: the reminder day-stamp', () => {
  it('reads the stamp, writes it, reads it back, sends, then records last_sent, in that order', async () => {
    db.rows = [due('a')];
    await (await freshProcess())(D);
    expect(db.log).toEqual(['select attempting_on', 'update attempting_on', 'select attempting_on', 'send a@example.test', 'update last_sent']);
    expect(db.rows[0]).toMatchObject({ attempting_on: D, last_sent: { blood_test_lipids: D } });
  });

  it('no write in the send path asks for its rows back (.select() on an update)', async () => {
    db.rows = [due('a')];
    await (await freshProcess())(D);
    for (const calls of db.builders.filter((c) => c.includes('update'))) expect(calls).not.toContain('select');
  });

  it('a restart after the hour sends nobody a second email the same day, a send in flight at the kill included', async () => {
    db.rows = [due('a'), due('b'), due('c')];
    db.send = (email) => (email === 'b@example.test' ? new Promise<never>(() => {}) : Promise.resolve(true));
    void (await freshProcess())(D); // b's send never returns: the process dies there
    await vi.waitFor(() => {
      expect(sends()).toHaveLength(3);
      expect(db.rows.filter((r) => r.last_sent.blood_test_lipids === D).map((r) => r.id)).toEqual(['a', 'c']);
    });

    db.send = null; // the new process: every send works
    await (await freshProcess())(D);
    expect([sendsTo('a'), sendsTo('b'), sendsTo('c')]).toEqual([1, 1, 1]);
  });

  it('a stamp with no send (the process died between them) sends nothing that day and sends the next day', async () => {
    db.rows = [due('a', { attempting_on: D })];
    await (await freshProcess())(D);
    expect(sendsTo('a')).toBe(0);
    await (await freshProcess())(NEXT);
    expect(sendsTo('a')).toBe(1);
    expect(db.rows[0]).toMatchObject({ attempting_on: NEXT, last_sent: { blood_test_lipids: NEXT } });
  });

  it('a provider error after the stamp keeps the stamp: nothing more that day, a send the next day', async () => {
    db.rows = [due('a')];
    db.send = async () => false;
    const run = await freshProcess();
    await run(D);
    expect(sendsTo('a')).toBe(1);
    expect(db.rows[0].attempting_on).toBe(D);

    db.send = null;
    await run(D);                    // a retried pass, same process
    await (await freshProcess())(D); // and after a restart
    expect(sendsTo('a')).toBe(1);

    await (await freshProcess())(NEXT);
    expect(sendsTo('a')).toBe(2);
  });

  it('a pass for an earlier day never moves a later stamp back, so that later day never sends twice', async () => {
    db.rows = [due('a', { attempting_on: NEXT })];
    await (await freshProcess())(D); // a stalled earlier-day pass
    expect(sendsTo('a')).toBe(0);
    expect(db.rows[0].attempting_on).toBe(NEXT);
  });

  it('a newer stamp that lands between an older pass\'s read and its write stays, and that pass sends nothing (Codex R2)', async () => {
    db.rows = [due('a')];
    // The D pass reads NULL, stalls; meanwhile a D+1 pass stamps D+1; then the D write lands.
    db.beforeStampWrite = () => { db.rows[0].attempting_on = NEXT; };
    await (await freshProcess())(D);
    expect(db.rows[0].attempting_on).toBe(NEXT);
    expect(sendsTo('a')).toBe(0);
  });

  it('the stamp write is guarded in the UPDATE itself: NULL or an earlier day only, with no .select()', async () => {
    db.rows = [due('a')];
    await (await freshProcess())(D);
    const write = db.builders.find((c) => c.includes('update') && c.includes('or'));
    expect(write).toBeDefined();
    expect(write).not.toContain('select');
  });
});

// US-28 AC9 with US-23 AC15: machine A's pass dies mid-way; machine B's cron
// meets A's fresh run (busy) at 08:30 and 09:30, takes the day over at 10:30,
// and runs the pass once. The stamps skip everyone A went to email, so across
// the two passes each person gets at most one email that day.
describe('US-23 AC15 with US-28 AC9: a busy answer, then a takeover', () => {
  const HOUR_MS = 60 * 60 * 1000;
  let stop: (() => void) | null = null;
  afterEach(() => { stop?.(); stop = null; vi.unstubAllEnvs(); vi.useRealTimers(); });

  it('B tries at 08:30 and 09:30 (busy), runs once at 10:30, and emails only whom A never reached', async () => {
    db.rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => due(id));
    db.send = (email) => (email === 'b@example.test' ? new Promise<never>(() => {}) : Promise.resolve(true));
    void (await freshProcess())(D); // machine A: the first five are stamped and sent; b never returns, f is never reached
    await vi.waitFor(() => expect(sends()).toHaveLength(5));
    db.send = null;

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(`${D}T07:30:00Z`));
    vi.resetModules();
    vi.stubEnv('FLY_MACHINE_ID', 'machine-b');
    const cron = await import('./reminder-v2-cron.server'); // NODE_ENV=test: self-start is a no-op
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RUN_SHARED_CRONS', 'true');
    const lock = vi.mocked((await import('./supabase.server')).tryAcquireCronLock)
      .mockReset().mockResolvedValueOnce('busy').mockResolvedValueOnce('busy').mockResolvedValue('won');
    stop = cron.stopReminderV2Cron;
    cron.startReminderV2Cron();

    await vi.advanceTimersByTimeAsync(2 * HOUR_MS); // 08:30, 09:30: busy, no pass
    expect(lock).toHaveBeenCalledTimes(2);
    expect(sends()).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(HOUR_MS);     // 10:30: won, the pass runs
    expect(lock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(HOUR_MS);     // 11:30: the day is done here
    expect(lock).toHaveBeenCalledTimes(3);
    expect(['a', 'b', 'c', 'd', 'e', 'f'].map(sendsTo)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
