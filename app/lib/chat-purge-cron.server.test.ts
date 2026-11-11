import { describe, it, expect, vi, beforeEach } from 'vitest';

// US-15 AC7 (2026-09-10): the question text is kept for 30 days to check
// article matching, then removed on every platform. The counts the audit runs
// on — matched_handles, classification, timings, is_fallback — stay forever.
//
// US-15 AC8 (2026-09-10, amended that evening): the bubble, embed and Discord
// transcripts share one window. On `platform in ('shopify','discord')` rows,
// `chat_messages.content` and `chat_conversations.title` go null once they are
// past 30 days. YouTube is left alone — those turns are public comments.

interface Row {
  id: string;
  created_at: string;
  message: string | null;
  router_context: Record<string, unknown> | null;
  router_raw: string | null;
  router_error: string | null;
  matched_handles: string[];
  classification: string | null;
  conversation_id: string | null;
  user_id: string;
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
  chat_question_archive: [] as Record<string, unknown>[],
  /** Every insert into the archive, batch by batch, in the order sent. */
  archiveInserts: [] as Record<string, unknown>[][],
  insertError: null as Record<string, string> | null,
  selectError: null as { message: string } | null,
  updateError: null as { message: string } | null,
  /** Table whose updates commit nothing, to prove the no-progress guard. */
  swallowUpdates: null as string | null,
  /** How many ids each `.update(...).in('id', …)` carried, in the order sent. */
  updateIdCounts: [] as number[],
  /** Row ids whose first blank silently commits nothing; the next one lands. */
  swallowFirstBlank: new Set<string>(),
  /** Row ids whose blank never commits. */
  neverBlank: new Set<string>(),
  /** Row ids another writer deletes just before their update lands. */
  vanishOnUpdate: new Set<string>(),
  /** How many ids each select skipped with `.not('id', 'in', …)`, in the order sent. */
  skipCounts: [] as number[],
  /** Reverse the row order on every other select (PostgREST promises no order without one). */
  flipOrder: false,
  /** Selects sent; past 200 the fake throws, so a spinning loop fails instead of hanging. */
  selects: 0,
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
      // `.returns<T>()` only narrows the type in supabase-js.
      returns: () => query,
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
      in: (col: string, values: unknown[]) => {
        const prev = matches;
        if (col.includes('.')) {
          const [embed, field] = col.split('.');
          if (!embedded) throw new Error(`filtered on ${col} without an !inner join`);
          if (embed !== 'chat_conversations') throw new Error(`unexpected embed ${embed}`);
          matches = () =>
            prev().filter((r) =>
              values.includes(
                store.chat_conversations.find((c) => c.id === r.conversation_id)?.[field as 'platform'],
              ),
            );
        } else {
          matches = () => prev().filter((r) => values.includes(r[col]));
        }
        return query;
      },
      lt: (col: string, value: string) => {
        const prev = matches;
        matches = () => prev().filter((r) => r[col] < value);
        return query;
      },
      not: (col: string, op: string, value: null | string) => {
        const prev = matches;
        if (op === 'in') {
          const ids = String(value).slice(1, -1).split(',');
          store.skipCounts.push(ids.length);
          matches = () => prev().filter((r) => !ids.includes(r[col]));
        } else {
          matches = () => prev().filter((r) => r[col] !== null);
        }
        return query;
      },
      is: (col: string, _value: null) => {
        const prev = matches;
        matches = () => prev().filter((r) => r[col] === null);
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
      limit: async (n: number) => {
        if (++store.selects > 200) throw new Error('fake: select loop spinning');
        const found = matches();
        if (store.flipOrder && store.selects % 2 === 0) found.reverse();
        return { data: store.selectError ? null : found.slice(0, n).map((r) => ({ ...r })), error: store.selectError };
      },
      insert: async (batch: Record<string, unknown>[]) => {
        store.archiveInserts.push(batch);
        if (store.insertError) return { error: store.insertError };
        rows.push(...batch);
        return { error: null };
      },
      update: (patch: Record<string, unknown>) => {
        const apply = (ids: string[]) => {
          if (store.updateError || store.swallowUpdates === table) return;
          for (const id of ids) {
            if (!store.vanishOnUpdate.has(id)) continue;
            rows.splice(rows.findIndex((r) => (r as { id: string }).id === id), 1);
            ids = ids.filter((other) => other !== id);
          }
          for (const id of ids) if (!store.swallowFirstBlank.delete(id) && !store.neverBlank.has(id)) Object.assign(rows.find((r) => (r as { id: string }).id === id)!, patch);
        };
        return {
          eq: async (_col: string, id: string) => {
            apply([id]);
            return { error: store.updateError };
          },
          in: async (_col: string, ids: string[]) => {
            store.updateIdCounts.push(ids.length);
            apply(ids);
            return { error: store.updateError };
          },
        };
      },
    };
    return query;
  },
}));

vi.mock('./chat-question-scrub.server', () => ({ scrubQuestion: vi.fn(), SCRUB_TIMEOUT_MS: 15_000 }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./supabase.server', () => ({
  supabaseAdmin: fakeAdmin,
  tryAcquireCronLock: vi.fn(async () => true),
  endCronLock: vi.fn(),
}));

import * as Sentry from '@sentry/react-router';
import {
  ARCHIVE_MAX_QUESTIONS, ARCHIVED_PLATFORMS, clearConversationMatchEvents, purgeOldChatText, purgeWithLock, PURGE_AFTER_DAYS, PURGED_PLATFORMS, PURGED_TEXT,
} from './chat-purge-cron.server';
import { DISCORD_SAVED_CHAT, YOUTUBE_SAVED_CHAT } from './chat-save-answers';
import { tryAcquireCronLock } from './supabase.server';
import { scrubQuestion } from './chat-question-scrub.server';
import { recordServerEvent } from './product-events.server';

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
    classification: 'ROUTE',
    conversation_id: null,
    user_id: 'user-1',
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
  delete process.env.CHAT_QUESTION_ARCHIVE;
  store.chat_question_archive = [];
  store.archiveInserts = [];
  store.insertError = null;
  vi.mocked(scrubQuestion).mockReset().mockImplementation(async (text: string) => `scrubbed: ${text}`);
  vi.mocked(recordServerEvent).mockReset();
  vi.mocked(Sentry.captureMessage).mockReset();
  vi.mocked(Sentry.captureException).mockReset();
  store.selectError = null;
  store.updateError = null;
  store.swallowUpdates = null;
  store.updateIdCounts = [];
  store.swallowFirstBlank = new Set();
  store.neverBlank = new Set();
  store.vanishOnUpdate = new Set();
  store.skipCounts = [];
  store.flipOrder = false;
  store.selects = 0;
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
    conversation('conv-discord-fresh', 'discord', 2),
    conversation('conv-youtube-old', 'youtube', 400),
  ];
  store.chat_messages = [
    message('msg-shopify-q', 'conv-shopify-old', 40),
    message('msg-shopify-a', 'conv-shopify-old', 40, 'assistant'),
    message('msg-shopify-fresh', 'conv-shopify-fresh', 3),
    message('msg-discord', 'conv-discord-old', 400),
    message('msg-discord-fresh', 'conv-discord-fresh', 2),
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
    expect(counts.messages).toBe(3);
    expect(msg('msg-shopify-q').content).toBeNull();
    expect(msg('msg-shopify-a').content).toBeNull();
  });

  it('blanks stale Discord transcripts too — text and title', async () => {
    await purgeOldChatText(NOW);
    expect(msg('msg-discord').content).toBeNull();
    expect(conv('conv-discord-old').title).toBeNull();
  });

  it('leaves Discord turns inside the window alone', async () => {
    await purgeOldChatText(NOW);
    expect(msg('msg-discord-fresh').content).toBe('text msg-discord-fresh');
    expect(conv('conv-discord-fresh').title).toBe('title conv-discord-fresh');
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

  it('never touches YouTube transcripts — public comments, their own retention', async () => {
    await purgeOldChatText(NOW);
    expect(msg('msg-youtube').content).toBe('text msg-youtube');
    expect(conv('conv-youtube-old').title).toBe('title conv-youtube-old');
  });

  it('leaves messages inside the window alone', async () => {
    await purgeOldChatText(NOW);
    expect(msg('msg-shopify-fresh').content).toBe('text msg-shopify-fresh');
  });

  it('nulls the title only on stale purged-platform conversations', async () => {
    const counts = await purgeOldChatText(NOW);
    expect(counts.conversations).toBe(2);
    expect(conv('conv-shopify-old').title).toBeNull();
    expect(conv('conv-shopify-fresh').title).toBe('title conv-shopify-fresh');
  });

  it('is idempotent — a second run finds nothing left to clear', async () => {
    await purgeOldChatText(NOW);
    expect(await purgeOldChatText(NOW)).toEqual({ matchEvents: 0, messages: 0, conversations: 0, archive: null, didNotBlank: 0 });
  });

  it('throws when an update fails instead of counting the rows as cleared', async () => {
    store.updateError = { message: 'PGRST204' };
    await expect(purgeOldChatText(NOW)).rejects.toThrow(/purge/i);
    expect(msg('msg-shopify-q').content).toBe('text msg-shopify-q');
  });

  // US-15 AC61: a pass whose updates never land ends without spinning, counts
  // its rows, and the passes after it still run.
  it('ends a pass whose updates never land, and the next pass still runs', async () => {
    store.swallowUpdates = 'chat_messages';
    const counts = await purgeOldChatText(NOW);
    expect(counts).toMatchObject({ didNotBlank: 3, conversations: 2 });
    expect(msg('msg-shopify-q').content).toBe('text msg-shopify-q');
    expect(conv('conv-shopify-old').title).toBeNull();
  });

  it('US-15 AC51: a 250-row backlog clears in batches of at most 100 ids', async () => {
    for (let i = 0; i < 250; i++) {
      store.chat_conversations.push(conversation(`bulk-${i}`, 'shopify', 40));
      store.chat_messages.push(message(`bulk-msg-${i}`, `bulk-${i}`, 40));
    }
    store.updateIdCounts = [];
    const counts = await purgeOldChatText(NOW);
    expect(counts.messages).toBe(253);
    expect(counts.conversations).toBe(252);
    expect(Math.max(...store.updateIdCounts)).toBeLessThanOrEqual(100);
    expect(store.chat_messages.filter((m) => m.id.startsWith('bulk-msg') && m.content !== null)).toHaveLength(0);
    expect(store.chat_conversations.filter((c) => c.id.startsWith('bulk-') && c.title !== null)).toHaveLength(0);
  });

  it('offers the placeholder the reader sees in place of purged text', () => {
    expect(PURGED_TEXT).toBe('[removed after 30 days]');
  });
});

describe('purgeWithLock — one machine per day', () => {
  it('purges under the chat_text_purge lock', async () => {
    expect(await purgeWithLock('2026-09-10', NOW)).toEqual({ matchEvents: 4, messages: 3, conversations: 2, archive: null, didNotBlank: 0 });
    expect(vi.mocked(tryAcquireCronLock).mock.calls[0][2]).toBe('chat_text_purge');
  });

  // A lock fault must reach the tick, which marks the day before the run and
  // releases it on a throw (US-28 AC7), so the day stays unclaimed and the
  // next tick retries. If this resolved instead, the day would be marked done
  // with nothing purged.
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

// US-15 AC44: before the purge blanks a web chat question, a scrubbed copy of
// that one question is kept, with its platform and the Monday of its week.
describe('purgeOldChatText — US-15 AC44 question archive', () => {
  beforeEach(() => {
    process.env.CHAT_QUESTION_ARCHIVE = 'on';
    // Created 40 days before NOW (Sat 2026-08-01): its Monday is 2026-07-27.
    store.chat_match_events = [
      row('shopify-route', 40, { platform: 'shopify', first: 'HbA1c 41 first', recent: ['HbA1c 41 recent'] }, { conversation_id: 'conv-shopify-old' }),
      row('widget-measure', 40, { platform: 'widget' }, { classification: 'MEASUREMENT' }),
      row('shopify-account', 40, { platform: 'shopify' }, { classification: 'ACCOUNT', conversation_id: 'conv-shopify-old' }),
      row('shopify-unlabelled', 40, { platform: 'shopify' }, { classification: null, conversation_id: 'conv-shopify-old' }),
      row('discord-route', 40, { platform: 'discord' }),
      row('youtube-route', 40, { platform: 'youtube' }),
      row('fresh-route', 29, { platform: 'shopify' }, { conversation_id: 'conv-shopify-fresh' }),
    ];
  });

  const archived = () => store.chat_question_archive.map((r) => r.question).sort();

  it('copies only shopify and widget rows classified ROUTE or MEASUREMENT', async () => {
    const counts = await purgeOldChatText(NOW);
    expect(archived()).toEqual(['scrubbed: question shopify-route', 'scrubbed: question widget-measure']);
    expect(counts.archive).toEqual({ eligible: 2, kept: 2, skipped: 0 });
  });

  it('a copy holds only its three fields, and its week is the Monday', async () => {
    await purgeOldChatText(NOW);
    for (const copy of store.chat_question_archive) {
      expect(Object.keys(copy).sort()).toEqual(['platform', 'question', 'week']);
      expect(copy.week).toBe('2026-07-27');
    }
    expect(store.chat_question_archive.map((r) => r.platform).sort()).toEqual(['shopify', 'widget']);
  });

  it('a question asked on a Monday keeps its own date as the week', async () => {
    store.chat_match_events = [row('monday', 0, { platform: 'widget' }, { created_at: '2026-07-27T00:05:00Z' })];
    await purgeOldChatText(NOW);
    expect(store.chat_question_archive[0].week).toBe('2026-07-27');
  });

  it('never copies the earlier questions in router_context', async () => {
    await purgeOldChatText(NOW);
    expect(vi.mocked(scrubQuestion).mock.calls.map((c) => c[0]).sort()).toEqual(['question shopify-route', 'question widget-measure']);
    expect(JSON.stringify(store.chat_question_archive)).not.toContain('HbA1c');
  });

  it('a skipped scrub is counted, and eligible = kept + skipped', async () => {
    vi.mocked(scrubQuestion).mockImplementation(async (t: string) => (t.includes('widget') ? null : `scrubbed: ${t}`));
    expect((await purgeOldChatText(NOW)).archive).toEqual({ eligible: 2, kept: 1, skipped: 1 });
  });

  it.each([
    ['never resolves', () => new Promise<string | null>(() => {})],
    ['throws', async () => { throw new Error('boom'); }],
  ])('a scrub that %s still leaves match events, messages and titles blanked in the same run', async (_, impl) => {
    vi.mocked(scrubQuestion).mockImplementation(impl as () => Promise<string | null>);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const run = purgeOldChatText(NOW);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const counts = await run;
      expect(counts).toMatchObject({ matchEvents: 6, messages: 3, conversations: 2, archive: { eligible: 2, kept: 0, skipped: 2 } });
    } finally {
      vi.useRealTimers();
    }
    expect(byId('shopify-route').message).toBeNull();
    expect(msg('msg-shopify-q').content).toBeNull();
    expect(conv('conv-shopify-old').title).toBeNull();
    expect(store.chat_question_archive).toEqual([]);
  });

  it('an insert error with details reaches neither the console nor Sentry', async () => {
    store.insertError = { message: 'new row violates check', details: 'Failing row contains (SENTINEL_TEXT)', hint: 'SENTINEL_HINT' };
    const spies = (['log', 'error', 'warn'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const counts = await purgeWithLock('2026-09-10', NOW);
      expect(counts?.archive).toEqual({ eligible: 2, kept: 0, skipped: 2 });
      expect(counts?.matchEvents).toBe(6);
      const seen = JSON.stringify([
        spies.map((s) => s.mock.calls),
        vi.mocked(Sentry.captureMessage).mock.calls,
        vi.mocked(Sentry.captureException).mock.calls,
      ]);
      expect(seen).not.toContain('SENTINEL');
      expect(seen).not.toContain('question shopify-route');
      expect(vi.mocked(Sentry.captureMessage)).toHaveBeenCalledWith('Chat question archive failed', expect.anything());
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('inserts once, in a shuffled order', async () => {
    store.chat_match_events = ['a', 'b', 'c', 'd'].map((id) => row(id, 40, { platform: 'widget' }));
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await purgeOldChatText(NOW);
    } finally {
      random.mockRestore();
    }
    expect(store.archiveInserts).toHaveLength(1);
    const order = store.archiveInserts[0].map((r) => r.question);
    const scrubOrder = vi.mocked(scrubQuestion).mock.calls.map((c) => `scrubbed: ${c[0]}`);
    expect([...order].sort()).toEqual([...scrubOrder].sort());
    expect(order).not.toEqual(scrubOrder);
  });

  it('never copies a shopify row whose conversation is gone', async () => {
    store.chat_conversations = store.chat_conversations.filter((c) => c.id !== 'conv-shopify-old');
    expect((await purgeOldChatText(NOW)).archive).toEqual({ eligible: 2, kept: 1, skipped: 1 });
    expect(archived()).toEqual(['scrubbed: question widget-measure']);
  });

  it('never copies a conversation deleted after the read and before the insert', async () => {
    vi.mocked(scrubQuestion).mockImplementation(async (t: string) => {
      // The DELETE lands while the scrub runs, after the row was read and blanked.
      store.chat_conversations = store.chat_conversations.filter((c) => c.id !== 'conv-shopify-old');
      return `scrubbed: ${t}`;
    });
    await purgeOldChatText(NOW);
    expect(archived()).toEqual(['scrubbed: question widget-measure']);
  });

  it('holds at most 200 questions; the rest count as skipped and blanking completes', async () => {
    const many = ARCHIVE_MAX_QUESTIONS + 5;
    store.chat_match_events = Array.from({ length: many }, (_, i) => row(`w${i}`, 40, { platform: 'widget' }));
    const counts = await purgeOldChatText(NOW);
    expect(ARCHIVE_MAX_QUESTIONS).toBe(200);
    expect(vi.mocked(scrubQuestion)).toHaveBeenCalledTimes(200);
    expect(counts.archive).toEqual({ eligible: many, kept: 200, skipped: 5 });
    expect(counts.matchEvents).toBe(many);
    expect(store.chat_match_events.every((r) => r.message === null)).toBe(true);
  });

  it('a budget spent on scrubbing still inserts what was scrubbed', async () => {
    // 40 questions at 10 s each is 400 s, past the 5-minute budget.
    store.chat_match_events = Array.from({ length: 40 }, (_, i) => row(`slow${i}`, 40, { platform: 'widget' }));
    vi.mocked(scrubQuestion).mockImplementation((text: string) => new Promise((r) => setTimeout(() => r(`scrubbed: ${text}`), 10_000)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.now() });
    try {
      const run = purgeOldChatText(NOW);
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      const counts = await run;
      // Scrubbing stops with 20 s left for the writes: calls at 0, 10, … 270 s.
      // Without the reserve it would scrub 30 and leave the insert no time.
      expect(counts.archive!.kept).toBe(28);
      expect(counts.archive!.kept + counts.archive!.skipped).toBe(40);
      expect(store.chat_question_archive).toHaveLength(counts.archive!.kept);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the counts as a value-free product event and in the log line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await purgeWithLock('2026-09-10', NOW);
      expect(vi.mocked(recordServerEvent)).toHaveBeenCalledWith('chat_question_archived', { eligible: 2, kept: 2, skipped: 0 });
      expect(log.mock.calls.join(' ')).toContain('questions archived: 2 eligible, 2 kept, 0 skipped');
    } finally {
      log.mockRestore();
    }
  });

  it.each([undefined, 'off', 'true', 'ON'])('with CHAT_QUESTION_ARCHIVE=%s: no scrub, no insert, no event; blanking as before', async (value) => {
    if (value === undefined) delete process.env.CHAT_QUESTION_ARCHIVE;
    else process.env.CHAT_QUESTION_ARCHIVE = value;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const counts = await purgeWithLock('2026-09-10', NOW);
      expect(counts).toEqual({ matchEvents: 6, messages: 3, conversations: 2, archive: null, didNotBlank: 0 });
    } finally {
      log.mockRestore();
    }
    expect(vi.mocked(scrubQuestion)).not.toHaveBeenCalled();
    expect(store.archiveInserts).toEqual([]);
    expect(vi.mocked(recordServerEvent)).not.toHaveBeenCalled();
    expect(byId('shopify-route').message).toBeNull();
  });

  // US-15 AC60: a row whose blank silently did nothing comes back in the next
  // batch beside new rows. Its question is held once per run, not once per batch.
  it('US-15 AC60: a row selected again after a silent blank makes one kept copy, not several', async () => {
    store.chat_match_events = [
      row('stuck', 40, { platform: 'widget' }),
      ...Array.from({ length: 150 }, (_, i) => row(`w${i}`, 40, { platform: 'widget' })),
    ];
    store.swallowFirstBlank = new Set(['stuck']);
    const counts = await purgeOldChatText(NOW);
    expect(store.chat_question_archive.filter((r) => r.question === 'scrubbed: question stuck')).toHaveLength(1);
    expect(counts.archive).toEqual({ eligible: 151, kept: 151, skipped: 0 });
    expect(byId('stuck').message).toBeNull();
  });

  it('US-15 AC60: rows that did not blank are reported once per run, by count only, and in the log line', async () => {
    store.chat_match_events = [
      row('stuck-SENTINEL-1', 40, { platform: 'widget' }, { message: 'SENTINEL question one' }),
      row('stuck-SENTINEL-2', 40, { platform: 'shopify' }, { message: 'SENTINEL question two', conversation_id: 'conv-shopify-old' }),
      ...Array.from({ length: 150 }, (_, i) => row(`w${i}`, 40, { platform: 'widget' })),
    ];
    store.swallowFirstBlank = new Set(['stuck-SENTINEL-1', 'stuck-SENTINEL-2']);
    const spies = (['log', 'error', 'warn'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const counts = await purgeWithLock('2026-09-10', NOW);
      expect(counts?.didNotBlank).toBe(2);
      expect(vi.mocked(Sentry.captureMessage).mock.calls).toEqual([
        ['Chat text purge: rows did not blank', { level: 'error', tags: { feature: 'chat_text_purge', stuck_rows: 2 } }],
      ]);
      const log = spies[0].mock.calls.join(' ');
      expect(log).toContain('questions archived: 152 eligible, 152 kept, 0 skipped; 2 rows did not blank');
      const seen = JSON.stringify([
        spies.map((s) => s.mock.calls),
        vi.mocked(Sentry.captureMessage).mock.calls,
        vi.mocked(Sentry.captureException).mock.calls,
        vi.mocked(recordServerEvent).mock.calls,
      ]);
      expect(seen).not.toContain('SENTINEL');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('US-15 AC60: a clean run reports nothing and logs 0 rows did not blank', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect((await purgeWithLock('2026-09-10', NOW))?.didNotBlank).toBe(0);
      expect(log.mock.calls.join(' ')).toContain('2 eligible, 2 kept, 0 skipped; 0 rows did not blank');
    } finally {
      log.mockRestore();
    }
    expect(vi.mocked(Sentry.captureMessage)).not.toHaveBeenCalled();
  });

  it('US-15 AC60: the guard stops on a batch holding only rows already sent, whatever their order', async () => {
    // Two rows that never blank, returned in a different order each time: the
    // batches never repeat exactly, so a guard that waits for an identical batch spins.
    store.chat_match_events = [row('never-1', 40, { platform: 'widget' }), row('never-2', 40, { platform: 'widget' })];
    store.neverBlank = new Set(['never-1', 'never-2']);
    store.flipOrder = true;
    // US-15 AC61: the stopped pass ends the run normally; the later passes run.
    expect(await purgeOldChatText(NOW)).toMatchObject({ didNotBlank: 2, messages: 3, conversations: 2 });
    // Reported once, with the count only.
    expect(vi.mocked(Sentry.captureMessage).mock.calls).toEqual([
      ['Chat text purge: rows did not blank', { level: 'error', tags: { feature: 'chat_text_purge', stuck_rows: 2 } }],
    ]);
    expect(store.archiveInserts).toEqual([]);
  });

  it('US-15 AC60: the guard lets a healthy multi-batch run finish', async () => {
    store.chat_match_events = Array.from({ length: 250 }, (_, i) => row(`h${i}`, 40, { platform: 'widget' }));
    store.flipOrder = true;
    const counts = await purgeOldChatText(NOW);
    expect(counts).toMatchObject({ matchEvents: 250, didNotBlank: 0, archive: { eligible: 250, kept: 200, skipped: 50 } });
    expect(store.chat_match_events.every((r) => r.message === null)).toBe(true);
    expect(vi.mocked(Sentry.captureMessage)).not.toHaveBeenCalled();
  });

  // US-15 AC61: one row that never blanks no longer fails the run, and a
  // question is copied only once its own row's blank has landed.
  it('US-15 AC61: one permanently stuck row: the rest still blank and are copied, and the run ends without throwing', async () => {
    store.chat_match_events.push(row('stuck-forever', 40, { platform: 'widget' }));
    store.neverBlank = new Set(['stuck-forever']);
    const counts = await purgeOldChatText(NOW);
    expect(counts.didNotBlank).toBe(1);
    expect(byId('stuck-forever').message).toBe('question stuck-forever');
    const others = store.chat_match_events.filter((r) => r.created_at < daysAgo(30) && r.id !== 'stuck-forever');
    expect(others.every((r) => r.message === null && r.router_raw === null)).toBe(true);
    for (const id of ['msg-shopify-q', 'msg-shopify-a', 'msg-discord']) expect(msg(id).content).toBeNull();
    expect(conv('conv-shopify-old').title).toBeNull();
    expect(conv('conv-discord-old').title).toBeNull();
    expect(archived()).toEqual(['scrubbed: question shopify-route', 'scrubbed: question widget-measure']);
    expect(counts.archive).toEqual({ eligible: 2, kept: 2, skipped: 0 });
  });

  it('US-15 AC61: a row stuck for two days is never copied while stuck, and is copied once on the day it blanks', async () => {
    store.chat_match_events = [row('stuck-days', 40, { platform: 'widget' })];
    store.neverBlank = new Set(['stuck-days']);
    const onDay = (n: number) => new Date(NOW.getTime() + n * 86400_000);
    for (const n of [0, 1]) expect((await purgeOldChatText(onDay(n))).didNotBlank).toBe(1);
    expect(store.archiveInserts.flat()).toEqual([]);
    store.neverBlank = new Set();
    await purgeOldChatText(onDay(2));
    expect(byId('stuck-days').message).toBeNull();
    expect(store.archiveInserts.flat().map((r) => r.question)).toEqual(['scrubbed: question stuck-days']);
  });

  it('US-15 AC61: a stuck row is a Sentry error with fixed tags only; no id or question text in any log, Sentry or event', async () => {
    store.chat_match_events = [
      row('stuck-SENTINEL', 40, { platform: 'shopify', first: 'SENTINEL first' }, { message: 'SENTINEL question', conversation_id: 'conv-shopify-old' }),
      row('w0', 40, { platform: 'widget' }),
    ];
    store.neverBlank = new Set(['stuck-SENTINEL']);
    const spies = (['log', 'error', 'warn'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      expect((await purgeWithLock('2026-09-10', NOW))?.didNotBlank).toBe(1);
      expect(vi.mocked(Sentry.captureMessage).mock.calls).toEqual([
        ['Chat text purge: rows did not blank', { level: 'error', tags: { feature: 'chat_text_purge', stuck_rows: 1 } }],
      ]);
      expect(spies[0].mock.calls.join(' ')).toContain('questions archived: 1 eligible, 1 kept, 0 skipped; 1 rows did not blank');
      const seen = JSON.stringify([
        spies.map((s) => s.mock.calls),
        vi.mocked(Sentry.captureMessage).mock.calls,
        vi.mocked(Sentry.captureException).mock.calls,
        vi.mocked(recordServerEvent).mock.calls,
        store.archiveInserts,
      ]);
      expect(seen).not.toContain('SENTINEL');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('US-15 AC61: 120 stuck rows selected first do not hide the healthy rows behind them', async () => {
    const stuckIds = Array.from({ length: 120 }, (_, i) => `stuck-${i}`);
    store.chat_match_events = [
      ...stuckIds.map((id) => row(id, 40, { platform: 'widget' })),
      ...Array.from({ length: 150 }, (_, i) => row(`healthy-${i}`, 40, { platform: 'widget' })),
    ];
    store.neverBlank = new Set(stuckIds);
    const counts = await purgeOldChatText(NOW);
    expect(store.chat_match_events.filter((r) => r.id.startsWith('healthy-') && r.message !== null)).toEqual([]);
    expect(counts.archive).toEqual({ eligible: 150, kept: 150, skipped: 0 });
    expect(archived().filter((q) => String(q).includes('stuck-'))).toEqual([]);
    expect(counts).toMatchObject({ didNotBlank: 120, messages: 3, conversations: 2 });
    expect(vi.mocked(Sentry.captureMessage).mock.calls).toEqual([
      ['Chat text purge: rows did not blank', { level: 'error', tags: { feature: 'chat_text_purge', stuck_rows: 120 } }],
    ]);
  });

  it('US-15 AC61: past 150 skipped stuck ids the pass ends, the later passes run, and Sentry says the cap was reached', async () => {
    const stuckIds = Array.from({ length: 260 }, (_, i) => `stuck-SENTINEL-${i}`);
    store.chat_match_events = [
      ...stuckIds.map((id) => row(id, 40, { platform: 'widget' }, { message: `SENTINEL ${id}` })),
      ...Array.from({ length: 50 }, (_, i) => row(`healthy-${i}`, 40, { platform: 'widget' })),
    ];
    store.neverBlank = new Set(stuckIds);
    const counts = await purgeOldChatText(NOW);
    expect(Math.max(...store.skipCounts)).toBeLessThanOrEqual(150);
    expect(counts).toMatchObject({ didNotBlank: 200, messages: 3, conversations: 2, archive: { eligible: 0, kept: 0, skipped: 0 } });
    // The healthy rows sat behind the cap: left for the next day, and the tag says so.
    expect(byId('healthy-0').message).toBe('question healthy-0');
    expect(vi.mocked(Sentry.captureMessage).mock.calls).toEqual([
      ['Chat text purge: rows did not blank', { level: 'error', tags: { feature: 'chat_text_purge', stuck_rows: 200, stuck_cap_reached: true } }],
    ]);
    expect(JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls)).not.toContain('SENTINEL');
  });

  it('US-15 AC61: a row another writer deletes before its blank lands is not kept', async () => {
    store.vanishOnUpdate = new Set(['widget-measure']);
    const counts = await purgeOldChatText(NOW);
    expect(archived()).toEqual(['scrubbed: question shopify-route']);
    expect(counts.archive).toEqual({ eligible: 1, kept: 1, skipped: 0 });
  });

  it('US-15 AC61: the chat DELETE still throws when a row will not blank', async () => {
    store.neverBlank = new Set(['shopify-route']);
    await expect(clearConversationMatchEvents('conv-shopify-old', 'user-1')).rejects.toThrow('deleted chat text purge made no progress');
  });

  it('a deleted conversation’s match events are blanked and never copied', async () => {
    store.chat_match_events.push(
      row('other-user-same-conv', 40, { platform: 'shopify' }, { conversation_id: 'conv-shopify-old', user_id: 'user-2' }),
    );
    expect(await clearConversationMatchEvents('conv-shopify-old', 'user-1')).toBe(3);
    for (const id of ['shopify-route', 'shopify-account', 'shopify-unlabelled']) {
      expect(byId(id)).toMatchObject({ message: null, router_raw: null, router_error: null });
      expect(byId(id).router_context).not.toHaveProperty('first');
    }
    // The filter names the user: another user's row is untouched.
    expect(byId('other-user-same-conv').message).toBe('question other-user-same-conv');
    // The conversation itself is deleted by the route; the purge then copies none of its rows.
    store.chat_match_events = store.chat_match_events.filter((r) => r.id !== 'other-user-same-conv');
    await purgeOldChatText(NOW);
    expect(archived()).toEqual(['scrubbed: question widget-measure']);
  });
});

// C1: the Discord and YouTube saved-chat sentences (chat-save-answers.ts) describe
// this cron. Each test fails when the cron changes until its sentence does too.
describe('the saved-chat sentences match the cron (C1)', () => {
  it('ARCHIVED_PLATFORMS: adding a platform fails until the Discord sentence changes', async () => {
    // A Discord copy with no end date would make "up to 30 days" false. A new platform
    // means re-reading the Discord sentence (and the guide), then updating this pin.
    expect({ ARCHIVED_PLATFORMS, DISCORD_SAVED_CHAT }).toEqual({
      ARCHIVED_PLATFORMS: ['shopify', 'widget'],
      DISCORD_SAVED_CHAT: 'Our server keeps the text of this conversation for up to 30 days after your last message in it. Discord keeps your messages under its own terms.',
    });
    process.env.CHAT_QUESTION_ARCHIVE = 'on';
    store.chat_match_events = [row('discord-route', 40, { platform: 'discord', first: 'q', recent: ['q'] })];
    await purgeOldChatText(NOW);
    expect(store.chat_question_archive).toEqual([]);
    expect(byId('discord-route')).toMatchObject({ message: null, router_raw: null, router_error: null });
  });

  it('fails if the cron starts purging YouTube transcripts while the YouTube sentence says "no end date"', async () => {
    expect(YOUTUBE_SAVED_CHAT).toContain('no end date');
    expect(PURGED_PLATFORMS).not.toContain('youtube');
    await purgeOldChatText(NOW);
    expect(msg('msg-youtube').content).toBe('text msg-youtube');
    expect(conv('conv-youtube-old').title).toBe('title conv-youtube-old');
  });
});
