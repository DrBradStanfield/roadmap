/**
 * US-27 AC4: the per-video lifetime cap (PER_VIDEO_REPLY_CAP, 30 replies)
 * counts every reply the bot has posted, however long the log grows.
 *
 * PostgREST answers a select with at most 1000 rows (Supabase's default max
 * rows; supabase-ab.server.ts and the reminder sweep work around the same cap).
 * The per-video totals were one select of every posted row, so once the log
 * passed 1000 posted replies, the rows past the first page never counted and
 * a video whose replies sat behind them read as having fewer than it had.
 *
 * Real supabase-js over a fetch that plays a small PostgREST: it parses the
 * query string the client really sends (`posted=eq.true`, `id=gt.…`,
 * `order=id.asc`, `limit=…`), applies it to an in-memory table, caps every
 * answer at MAX_ROWS rows, and refuses any operator it does not know with a 400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = { id: number; posted: boolean; video_id: string | null; posted_at: string | null };

const db = vi.hoisted(() => ({
  table: [] as Row[],
  maxRows: 1000,
  gets: 0,
  getUrls: [] as string[],
  failGetNo: 0, // 1-based GET (row read) that answers 503; 0 = none
}));

vi.mock('./supabase-client.server', async () => {
  const { createClient } = await import('@supabase/supabase-js');

  type Pred = (r: Record<string, unknown>) => boolean;
  function predicate(column: string, raw: string): Pred {
    const dot = raw.indexOf('.');
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    if (op === 'eq') return (r) => String(r[column]) === value;
    if (op === 'gt') return (r) => Number(r[column]) > Number(value);
    if (op === 'gte') return (r) => String(r[column] ?? '') >= value;
    throw new Error(`fake PostgREST: unsupported operator ${op}`);
  }

  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const preds: Pred[] = [];
    let select: string[] | null = null;
    let order: string | null = null;
    let limit = Infinity;
    try {
      for (const [key, raw] of url.searchParams) {
        if (key === 'select') { select = raw.split(','); continue; }
        if (key === 'order') { order = raw; continue; }
        if (key === 'limit') { limit = Number(raw); continue; }
        if (key === 'offset') throw new Error('fake PostgREST: offset not modelled');
        preds.push(predicate(key, raw));
      }
      if (order !== null && order !== 'id.asc') throw new Error(`fake PostgREST: order ${order} not modelled`);
    } catch (e) {
      return new Response(JSON.stringify({ message: (e as Error).message }), { status: 400 });
    }
    // Without an order, Postgres returns rows in no promised order; the table's
    // insertion order stands in for it, as heap order usually does.
    const hits = db.table.filter((r) => preds.every((p) => p(r as unknown as Record<string, unknown>)));
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-range': `*/${hits.length}` } });
    }
    if (method !== 'GET') return new Response(JSON.stringify({ message: `fake PostgREST: ${method}` }), { status: 405 });
    db.gets++;
    db.getUrls.push(decodeURIComponent(url.search));
    if (db.gets === db.failGetNo) {
      return new Response(JSON.stringify({ code: 'PGRST303', message: 'JWT issued at future' }), { status: 401 });
    }
    const sorted = order ? [...hits].sort((a, b) => a.id - b.id) : hits;
    const rows = sorted.slice(0, Math.min(limit, db.maxRows)).map((r) =>
      select ? Object.fromEntries(select.map((c) => [c, (r as Record<string, unknown>)[c]])) : r);
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  return {
    supabaseAdmin: createClient('https://abcdefghijklmnopqrst.supabase.co', 'service-role-key', {
      global: { fetch: fakeFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import * as Sentry from '@sentry/react-router';
import { PER_VIDEO_REPLY_CAP } from './youtube-bot-config.server';
import { readPostingCaps } from './youtube-bot-store.server';

const POSTED_AT = '2026-08-01T00:00:00.000Z';
let nextId = 1;
function posted(video_id: string | null): Row {
  return { id: nextId++, posted: true, video_id, posted_at: POSTED_AT };
}
function skipped(video_id: string | null = null): Row {
  return { id: nextId++, posted: false, video_id, posted_at: null };
}
/** `n` posted replies spread over videos old-0, old-1, ... at 5 a video. */
const older = (n: number) => Array.from({ length: n }, (_, i) => posted(`old-${Math.floor(i / 5)}`));

beforeEach(() => {
  db.table = [];
  db.maxRows = 1000;
  db.gets = 0;
  db.getUrls = [];
  db.failGetNo = 0;
  nextId = 1;
  vi.mocked(Sentry.captureException).mockClear();
});

describe('US-27 AC4: the per-video cap counts every posted reply', () => {
  it('counts a video at the cap whose replies sit behind 1000 older posted replies', async () => {
    // A skipped claim first, so the last id on a page (1001) is not the number of rows read (1000).
    db.table = [skipped(), ...older(1000), ...Array.from({ length: PER_VIDEO_REPLY_CAP }, () => posted('new-video'))];

    const { videoPostCounts } = await readPostingCaps();
    expect(videoPostCounts.get('new-video')).toBe(PER_VIDEO_REPLY_CAP);
    expect(videoPostCounts.get('old-0')).toBe(5);
    expect(videoPostCounts.get('old-199')).toBe(5);
    // Each page asks in id order after the last id read: paging by id needs both.
    expect(db.getUrls).toHaveLength(3);
    for (const q of db.getUrls) expect(q).toMatch(/order=id\.asc/);
    expect(db.getUrls[0]).toMatch(/id=gt\.0(&|$)/);
    expect(db.getUrls[1]).toMatch(/id=gt\.1001(&|$)/);
  });

  it('counts every reply when the server caps an answer below 1000 rows', async () => {
    db.maxRows = 300;
    db.table = [...older(650), ...Array.from({ length: 7 }, () => posted('new-video'))];

    const { videoPostCounts } = await readPostingCaps();
    expect(videoPostCounts.get('new-video')).toBe(7);
    expect([...videoPostCounts.values()].reduce((a, b) => a + b, 0)).toBe(657);
  });

  it('control: a short log, with skipped claims and a reply with no video, counts as before', async () => {
    // The cap counts posted replies only: a skipped row on video a is not one.
    db.table = [posted('a'), skipped(), posted('a'), posted('b'), posted(null), skipped('a')];

    expect(await readPostingCaps()).toEqual({
      dailyCount: 0, // POSTED_AT is not today
      videoPostCounts: new Map([['a', 2], ['b', 1]]),
    });
  });

  it('control: an empty log reads as no replies on any video', async () => {
    expect((await readPostingCaps()).videoPostCounts).toEqual(new Map());
  });

  it('a failed later page rejects, never a partial count (AC1)', async () => {
    db.table = [...older(1000), ...Array.from({ length: 10 }, () => posted('new-video'))];
    db.failGetNo = 2;

    await expect(readPostingCaps()).rejects.toMatchObject({ code: 'PGRST303' });
    // The failure reaches Sentry, which is how the cap-read failures were found.
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PGRST303' }),
      { tags: { feature: 'youtube-bot' } },
    );
  });
});
