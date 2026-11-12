/**
 * US-27 AC5, US-09 AC31: the bot marks a claimed comment as posting before it
 * posts, so one comment gets at most one public reply.
 *
 * Driven through startYouTubeBot on a fake clock, as youtube-bot-tick-overlap.test.ts.
 * Fakes only: real supabase-js over a small PostgREST (as youtube-bot-video-cap-page.test.ts)
 * that applies each UPDATE's and DELETE's WHERE when the request arrives, a stubbed
 * global fetch for Google, and a mocked runPipeline. Each "machine" is a fresh
 * module instance (vi.resetModules) on the one shared table.
 *
 * The cleanup RPC is modelled as its SQL reads (supabase/rls-policies.sql,
 * youtube_bot_cleanup_skipped): delete posted=false rows past the newest
 * `keepNewest`. Tests that set keepNewest to 0 stand for "200 newer skips pushed it
 * out". The real SQL is not run here; there is no Postgres in vitest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: number; youtube_comment_id: string; posted: boolean; video_id: string | null;
  posted_at: string | null; posted_youtube_id: string | null; user_channel: string | null;
  user_comment: string | null; reply_text: string | null;
};
type Req = { method: string; path: string; params: URLSearchParams; body: string; prefer: string };

const db = vi.hoisted(() => {
  Object.assign(process.env, {
    YOUTUBE_BOT_CHANNEL_ID: 'UC_brad', YOUTUBE_BOT_CLIENT_ID: 'synthetic-client',
    YOUTUBE_BOT_CLIENT_SECRET: 'synthetic-secret', YOUTUBE_BOT_REFRESH_TOKEN: 'synthetic-refresh',
  });
  // persistYouTubeTurn is a no-op without a bot profile: the chat tables are out of scope.
  delete process.env.YOUTUBE_BOT_PROFILE_ID;
  delete process.env.DISCORD_BOT_PROFILE_ID;
  return {
    table: [] as Row[],
    nextId: 1,
    keepNewest: 200,
    requests: [] as Req[],
    /** Answers a request instead of the table when it returns a Response. */
    fail: null as null | ((r: Req) => Response | null),
  };
});

const spy = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/react-router', () => ({
  captureException: (...a: unknown[]) => spy.captureException(...a),
  captureMessage: (...a: unknown[]) => spy.captureMessage(...a),
}));

const ctl = vi.hoisted(() => ({
  pipelineCalls: [] as string[],
  /** Holds the next pipeline answers until released; null runs at once. */
  hold: null as null | Array<() => void>,
}));
vi.mock('./youtube-bot-pipeline.server', async (orig) => ({
  ...(await orig<typeof import('./youtube-bot-pipeline.server')>()),
  loadVideoBody: () => ({ entry: { title: 'T', handle: 'h', url: 'https://example.test/h', tags: [], publishedAt: '2026-09-01' }, body: 'body' }),
  runPipeline: async (thread: { topLevelCommentId: string; text: string }) => {
    ctl.pipelineCalls.push(thread.topLevelCommentId);
    if (ctl.hold) await new Promise<void>((resolve) => ctl.hold!.push(resolve));
    return { posted: true, replyText: `Answer ${MARKER} for you`, classification: 'QUESTION', routerHandles: [] };
  },
}));

// The stored turn (chat tables) is observed here, not run: those tables are out of this fake's scope.
const persisted = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('./youtube-bot-store.server', async (orig) => ({
  ...(await orig<typeof import('./youtube-bot-store.server')>()),
  persistYouTubeTurn: async (p: Record<string, unknown>) => { persisted.push(p); },
}));

vi.mock('./supabase.server', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
  const NOT_FILTERS = new Set(['select', 'order', 'limit', 'columns']);

  function predicate(column: string, raw: string): (r: Record<string, unknown>) => boolean {
    const dot = raw.indexOf('.');
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    if (op === 'eq') return (r) => r[column] !== null && String(r[column]) === value;
    if (op === 'gt') return (r) => Number(r[column]) > Number(value);
    if (op === 'gte') return (r) => r[column] !== null && String(r[column]) >= value;
    throw new Error(`fake PostgREST: unsupported operator ${op}`);
  }

  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const req: Req = {
      method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams,
      body: typeof init?.body === 'string' ? init.body : '', prefer: headers.get('prefer') ?? '',
    };
    db.requests.push(req);
    const injected = db.fail?.(req);
    if (injected) return injected;

    if (url.pathname === '/rest/v1/rpc/youtube_bot_cleanup_skipped') {
      const keep = new Set(db.table.filter((r) => !r.posted).sort((a, b) => b.id - a.id).slice(0, db.keepNewest).map((r) => r.id));
      db.table = db.table.filter((r) => r.posted || keep.has(r.id));
      return new Response(null, { status: 204 });
    }
    if (url.pathname !== '/rest/v1/youtube_bot_log') return json({ message: `not modelled: ${url.pathname}` }, 404);

    const preds = [...url.searchParams].filter(([k]) => !NOT_FILTERS.has(k)).map(([k, v]) => predicate(k, v));
    // Applied now, as Postgres applies a WHERE when the statement runs.
    const hits = () => db.table.filter((r) => preds.every((p) => p(r as unknown as Record<string, unknown>)));
    const select = url.searchParams.get('select')?.split(',') ?? null;
    const shape = (rows: Row[]) => rows.map((r) => (select ? Object.fromEntries(select.map((c) => [c, (r as Record<string, unknown>)[c]])) : r));

    switch (req.method) {
      case 'HEAD':
        return new Response(null, { status: 200, headers: { 'content-range': `*/${hits().length}` } });
      case 'GET': {
        const order = url.searchParams.get('order');
        let rows = hits();
        if (order === 'id.asc') rows = [...rows].sort((a, b) => a.id - b.id);
        else if (order === 'posted_at.desc') rows = [...rows].sort((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)));
        else if (order) return json({ message: `order ${order} not modelled` }, 400);
        return json(shape(rows.slice(0, Number(url.searchParams.get('limit') ?? Infinity))));
      }
      case 'POST': {
        const row = JSON.parse(req.body) as Partial<Row>;
        if (db.table.some((r) => r.youtube_comment_id === row.youtube_comment_id)) {
          return json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409);
        }
        const full: Row = {
          id: db.nextId++, youtube_comment_id: '', posted: false, video_id: null, posted_at: null,
          posted_youtube_id: null, user_channel: null, user_comment: null, reply_text: null, ...row,
        };
        db.table.push(full);
        return json(shape([full]), 201);
      }
      case 'PATCH': {
        const patch = JSON.parse(req.body) as Partial<Row>;
        const rows = hits();
        for (const r of rows) Object.assign(r, patch);
        return req.prefer.includes('return=representation') ? json(shape(rows)) : new Response(null, { status: 204 });
      }
      case 'DELETE': {
        const gone = new Set(hits());
        db.table = db.table.filter((r) => !gone.has(r));
        return new Response(null, { status: 204 });
      }
      default:
        return json({ message: req.method }, 405);
    }
  }

  return {
    supabaseAdmin: createClient('https://abcdefghijklmnopqrst.supabase.co', 'service-role-key', {
      global: { fetch: fakeFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

/** In every viewer comment and every model answer; it must never reach a log, Sentry or the posting mark. */
const MARKER = 'zebra-marker-9931';
/** In every Google error body; the bot must never log or report a body. */
const GOOGLE_BODY = 'google-body-sentinel-4417';
/** One serializer for every sentinel check: expands an Error, even one nested in an object, which JSON.stringify turns into {}. */
const dump = (a: unknown) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : JSON.stringify(a, (_k, v) => (v instanceof Error ? `${v.message} ${v.stack}` : v)) ?? String(a));
const NOW = new Date('2026-11-12T10:00:00.000Z');
const FIRST_TICK_MS = 30_000;
const TICK_MS = 30 * 60_000;

type PostPlan = 'ok' | 'timeout' | 'hang' | { status: number; reason?: string; message?: string } | (() => Promise<Response>);
type Reply = { id: string; author: string; channel: string; text: string; publishedAt: string };

const g = {
  threads: [] as string[],
  replies: new Map<string, Reply[]>(),
  posts: [] as Array<{ parentId: string; text: string }>,
  plan: [] as PostPlan[],
  calls: [] as string[],
};

function googleError(status: number, reason = 'forbidden', message = `Refused ${GOOGLE_BODY}`): Response {
  return new Response(JSON.stringify({ error: { code: status, message, errors: [{ reason, domain: 'youtube.comment', message }] } }), { status });
}

async function googleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  g.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'test-access', expires_in: 3600 });
  if (url.pathname === '/youtube/v3/channels') return json({ items: [{ snippet: { customUrl: '@drbrad' } }] });
  if (url.pathname === '/youtube/v3/commentThreads') {
    return json({ items: g.threads.map((id) => ({ snippet: { videoId: 'v1', canReply: true, topLevelComment: { id, snippet: {
      authorDisplayName: 'Viewer', authorChannelId: { value: 'UC_viewer' },
      textOriginal: `${MARKER} how much magnesium should I take each day`,
      publishedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    } } } })) });
  }
  if (url.pathname === '/youtube/v3/comments' && (init?.method ?? 'GET') === 'GET') {
    return json({ items: (g.replies.get(url.searchParams.get('parentId')!) ?? []).map((r) => ({ id: r.id, snippet: {
      authorDisplayName: r.author, authorChannelId: { value: r.channel }, textOriginal: r.text, publishedAt: r.publishedAt,
    } })) });
  }
  if (url.pathname === '/youtube/v3/comments' && init?.method === 'POST') {
    const { snippet } = JSON.parse(String(init.body)) as { snippet: { parentId: string; textOriginal: string } };
    g.posts.push({ parentId: snippet.parentId, text: snippet.textOriginal });
    const plan = g.plan.shift() ?? 'ok';
    if (plan === 'ok') return json({ id: `posted-${g.posts.length}` });
    // Google took the request; our side gave up at the deadline.
    if (plan === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (plan === 'hang') return new Promise<Response>(() => {});
    if (typeof plan === 'function') return plan();
    return googleError(plan.status, plan.reason, plan.message);
  }
  return new Response('not modelled', { status: 404 });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Bot = typeof import('./youtube-bot.server');
let machines: Bot[] = [];

/** A fresh process on the shared table: a new module instance, which auto-starts on import. */
async function bootMachine(): Promise<Bot> {
  vi.resetModules();
  const m = await import('./youtube-bot.server');
  machines.push(m);
  return m;
}

const logLines = () => vi.mocked(console.log).mock.calls.map((c) => c[0]).filter((l): l is string => typeof l === 'string');
const tickLogs = () => logLines().filter((l) => l.startsWith('{"evt":"youtube_bot_tick"')).map((l) => JSON.parse(l) as Record<string, unknown>);

/** Advances the clock, then waits for `n` tick log lines in all. */
async function tickTo(ms: number, n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.waitFor(() => expect(tickLogs()).toHaveLength(n), { timeout: 3000, interval: 1 });
}

const row = (id: string) => db.table.find((r) => r.youtube_comment_id === id);
const tableReqs = (method: string) => db.requests.filter((r) => r.path === '/rest/v1/youtube_bot_log' && r.method === method);
/** The posting mark: an UPDATE guarded by posted=false that sets posted=true. */
const markReqs = () => tableReqs('PATCH').filter((r) => r.params.get('posted') === 'eq.false');
const markToken = (r: Req) => (JSON.parse(r.body) as { posted_at: string }).posted_at;

function seedPosted(id: string, over: Partial<Row> = {}): Row {
  const r: Row = {
    id: db.nextId++, youtube_comment_id: id, posted: true, video_id: 'v1',
    posted_at: new Date(NOW.getTime() - 3_600_000).toISOString(), posted_youtube_id: `bot-${id}`,
    user_channel: 'Viewer', user_comment: 'earlier comment', reply_text: 'earlier reply', ...over,
  };
  db.table.push(r);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  process.env.YOUTUBE_BOT_FORCE_START = 'true';
  Object.assign(db, { table: [], nextId: 1, keepNewest: 200, requests: [], fail: null });
  Object.assign(g, { threads: [], replies: new Map(), posts: [], plan: [], calls: [] });
  Object.assign(ctl, { pipelineCalls: [], hold: null });
  persisted.length = 0;
  spy.captureException.mockReset();
  spy.captureMessage.mockReset();
  vi.stubGlobal('fetch', vi.fn(googleFetch));
  for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

afterEach(async () => {
  for (const m of machines) m.stopYouTubeBot();
  machines = [];
  delete process.env.YOUTUBE_BOT_FORCE_START;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Design §6 pins
// ---------------------------------------------------------------------------

describe('US-27 AC5: a post whose outcome is unknown is counted and never posted again', () => {
  it('a post that times out after Google took it: posted=true with no id, counted, no second post', async () => {
    g.threads = ['c1'];
    g.plan = ['timeout'];
    db.keepNewest = 0; // 200 newer skips have pushed it out of the cleanup window
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: null, video_id: 'v1' });
    expect(tickLogs()[0]).toMatchObject({ posted: 0, unknown: 1, dailyTotal: 1 });

    await tickTo(TICK_MS, 2);
    expect(g.posts).toHaveLength(1);
    expect(ctl.pipelineCalls).toEqual(['c1']);
  });

  it('the success write fails after a 200: the row stays posted, no second post', async () => {
    g.threads = ['c1'];
    db.keepNewest = 0;
    db.fail = (r) => (r.method === 'PATCH' && r.body.includes('posted_youtube_id')
      ? new Response(JSON.stringify({ message: 'synthetic outage' }), { status: 503 }) : null);
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);
    expect(row('c1')).toMatchObject({ posted: true });

    await tickTo(TICK_MS, 2);
    expect(g.posts).toHaveLength(1);
  });

  it('a 503 from Google is unknown: the tick log and the daily cap count it, so the cap stops one post earlier', async () => {
    for (let i = 0; i < 48; i++) seedPosted(`old-${i}`, { video_id: `old-video-${i}`, posted_at: '2026-11-12T01:00:00.000Z' });
    g.threads = ['c1', 'c2', 'c3'];
    g.plan = [{ status: 503, reason: 'backendError' }, 'ok'];
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(g.posts.map((p) => p.parentId)).toEqual(['c1', 'c2']); // 48 + 2 = the cap of 50
    expect(tickLogs()[0]).toMatchObject({ posted: 1, unknown: 1, followUpsUnknown: 0, dailyTotal: 50 });
    expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: null });
  });

  it('R2: an unknown post stores the turn as a success does, with no posted id', async () => {
    g.threads = ['c1'];
    g.plan = ['timeout'];
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      thread: expect.objectContaining({ topLevelCommentId: 'c1', videoId: 'v1' }),
      outcome: expect.objectContaining({ posted: true, classification: 'QUESTION' }),
      postedYoutubeId: null,
      followUpCommentId: null,
    });
  });

  it('a 400 processingFailure is unknown (Q4): counted and kept', async () => {
    g.threads = ['c1'];
    g.plan = [{ status: 400, reason: 'processingFailure' }];
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: null });
    expect(tickLogs()[0]).toMatchObject({ unknown: 1 });
  });

  it('the follow-up path: a timed-out follow-up is counted and never posted again', async () => {
    seedPosted('T1', { posted_youtube_id: 'bot-1' });
    g.replies.set('T1', [
      { id: 'bot-1', author: 'Dr Brad', channel: 'UC_brad', text: 'first answer', publishedAt: '2026-11-12T09:10:00.000Z' },
      { id: 'T1.r2', author: 'Viewer', channel: 'UC_viewer', text: `${MARKER} and what about at night?`, publishedAt: '2026-11-12T09:50:00.000Z' },
    ]);
    g.plan = ['timeout'];
    db.keepNewest = 0;
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(row('T1.r2')).toMatchObject({ posted: true, posted_youtube_id: null, video_id: 'v1' });
    expect(tickLogs()[0]).toMatchObject({ followUpsPosted: 0, followUpsUnknown: 1, dailyTotal: 2 });

    await tickTo(TICK_MS, 2);
    expect(g.posts).toHaveLength(1);
  });
});

describe('US-27 AC5: the posting mark comes before the post', () => {
  it('a failed mark posts nothing, removes the claim, and the next tick posts once', async () => {
    g.threads = ['c1'];
    let failed = false;
    db.fail = (r) => {
      if (failed || !(r.method === 'PATCH' && r.params.get('posted') === 'eq.false')) return null;
      failed = true;
      return new Response(JSON.stringify({ message: 'synthetic outage' }), { status: 503 });
    };
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);
    expect(markReqs()).toHaveLength(1);
    expect(g.posts).toHaveLength(0);
    expect(row('c1')).toBeUndefined();

    await tickTo(TICK_MS, 2);
    expect(g.posts).toHaveLength(1);
    expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: 'posted-1' });
  });

  it('condition 2: the mark is an UPDATE with no select, read back by a separate SELECT on its token', async () => {
    g.threads = ['c1'];
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    const [mark] = markReqs();
    expect(mark).toBeDefined();
    expect(mark.params.has('select')).toBe(false);
    expect(mark.prefer).not.toContain('return=representation');
    const token = markToken(mark);
    const after = db.requests.slice(db.requests.indexOf(mark) + 1);
    expect(after[0]).toMatchObject({ method: 'GET', path: '/rest/v1/youtube_bot_log' });
    expect(after[0].params.get('posted_at')).toBe(`eq.${token}`);
    expect(g.posts).toHaveLength(1);
  });

  for (const [name, answer] of [
    // 500, not 503: postgrest-js retries a GET on 503 with a backoff this fake clock would have to walk.
    ['fails', () => new Response(JSON.stringify({ message: 'synthetic outage' }), { status: 500 })],
    ['is unreadable', () => new Response('<html>gateway</html>', { status: 200 })],
  ] as const) {
    it(`condition 2: a read-back that ${name} counts as not verified: no post`, async () => {
      g.threads = ['c1'];
      db.fail = (r) => (r.method === 'GET' && r.params.has('posted_at') && r.params.get('posted_at')!.startsWith('eq.') ? answer() : null);
      await bootMachine();
      await tickTo(FIRST_TICK_MS, 1);

      expect(markReqs()).toHaveLength(1);
      expect(g.posts).toHaveLength(0);
      expect(row('c1')).toBeUndefined(); // released, so a later tick retries
    });
  }
});

describe('US-27 AC5: a definite refusal releases the mark (Q3)', () => {
  for (const [name, plan, sentry] of [
    ['a 400 not-replyable', { status: 400, reason: 'badRequest', message: "Not all comments can be replied to. Check the comment thread's canReply field." }, false],
    ['a 403 forbidden', { status: 403, reason: 'forbidden' }, true],
  ] as const) {
    it(`${name} reverts to a plain claim, by its token: not counted, not retried`, async () => {
      g.threads = ['c1'];
      g.plan = [plan];
      const bot = await bootMachine();
      await tickTo(FIRST_TICK_MS, 1);

      expect(row('c1')).toMatchObject({ posted: false, posted_at: null, video_id: null });
      const revert = tableReqs('PATCH').find((r) => (JSON.parse(r.body) as { posted?: boolean }).posted === false);
      expect(revert?.params.get('posted_at')).toBe(`eq.${markToken(markReqs()[0])}`);
      expect(revert?.params.get('youtube_comment_id')).toBe('eq.c1');
      expect((await bot.readPostingCaps()).dailyCount).toBe(0);
      expect(tickLogs()[0]).toMatchObject({ posted: 0, unknown: 0, skipped: 1 });
      expect(spy.captureException).not.toHaveBeenCalled();
      expect(spy.captureMessage.mock.calls.length > 0).toBe(sentry);

      await tickTo(TICK_MS, 2);
      expect(ctl.pipelineCalls).toEqual(['c1']);
    });
  }

  it('condition 4: the revert cannot touch a row another machine has since marked', async () => {
    g.threads = ['c1'];
    const theirs = '2026-11-12T10:00:30.000123Z';
    g.plan = [async () => {
      Object.assign(row('c1')!, { posted: true, posted_at: theirs }); // another machine's mark lands meanwhile
      return googleError(403);
    }];
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(row('c1')).toMatchObject({ posted: true, posted_at: theirs, video_id: 'v1' });
    expect(tableReqs('DELETE')).toHaveLength(0);
  });

  for (const [name, plan] of [
    ['401', { status: 401, reason: 'authError' }],
    ['429', { status: 429, reason: 'rateLimitExceeded' }],
    ['403 quotaExceeded', { status: 403, reason: 'quotaExceeded' }],
    ['403 rateLimitExceeded (R1)', { status: 403, reason: 'rateLimitExceeded' }],
  ] as const) {
    it(`a ${name} deletes the row by its token and ends this tick's posting; a later tick retries`, async () => {
      seedPosted('T1', { posted_youtube_id: 'bot-1' });
      g.replies.set('T1', [
        { id: 'bot-1', author: 'Dr Brad', channel: 'UC_brad', text: 'first answer', publishedAt: '2026-11-12T09:10:00.000Z' },
        { id: 'T1.r2', author: 'Viewer', channel: 'UC_viewer', text: `${MARKER} and what about at night?`, publishedAt: '2026-11-12T09:50:00.000Z' },
      ]);
      g.threads = ['c1', 'c2', 'c3'];
      g.plan = [plan];
      await bootMachine();
      await tickTo(FIRST_TICK_MS, 1);

      expect(g.posts).toHaveLength(1);
      expect(ctl.pipelineCalls).toEqual(['c1']); // no model call for c2, c3 or the follow-up
      expect(row('c1')).toBeUndefined();
      const del = tableReqs('DELETE').find((r) => r.params.get('youtube_comment_id') === 'eq.c1');
      expect(del?.params.get('posted_at')).toBe(`eq.${markToken(markReqs()[0])}`);
      expect(g.calls.filter((c) => c === 'GET /youtube/v3/comments')).toHaveLength(0); // no follow-up scan

      await tickTo(TICK_MS, 2);
      expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: expect.any(String) });
    });
  }
});

// ---------------------------------------------------------------------------
// The owner's conditions
// ---------------------------------------------------------------------------

const UNKNOWN = 'YouTube bot: post outcome unknown';
const UNKNOWN_400 = 'YouTube bot: post outcome unknown (unreadable 400)';

/** Google answered with a status, then the body stream broke (a reset socket, or the deadline mid-body). */
const brokenBody = (status: number) => async () => new Response(
  new ReadableStream({ start(c) { c.error(new TypeError(`terminated ${GOOGLE_BODY}`)); } }), { status });

describe('Codex review: a status whose body cannot be read keeps its status', () => {
  /** Every console and Sentry argument, as text: the stream error carries the Google-body sentinel. */
  const reported = () => [
    ...(['log', 'warn', 'error', 'info'] as const).flatMap((l) => vi.mocked(console[l]).mock.calls.flat()),
    ...spy.captureException.mock.calls.flat(),
    ...spy.captureMessage.mock.calls.flat(),
  ].map(dump).join('\n');

  for (const status of [401, 429]) {
    it(`a ${status} with a broken body still deletes the claim by its token and halts the tick`, async () => {
      g.threads = ['c1', 'c2'];
      g.plan = [brokenBody(status)];
      const tokenCalls = () => g.calls.filter((c) => c === 'POST /token').length;
      await bootMachine();
      await tickTo(FIRST_TICK_MS, 1);

      expect(ctl.pipelineCalls).toEqual(['c1']); // no model call for c2
      expect(row('c1')).toBeUndefined();
      expect(tickLogs()[0]).toMatchObject({ halted: 'accountWide' }); // N2
      const del = tableReqs('DELETE').find((r) => r.params.get('youtube_comment_id') === 'eq.c1');
      expect(del?.params.get('posted_at')).toBe(`eq.${markToken(markReqs()[0])}`);

      await tickTo(TICK_MS, 2);
      if (status === 401) expect(tokenCalls()).toBe(2); // the bad token was dropped
      expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: expect.any(String) });
      expect(reported()).not.toContain(GOOGLE_BODY);
    });
  }

  // A 400 may be processingFailure, which Google may have taken (Q4): without its body it is unknown.
  for (const status of [200, 400]) {
    it(`a ${status} with a broken body is unknown: the mark is kept and counted`, async () => {
      g.threads = ['c1'];
      g.plan = [brokenBody(status)];
      await bootMachine();
      await tickTo(FIRST_TICK_MS, 1);

      expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: null, video_id: 'v1' });
      expect(tickLogs()[0]).toMatchObject({ posted: 0, unknown: 1, dailyTotal: 1 });
      expect(reported()).not.toContain(GOOGLE_BODY);
      // N2: the status tells an unreadable 2xx from an unreadable 400 in triage.
      // N1: an unreadable 400 has its own fixed message, so Sentry gives it its own issue.
      expect(spy.captureMessage).toHaveBeenCalledWith(status === 400 ? UNKNOWN_400 : UNKNOWN, expect.objectContaining({
        tags: { feature: 'youtube-bot', subsystem: 'post', why: 'unreadable', status: String(status) },
      }));
    });
  }

  // N3: a readable 400 with no reason code (a proxy's HTML page) may hide processingFailure: unknown, not refused.
  it('a readable 400 whose body is not JSON is unknown: the mark is kept, counted, never posted again', async () => {
    g.threads = ['c1'];
    g.plan = [async () => new Response(`<html>Bad Request ${GOOGLE_BODY}</html>`, { status: 400 })];
    const bot = await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: null, video_id: 'v1' });
    expect(tickLogs()[0]).toMatchObject({ posted: 0, unknown: 1, dailyTotal: 1 });
    expect((await bot.readPostingCaps()).dailyCount).toBe(1);
    expect(spy.captureMessage).toHaveBeenCalledWith(UNKNOWN_400, expect.objectContaining({
      level: 'error', // (b): an unreadable 400 alerts
      tags: { feature: 'youtube-bot', subsystem: 'post', why: 'unreadable', status: '400' },
    }));
    expect(reported()).not.toContain(GOOGLE_BODY);

    await tickTo(TICK_MS, 2);
    expect(g.posts).toHaveLength(1);
  });

  it('(b) a 5xx unknown stays a warning', async () => {
    g.threads = ['c1'];
    g.plan = [{ status: 503 }];
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(spy.captureMessage).toHaveBeenCalledWith(UNKNOWN, expect.objectContaining({
      level: 'warning', tags: { feature: 'youtube-bot', subsystem: 'post', why: '5xx' },
    }));
    expect(spy.captureMessage).not.toHaveBeenCalledWith(UNKNOWN_400, expect.anything());
  });

  it('a readable JSON 400 with a real reason stays refused: the mark is reverted, not counted', async () => {
    g.threads = ['c1'];
    g.plan = [{ status: 400, reason: 'invalidCommentText' }];
    const bot = await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(row('c1')).toMatchObject({ posted: false, posted_at: null, video_id: null });
    expect((await bot.readPostingCaps()).dailyCount).toBe(0);
    expect(tickLogs()[0]).toMatchObject({ posted: 0, unknown: 0, skipped: 1 });
  });
});

/** A 400 with no reason code: unknown, mark kept (N3). */
const html400 = async () => new Response('<html>Bad Request</html>', { status: 400 });

describe('(c) the second unreadable 400 in one tick ends its posting', () => {
  const seedFollowUp = (thread: string) => {
    seedPosted(thread, { posted_youtube_id: `bot-${thread}` });
    g.replies.set(thread, [
      { id: `bot-${thread}`, author: 'Dr Brad', channel: 'UC_brad', text: 'first answer', publishedAt: '2026-11-12T09:10:00.000Z' },
      { id: `${thread}.r2`, author: 'Viewer', channel: 'UC_viewer', text: `${MARKER} and what about at night?`, publishedAt: '2026-11-12T09:50:00.000Z' },
    ]);
  };

  it('two in one tick: the second halts, no further model call or follow-up; both marks kept and counted', async () => {
    seedFollowUp('T1');
    g.threads = ['c1', 'c2', 'c3'];
    g.plan = [html400, html400];
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(ctl.pipelineCalls).toEqual(['c1', 'c2']); // no model call for c3 or the follow-up
    expect(g.calls.filter((c) => c === 'GET /youtube/v3/comments')).toHaveLength(0); // no follow-up scan
    for (const id of ['c1', 'c2']) expect(row(id)).toMatchObject({ posted: true, posted_youtube_id: null });
    expect(tickLogs()[0]).toMatchObject({ posted: 0, unknown: 2, followUpsUnknown: 0, halted: 'unreadable400' });

    // The next tick starts fresh: c3 and the follow-up are answered.
    await tickTo(TICK_MS, 2);
    expect(row('c3')).toMatchObject({ posted: true, posted_youtube_id: expect.any(String) });
    expect(row('T1.r2')).toMatchObject({ posted: true, posted_youtube_id: expect.any(String) });
  });

  it('one, then a success: the tick goes on, follow-ups included', async () => {
    seedFollowUp('T1');
    g.threads = ['c1', 'c2'];
    g.plan = [html400];
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: null });
    expect(row('c2')).toMatchObject({ posted: true, posted_youtube_id: expect.any(String) });
    expect(row('T1.r2')).toMatchObject({ posted: true, posted_youtube_id: expect.any(String) });
    expect(tickLogs()[0]).toMatchObject({ posted: 1, unknown: 1, followUpsPosted: 1 });
    expect(tickLogs()[0]).not.toHaveProperty('halted'); // N2: absent when the tick ran to its end
  });

  it('one top-level, then one follow-up: the second halts the follow-up pass', async () => {
    seedFollowUp('T1');
    seedFollowUp('T2');
    g.threads = ['c1'];
    g.plan = [html400, html400];
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(ctl.pipelineCalls).toHaveLength(2); // c1 and one follow-up; none for the other
    expect(tickLogs()[0]).toMatchObject({ unknown: 1, followUpsUnknown: 1, followUpsPosted: 0, halted: 'unreadable400' });
  });

  it('the count resets each tick: one per tick never halts', async () => {
    g.threads = ['c1'];
    g.plan = [html400];
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);
    g.threads = ['c2', 'c3'];
    g.plan = [html400];
    await tickTo(TICK_MS, 2);

    expect(row('c2')).toMatchObject({ posted: true, posted_youtube_id: null });
    expect(row('c3')).toMatchObject({ posted: true, posted_youtube_id: expect.any(String) });
  });

  it('unreadable 2xx and 5xx answers do not count toward it', async () => {
    g.threads = ['c1', 'c2', 'c3', 'c4'];
    g.plan = [html400, async () => new Response('<html>ok</html>', { status: 200 }), { status: 503 }];
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);

    expect(ctl.pipelineCalls).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(row('c4')).toMatchObject({ posted: true, posted_youtube_id: expect.any(String) });
  });
});

describe('R3: a 401 drops the cached Google token', () => {
  it('the next tick asks Google for a fresh token', async () => {
    g.threads = ['c1'];
    g.plan = [{ status: 401, reason: 'authError' }];
    const tokenCalls = () => g.calls.filter((c) => c === 'POST /token').length;
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);
    expect(tokenCalls()).toBe(1);

    await tickTo(TICK_MS, 2);
    expect(tokenCalls()).toBe(2);
  });
});

describe('condition 1: two machines, one comment, one public reply', () => {
  it('both claim at the same moment: one claims and posts, the other skips', async () => {
    g.threads = ['c1'];
    await bootMachine();
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 2);

    expect(g.posts).toHaveLength(1);
    expect(ctl.pipelineCalls).toEqual(['c1']);
    expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: 'posted-1' });
  });

  it('both hold a claim (cleanup freed the first) and mark at once: exactly one verifies and posts; the other leaves the row alone', async () => {
    g.threads = ['c1'];
    ctl.hold = [];
    await bootMachine(); // machine A
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS);
    await vi.waitFor(() => expect(ctl.hold).toHaveLength(1), { timeout: 3000, interval: 1 });
    db.table = db.table.filter((r) => r.youtube_comment_id !== 'c1'); // cleanup removed A's plain claim

    await bootMachine(); // machine B claims it again
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS);
    await vi.waitFor(() => expect(ctl.hold).toHaveLength(2), { timeout: 3000, interval: 1 });
    const before = db.requests.length;

    for (const release of ctl.hold!.splice(0)) release(); // both answers arrive together
    await vi.waitFor(() => expect(tickLogs()).toHaveLength(2), { timeout: 3000, interval: 1 });

    expect(g.posts).toHaveLength(1);
    expect(markReqs()).toHaveLength(2);
    expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: 'posted-1' });
    const raceWrites = db.requests.slice(before).filter((r) => r.path === '/rest/v1/youtube_bot_log' && r.method !== 'GET' && r.method !== 'HEAD');
    // Two marks and the winner's success write; the loser neither unclaims nor alters the row.
    expect(raceWrites.map((r) => r.method)).toEqual(['PATCH', 'PATCH', 'PATCH']);
    expect(tickLogs().map((l) => l.posted).sort()).toEqual([0, 1]);
  });
});

describe('token collision: the mark is matched by the claim row, not only its token', () => {
  it('two machines draw the same token on different claim rows (a re-inserted claim): only the live row\'s owner posts', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // both tokens collide: same frozen millisecond, same draw
    g.threads = ['c1'];
    ctl.hold = [];
    await bootMachine(); // machine A claims row 1
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS);
    await vi.waitFor(() => expect(ctl.hold).toHaveLength(1), { timeout: 3000, interval: 1 });
    db.table = db.table.filter((r) => r.youtube_comment_id !== 'c1'); // cleanup removed A's claim

    await bootMachine(); // machine B claims the comment again: row 2
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS);
    await vi.waitFor(() => expect(ctl.hold).toHaveLength(2), { timeout: 3000, interval: 1 });
    vi.setSystemTime(NOW.getTime() + 2 * FIRST_TICK_MS); // both marks in one millisecond

    const [releaseA, releaseB] = ctl.hold!.splice(0);
    releaseA(); // A marks first, so a comment-wide WHERE would take B's row
    releaseB();
    await vi.waitFor(() => expect(tickLogs()).toHaveLength(2), { timeout: 3000, interval: 1 });

    const tokens = markReqs().map(markToken);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
    expect(g.posts).toHaveLength(1);
    expect(db.table.filter((r) => r.youtube_comment_id === 'c1')).toEqual([
      expect.objectContaining({ id: 2, posted: true, posted_youtube_id: 'posted-1' }),
    ]);
  });
});

describe('condition 3: a crash between the mark and the post', () => {
  it('leaves posted=true with no id: counted in both caps, kept by unclaim and cleanup, never retried', async () => {
    g.threads = ['c1'];
    g.plan = ['hang']; // the process dies with the post in flight
    db.keepNewest = 0;
    const a = await bootMachine();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS);
    await vi.waitFor(() => expect(g.posts).toHaveLength(1), { timeout: 3000, interval: 1 });
    a.stopYouTubeBot();

    expect(row('c1')).toMatchObject({ posted: true, posted_youtube_id: null, video_id: 'v1' });
    const b = await bootMachine(); // the restarted process
    const store = await import('./youtube-bot-store.server');
    await store.unclaimComment('c1');
    await store.cleanupSkippedRows();
    expect(row('c1')).toBeDefined();
    expect(await b.readPostingCaps()).toMatchObject({ dailyCount: 1, videoPostCounts: new Map([['v1', 1]]) });

    await tickTo(FIRST_TICK_MS, 1);
    await tickTo(TICK_MS, 2);
    expect(g.posts).toHaveLength(1);
    expect(ctl.pipelineCalls).toEqual(['c1']);
  });
});

describe('condition 5: no viewer or answer text, and no Google body, in the mark, the logs or Sentry', () => {
  it('holds on success, unknown, refusal, account-wide refusal, a failed mark and a follow-up', async () => {
    seedPosted('T1', { posted_youtube_id: 'bot-1' });
    g.replies.set('T1', [
      { id: 'bot-1', author: 'Dr Brad', channel: 'UC_brad', text: 'first answer', publishedAt: '2026-11-12T09:10:00.000Z' },
      { id: 'T1.r2', author: 'Viewer', channel: 'UC_viewer', text: `${MARKER} and what about at night?`, publishedAt: '2026-11-12T09:50:00.000Z' },
    ]);
    g.threads = ['c1', 'c2', 'c3', 'c4', 'c5'];
    g.plan = ['ok', 'timeout', { status: 503 }, { status: 403, reason: 'forbidden' }, { status: 400, reason: 'processingFailure' }, 'timeout'];
    let failedMark = false;
    db.fail = (r) => {
      if (failedMark || !(r.method === 'PATCH' && r.params.get('youtube_comment_id') === 'eq.c5' && r.params.get('posted') === 'eq.false')) return null;
      failedMark = true;
      return new Response(JSON.stringify({ message: `synthetic ${MARKER}` }), { status: 503 });
    };
    await bootMachine();
    await tickTo(FIRST_TICK_MS, 1);
    g.threads = ['c6'];
    g.plan = [{ status: 429, reason: 'rateLimitExceeded' }];
    await tickTo(TICK_MS, 2);

    const out = [
      ...(['log', 'warn', 'error', 'info'] as const).flatMap((l) => vi.mocked(console[l]).mock.calls.flat()),
      ...spy.captureException.mock.calls.flat(),
      ...spy.captureMessage.mock.calls.flat(),
    ].map(dump).join('\n');
    expect(out).not.toContain(MARKER);
    expect(out).not.toContain(GOOGLE_BODY);
    // The mark and every release carry no viewer or answer text; only the success write stores it.
    for (const r of db.requests.filter((q) => q.path === '/rest/v1/youtube_bot_log' && q.method !== 'GET' && !q.body.includes('posted_youtube_id'))) {
      expect(r.body).not.toContain(MARKER);
    }
    expect(g.posts.length).toBeGreaterThan(3); // the paths above really ran
  });
});

describe('condition 6: the deploy window', () => {
  it("today's claim and caps treat a posted=true row with no id as posted: no claim, counted", async () => {
    seedPosted('c1', { posted_youtube_id: null, user_channel: null, user_comment: null, reply_text: null, posted_at: '2026-11-12T09:00:00.000123Z' });
    const bot = await bootMachine();
    const store = await import('./youtube-bot-store.server');
    // Today's claim returns the row id or null; the code before C15 returned false at the same 23505 line.
    expect(await store.claimComment('c1')).toBeNull();
    expect(await bot.readPostingCaps()).toMatchObject({ dailyCount: 1, videoPostCounts: new Map([['v1', 1]]) });
  });
});
