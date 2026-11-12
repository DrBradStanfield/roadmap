/**
 * US-17 AC16 / AC10 and US-23 AC5: a reminder opt-in is decided once.
 *  - Two verified opt-ins for one address at the same time leave one row and
 *    one token; both callers get that token; one plan-ready email, one
 *    `reminder_optin`.
 *  - An unsubscribe is not undone by a schedule push in flight.
 *
 * The primed-sequence stub in reminder-v2-typed.test.ts cannot model two
 * callers, so this file runs the real lib against a stateful in-memory
 * `reminder_optin_v2`: unique email and token (a duplicate insert answers
 * 23505), filters read when a write APPLIES (as Postgres re-checks the WHERE
 * under the row lock), and a barrier that holds every query until the test
 * releases it in a scripted order.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// The fake table
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message: string } | null };
interface PendingOp { tag: string | undefined; label: string; run: () => void }

/** Which caller issued a query: the scripted order releases by this tag. */
const caller = new AsyncLocalStorage<string>();

/** PostgREST sends filter values as text; a jsonb column compares as its JSON text. */
function same(a: unknown, b: unknown): boolean {
  const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  return text(a) === text(b);
}

class FakeDb {
  rows: Row[] = [];
  pending: PendingOp[] = [];
  private ids = 0;
  private holding = false;

  reset(): void {
    this.rows = [];
    this.pending = [];
    this.ids = 0;
    this.holding = false;
  }

  nextId(): string {
    return `id-${String(++this.ids).padStart(4, '0')}`;
  }

  seed(row: Row): void {
    const now = new Date().toISOString();
    this.rows.push({ id: this.nextId(), last_sent: {}, created_at: now, updated_at: now, ...row });
  }

  row(email: string): Row | undefined {
    return this.rows.find((r) => r.email === email);
  }

  /** From now on every query waits in `pending` until released. */
  hold(): void {
    this.holding = true;
  }

  /** Stop holding; release what is waiting, in arrival order. */
  auto(): void {
    this.holding = false;
    for (const op of this.pending.splice(0)) op.run();
  }

  submit(label: string, apply: () => Result): Promise<Result> {
    return new Promise((resolve) => {
      const op: PendingOp = { tag: caller.getStore(), label, run: () => resolve(apply()) };
      if (this.holding) this.pending.push(op);
      else queueMicrotask(op.run);
    });
  }

  /** A 23505 when `candidate` would share an email or token with another row. */
  clash(candidate: Row, self?: Row): Result | null {
    const dup = this.rows.some((r) => r !== self && (r.email === candidate.email || r.token === candidate.token));
    return dup ? { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } } : null;
  }

  from(table: string): FakeQuery {
    if (table !== 'reminder_optin_v2') throw new Error(`unexpected table ${table}`);
    return new FakeQuery(this);
  }
}

class FakeQuery implements PromiseLike<Result> {
  private kind: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private payload: Row = {};
  private columns: string[] | null = null;
  private returning = false;
  private filters: Array<(row: Row) => boolean> = [];
  private single = false;
  private cap: number | null = null;

  constructor(private readonly db: FakeDb) {}

  select(cols?: string): this {
    if (this.kind === 'select') this.columns = cols ? cols.split(',').map((c) => c.trim()) : null;
    else this.returning = true;
    return this;
  }
  insert(row: Row): this { this.kind = 'insert'; this.payload = row; return this; }
  upsert(row: Row, opts: { onConflict: string }): this {
    if (opts.onConflict !== 'email') throw new Error('fake upsert knows only onConflict email');
    this.kind = 'upsert'; this.payload = row; return this;
  }
  update(patch: Row): this { this.kind = 'update'; this.payload = patch; return this; }
  delete(): this { this.kind = 'delete'; return this; }
  eq(col: string, v: unknown): this { this.filters.push((r) => same(r[col], v)); return this; }
  neq(col: string, v: unknown): this { this.filters.push((r) => !same(r[col], v)); return this; }
  gt(col: string, v: unknown): this { this.filters.push((r) => String(r[col]) > String(v)); return this; }
  lt(col: string, v: unknown): this { this.filters.push((r) => String(r[col]) < String(v)); return this; }
  in(col: string, vs: unknown[]): this { this.filters.push((r) => vs.some((v) => same(r[col], v))); return this; }
  order(): this { return this; }
  limit(n: number): this { this.cap = n; return this; }

  maybeSingle(): Promise<Result> {
    this.single = true;
    return this.run();
  }

  then<A = Result, B = never>(
    onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onFulfilled, onRejected);
  }

  private run(): Promise<Result> {
    return this.db.submit(this.kind, () => this.apply());
  }

  /** Runs when the barrier releases the query: filters read the table as it is THEN. */
  private apply(): Result {
    const db = this.db;
    const matched = () => db.rows.filter((r) => this.filters.every((f) => f(r))).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const copy = (r: Row) => structuredClone(this.columns ? Object.fromEntries(this.columns.map((c) => [c, r[c]])) : r);
    const now = new Date().toISOString();
    switch (this.kind) {
      case 'select': {
        const rows = matched().slice(0, this.cap ?? undefined);
        if (!this.single) return { data: rows.map(copy), error: null };
        if (rows.length > 1) return { data: null, error: { message: 'more than one row' } };
        return { data: rows[0] ? copy(rows[0]) : null, error: null };
      }
      case 'insert': {
        const row = { id: db.nextId(), last_sent: {}, created_at: now, updated_at: now, ...structuredClone(this.payload) };
        const clash = db.clash(row);
        if (clash) return clash;
        db.rows.push(row);
        return { data: this.returning ? [copy(row)] : null, error: null };
      }
      case 'upsert': {
        // INSERT ... ON CONFLICT (email) DO UPDATE SET <every column sent>.
        const existing = db.rows.find((r) => r.email === this.payload.email);
        if (!existing) {
          const row = { id: db.nextId(), last_sent: {}, created_at: now, updated_at: now, ...structuredClone(this.payload) };
          const clash = db.clash(row);
          if (clash) return clash;
          db.rows.push(row);
          return { data: null, error: null };
        }
        const clash = db.clash({ ...existing, ...this.payload }, existing);
        if (clash) return clash;
        Object.assign(existing, structuredClone(this.payload));
        return { data: null, error: null };
      }
      case 'update': {
        const rows = matched();
        for (const r of rows) {
          const clash = db.clash({ ...r, ...this.payload }, r);
          if (clash) return clash;
        }
        for (const r of rows) Object.assign(r, structuredClone(this.payload));
        return { data: this.returning ? rows.map(copy) : null, error: null };
      }
      case 'delete': {
        const rows = matched();
        db.rows = db.rows.filter((r) => !rows.includes(r));
        return { data: this.returning ? rows.map(copy) : null, error: null };
      }
    }
  }
}

const db = new FakeDb();

// ---------------------------------------------------------------------------
// Scheduling helpers
// ---------------------------------------------------------------------------

/** Let every caller run until it is waiting on the table (or finished). */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
}

type Callers<T> = Record<string, () => Promise<T>>;

function start<T>(callers: Callers<T>): { done: Set<string>; results: Promise<PromiseSettledResult<T>[]> } {
  const done = new Set<string>();
  const runs = Object.entries(callers).map(([tag, fn]) => caller.run(tag, fn).finally(() => done.add(tag)));
  return { done, results: Promise.allSettled(runs) };
}

function values<T>(settled: PromiseSettledResult<T>[]): T[] {
  return settled.map((s) => {
    if (s.status === 'rejected') throw s.reason;
    return s.value;
  });
}

/** Released together: each round, every live caller's next query applies, in arrival order. */
async function lockstep<T>(callers: Callers<T>): Promise<T[]> {
  db.hold();
  const { done, results } = start(callers);
  for (let round = 0; round < 50; round++) {
    await settle();
    if (done.size === Object.keys(callers).length) break;
    // Exactly one waiting query per caller still running: a caller that is late
    // to the table would otherwise drop out of the round and run alone.
    const live = Object.keys(callers).filter((tag) => !done.has(tag)).sort();
    const batch = db.pending.splice(0);
    const waiting = batch.map((op) => op.tag ?? '?').sort();
    if (JSON.stringify(waiting) !== JSON.stringify(live)) {
      throw new Error(`round ${round}: waiting ${waiting.join(',') || 'none'}, running ${live.join(',')}`);
    }
    for (const op of batch) op.run();
  }
  db.auto();
  return values(await results);
}

/** Release one query per entry of `order`, from the caller it names; then run free. */
async function scripted<T>(callers: Callers<T>, order: string[]): Promise<PromiseSettledResult<T>[]> {
  db.hold();
  const { results } = start(callers);
  for (const tag of order) {
    await settle();
    const i = db.pending.findIndex((op) => op.tag === tag);
    if (i < 0) throw new Error(`no query from ${tag} is waiting (pending: ${db.pending.map((op) => `${op.tag}:${op.label}`).join(', ')})`);
    db.pending.splice(i, 1)[0].run();
  }
  db.auto();
  return results;
}

// ---------------------------------------------------------------------------
// The module graph under test
// ---------------------------------------------------------------------------

const sendPlanReadyEmail = vi.fn(async () => true);
const recordServerEvent = vi.fn(async (_name: string, _meta?: unknown) => {});

vi.mock('./supabase.server', () => ({
  get supabaseAdmin() { return db; },
  hashClientIp: (ip: string) => `h:${ip}`,
}));
vi.mock('./klaviyo.server', () => ({ subscribeToKlaviyo: vi.fn(async () => {}) }));
vi.mock('./email.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendPlanReadyEmail: (...a: unknown[]) => sendPlanReadyEmail(...(a as [])),
}));
vi.mock('./product-events.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordServerEvent: (name: string, meta?: unknown) => recordServerEvent(name, meta),
}));

import {
  deleteByEmail,
  getOptinsBatch,
  unsubscribeByToken,
  updateScheduleByToken,
  upsertVerifiedOptin,
  type Enrolment,
} from './reminder-v2.server';
import { action } from '../routes/api.reminders-v2';

const OWNER = 'owner@example.com';
const ITEM = { category: 'blood_test_lipids', label: 'Lipid panel blood test', dueAt: '2027-05-12' };
const SCHEDULE = [ITEM];
const CLIENT_ID = 'client-c14';

let ipCounter = 0;
function post(body: unknown): Request {
  return new Request('https://health-tool-app.fly.dev/api/reminders-v2', {
    method: 'POST',
    headers: { Origin: 'https://drstanfield.com', 'fly-client-ip': `10.14.0.${++ipCounter}` },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  vi.stubEnv('GOOGLE_DRIVE_CLIENT_ID', CLIENT_ID);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ aud: CLIENT_ID, email_verified: 'true', email: OWNER })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The fake itself: without these, the pins below prove nothing
// ---------------------------------------------------------------------------

describe('the fake reminder_optin_v2 table', () => {
  it('answers 23505 to a second row with the same email or the same token', async () => {
    db.seed({ email: OWNER, provider: 'typed', token: 'tok-a', schedule: SCHEDULE });
    const sameEmail = await db.from('reminder_optin_v2').insert({ email: OWNER, provider: 'typed', token: 'tok-b', schedule: SCHEDULE });
    const sameToken = await db.from('reminder_optin_v2').insert({ email: 'other@example.com', provider: 'typed', token: 'tok-a', schedule: SCHEDULE });
    expect(sameEmail.error?.code).toBe('23505');
    expect(sameToken.error?.code).toBe('23505');
    expect(db.rows).toHaveLength(1);
  });

  it('reads an UPDATE filter when the write applies: one whose filter stopped matching while it waited changes nothing', async () => {
    db.seed({ email: OWNER, provider: 'typed', token: 'tok-squat', schedule: SCHEDULE });
    await scripted({
      rotate: async () => db.from('reminder_optin_v2').update({ token: 'tok-a' }).eq('email', OWNER).neq('provider', 'google-drive'),
      verify: async () => db.from('reminder_optin_v2').update({ provider: 'google-drive' }).eq('email', OWNER),
    }, ['verify', 'rotate']);
    expect(db.row(OWNER)).toMatchObject({ provider: 'google-drive', token: 'tok-squat' });
  });

  it('applies the same UPDATE when its filter still matches (the control for the case above)', async () => {
    db.seed({ email: OWNER, provider: 'typed', token: 'tok-squat', schedule: SCHEDULE });
    await scripted({
      rotate: async () => db.from('reminder_optin_v2').update({ token: 'tok-a' }).eq('email', OWNER).neq('provider', 'google-drive'),
      verify: async () => db.from('reminder_optin_v2').update({ provider: 'google-drive' }).eq('email', OWNER),
    }, ['rotate', 'verify']);
    expect(db.row(OWNER)).toMatchObject({ provider: 'google-drive', token: 'tok-a' });
  });

  it('compares a jsonb column with its JSON text, as the tombstone filters do', async () => {
    db.seed({ email: OWNER, provider: 'typed', token: 'tok-a', schedule: [] });
    const { data } = await db.from('reminder_optin_v2').select('token').neq('schedule', '[]');
    expect(data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pins: as the caller sees them
// ---------------------------------------------------------------------------

describe('US-17 AC16: two verified opt-ins for one address at once', () => {
  it('with no row yet: one token for both, exactly one isNew, and that token pushes', async () => {
    const [a, b] = await lockstep({
      a: () => upsertVerifiedOptin(OWNER, SCHEDULE),
      b: () => upsertVerifiedOptin(OWNER, SCHEDULE),
    });

    expect(a.token).toBeDefined();
    expect(b.token).toBe(a.token);
    expect([a, b].filter((r: Enrolment) => r.isNew)).toHaveLength(1);
    expect(db.rows).toHaveLength(1);
    expect(await updateScheduleByToken(a.token!, SCHEDULE)).toBe(true);
    expect(await updateScheduleByToken(b.token!, SCHEDULE)).toBe(true);
  });

  it("over another lane's row: one new token for both, the old token pushes nothing", async () => {
    db.seed({ email: OWNER, provider: 'typed', token: 'tok-squat', schedule: SCHEDULE, last_sent: { blood_test_lipids: '2026-08-01' } });

    const [a, b] = await lockstep({
      a: () => upsertVerifiedOptin(OWNER, SCHEDULE),
      b: () => upsertVerifiedOptin(OWNER, SCHEDULE),
    });

    expect(a.token).toBeDefined();
    expect(a.token).not.toBe('tok-squat');
    expect(b.token).toBe(a.token);
    expect([a, b].filter((r: Enrolment) => r.isNew)).toHaveLength(0);
    expect(await updateScheduleByToken('tok-squat', SCHEDULE)).toBe(false);
    expect(await updateScheduleByToken(a.token!, SCHEDULE)).toBe(true);
    expect(db.row(OWNER)).toMatchObject({ provider: 'google-drive', last_sent: { blood_test_lipids: '2026-08-01' } });
  });

  it("over another lane's row, one caller finishing before the other's rotation: the late rotation changes nothing", async () => {
    db.seed({ email: OWNER, provider: 'typed', token: 'tok-squat', schedule: SCHEDULE });

    // a: insert (23505), rotate, refresh, read-back; only then b's rotation.
    const settled = await scripted({
      a: () => upsertVerifiedOptin(OWNER, SCHEDULE),
      b: () => upsertVerifiedOptin(OWNER, SCHEDULE),
    }, ['a', 'b', 'a', 'a', 'a', 'b']);
    const [a, b] = values(settled);

    expect(a.token).toBeDefined();
    expect(a.token).not.toBe('tok-squat');
    expect(b.token).toBe(a.token);
    expect(db.row(OWNER)?.token).toBe(a.token);
  });

  it('at the route (US-17 AC10): two 200s with one token, one plan-ready email, one reminder_optin', async () => {
    const body = { op: 'optin', provider: 'google-drive', idToken: 'id-token-c14', schedule: SCHEDULE };
    const [first, second] = await lockstep({
      a: () => action({ request: post(body) } as never),
      b: () => action({ request: post(body) } as never),
    });

    expect([first.status, second.status]).toEqual([200, 200]);
    const [ja, jb] = (await Promise.all([first.json(), second.json()])) as Array<{ token: string }>;
    expect(ja.token).toBeDefined();
    expect(jb.token).toBe(ja.token);
    expect(sendPlanReadyEmail).toHaveBeenCalledTimes(1);
    expect(recordServerEvent.mock.calls.filter(([name]) => name === 'reminder_optin')).toHaveLength(1);
  });
});

describe('US-23 AC5: an unsubscribe is not undone by a schedule push in flight', () => {
  it('push reads, click reads, click writes, push writes: the row stays switched off', async () => {
    db.seed({ email: OWNER, provider: 'google-drive', token: 'tok-a', schedule: SCHEDULE });

    const settled = await scripted<unknown>({
      push: () => updateScheduleByToken('tok-a', SCHEDULE),
      click: () => unsubscribeByToken('tok-a'),
    }, ['push', 'click', 'click', 'push']);
    values(settled);

    expect(await updateScheduleByToken('tok-a', SCHEDULE)).toBe(false);
    expect((await getOptinsBatch(10, null)).map((r) => r.schedule)).toEqual([[]]);
  });

  it("the next app load's push (the device's only call when its file holds the token) answers 404 and refills nothing", async () => {
    db.seed({ email: OWNER, provider: 'google-drive', token: 'tok-a', schedule: SCHEDULE });
    expect(await unsubscribeByToken('tok-a')).toBe('google-drive');

    const res = await action({ request: post({ op: 'update', token: 'tok-a', schedule: SCHEDULE }) } as never);

    expect(res.status).toBe(404); // the device flips its file to cancelled on this answer
    expect(db.row(OWNER)?.schedule).toEqual([]);
  });
});

describe('a verified opt-in, one caller at a time', () => {
  it('no row: creates a google-drive row and answers isNew with its token', async () => {
    const result = await upsertVerifiedOptin(OWNER, SCHEDULE);
    expect(result.isNew).toBe(true);
    expect(db.row(OWNER)).toMatchObject({ provider: 'google-drive', token: result.token, last_sent: {} });
  });

  it('its own row: keeps the token and last_sent (links already sent keep working) and refreshes the schedule', async () => {
    db.seed({ email: OWNER, provider: 'google-drive', token: 'tok-a', schedule: [], last_sent: { blood_test_lipids: '2026-08-01' } });
    const result = await upsertVerifiedOptin(OWNER, SCHEDULE);
    expect(result).toEqual({ isNew: false, token: 'tok-a' });
    expect(db.row(OWNER)).toMatchObject({ token: 'tok-a', schedule: SCHEDULE, last_sent: { blood_test_lipids: '2026-08-01' } });
  });

  it("another lane's row: rotates the token, so the old holder can no longer cancel, and keeps last_sent", async () => {
    db.seed({ email: OWNER, provider: 'dropbox', token: 'tok-squat', schedule: SCHEDULE, last_sent: { blood_test_lipids: '2026-08-01' } });
    const result = await upsertVerifiedOptin(OWNER, SCHEDULE);
    expect(result.isNew).toBe(false);
    expect(result.token).not.toBe('tok-squat');
    expect(db.row(OWNER)).toMatchObject({ provider: 'google-drive', token: result.token, last_sent: { blood_test_lipids: '2026-08-01' } });
    expect(await unsubscribeByToken('tok-squat')).toBeNull();
  });
});

describe('a verified opt-in whose row changes under it (Q1: retry once, then fail)', () => {
  it('the row is deleted after the insert lost: the retry inserts, and that caller is the new row', async () => {
    db.seed({ email: OWNER, provider: 'typed', token: 'tok-squat', schedule: SCHEDULE });
    const settled = await scripted<unknown>({
      v: () => upsertVerifiedOptin(OWNER, SCHEDULE),
      x: () => deleteByEmail(OWNER),
    }, ['v', 'x']);
    const [result] = values(settled) as [Enrolment];
    expect(result.isNew).toBe(true);
    expect(db.row(OWNER)).toMatchObject({ provider: 'google-drive', token: result.token });
  });

  it('another lane re-creates the row after every attempt: the opt-in throws rather than loop', async () => {
    db.seed({ email: OWNER, provider: 'typed', token: 'tok-squat', schedule: SCHEDULE });
    const churn = async () => {
      for (const token of ['tok-x1', 'tok-x2']) {
        await deleteByEmail(OWNER);
        await db.from('reminder_optin_v2').insert({ email: OWNER, provider: 'typed', token, schedule: SCHEDULE });
      }
    };
    // Each attempt: v insert (23505), x delete, v rotate and refresh (no row), x re-insert, v read-back (another lane).
    const settled = await scripted<unknown>({ v: () => upsertVerifiedOptin(OWNER, SCHEDULE), x: churn },
      ['v', 'x', 'v', 'v', 'x', 'v', 'v', 'x', 'v', 'v', 'x', 'v']);
    expect(settled[0].status).toBe('rejected');
    expect(db.row(OWNER)).toMatchObject({ provider: 'typed', token: 'tok-x2' });
  });
});
