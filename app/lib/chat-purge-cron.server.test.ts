import { describe, it, expect, vi, beforeEach } from 'vitest';

// US-15 AC7 (2026-09-10): the question text is kept for 30 days to check
// article matching, then removed on every platform. The counts the audit runs
// on — matched_handles, classification, timings, is_fallback — stay forever.
//
// US-15 AC8 (2026-09-10): the bubble and embed transcripts join the same
// window. On Shopify rows only, `chat_messages.content` and
// `chat_conversations.title` go null once they are past 30 days. Discord and
// YouTube transcripts are a different record and are never touched here.

interface Row {
  id: string;
  created_at: string;
  message: string | null;
  router_context: Record<string, unknown> | null;
  router_raw: string | null;
  router_error: string | null;
  matched_handles: string[];
}

interface MessageRow {
  id: string;
  conversation_id: string;
  created_at: string;
  role: string;
  content: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  is_fallback: boolean;
  failure_mode: string | null;
}

interface ConversationRow {
  id: string;
  platform: string;
  updated_at: string;
  title: string | null;
}

const store = vi.hoisted(() => ({
  chat_match_events: [] as Row[],
  chat_messages: [] as MessageRow[],
  chat_conversations: [] as ConversationRow[],
  selectError: null as { message: string } | null,
  updateError: null as { message: string } | null,
  /** Table whose updates commit nothing, to prove the no-progress guard. */
  swallowUpdates: null as string | null,
}));

// A fake PostgREST that really filters, so "only rows older than 30 days" and
// "running twice changes nothing" are properties of the code, not the mock.
// The embedded platform filter really joins: a message's platform is read off
// its conversation row, so a missing `!inner` join is a test failure.
const fakeAdmin = vi.hoisted(() => ({
  from: (table: string) => {
    const rows = (store as unknown as Record<string, unknown[]>)[table];
    if (!Array.isArray(rows)) throw new Error(`unexpected table ${table}`);
    let embedded = false;
    let matches = () => rows.slice() as Record<string, any>[];
    const query: any = {
      select: (cols: string) => {
        embedded = cols.includes('chat_conversations!inner');
        return query;
      },
      eq: (col: string, value: unknown) => {
        const prev = matches;
        if (col.includes('.')) {
          const [embed, field] = col.split('.');
          if (!embedded) throw new Error(`filtered on ${col} without an !inner join`);
          if (embed !== 'chat_conversations') throw new Error(`unexpected embed ${embed}`);
          matches = () =>
            prev().filter(
              (r) => store.chat_conversations.find((c) => c.id === r.conversation_id)?.[field as 'platform'] === value,
            );
        } else {
          matches = () => prev().filter((r) => r[col] === value);
        }
        return query;
      },
      lt: (col: string, value: string) => {
        const prev = matches;
        matches = () => prev().filter((r) => r[col] < value);
        return query;
      },
      not: (col: string, _op: string, _value: null) => {
        const prev = matches;
        matches = () => prev().filter((r) => r[col] !== null);
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
        matches = () => prev().filter((r) => cols.some((c) => r[c] !== null));
        return query;
      },
      limit: async (n: number) => ({
        data: store.selectError ? null : matches().slice(0, n).map((r) => ({ ...r })),
        error: store.selectError,
      }),
      update: (patch: Record<string, unknown>) => {
        const apply = (ids: string[]) => {
          if (store.updateError || store.swallowUpdates === table) return;
          for (const id of ids) Object.assign(rows.find((r) => (r as { id: string }).id === id)!, patch);
        };
        return {
          eq: async (_col: string, id: string) => {
            apply([id]);
            return { error: store.updateError };
          },
          in: async (_col: string, ids: string[]) => {
            apply(ids);
            return { error: store.updateError };
          },
        };
      },
    };
    return query;
  },
}));

vi.mock('./supabase.server', () => ({
  supabaseAdmin: fakeAdmin,
  tryAcquireCronLock: vi.fn(async () => true),
}));

import { purgeOldChatText, purgeWithLock, PURGE_AFTER_DAYS, PURGED_TEXT } from './chat-purge-cron.server';
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

function conversation(id: string, platform: string, ageDays: number): ConversationRow {
  return { id, platform, updated_at: daysAgo(ageDays), title: `title ${id}` };
}

function message(id: string, conversationId: string, ageDays: number, role = 'user'): MessageRow {
  return {
    id,
    conversation_id: conversationId,
    created_at: daysAgo(ageDays),
    role,
    content: `text ${id}`,
    model: 'claude-test',
    input_tokens: 11,
    output_tokens: 22,
    is_fallback: false,
    failure_mode: null,
  };
}

beforeEach(() => {
  store.selectError = null;
  store.updateError = null;
  store.swallowUpdates = null;
  store.chat_match_events = [
    row('old-widget', 40, { platform: 'widget' }),
    row('old-shopify', 31, { platform: 'shopify', first: 'HbA1c 41', recent: ['HbA1c 41', 'BP 140/90'] }),
    row('old-youtube', 200, { platform: 'youtube', videoId: 'vid1', posted: true, first: 'q', recent: ['q'] }),
    row('fresh', 29, { platform: 'shopify', first: 'HbA1c 41', recent: ['HbA1c 41'] }),
    // Purged by the earlier version of this cron, which left the model output
    // behind: message is already null, router_raw still holds the answer.
    row('half-purged', 60, { platform: 'widget' }, { message: null, router_error: null }),
  ];
  store.chat_conversations = [
    conversation('conv-shopify-old', 'shopify', 40),
    conversation('conv-shopify-fresh', 'shopify', 3),
    conversation('conv-discord-old', 'discord', 400),
    conversation('conv-youtube-old', 'youtube', 400),
  ];
  store.chat_messages = [
    message('msg-shopify-q', 'conv-shopify-old', 40),
    message('msg-shopify-a', 'conv-shopify-old', 40, 'assistant'),
    message('msg-shopify-fresh', 'conv-shopify-fresh', 3),
    message('msg-discord', 'conv-discord-old', 400),
    message('msg-youtube', 'conv-youtube-old', 400),
  ];
  vi.mocked(tryAcquireCronLock).mockClear().mockResolvedValue(true);
});

const byId = (id: string) => store.chat_match_events.find((r) => r.id === id)!;
const msg = (id: string) => store.chat_messages.find((r) => r.id === id)!;
const conv = (id: string) => store.chat_conversations.find((r) => r.id === id)!;

describe('purgeOldChatText — US-15 AC7 30-day question retention', () => {
  it('clears the question and the earlier turns on rows older than 30 days, every platform', async () => {
    expect((await purgeOldChatText(NOW)).matchEvents).toBe(4);
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

  it('throws on a database error rather than reporting a clean run', async () => {
    store.selectError = { message: 'PGRST303' };
    await expect(purgeOldChatText(NOW)).rejects.toThrow(/purge/i);
  });
});

describe('purgeOldChatText — US-15 AC8 bubble and embed transcripts', () => {
  it('blanks the text of Shopify messages older than 30 days', async () => {
    const counts = await purgeOldChatText(NOW);
    expect(counts.messages).toBe(2);
    expect(msg('msg-shopify-q').content).toBeNull();
    expect(msg('msg-shopify-a').content).toBeNull();
  });

  it('keeps every column the shape of the conversation is read from', async () => {
    await purgeOldChatText(NOW);
    expect(msg('msg-shopify-a')).toMatchObject({
      id: 'msg-shopify-a',
      role: 'assistant',
      created_at: daysAgo(40),
      model: 'claude-test',
      input_tokens: 11,
      output_tokens: 22,
      is_fallback: false,
      failure_mode: null,
    });
  });

  it('never touches Discord or YouTube transcripts', async () => {
    await purgeOldChatText(NOW);
    expect(msg('msg-discord').content).toBe('text msg-discord');
    expect(msg('msg-youtube').content).toBe('text msg-youtube');
    expect(conv('conv-discord-old').title).toBe('title conv-discord-old');
    expect(conv('conv-youtube-old').title).toBe('title conv-youtube-old');
  });

  it('leaves messages inside the window alone', async () => {
    await purgeOldChatText(NOW);
    expect(msg('msg-shopify-fresh').content).toBe('text msg-shopify-fresh');
  });

  it('nulls the title only on stale Shopify conversations', async () => {
    const counts = await purgeOldChatText(NOW);
    expect(counts.conversations).toBe(1);
    expect(conv('conv-shopify-old').title).toBeNull();
    expect(conv('conv-shopify-fresh').title).toBe('title conv-shopify-fresh');
  });

  it('is idempotent — a second run finds nothing left to clear', async () => {
    await purgeOldChatText(NOW);
    expect(await purgeOldChatText(NOW)).toEqual({ matchEvents: 0, messages: 0, conversations: 0 });
  });

  it('throws when an update fails instead of counting the rows as cleared', async () => {
    store.updateError = { message: 'PGRST204' };
    await expect(purgeOldChatText(NOW)).rejects.toThrow(/purge/i);
    expect(msg('msg-shopify-q').content).toBe('text msg-shopify-q');
  });

  it('throws rather than spinning when the updates never land', async () => {
    store.swallowUpdates = 'chat_messages';
    await expect(purgeOldChatText(NOW)).rejects.toThrow(/no progress/i);
  });

  it('offers the placeholder the reader sees in place of purged text', () => {
    expect(PURGED_TEXT).toBe('[removed after 30 days]');
  });
});

describe('purgeWithLock — one machine per day', () => {
  it('purges under the chat_text_purge lock', async () => {
    expect(await purgeWithLock('2026-09-10', NOW)).toEqual({ matchEvents: 4, messages: 2, conversations: 1 });
    expect(vi.mocked(tryAcquireCronLock).mock.calls[0][2]).toBe('chat_text_purge');
  });

  // A lock fault must reach the tick's catch, which is the only path that
  // leaves `lastRunDate` unset — the assignment sits AFTER the await, so the
  // day stays unclaimed and the next tick retries. If this resolved instead,
  // the day would be marked done with nothing purged.
  it('propagates a lock fault instead of purging, so the day is never claimed', async () => {
    vi.mocked(tryAcquireCronLock).mockRejectedValue(new Error('cron lock row missing (chat_text_purge)'));
    await expect(purgeWithLock('2026-09-10', NOW)).rejects.toThrow(/cron lock row missing/);
    expect(byId('old-widget').message).toBe('question old-widget');
  });

  it('does nothing when another machine holds the lock', async () => {
    vi.mocked(tryAcquireCronLock).mockResolvedValue(false);
    expect(await purgeWithLock('2026-09-10', NOW)).toBeNull();
    expect(byId('old-widget').message).toBe('question old-widget');
    expect(msg('msg-shopify-q').content).toBe('text msg-shopify-q');
  });
});
