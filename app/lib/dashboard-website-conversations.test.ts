/**
 * US-15 AC52a: the owner dashboard's "Website conversations" counts the
 * `chat_conversations` rows whose platform is `shopify`. It was total minus
 * Discord, so each YouTube bot thread (platform `youtube`) was counted as a
 * website conversation.
 *
 * Real `getDashboardStats` through the real supabase-js client, whose fetch
 * is a small PostgREST: it applies a `platform=eq.` filter to
 * `chat_conversations` and answers `Prefer: count=exact` with the count in
 * Content-Range. Every other table is empty. Synthetic rows only. The fake
 * shows which requests the client sends, not how PostgREST reads them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ convs: [] as { platform: string; created_at: string }[], counts: [] as string[], refuse: '' }));

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const exact = (new Headers(init?.headers).get('prefer') ?? '').includes('count=exact');
    const json = (body: unknown[], count?: number) => {
      const h = new Headers({ 'content-type': 'application/json' });
      if (count !== undefined) h.set('content-range', body.length ? `0-${body.length - 1}/${count}` : `*/${count}`);
      return new Response(init?.method === 'HEAD' ? null : JSON.stringify(body), { status: 200, headers: h });
    };
    if (url.pathname.includes('/rpc/')) return json([]);
    if (!url.pathname.endsWith('/chat_conversations')) return json([], exact ? 0 : undefined);
    const platform = url.searchParams.get('platform');
    if (platform !== null && !platform.startsWith('eq.')) {
      return new Response(JSON.stringify({ message: `fake PostgREST: ${platform}` }), { status: 400 });
    }
    if (init?.method === 'HEAD') db.counts.push(url.search);
    if (platform && platform === db.refuse) return new Response(null, { status: 500 });
    const rows = platform === null ? db.convs : db.convs.filter((c) => `eq.${c.platform}` === platform);
    return json(rows.slice(0, Number(url.searchParams.get('limit') ?? 1000)), exact ? rows.length : undefined);
  }
  return {
    ...actual,
    createClient: (u: string, k: string, o?: Record<string, unknown>) =>
      actual.createClient(u, k, { ...o, global: { fetch: fakeFetch }, auth: { persistSession: false, autoRefreshToken: false } }),
  };
});
vi.mock('./klaviyo.server', () => ({ getCachedKlaviyoCaptureStats: async () => null }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

async function chat() {
  vi.stubEnv('SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-role-key');
  vi.resetModules();
  const { getDashboardStats } = await import('./supabase.server');
  return (await getDashboardStats()).chat;
}
const rows = (platform: string, n: number) => Array.from({ length: n }, () => ({ platform, created_at: '2026-11-01T00:00:00Z' }));

beforeEach(() => {
  db.convs = [];
  db.counts = [];
  db.refuse = '';
});

describe('US-15 AC52a: "Website conversations" counts website rows', () => {
  it('3 website, 2 Discord and 5 YouTube rows read 3 website conversations, not 8', async () => {
    db.convs = [...rows('shopify', 3), ...rows('discord', 2), ...rows('youtube', 5)];
    expect(await chat()).toMatchObject({ totalConversations: 10, shopifyConversations: 3, discordConversations: 2 });
    expect(db.counts.sort()).toEqual(['?select=*', '?select=*&platform=eq.discord', '?select=*&platform=eq.shopify']);
  });

  it('with no YouTube rows the three numbers are 5, 3 and 2', async () => {
    db.convs = [...rows('shopify', 3), ...rows('discord', 2)];
    expect(await chat()).toMatchObject({ totalConversations: 5, shopifyConversations: 3, discordConversations: 2 });
  });

  it('YouTube and Discord rows alone read 0 website conversations', async () => {
    db.convs = [...rows('discord', 2), ...rows('youtube', 5)];
    expect(await chat()).toMatchObject({ totalConversations: 7, shopifyConversations: 0, discordConversations: 2 });
  });

  it('a website count the database refuses reads 0, and the other two numbers are still read', async () => {
    db.convs = [...rows('shopify', 3), ...rows('discord', 2)];
    db.refuse = 'eq.shopify';
    expect(await chat()).toMatchObject({ totalConversations: 5, shopifyConversations: 0, discordConversations: 2 });
  });

  it('an empty table reads 0 for each', async () => {
    expect(await chat()).toMatchObject({ totalConversations: 0, shopifyConversations: 0, discordConversations: 0 });
  });
});
