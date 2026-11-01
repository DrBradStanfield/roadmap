/**
 * US-15 AC49: a short crisis or emergency follow-up in a thread the bot already
 * answered reaches the answer model, as a short top-level comment does
 * (filterThread, US-15 AC39 review N5). The follow-up word floor (3) used to
 * drop "chest pain" or "kill me" before the classifier or model saw it.
 *
 * Drives one real tick: synthetic YouTube HTTP, an in-memory youtube_bot_log,
 * the classifier and the answer model stubbed. No live call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // youtube-bot.server reads its config at module load.
  Object.assign(process.env, {
    YOUTUBE_BOT_CHANNEL_ID: 'UC_brad', YOUTUBE_BOT_CLIENT_ID: 'synthetic-client',
    YOUTUBE_BOT_CLIENT_SECRET: 'synthetic-secret', YOUTUBE_BOT_REFRESH_TOKEN: 'synthetic-refresh',
  });
});

const NOW = Date.parse('2026-11-01T08:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

const state = vi.hoisted(() => ({ followUpText: '', claims: [] as string[] }));

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => {
  /** A PostgREST-builder stand-in: every filter returns the chain; awaiting it answers by table and columns. */
  function builder(table: string, answer: () => unknown) {
    const chain: Record<string, unknown> = {};
    for (const m of ['eq', 'gte', 'gt', 'lt', 'order', 'limit', 'in']) chain[m] = () => chain;
    chain.maybeSingle = () => Promise.resolve(table === 'chat_conversations' ? { data: null, error: null } : answer());
    chain.single = () => Promise.resolve({ data: { id: 'conv-1' }, error: null });
    chain.select = () => chain;
    chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(answer()).then(ok, bad);
    return chain;
  }
  return {
    supabaseAdmin: {
      rpc: () => Promise.resolve({ error: null }),
      from: (table: string) => ({
        select: (cols: string, opts?: { head?: boolean }) => builder(table, () => {
          if (opts?.head) return { count: 1, error: null };
          if (table === 'youtube_bot_log' && cols.includes('posted_youtube_id')) {
            // The bot answered thread t1 two hours ago.
            return {
              data: [{ youtube_comment_id: 't1', posted_youtube_id: 't1.bot1', video_id: 'vid1',
                user_channel: 'Viewer', user_comment: 'How much magnesium should I take each day?', posted_at: iso(2 * HOUR) }],
              error: null,
            };
          }
          return { data: [], error: null };
        }),
        insert: (row: Record<string, unknown>) => {
          if (table === 'youtube_bot_log') state.claims.push(String(row.youtube_comment_id));
          return builder(table, () => ({ data: { id: 1 }, error: null }));
        },
        update: () => builder(table, () => ({ error: null })),
        delete: () => builder(table, () => ({ error: null })),
      }),
    },
  };
});
vi.mock('./blog-index.server', async (orig) => ({
  ...(await orig<typeof import('./blog-index.server')>()),
  findBlogByVideoId: (videoId: string) => (videoId === 'vid1'
    ? { title: 'Magnesium, explained', handle: 'synthetic-magnesium-post', url: 'u', tags: [], publishedAt: '2026-06-01T00:00:00Z', youtube: 'https://youtu.be/vid1' }
    : null),
}));
vi.mock('./matched-content', async (orig) => ({
  ...(await orig<typeof import('./matched-content')>()),
  loadBlogArticle: (handle: string) => (handle === 'synthetic-magnesium-post' ? '---\ntitle: "Magnesium, explained"\n---\nThe video body.' : null),
}));
vi.mock('./chat-classifier.server', async (orig) => ({
  ...(await orig<typeof import('./chat-classifier.server')>()),
  classifyMessage: vi.fn(async () => ({ classification: 'MEASUREMENT', routerSkipped: true, latencyMs: 1, cacheHit: false, raw: 'MEASUREMENT', usage: { inputTokens: 1, outputTokens: 1 } })),
}));
vi.mock('./chat.server', async (orig) => ({
  ...(await orig<typeof import('./chat.server')>()),
  getChatCompletion: vi.fn(async () => ({ content: 'Please call your local emergency number now (111 in NZ, 911 in the US).', usage: { inputTokens: 1, outputTokens: 1 }, isFallback: false })),
}));

import { classifyMessage } from './chat-classifier.server';

type Call = [RequestInfo | URL, RequestInit | undefined];
function posts(): Array<{ parentId: string; textOriginal: string }> {
  return (vi.mocked(fetch).mock.calls as Call[])
    .filter(([url, init]) => String(url).startsWith('https://www.googleapis.com/youtube/v3/comments') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init!.body)).snippet);
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  process.env.YOUTUBE_BOT_FORCE_START = 'true';
  state.claims = [];
  vi.mocked(classifyMessage).mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'synthetic-access', expires_in: 3600 });
    if (url.startsWith('https://www.googleapis.com/youtube/v3/commentThreads')) return json({ items: [] });
    if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
      return json({ items: [{ snippet: { customUrl: url.includes('id=UC_brad') ? '@drbradstanfield' : '@viewer' } }] });
    }
    if (url.startsWith('https://www.googleapis.com/youtube/v3/comments') && init?.method === 'POST') return json({ id: 't1.bot2' });
    if (url.startsWith('https://www.googleapis.com/youtube/v3/comments')) {
      return json({ items: [
        { id: 't1.bot1', snippet: { authorDisplayName: 'Dr Brad Stanfield', authorChannelId: { value: 'UC_brad' }, textOriginal: 'About 200-400 mg a day.', publishedAt: iso(2 * HOUR) } },
        { id: 't1.v2', snippet: { authorDisplayName: 'Viewer', authorChannelId: { value: 'UC_viewer' }, textOriginal: state.followUpText, publishedAt: iso(HOUR) } },
      ] });
    }
    return new Response('unexpected request', { status: 500 });
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  (await import('./youtube-bot.server')).stopYouTubeBot();
  delete process.env.YOUTUBE_BOT_FORCE_START;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Start the bot and let its first tick (30 s after start) run to the end. */
async function runFirstTick(followUpText: string) {
  state.followUpText = followUpText;
  (await import('./youtube-bot.server')).startYouTubeBot();
  await vi.advanceTimersByTimeAsync(30_000);
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

describe('US-15 AC49: a short crisis follow-up reaches the answer model', () => {
  it.each(['chest pain', 'kill me', 'overdosed'])('"%s" from the asker reaches the model and the stubbed reply is posted', async (text) => {
    await runFirstTick(text);
    expect(state.claims).toContain('t1.v2');
    expect(vi.mocked(classifyMessage).mock.calls.map((c) => c[0])).toContain(text);
    expect(posts()).toEqual([{ parentId: 't1', textOriginal: '@viewer Please call your local emergency number now (111 in NZ, 911 in the US).' }]);
  });

  it('control: a short follow-up that is not a crisis is still dropped by the word floor', async () => {
    await runFirstTick('thanks doc');
    expect(state.claims).not.toContain('t1.v2');
    expect(classifyMessage).not.toHaveBeenCalled();
    expect(posts()).toEqual([]);
  });

  it('control: a three-word follow-up passes the floor, as before', async () => {
    await runFirstTick('what about children?');
    expect(state.claims).toContain('t1.v2');
    expect(posts()).toHaveLength(1);
  });
});
