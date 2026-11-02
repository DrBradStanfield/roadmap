/**
 * US-23 (a reminder goes out when it is due): the daily pass reads every
 * opt-in once, even while rows are deleted under it.
 *
 * The cron's own sends cause deletes: a permanent bounce reaches the Resend
 * webhook within seconds and `deleteByEmail` removes the row, and erase and
 * the email unsubscribe can land at any time. With offset paging, each row
 * deleted from a page already read moved every later row back by one, so the
 * next page started one row late and a due user was not read that day.
 *
 * Real `processV2Reminders`, `getOptinsBatch`, `deleteByEmail`, `recordSent`
 * and `purgeTombstones`, through the real supabase-js client over a fetch
 * that plays a small PostgREST (filters, `order`, `offset`, `limit`, the
 * representation `deleteByEmail` asks for).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = {
  id: string; email: string; provider: string; token: string; created_at: string; updated_at: string;
  schedule: { category: string; label: string; dueAt: string }[]; last_sent: Record<string, string>;
};

const db = vi.hoisted(() => ({
  table: [] as Row[],
  readIds: [] as string[], // every opt-in id the cron's page reads returned, in order
  bouncing: new Set<string>(),
  rowsAtStart: 0,
}));

vi.mock('./supabase.server', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const JSONB = new Set(['schedule', 'last_sent']);
  type R = Record<string, unknown>;

  function predicate(column: string, raw: string): (r: R) => boolean {
    const dot = raw.indexOf('.');
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    const cell = (r: R) => String(r[column]);
    if (op === 'gt') return (r) => cell(r) > value;
    if (op === 'lt') return (r) => cell(r) < value;
    if (op === 'eq') {
      return JSONB.has(column)
        ? (r) => JSON.stringify(r[column]) === JSON.stringify(JSON.parse(value))
        : (r) => cell(r) === value;
    }
    if (op === 'in') {
      const set = new Set(value.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')));
      return (r) => set.has(cell(r));
    }
    throw new Error(`fake PostgREST: unsupported operator ${op}`);
  }

  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const preds: ((r: R) => boolean)[] = [];
    let select: string[] | null = null;
    let order: { col: string; asc: boolean }[] = [];
    let offset = 0;
    let limit = Infinity;
    try {
      for (const [key, raw] of url.searchParams) {
        if (key === 'select') select = raw.split(',');
        else if (key === 'order') order = raw.split(',').map((o) => ({ col: o.split('.')[0], asc: !o.includes('.desc') }));
        else if (key === 'offset') offset = Number(raw);
        else if (key === 'limit') limit = Number(raw);
        else preds.push(predicate(key, raw));
      }
    } catch (e) {
      return new Response(JSON.stringify({ message: (e as Error).message }), { status: 400 });
    }
    const hit = (r: Row) => preds.every((p) => p(r as unknown as R));
    const project = (r: Row) => (select ? Object.fromEntries(select.map((c) => [c, (r as unknown as R)[c]])) : r);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    if (method === 'GET') {
      // A walk that never ends would spin in microtasks past any test timeout.
      if (db.readIds.length > 10 * db.rowsAtStart + 100) {
        return new Response(JSON.stringify({ message: 'fake PostgREST: walk did not end' }), { status: 500 });
      }
      const rows = db.table.filter(hit);
      if (order.length) {
        rows.sort((a, b) => {
          for (const { col, asc } of order) {
            const x = String((a as unknown as R)[col]);
            const y = String((b as unknown as R)[col]);
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
      }
      const page = rows.slice(offset, offset + limit).slice(0, 1000).map(project);
      if (select?.includes('token')) db.readIds.push(...page.map((r) => String(r.id)));
      return json(page);
    }
    if (method === 'DELETE') {
      const gone = db.table.filter(hit);
      db.table = db.table.filter((r) => !hit(r));
      return json(gone.map(project));
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(String(init?.body ?? '{}'));
      db.table = db.table.map((r) => (hit(r) ? { ...r, ...patch } : r));
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ message: `fake PostgREST: ${method}` }), { status: 405 });
  }

  return {
    tryAcquireCronLock: vi.fn(),
    supabaseAdmin: createClient('https://abcdefghijklmnopqrst.supabase.co', 'service-role-key', {
      global: { fetch: fakeFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
});
vi.mock('./email.server', () => {
  // Imported at call time: reminder-v2.server itself imports this module.
  const deleteByEmail = async (email: string) => (await import('./reminder-v2.server')).deleteByEmail(email);
  return {
    APP_BASE_URL: 'https://example.com',
    buildReminderV2EmailHtml: vi.fn(() => '<html></html>'),
    // A permanent bounce: the Resend webhook deletes the row (the real
    // deleteByEmail) before the cron reads its next page.
    sendReminderEmail: vi.fn(async (email: string) => {
      if (db.bouncing.has(email)) await deleteByEmail(email);
      return true;
    }),
  };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn() }));

import { processV2Reminders } from './reminder-v2-cron.server';
import { sendReminderEmail } from './email.server';
import { deleteByEmail } from './reminder-v2.server';

const TODAY = '2026-10-31';

// Ids deliberately not in enrolment order, so a walk that pages by one key
// and resumes by the other misses rows.
function makeTable(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const scrambled = (i * 37) % n;
    return {
      id: `00000000-0000-4000-8000-${String(scrambled).padStart(12, '0')}`,
      email: `u${i}@example.com`,
      provider: 'typed',
      token: `t${i}`,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      updated_at: '2026-09-01T00:00:00.000Z',
      schedule: [{ category: 'blood_test_lipids', label: 'Lipid panel', dueAt: '2026-10-01' }],
      last_sent: {},
    };
  });
}
const emailed = () => vi.mocked(sendReminderEmail).mock.calls.map((c) => c[0]).sort();
const allEmails = (rows: Row[]) => rows.map((r) => r.email).sort();

beforeEach(() => {
  db.readIds = [];
  db.bouncing.clear();
  vi.mocked(sendReminderEmail).mockClear();
});

describe('US-23: the daily pass reads every opt-in once while rows are deleted', () => {
  it('control: 120 due rows and no deletes, every row is read once and emailed once', async () => {
    const rows = makeTable(120);
    db.table = rows.map((r) => ({ ...r }));
    db.rowsAtStart = rows.length;

    expect(await processV2Reminders(TODAY)).toBe(120);
    expect(emailed()).toEqual(allEmails(rows));
    expect([...db.readIds].sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it('two bounces among the first rows read do not skip anyone after them', async () => {
    const rows = makeTable(120);
    db.table = rows.map((r) => ({ ...r }));
    db.rowsAtStart = rows.length;
    // The 4th and 8th rows enrolled: on the first page in either order.
    db.bouncing.add(rows[3].email).add(rows[7].email);

    await processV2Reminders(TODAY);
    expect(emailed()).toEqual(allEmails(rows)); // the bounced two were emailed once, then deleted
    expect(new Set(db.readIds).size).toBe(db.readIds.length); // nobody read twice
    expect(db.table).toHaveLength(118);
  });

  it('a row deleted from a later page before it is read is simply not there', async () => {
    const rows = makeTable(120);
    db.table = rows.map((r) => ({ ...r }));
    db.rowsAtStart = rows.length;
    db.bouncing.add(rows[0].email);
    // rows[100] is on the third page by id and by enrolment time alike.
    const erased = rows[100].email;
    // An erase lands for a row the walk has not reached yet.
    vi.mocked(sendReminderEmail).mockImplementationOnce(async (email: string) => {
      await deleteByEmail(erased);
      if (db.bouncing.has(email)) await deleteByEmail(email);
      return true;
    });

    await processV2Reminders(TODAY);
    const expected = allEmails(rows).filter((e) => e !== erased);
    expect(emailed()).toEqual(expected);
  });

  it('exactly one full page ends the walk after one empty read', async () => {
    const rows = makeTable(50);
    db.table = rows.map((r) => ({ ...r }));
    db.rowsAtStart = rows.length;

    expect(await processV2Reminders(TODAY)).toBe(50);
    expect(db.readIds).toHaveLength(50);
  });
});
