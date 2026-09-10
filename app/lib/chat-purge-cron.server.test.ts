import { describe, it, expect, vi, beforeEach } from 'vitest';

// US-15 AC7 (2026-09-10): the question text is kept for 30 days to check
// article matching, then removed on every platform. The counts the audit runs
// on — matched_handles, classification, timings, is_fallback — stay forever.

interface Row {
  id: string;
  created_at: string;
  message: string | null;
  router_context: Record<string, unknown> | null;
  router_raw: string | null;
  router_error: string | null;
  matched_handles: string[];
}

const store = vi.hoisted(() => ({
  rows: [] as Row[],
  selectError: null as { message: string } | null,
  updateError: null as { message: string } | null,
}));

// A fake PostgREST that really filters, so "only rows older than 30 days" and
// "running twice changes nothing" are properties of the code, not the mock.
const fakeAdmin = vi.hoisted(() => ({
  from: (table: string) => {
    if (table !== 'chat_match_events') throw new Error(`unexpected table ${table}`);
    let matches = () => store.rows.slice();
    const query: any = {
      select: () => query,
      lt: (col: string, value: string) => {
        const prev = matches;
        matches = () => prev().filter((r) => (r as any)[col] < value);
        return query;
      },
      not: (col: string, _op: string, _value: null) => {
        const prev = matches;
        matches = () => prev().filter((r) => (r as any)[col] !== null);
        return query;
      },
      // Only the shape the cron sends: "a.not.is.null,b.not.is.null,…".
      or: (expr: string) => {
        const cols = expr.split(',').map((clause) => {
          const [col, ...rest] = clause.split('.');
          if (rest.join('.') !== 'not.is.null') throw new Error(`unexpected or() clause ${clause}`);
          return col;
        });
        const prev = matches;
        matches = () => prev().filter((r) => cols.some((c) => (r as any)[c] !== null));
        return query;
      },
      limit: async (n: number) => ({
        data: store.selectError ? null : matches().slice(0, n).map((r) => ({ id: r.id, router_context: r.router_context })),
        error: store.selectError,
      }),
      update: (patch: Partial<Row>) => ({
        eq: async (_col: string, id: string) => {
          if (!store.updateError) Object.assign(store.rows.find((r) => r.id === id)!, patch);
          return { error: store.updateError };
        },
      }),
    };
    return query;
  },
}));

vi.mock('./supabase.server', () => ({
  supabaseAdmin: fakeAdmin,
  tryAcquireCronLock: vi.fn(async () => true),
}));

import { purgeOldChatText, purgeWithLock, PURGE_AFTER_DAYS } from './chat-purge-cron.server';
import { tryAcquireCronLock } from './supabase.server';

const NOW = new Date('2026-09-10T04:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString();

function row(id: string, ageDays: number, context: Record<string, unknown>, over: Partial<Row> = {}): Row {
  return {
    id,
    created_at: daysAgo(ageDays),
    message: `question ${id}`,
    router_context: context,
    router_raw: `{"handles":["ldl-cholesterol"]} for ${id}`,
    router_error: `parse failed on "${id}"`,
    matched_handles: ['ldl-cholesterol'],
    ...over,
  };
}

beforeEach(() => {
  store.selectError = null;
  store.updateError = null;
  store.rows = [
    row('old-widget', 40, { platform: 'widget' }),
    row('old-shopify', 31, { platform: 'shopify', first: 'HbA1c 41', recent: ['HbA1c 41', 'BP 140/90'] }),
    row('old-youtube', 200, { platform: 'youtube', videoId: 'vid1', posted: true, first: 'q', recent: ['q'] }),
    row('fresh', 29, { platform: 'shopify', first: 'HbA1c 41', recent: ['HbA1c 41'] }),
    // Purged by the earlier version of this cron, which left the model output
    // behind: message is already null, router_raw still holds the answer.
    row('half-purged', 60, { platform: 'widget' }, { message: null, router_error: null }),
  ];
  vi.mocked(tryAcquireCronLock).mockClear().mockResolvedValue(true);
});

const byId = (id: string) => store.rows.find((r) => r.id === id)!;

describe('purgeOldChatText — US-15 AC7 30-day question retention', () => {
  it('clears the question and the earlier turns on rows older than 30 days, every platform', async () => {
    expect(await purgeOldChatText(NOW)).toBe(4);
    for (const id of ['old-widget', 'old-shopify', 'old-youtube']) {
      expect(byId(id).message).toBeNull();
      expect(byId(id).router_context).not.toHaveProperty('first');
      expect(byId(id).router_context).not.toHaveProperty('recent');
    }
  });

  it('clears the model output too — router_raw and router_error', async () => {
    await purgeOldChatText(NOW);
    for (const id of ['old-widget', 'old-shopify', 'old-youtube']) {
      expect(byId(id).router_raw).toBeNull();
      expect(byId(id).router_error).toBeNull();
    }
  });

  it('picks up a row purged before router_raw was in scope', async () => {
    await purgeOldChatText(NOW);
    expect(byId('half-purged').router_raw).toBeNull();
  });

  it('leaves rows inside the window untouched', async () => {
    await purgeOldChatText(NOW);
    expect(byId('fresh').message).toBe('question fresh');
    expect(byId('fresh').router_raw).not.toBeNull();
    expect(byId('fresh').router_error).not.toBeNull();
    expect(byId('fresh').router_context).toEqual({ platform: 'shopify', first: 'HbA1c 41', recent: ['HbA1c 41'] });
    expect(PURGE_AFTER_DAYS).toBe(30);
  });

  it('keeps the counts the audit runs on — handles and the surface name', async () => {
    await purgeOldChatText(NOW);
    expect(byId('old-shopify').matched_handles).toEqual(['ldl-cholesterol']);
    expect(byId('old-shopify').router_context).toEqual({ platform: 'shopify' });
    // Keys that are not a question survive: the YouTube row keeps its ids.
    expect(byId('old-youtube').router_context).toEqual({ platform: 'youtube', videoId: 'vid1', posted: true });
  });

  it('is idempotent — a second run finds nothing left to clear', async () => {
    await purgeOldChatText(NOW);
    expect(await purgeOldChatText(NOW)).toBe(0);
  });

  it('throws on a database error rather than reporting a clean run', async () => {
    store.selectError = { message: 'PGRST303' };
    await expect(purgeOldChatText(NOW)).rejects.toThrow(/purge/i);
  });
});

describe('purgeWithLock — one machine per day', () => {
  it('purges under the chat_text_purge lock', async () => {
    expect(await purgeWithLock('2026-09-10', NOW)).toBe(4);
    expect(vi.mocked(tryAcquireCronLock).mock.calls[0][2]).toBe('chat_text_purge');
  });

  it('does nothing when another machine holds the lock', async () => {
    vi.mocked(tryAcquireCronLock).mockResolvedValue(false);
    expect(await purgeWithLock('2026-09-10', NOW)).toBeNull();
    expect(byId('old-widget').message).toBe('question old-widget');
  });
});
