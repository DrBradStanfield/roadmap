// US-15 AC70 (lead S-2): every write a Discord or a YouTube chat turn makes, in
// order, on success and on each failed write, pinned row for row. These pin what
// each surface does today, differences included, so a later shared persist
// function (lead S-1) cannot widen what is stored, drop a cut or change a
// failure path without a red test. The web turn's writes: api.chat-persist-pins.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Write =
  | { op: 'insert'; table: string; row: Record<string, unknown> }
  | { op: 'update'; table: string; patch: Record<string, unknown>; eq: [string, unknown] };

const db = vi.hoisted(() => {
  // Read at module load: both persist functions are no-ops without them.
  process.env.DISCORD_BOT_PROFILE_ID = 'bot-profile';
  process.env.YOUTUBE_BOT_PROFILE_ID = 'bot-profile';
  return {
    writes: [] as Write[],
    /** Writes that answer an error, keyed `table` or `table:role`. */
    fail: new Set<string>(),
    /** The conversation YouTube's find-or-create finds, if any. */
    existing: null as null | { id: string },
    /** Makes from() throw, as a client fault would. */
    throws: false,
  };
});

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase-client.server', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (db.throws) throw new Error('client fault');
      const res = (key: string) => (db.fail.has(key) || db.fail.has(table)
        ? { data: null, error: { message: 'boom' } }
        : { data: { id: 'conv-new' }, error: null });
      return {
        insert: (row: Record<string, unknown>) => {
          db.writes.push({ op: 'insert', table, row });
          const r = res(`${table}:${String(row.role ?? '')}`);
          return { select: () => ({ single: () => Promise.resolve(r) }), then: (ok: (v: unknown) => unknown) => Promise.resolve(r).then(ok) };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, val: unknown) => {
            db.writes.push({ op: 'update', table, patch, eq: [col, val] });
            return Promise.resolve({ data: null, error: null });
          },
        }),
        select: () => {
          const chain = { eq: () => chain, maybeSingle: () => Promise.resolve({ data: db.existing, error: null }) };
          return chain;
        },
      };
    },
  },
}));

import { persistConversation } from './discord-bot-persist.server';
import { persistYouTubeTurn } from './youtube-bot-store.server';
import { CHAT_MODEL } from './chat.server';
import type { ChatCompletionResult } from './chat.server';

beforeEach(() => {
  db.writes = [];
  db.fail = new Set();
  db.existing = null;
  db.throws = false;
});

const NOT_RUN = {
  matched_handles: [], router_version: null, router_latency_ms: null, router_cache_hit: null, router_input_tokens: null,
  router_cache_read_tokens: null, router_output_tokens: null, router_raw: null, router_error: null,
};
const answer = { input_tokens: 11, output_tokens: 22, model: CHAT_MODEL, is_fallback: false, failure_mode: null, error_detail: null };
const asstId = () => (db.writes.find((w) => w.op === 'insert' && w.row.role === 'assistant') as { row: { id: unknown } } | undefined)?.row.id;

describe('US-15 AC70: every write a Discord turn makes', () => {
  const turn = {
    conversationId: null as string | null, authorId: 'u1', userMessage: 'What is a good ApoB?', userDiscordMessageId: 'm1',
    assistantContent: 'An answer.', silent: false, assistantDiscordMessageIds: ['m2', 'm3'],
    usage: { inputTokens: 11, outputTokens: 22, cacheCreationTokens: 0, cacheReadTokens: 0 },
    isFallback: false, routerResult: null, classifier: { classification: 'GREETING', routerSkipped: true },
    contextFirst: 'first question', contextRecent: ['earlier'],
  };
  const conv = { op: 'insert', table: 'chat_conversations', row: { user_id: 'bot-profile', title: 'What is a good ApoB?', platform: 'discord', external_id: 'u1' } };
  const user = (c: string) => ({ op: 'insert', table: 'chat_messages', row: { conversation_id: c, user_id: 'bot-profile', role: 'user', content: 'What is a good ApoB?', discord_message_id: 'm1' } });
  const asst = (c: string) => ({ op: 'insert', table: 'chat_messages', row: { id: asstId(), conversation_id: c, user_id: 'bot-profile', role: 'assistant', content: 'An answer.', ...answer, discord_message_id: 'm2' } });
  const event = (c: string | null, messageId: unknown, context: Record<string, unknown> = { first: 'first question', recent: ['earlier'] }) => ({
    op: 'insert', table: 'chat_match_events', row: {
      message_id: messageId, conversation_id: c, user_id: 'bot-profile', message: 'What is a good ApoB?',
      router_context: { platform: 'discord', ...context }, ...NOT_RUN, classification: 'GREETING', router_skipped: true, is_fallback: false, failure_mode: null,
    },
  });
  const touch = (c: string) => ({ op: 'update', table: 'chat_conversations', patch: { updated_at: expect.any(String) }, eq: ['id', c] });

  const cases: Array<[string, Partial<typeof turn>, string[], () => unknown[]]> = [
    ['a new conversation: conversation, question, answer, event, then the timestamp', {}, [],
      () => [conv, user('conv-new'), asst('conv-new'), event('conv-new', asstId()), touch('conv-new')]],
    ['a known conversation: no conversation row', { conversationId: 'conv-old' }, [],
      () => [user('conv-old'), asst('conv-old'), event('conv-old', asstId()), touch('conv-old')]],
    ['a silent (SPAM) turn: the event alone, message_id null, no timestamp (AC48)', { silent: true }, [],
      () => [event(null, null)]],
    ['a silent turn in a known conversation: the event alone, no timestamp', { silent: true, conversationId: 'conv-old' }, [],
      () => [event('conv-old', null)]],
    ['the conversation insert fails: nothing more', {}, ['chat_conversations'],
      () => [conv]],
    ['the question insert fails: the rest still written', {}, ['chat_messages:user'],
      () => [conv, user('conv-new'), asst('conv-new'), event('conv-new', asstId()), touch('conv-new')]],
    ['the answer insert fails: no event and no timestamp', {}, ['chat_messages:assistant'],
      () => [conv, user('conv-new'), asst('conv-new')]],
    ['the event insert fails: the timestamp still moves', {}, ['chat_match_events'],
      () => [conv, user('conv-new'), asst('conv-new'), event('conv-new', asstId()), touch('conv-new')]],
  ];

  it.each(cases)('%s', async (_name, over, fail, expected) => {
    db.fail = new Set(fail);
    await expect(persistConversation({ ...turn, ...over })).resolves.toBeUndefined();
    expect(db.writes).toEqual(expected());
  });
});

describe('US-15 AC70: every write a YouTube turn makes', () => {
  const thread = { topLevelCommentId: 'c1', videoId: 'v1', authorDisplayName: 'Viewer', authorChannelId: 'UC_v', text: 'Is ApoB better than LDL?', publishedAt: '2026-11-01T00:00:00Z' };
  const completion: ChatCompletionResult = {
    content: '  An answer.  ', isFallback: false, stopReason: 'end_turn',
    usage: { inputTokens: 11, outputTokens: 22, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
  const answered = { posted: true, replyText: 'An answer.', classification: 'GREETING', routerSkipped: true, completion };
  const skipped = { posted: false, skipReason: 'classifier=SPAM', classification: 'SPAM', routerHandles: [], routerResult: null };
  const conv = { op: 'insert', table: 'chat_conversations', row: { user_id: 'bot-profile', title: 'Is ApoB better than LDL?', platform: 'youtube', external_id: 'c1' } };
  const user = (c: string) => ({ op: 'insert', table: 'chat_messages', row: { conversation_id: c, user_id: 'bot-profile', role: 'user', content: 'Is ApoB better than LDL?' } });
  const asst = (c: string) => ({ op: 'insert', table: 'chat_messages', row: { id: expect.any(String), conversation_id: c, user_id: 'bot-profile', role: 'assistant', content: 'An answer.', ...answer } });
  const event = (c: string, messageId: unknown, o: { posted: boolean; skipReason: string | null; classification: string; followUp?: string | null; postedId?: string | null }) => ({
    op: 'insert', table: 'chat_match_events', row: {
      message_id: messageId, conversation_id: c, user_id: 'bot-profile', message: 'Is ApoB better than LDL?',
      router_context: { platform: 'youtube', videoId: 'v1', commentId: 'c1', followUpCommentId: o.followUp ?? null, postedYoutubeId: o.postedId ?? null, posted: o.posted, skipReason: o.skipReason },
      ...NOT_RUN, classification: o.classification, router_skipped: o.classification === 'GREETING', is_fallback: false, failure_mode: null,
    },
  });
  const posted = { posted: true, skipReason: null, classification: 'GREETING', postedId: 'yt-9' };

  it('a new thread answered: conversation, comment, answer (trimmed), event; no timestamp update', async () => {
    await persistYouTubeTurn({ thread, outcome: answered, postedYoutubeId: 'yt-9' });
    expect(db.writes).toEqual([conv, user('conv-new'), asst('conv-new'), event('conv-new', asstId(), posted)]);
  });

  it('a follow-up in a known thread: no conversation row, the follow-up id on the event', async () => {
    db.existing = { id: 'conv-old' };
    await persistYouTubeTurn({ thread, outcome: answered, postedYoutubeId: 'yt-9', followUpCommentId: 'c1.r2' });
    expect(db.writes).toEqual([user('conv-old'), asst('conv-old'), event('conv-old', asstId(), { ...posted, followUp: 'c1.r2' })]);
  });

  it('a silent classifier skip: comment and event, no answer row, message_id null', async () => {
    await persistYouTubeTurn({ thread, outcome: skipped, postedYoutubeId: null });
    expect(db.writes).toEqual([conv, user('conv-new'), event('conv-new', null, { posted: false, skipReason: 'classifier=SPAM', classification: 'SPAM' })]);
  });

  it('the conversation insert fails: nothing more', async () => {
    db.fail = new Set(['chat_conversations']);
    await persistYouTubeTurn({ thread, outcome: answered, postedYoutubeId: 'yt-9' });
    expect(db.writes).toEqual([conv]);
  });

  it('the comment insert fails: the rest still written', async () => {
    db.fail = new Set(['chat_messages:user']);
    await persistYouTubeTurn({ thread, outcome: answered, postedYoutubeId: 'yt-9' });
    expect(db.writes).toEqual([conv, user('conv-new'), asst('conv-new'), event('conv-new', asstId(), posted)]);
  });

  it('the answer insert fails: the event is still written, its message_id null', async () => {
    db.fail = new Set(['chat_messages:assistant']);
    await persistYouTubeTurn({ thread, outcome: answered, postedYoutubeId: 'yt-9' });
    expect(db.writes).toEqual([conv, user('conv-new'), asst('conv-new'), event('conv-new', null, posted)]);
  });

  it('a client fault is swallowed: the bot goes on', async () => {
    db.throws = true;
    await expect(persistYouTubeTurn({ thread, outcome: answered, postedYoutubeId: 'yt-9' })).resolves.toBeUndefined();
    expect(db.writes).toEqual([]);
  });
});
