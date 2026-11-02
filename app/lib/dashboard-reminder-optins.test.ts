/**
 * US-17 AC1c: the owner dashboard's "Reminder Opt-ins" counts rows that can
 * still be emailed. A tombstone (schedule `[]` after an unsubscribe, a
 * toggle-off or an erase, kept 90 days by AC1b) is not an opt-in, and the
 * headline is exact past PostgREST's 1000-row page.
 *
 * Real `getDashboardStats` through the real supabase-js client, whose fetch
 * is a small PostgREST: it applies `schedule` filters to the reminder table,
 * caps a GET at 1000 rows, and answers `Prefer: count=exact` with the full
 * count in Content-Range, as PostgREST does. Every other table is empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Optin = { provider: string; last_sent: Record<string, string>; schedule: { dueAt: string }[] };
const db = vi.hoisted(() => ({ optins: [] as Optin[], urls: [] as string[] }));

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();

  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const json = (body: unknown, count?: number) => {
      const h = new Headers({ 'content-type': 'application/json' });
      const n = Array.isArray(body) ? body.length : 0;
      if (count !== undefined) h.set('content-range', n ? `0-${n - 1}/${count}` : `*/${count}`);
      return new Response(JSON.stringify(body), { status: 200, headers: h });
    };
    if (url.pathname.includes('/rpc/')) return json([]);
    const exact = (headers.get('prefer') ?? '').includes('count=exact');
    if (!url.pathname.endsWith('/reminder_optin_v2')) return json([], exact ? 0 : undefined);

    db.urls.push(url.search);
    let rows = db.optins;
    for (const [key, raw] of url.searchParams) {
      if (key === 'select' || key === 'limit' || key === 'order') continue;
      if (key !== 'schedule') {
        return new Response(JSON.stringify({ message: `fake PostgREST: filter on ${key}` }), { status: 400 });
      }
      const dot = raw.indexOf('.');
      const op = raw.slice(0, dot);
      const value = JSON.stringify(JSON.parse(raw.slice(dot + 1)));
      if (op === 'eq') rows = rows.filter((r) => JSON.stringify(r.schedule) === value);
      else if (op === 'neq') rows = rows.filter((r) => JSON.stringify(r.schedule) !== value);
      else return new Response(JSON.stringify({ message: `fake PostgREST: ${op}` }), { status: 400 });
    }
    return json(rows.slice(0, 1000), exact ? rows.length : undefined);
  }

  return {
    ...actual,
    createClient: (u: string, k: string, o?: Record<string, unknown>) =>
      actual.createClient(u, k, { ...o, global: { fetch: fakeFetch }, auth: { persistSession: false, autoRefreshToken: false } }),
  };
});
vi.mock('./klaviyo.server', () => ({ getCachedKlaviyoCaptureStats: async () => null }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const live = (provider: string, sent = false): Optin => ({
  provider,
  last_sent: sent ? { blood_test_lipids: '2026-09-01' } : {},
  schedule: [{ dueAt: '2027-03-01' }],
});
const tomb = (provider: string, sent = false): Optin => ({ ...live(provider, sent), schedule: [] });

async function stats() {
  vi.stubEnv('SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-role-key');
  vi.resetModules();
  const { getDashboardStats } = await import('./supabase.server');
  return getDashboardStats();
}

beforeEach(() => {
  db.optins = [];
  db.urls = [];
});

describe('US-17 AC1c: the dashboard counts live reminder opt-ins only', () => {
  it('one live row and two tombstones show 1 opt-in, and tombstones are not in the breakdown', async () => {
    db.optins = [live('google-drive'), tomb('typed', true), tomb('typed')];
    const s = await stats();
    expect(s.reminderOptins).toBe(1);
    expect(s.reminders.activeOptins).toBe(1);
    expect(s.reminders.byProvider).toEqual([{ provider: 'google-drive', count: 1 }]);
    expect(s.reminders.withSends).toBe(0);
  });

  it('control: with no tombstones every row is counted and broken down', async () => {
    db.optins = [live('typed', true), live('typed'), live('dropbox')];
    const s = await stats();
    expect(s.reminderOptins).toBe(3);
    expect(s.reminders.byProvider).toEqual([
      { provider: 'typed', count: 2 },
      { provider: 'dropbox', count: 1 },
    ]);
    expect(s.reminders.withSends).toBe(1);
  });

  it('the headline count is exact past 1000 live rows', async () => {
    db.optins = [...Array.from({ length: 1500 }, () => live('typed')), tomb('typed')];
    const s = await stats();
    expect(s.reminderOptins).toBe(1500);
  });

  it('the reminder read asks the database for live rows only', async () => {
    db.optins = [live('typed')];
    await stats();
    expect(db.urls).toHaveLength(1);
    expect(new URLSearchParams(db.urls[0]).get('schedule')).toBe('neq.[]');
  });
});
