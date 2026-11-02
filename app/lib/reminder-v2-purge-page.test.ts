/**
 * US-17 AC1b: a row switched off stays 90 days, then is deleted. The sweep
 * must reach every such row, however many live rows are also past 90 days.
 *
 * PostgREST answers a select with at most 1000 rows (Supabase's default max
 * rows; supabase.server.ts relies on the same cap). A live row whose user has
 * not been back and has had no send in 90 days also matches
 * `updated_at < cutoff`, so with only the age in the query, 1000 such rows
 * filled the page and a tombstone behind them was never seen, on any day.
 *
 * Real supabase-js over a fetch that plays a small PostgREST: it parses the
 * query string the client really sends (`updated_at=lt.…`, `schedule=eq.[]`,
 * `id=in.(…)`), applies it to an in-memory table, caps a GET at 1000 rows,
 * and refuses any operator it does not know with a 400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = { id: string; email: string; updated_at: string; schedule: unknown[] };

const db = vi.hoisted(() => ({
  table: [] as Row[],
  requests: [] as { method: string; url: string; inIds: number }[],
  failDeleteNo: 0, // 1-based DELETE request that answers 503; 0 = none
}));

vi.mock('./supabase.server', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const JSONB = new Set(['schedule', 'last_sent']);
  const MAX_ROWS = 1000;

  type Pred = (r: Record<string, unknown>) => boolean;
  function predicate(column: string, raw: string): Pred {
    const dot = raw.indexOf('.');
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    if (op === 'lt') return (r) => String(r[column]) < value;
    if (op === 'eq') {
      return JSONB.has(column)
        ? (r) => JSON.stringify(r[column]) === JSON.stringify(JSON.parse(value))
        : (r) => String(r[column]) === value;
    }
    if (op === 'in') {
      const set = new Set(value.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')));
      return (r) => set.has(String(r[column]));
    }
    throw new Error(`fake PostgREST: unsupported operator ${op}`);
  }

  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const preds: Pred[] = [];
    let select: string[] | null = null;
    let inIds = 0;
    try {
      for (const [key, raw] of url.searchParams) {
        if (key === 'select') { select = raw.split(','); continue; }
        if (raw.startsWith('in.')) inIds = raw.split(',').length;
        preds.push(predicate(key, raw));
      }
    } catch (e) {
      return new Response(JSON.stringify({ message: (e as Error).message }), { status: 400 });
    }
    db.requests.push({ method, url: url.toString(), inIds });
    const hit = (r: Row) => preds.every((p) => p(r as unknown as Record<string, unknown>));
    if (method === 'GET') {
      const rows = db.table.filter(hit).slice(0, MAX_ROWS).map((r) =>
        select ? Object.fromEntries(select.map((c) => [c, (r as Record<string, unknown>)[c]])) : r);
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'DELETE') {
      if (db.requests.filter((r) => r.method === 'DELETE').length === db.failDeleteNo) {
        return new Response(JSON.stringify({ message: 'upstream unavailable' }), { status: 503 });
      }
      db.table = db.table.filter((r) => !hit(r));
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ message: `fake PostgREST: ${method}` }), { status: 405 });
  }

  return {
    supabaseAdmin: createClient('https://abcdefghijklmnopqrst.supabase.co', 'service-role-key', {
      global: { fetch: fakeFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./email.server', () => ({ APP_BASE_URL: 'https://example.com' }));

import { purgeTombstones } from './reminder-v2.server';

const NOW = Date.parse('2026-10-31T08:00:00Z');
const OLD = '2026-06-01T00:00:00.000Z'; // 152 days before NOW
const RECENT = '2026-10-01T00:00:00.000Z'; // 30 days before NOW
const LIVE = [{ category: 'annual_checkin', label: 'Annual health check-in', dueAt: '2027-05-01' }];

function live(i: number, updated_at = OLD): Row {
  return { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, email: `live-${i}@example.com`, updated_at, schedule: LIVE };
}
function tomb(i: number, updated_at = OLD): Row {
  return { id: `11111111-0000-4000-8000-${String(i).padStart(12, '0')}`, email: `off-${i}@example.com`, updated_at, schedule: [] };
}
const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

beforeEach(() => {
  db.table = [];
  db.requests = [];
  db.failDeleteNo = 0;
});

describe('US-17 AC1b — the 90-day sweep reaches every tombstone', () => {
  it('deletes a tombstone behind 1000 live rows that are also past 90 days, on the first run', async () => {
    const liveRows = Array.from({ length: 1000 }, (_, i) => live(i));
    db.table = [...liveRows, tomb(0)];

    expect(await purgeTombstones(NOW)).toBe(1);
    expect(ids(db.table)).toEqual(ids(liveRows)); // tombstone gone, every live row kept
  });

  it('deletes more than 1000 tombstones over successive daily runs, never a live row', async () => {
    const liveRows = Array.from({ length: 50 }, (_, i) => live(i));
    db.table = [...liveRows, ...Array.from({ length: 1150 }, (_, i) => tomb(i))];

    const first = await purgeTombstones(NOW);
    const second = await purgeTombstones(NOW + 86_400_000);
    expect(first + second).toBe(1150);
    expect(ids(db.table)).toEqual(ids(liveRows));
  });

  it('keeps tombstones younger than 90 days and live rows of any age', async () => {
    const keep = [tomb(1, RECENT), live(1, RECENT), live(2, OLD)];
    db.table = [...keep, tomb(2, OLD)];

    expect(await purgeTombstones(NOW)).toBe(1);
    expect(ids(db.table)).toEqual(ids(keep));
  });

  it('deletes at most 100 ids per request, so no delete URL grows with the backlog', async () => {
    db.table = Array.from({ length: 250 }, (_, i) => tomb(i));

    expect(await purgeTombstones(NOW)).toBe(250);
    expect(db.table).toEqual([]);
    const deletes = db.requests.filter((r) => r.method === 'DELETE');
    expect(deletes.map((d) => d.inIds)).toEqual([100, 100, 50]);
    expect(Math.max(...deletes.map((d) => d.url.length))).toBeLessThan(8 * 1024);
  });

  it('a failed delete batch throws, so the cron reports it; the next run deletes the rest', async () => {
    db.table = Array.from({ length: 250 }, (_, i) => tomb(i));
    db.failDeleteNo = 2;

    await expect(purgeTombstones(NOW)).rejects.toThrow(/tombstone delete failed/);
    expect(db.table).toHaveLength(150); // the first 100 went before the failure

    db.failDeleteNo = 0;
    expect(await purgeTombstones(NOW + 86_400_000)).toBe(150);
    expect(db.table).toEqual([]);
  });
});
