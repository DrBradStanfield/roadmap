import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/react-router';
import {
  assessThreadFollowUp,
  buildThreadHistory,
  addressReply,
  readPostingCaps,
  PER_VIDEO_REPLY_CAP,
  completionOutcome,
  shouldUnclaim,
  persistYouTubeTurn,
  filterThread,
  isNotReplyableError,
  type YouTubeReply,
} from './youtube-bot.server';
import { ROUTER_VERSION } from './chat-router.server';
import { CHAT_MODEL, FALLBACK_RESPONSE } from './chat.server';

// Chainable PostgREST-builder stub: every filter returns the chain, awaiting it
// resolves to whatever response the test staged.
const supa = vi.hoisted(() => {
  // Read at module load: persistYouTubeTurn is a no-op without it.
  process.env.YOUTUBE_BOT_PROFILE_ID = 'bot-profile';
  return {
    countRes: { count: 0 as number | null, error: null as unknown },
    listRes: { data: [] as Array<{ video_id: string | null }> | null, error: null as unknown },
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  };
});

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (_cols: string, opts?: { head?: boolean }) => {
        const res = opts?.head ? supa.countRes : supa.listRes;
        type Chain = {
          eq: () => Chain;
          gte: () => Chain;
          maybeSingle: () => Promise<unknown>;
          then: (onOk: (v: unknown) => unknown) => Promise<unknown>;
        };
        const chain: Chain = {
          eq: () => chain,
          gte: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          then: (onOk) => Promise.resolve(res).then(onOk),
        };
        return chain;
      },
      insert: (row: Record<string, unknown>) => {
        supa.inserts.push({ table, row });
        const ok = { data: { id: 'conv-1' }, error: null };
        return {
          select: () => ({ single: () => Promise.resolve(ok) }),
          then: (onOk: (v: unknown) => unknown) => Promise.resolve(ok).then(onOk),
        };
      },
    }),
  },
}));

const CHANNEL = 'UC_brad';
const HANDLE = '@drbradstanfield';

function reply(over: Partial<YouTubeReply> & { id: string }): YouTubeReply {
  return {
    authorDisplayName: 'Viewer',
    authorChannelId: 'UC_viewer',
    text: 'Thanks, but does this apply to women over 60 as well?',
    publishedAt: '2026-08-09T10:00:00Z',
    ...over,
  };
}

const botReply = (id: string, publishedAt: string): YouTubeReply =>
  reply({ id, authorChannelId: CHANNEL, authorDisplayName: 'Dr Brad Stanfield', text: 'Answer.', publishedAt });

const base = {
  botPostedIds: new Set(['t1.bot1']),
  channelId: CHANNEL,
  originalAuthor: 'Viewer',
  channelHandle: HANDLE,
};

describe('assessThreadFollowUp', () => {
  it('accepts the original author continuing after the bot reply', () => {
    const d = assessThreadFollowUp({
      ...base,
      replies: [botReply('t1.bot1', '2026-08-09T09:00:00Z'), reply({ id: 't1.r2' })],
    });
    expect(d).toHaveProperty('candidate');
    expect((d as { candidate: YouTubeReply }).candidate.id).toBe('t1.r2');
  });

  it('accepts a third party ONLY with an @our-handle mention', () => {
    const third = reply({ id: 't1.r2', authorDisplayName: 'SomeoneElse' });
    const noMention = assessThreadFollowUp({
      ...base,
      replies: [botReply('t1.bot1', '2026-08-09T09:00:00Z'), third],
    });
    expect(noMention).toEqual({ skip: 'no-addressed-followup' });

    const withMention = assessThreadFollowUp({
      ...base,
      replies: [
        botReply('t1.bot1', '2026-08-09T09:00:00Z'),
        { ...third, text: `${HANDLE} what about statins?` },
      ],
    });
    expect(withMention).toHaveProperty('candidate');
  });

  it('without a known handle, falls back to original-author-only', () => {
    const d = assessThreadFollowUp({
      ...base,
      channelHandle: null,
      replies: [
        botReply('t1.bot1', '2026-08-09T09:00:00Z'),
        reply({ id: 't1.r2', authorDisplayName: 'SomeoneElse', text: `${HANDLE} what about statins?` }),
      ],
    });
    expect(d).toEqual({ skip: 'no-addressed-followup' });
  });

  it('ignores replies published BEFORE the bot reply (they were context, not follow-ups)', () => {
    const d = assessThreadFollowUp({
      ...base,
      replies: [reply({ id: 't1.r0', publishedAt: '2026-08-09T08:00:00Z' }), botReply('t1.bot1', '2026-08-09T09:00:00Z')],
    });
    expect(d).toEqual({ skip: 'no-addressed-followup' });
  });

  it('exits permanently when Brad replied himself (channel comment not posted by the bot)', () => {
    const d = assessThreadFollowUp({
      ...base,
      replies: [
        botReply('t1.bot1', '2026-08-09T09:00:00Z'),
        botReply('t1.brad-manual', '2026-08-09T09:30:00Z'),
        reply({ id: 't1.r3', publishedAt: '2026-08-09T11:00:00Z' }),
      ],
    });
    expect(d).toEqual({ skip: 'brad-engaged' });
  });

  it('enforces the hard cap of 2 channel replies per thread', () => {
    const d = assessThreadFollowUp({
      ...base,
      botPostedIds: new Set(['t1.bot1', 't1.bot2']),
      replies: [
        botReply('t1.bot1', '2026-08-09T09:00:00Z'),
        botReply('t1.bot2', '2026-08-09T10:00:00Z'),
        reply({ id: 't1.r3', publishedAt: '2026-08-09T11:00:00Z' }),
      ],
    });
    expect(d).toEqual({ skip: 'thread-cap' });
  });

  it('takes the OLDEST addressed follow-up when several queue up', () => {
    const d = assessThreadFollowUp({
      ...base,
      replies: [
        botReply('t1.bot1', '2026-08-09T09:00:00Z'),
        reply({ id: 't1.r3', publishedAt: '2026-08-09T11:00:00Z' }),
        reply({ id: 't1.r2', publishedAt: '2026-08-09T10:00:00Z' }),
      ].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)),
    });
    expect((d as { candidate: YouTubeReply }).candidate.id).toBe('t1.r2');
  });
});

describe('addressReply', () => {
  it('prefixes the asker @handle on follow-ups', () => {
    expect(addressReply('Short answer.', '@viewer99')).toBe('@viewer99 Short answer.');
  });

  it('adds the missing @ when customUrl omits it', () => {
    expect(addressReply('Short answer.', 'viewer99')).toBe('@viewer99 Short answer.');
  });

  it('degrades to no prefix when the handle is unresolvable', () => {
    expect(addressReply('Short answer.', null)).toBe('Short answer.');
  });

  it('never double-tags when the model already addressed them', () => {
    expect(addressReply('@Viewer99 already addressed.', '@viewer99')).toBe('@Viewer99 already addressed.');
  });
});

describe('buildThreadHistory', () => {
  it('maps bot turns to assistant, viewers to name-prefixed user, stops at the candidate', () => {
    const replies = [
      botReply('t1.bot1', '2026-08-09T09:00:00Z'),
      reply({ id: 't1.r2', text: 'follow-up one', publishedAt: '2026-08-09T10:00:00Z' }),
      reply({ id: 't1.r3', text: 'should be excluded', publishedAt: '2026-08-09T11:00:00Z' }),
    ];
    const h = buildThreadHistory({ author: 'Viewer', text: 'original comment' }, replies, CHANNEL, 't1.r3');
    expect(h).toEqual([
      { role: 'user', content: 'Viewer: original comment' },
      { role: 'assistant', content: 'Answer.' },
      { role: 'user', content: 'Viewer: follow-up one' },
    ]);
  });

  it('merges consecutive same-role turns so the API never sees an invalid sequence', () => {
    const replies = [
      reply({ id: 't1.r1', text: 'second thought', publishedAt: '2026-08-09T08:30:00Z' }),
      botReply('t1.bot1', '2026-08-09T09:00:00Z'),
      reply({ id: 't1.r3', text: 'candidate', publishedAt: '2026-08-09T10:00:00Z' }),
    ];
    const h = buildThreadHistory({ author: 'Viewer', text: 'original' }, replies, CHANNEL, 't1.r3');
    expect(h).toHaveLength(2);
    expect(h[0].role).toBe('user');
    expect(h[0].content).toBe('Viewer: original\n\nViewer: second thought');
    expect(h[1]).toEqual({ role: 'assistant', content: 'Answer.' });
  });
});

// US-27 AC1+AC2 (Sentry JAVASCRIPT-REMIX-64/65): a failed cap read must fail
// distinguishably (reject) — never resolve to a value that reads as zero
// posts, which silently re-arms the full daily/per-video posting budget.
describe('US-27: posting-cap reads fail closed', () => {
  beforeEach(() => {
    supa.countRes = { count: 0, error: null };
    supa.listRes = { data: [], error: null };
  });

  it('rejects when the daily-count read errors (AC1: never resolves to 0)', async () => {
    supa.countRes = { count: null, error: { code: 'PGRST303', message: 'JWT issued at future' } };
    await expect(readPostingCaps()).rejects.toMatchObject({ code: 'PGRST303' });
  });

  it('rejects when the per-video read errors (AC1: never resolves to an empty map)', async () => {
    supa.countRes = { count: 5, error: null };
    supa.listRes = { data: null, error: { code: 'PGRST303', message: 'JWT issued at future' } };
    await expect(readPostingCaps()).rejects.toMatchObject({ code: 'PGRST303' });
  });

  // Brad 2026-11-03: raised from 10 to 30 now the replies are better.
  it('caps each video at 30 bot replies in its lifetime (US-27)', () => {
    expect(PER_VIDEO_REPLY_CAP).toBe(30);
  });

  it('resolves both caps on success, aggregating per-video totals', async () => {
    supa.countRes = { count: 7, error: null };
    supa.listRes = {
      data: [{ video_id: 'a' }, { video_id: 'a' }, { video_id: 'b' }, { video_id: null }],
      error: null,
    };
    expect(await readPostingCaps()).toEqual({
      dailyCount: 7,
      videoPostCounts: new Map([['a', 2], ['b', 1]]),
    });
  });
});

// US-15 AC15 (chat audit 2026-09-29 F2): a refusal is a decision, not a
// transient failure. Read from the code, not observed in the logs: unclaiming
// it would re-run the same comment every 30-minute tick for up to 7 days,
// three model calls each time.
describe('US-15 AC15: a refusal skips the comment and keeps the claim', () => {
  const usage = { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 };

  it('a refusal is not posted, records its category, and is not unclaimed', () => {
    const line = "I can't help with that here. Please raise it with your doctor or pharmacist.";
    const outcome = completionOutcome({
      content: line,
      usage, isFallback: false, isRefusal: true, refusalCategory: 'general_harms', failureMode: 'refusal', stopReason: 'refusal',
    }, 42);
    expect(outcome.posted).toBe(false);
    expect(outcome.failureMode).toBe('refusal');
    // Adversary R11: the same bounded Sentry warning the web chat sends.
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Chat: main-LLM refusal', {
      level: 'warning',
      tags: { feature: 'chat', subsystem: 'main-llm', platform: 'youtube', stopReason: 'refusal', refusalCategory: 'general_harms' },
      extra: { latencyMs: 42, conversationId: null },
    });
    expect(JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls)).not.toContain(line);
    expect(outcome.skipReason).toBe('main-LLM refusal (general_harms)');
    expect(outcome.replyText).toBeUndefined();
    expect(shouldUnclaim(outcome)).toBe(false);
  });

  it('a fallback is still unclaimed for retry next tick', () => {
    const outcome = completionOutcome({ content: 'Sorry', usage, isFallback: true, failureMode: 'api-error' }, 1);
    expect(outcome.posted).toBe(false);
    expect(outcome.skipReason).toBe('main-LLM failure (api-error)');
    expect(shouldUnclaim(outcome)).toBe(true);
  });

  it('SKIP_NO_REPLY keeps the claim; an answer is posted', () => {
    const skip = completionOutcome({ content: ' SKIP_NO_REPLY ', usage, isFallback: false }, 1);
    expect(skip).toMatchObject({ posted: false, skipReason: 'main-LLM returned SKIP_NO_REPLY' });
    expect(shouldUnclaim(skip)).toBe(false);
    expect(completionOutcome({ content: 'An answer. ', usage, isFallback: false }, 1))
      .toMatchObject({ posted: true, replyText: 'An answer.' });
  });
});

describe('US-15 AC27: stored text cuts keep surrogate pairs whole (Sentry 6Y)', () => {
  // JSON.stringify writes a lone surrogate as a \udXXX escape; PostgREST then
  // rejects the whole body (PGRST102 "Empty or invalid json").
  const LONE_SURROGATE = /\\u[dD][89a-fA-F]/;

  it('cuts the YouTube conversation title and router_raw before a split emoji', async () => {
    supa.inserts.length = 0;
    await persistYouTubeTurn({
      thread: {
        topLevelCommentId: 'c1',
        videoId: 'v1',
        authorDisplayName: 'Viewer',
        authorChannelId: 'UC_viewer',
        text: 'a'.repeat(79) + '😀' + 'b',
        publishedAt: '2026-10-07T00:00:00Z',
      },
      outcome: {
        posted: false,
        skipReason: 'router-error',
        routerResult: {
          handles: [],
          rawJson: 'r'.repeat(499) + '😀',
          usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
          latencyMs: 1,
          cacheHit: false,
          error: 'parse',
        },
      },
      postedYoutubeId: null,
    });

    const conv = supa.inserts.find((i) => i.table === 'chat_conversations');
    // US-15 AC52: the web's generateTitle, so a long title ends in an ellipsis.
    expect(conv?.row.title).toBe('a'.repeat(79) + '…');
    const evt = supa.inserts.find((i) => i.table === 'chat_match_events');
    expect(evt?.row.router_raw).toBe('r'.repeat(499));
    for (const { row } of supa.inserts) expect(JSON.stringify(row)).not.toMatch(LONE_SURROGATE);
  });
});

// US-15 AC37 (Sentry 6Z): the row carries the router's output token count,
// and null when the router did not run.
describe('US-15 AC37: router_output_tokens on the YouTube row', () => {
  const thread = {
    topLevelCommentId: 'c1', videoId: 'v1', authorDisplayName: 'Viewer', authorChannelId: 'UC_viewer',
    text: 'hello', publishedAt: '2026-10-14T00:00:00Z',
  };
  const routerResult = {
    handles: [], rawJson: '{"handles":[]}', latencyMs: 1, cacheHit: false, error: null,
    usage: { inputTokens: 900, outputTokens: 37, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
  const row = () => supa.inserts.find((i) => i.table === 'chat_match_events')?.row;

  it('US-15 AC37: carries the count when the router ran', async () => {
    supa.inserts.length = 0;
    await persistYouTubeTurn({ thread, outcome: { posted: false, skipReason: 'no-match', routerResult }, postedYoutubeId: null });
    expect(row()?.router_output_tokens).toBe(37);
  });

  it('US-15 AC37: reads null when the router did not run', async () => {
    supa.inserts.length = 0;
    await persistYouTubeTurn({ thread, outcome: { posted: false, skipReason: 'classifier-skip' }, postedYoutubeId: null });
    expect(row()?.router_output_tokens).toBeNull();
  });
});

describe('US-53: a comment YouTube will not let us reply to is skipped, not an error', () => {
  const thread = {
    topLevelCommentId: 'c1', videoId: 'v1', authorDisplayName: 'A', authorChannelId: null,
    text: 'How much magnesium should I take for sleep, and which form is best?',
    publishedAt: new Date().toISOString(),
  };

  it('AC1: canReply false fails the filter; true or absent passes', () => {
    expect(filterThread({ ...thread, canReply: false })).toEqual({ pass: false, reason: 'cannot reply' });
    expect(filterThread({ ...thread, canReply: true }).pass).toBe(true);
    expect(filterThread(thread).pass).toBe(true);
  });

  it('a short comment passes when it reads as a crisis or emergency (US-15 AC39 review N5)', () => {
    for (const text of ['I want to die', 'thinking of suicide', 'gonna kill myself', 'chest pain right now', "can't breathe help", 'took an overdose']) {
      expect(filterThread({ ...thread, text }).pass, text).toBe(true);
    }
    expect(filterThread({ ...thread, text: 'great video thanks' })).toEqual({ pass: false, reason: 'too short (3 words)' });
  });

  it('AC2: only the canReply 400 counts as not replyable', () => {
    const body = '{"error":{"code":400,"message":"Not all comments can be replied to. Check the comment thread\'s canReply field."}}';
    expect(isNotReplyableError(new Error(`YouTube post failed: 400 ${body}`))).toBe(true);
    expect(isNotReplyableError(new Error('YouTube post failed: 403 quota'))).toBe(false);
    expect(isNotReplyableError(new Error('YouTube post failed: 400 other'))).toBe(false);
  });
});

// US-15 AC37a: every chat row a YouTube turn writes, pinned column for column,
// so moving the router columns into one shared mapping changes nothing else.
describe('US-15 AC37a: the YouTube turn rows, column for column', () => {
  const thread = {
    topLevelCommentId: 'c1', videoId: 'v1', authorDisplayName: 'Viewer', authorChannelId: 'UC_viewer',
    text: 'What is a good ApoB?', publishedAt: '2026-10-14T00:00:00Z',
  };
  const usage = { inputTokens: 11, outputTokens: 22, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const routerResult = {
    handles: ['apob'], rawJson: '{"handles":["apob"]}', latencyMs: 15, cacheHit: true, error: null,
    usage: { inputTokens: 900, outputTokens: 37, cacheCreationTokens: 0, cacheReadTokens: 120 },
  };
  const conv = { user_id: 'bot-profile', title: 'What is a good ApoB?', platform: 'youtube', external_id: 'c1' };
  const userRow = { conversation_id: 'conv-1', user_id: 'bot-profile', role: 'user', content: 'What is a good ApoB?' };
  const context = { platform: 'youtube', videoId: 'v1', commentId: 'c1', followUpCommentId: null };

  it('a posted answer the router ran for', async () => {
    supa.inserts.length = 0;
    await persistYouTubeTurn({
      thread, postedYoutubeId: 'yt-9',
      outcome: { posted: true, classification: 'ROUTE', routerHandles: ['apob'], routerResult, routerSkipped: false,
        replaced: ['old-post'], replyText: 'An answer.', completion: { content: 'An answer.', usage, isFallback: false }, isFallback: false },
    });
    const asst = supa.inserts[2].row;
    expect(supa.inserts).toEqual([
      { table: 'chat_conversations', row: conv },
      { table: 'chat_messages', row: userRow },
      { table: 'chat_messages', row: { id: expect.any(String), conversation_id: 'conv-1', user_id: 'bot-profile', role: 'assistant',
        content: 'An answer.', input_tokens: 11, output_tokens: 22, model: CHAT_MODEL, is_fallback: false, failure_mode: null, error_detail: null } },
      { table: 'chat_match_events', row: {
        message_id: asst.id, conversation_id: 'conv-1', user_id: 'bot-profile', message: 'What is a good ApoB?',
        router_context: { ...context, postedYoutubeId: 'yt-9', posted: true, skipReason: null, replaced: ['old-post'] },
        matched_handles: ['apob'], router_version: ROUTER_VERSION, router_latency_ms: 15, router_cache_hit: true,
        router_input_tokens: 900, router_cache_read_tokens: 120, router_output_tokens: 37, router_raw: null, router_error: null,
        classification: 'ROUTE', router_skipped: false, is_fallback: false, failure_mode: null,
      } },
    ]);
  });

  it('a classifier skip: the router did not run, so every router column is null, router_version included', async () => {
    supa.inserts.length = 0;
    await persistYouTubeTurn({
      thread, postedYoutubeId: null,
      outcome: { posted: false, skipReason: 'classifier=GREETING', classification: 'GREETING', routerHandles: [], routerResult: null, routerSkipped: true },
    });
    expect(supa.inserts).toEqual([
      { table: 'chat_conversations', row: conv },
      { table: 'chat_messages', row: userRow },
      { table: 'chat_match_events', row: {
        message_id: null, conversation_id: 'conv-1', user_id: 'bot-profile', message: 'What is a good ApoB?',
        router_context: { ...context, postedYoutubeId: null, posted: false, skipReason: 'classifier=GREETING' },
        matched_handles: [], router_version: null, router_latency_ms: null, router_cache_hit: null,
        router_input_tokens: null, router_cache_read_tokens: null, router_output_tokens: null, router_raw: null, router_error: null,
        classification: 'GREETING', router_skipped: true, is_fallback: false, failure_mode: null,
      } },
    ]);
  });
});

// US-15 AC52 (Brad 2026-11-03, "do it"): a YouTube turn writes the rows the web
// chat writes, a failed turn included, from the same mappings.
describe('US-15 AC52: a YouTube turn writes the web chat\'s rows', () => {
  const thread = {
    topLevelCommentId: 'c1', videoId: 'v1', authorDisplayName: 'Viewer', authorChannelId: 'UC_viewer',
    text: 'What is a good ApoB?', publishedAt: '2026-11-03T00:00:00Z',
  };
  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const rowOf = (table: string, role?: string) =>
    supa.inserts.find((i) => i.table === table && (!role || i.row.role === role))?.row;

  it('a failed answer (api-error) stores the assistant row with failure_mode and error_detail, as the web does', async () => {
    supa.inserts.length = 0;
    const completion = { content: FALLBACK_RESPONSE, usage, isFallback: true, failureMode: 'api-error' as const, errorDetail: 'e'.repeat(600) };
    await persistYouTubeTurn({
      thread, postedYoutubeId: null,
      outcome: { classification: 'ROUTE', routerHandles: [], routerResult: null, routerSkipped: true, completion, ...completionOutcome(completion, 1) },
    });
    const asst = rowOf('chat_messages', 'assistant');
    expect(asst).toEqual({
      id: expect.any(String), conversation_id: 'conv-1', user_id: 'bot-profile', role: 'assistant',
      content: FALLBACK_RESPONSE, input_tokens: 0, output_tokens: 0, model: CHAT_MODEL,
      is_fallback: true, failure_mode: 'api-error', error_detail: 'e'.repeat(500),
    });
    expect(rowOf('chat_match_events')).toMatchObject({ message_id: asst?.id, is_fallback: true, failure_mode: 'api-error' });
  });

  it('an empty answer stores failure_mode empty-response and no error_detail', async () => {
    supa.inserts.length = 0;
    const completion = { content: FALLBACK_RESPONSE, usage, isFallback: true, failureMode: 'empty-response' as const };
    await persistYouTubeTurn({ thread, postedYoutubeId: null, outcome: { completion, ...completionOutcome(completion, 1) } });
    expect(rowOf('chat_messages', 'assistant')).toMatchObject({ content: FALLBACK_RESPONSE, is_fallback: true, failure_mode: 'empty-response', error_detail: null });
  });

  it('a refusal stores the refusal line with failure_mode refusal, not a fallback', async () => {
    supa.inserts.length = 0;
    const line = "I can't help with that here. Please raise it with your doctor or pharmacist.";
    const completion = { content: line, usage, isFallback: false, isRefusal: true, refusalCategory: 'general_harms' as const, failureMode: 'refusal' as const, stopReason: 'refusal' };
    await persistYouTubeTurn({ thread, postedYoutubeId: null, outcome: { completion, ...completionOutcome(completion, 1) } });
    expect(rowOf('chat_messages', 'assistant')).toMatchObject({ content: line, is_fallback: false, failure_mode: 'refusal', error_detail: null });
    expect(rowOf('chat_match_events')).toMatchObject({ is_fallback: false, failure_mode: 'refusal' });
  });

  it('stores the answer trimmed, as posted, so a padded SKIP_NO_REPLY still reads SKIP_NO_REPLY', async () => {
    for (const [raw, stored] of [[' An answer.\n', 'An answer.'], [' SKIP_NO_REPLY\n', 'SKIP_NO_REPLY']]) {
      supa.inserts.length = 0;
      const completion = { content: raw, usage, isFallback: false };
      await persistYouTubeTurn({ thread, postedYoutubeId: null, outcome: { completion, ...completionOutcome(completion, 1) } });
      expect(rowOf('chat_messages', 'assistant')?.content).toBe(stored);
    }
  });

  it('a classifier skip (no model call) still stores no assistant row', async () => {
    supa.inserts.length = 0;
    await persistYouTubeTurn({ thread, postedYoutubeId: null, outcome: { posted: false, skipReason: 'classifier=GREETING', classification: 'GREETING' } });
    expect(rowOf('chat_messages', 'assistant')).toBeUndefined();
    expect(rowOf('chat_match_events')?.message_id).toBeNull();
  });

  it('the match event holds the question as the web stores it: control characters spaced, first 500 characters', async () => {
    supa.inserts.length = 0;
    await persistYouTubeTurn({ thread: { ...thread, text: 'a\u0007b' + 'c'.repeat(700) }, postedYoutubeId: null, outcome: { posted: false, skipReason: 'no-match' } });
    expect(rowOf('chat_match_events')?.message).toBe('a b' + 'c'.repeat(497));
    // The comment itself stays whole in its chat_messages row.
    expect(rowOf('chat_messages', 'user')?.content).toBe('a\u0007b' + 'c'.repeat(700));
  });

  it('the conversation title is made as the web makes it', async () => {
    supa.inserts.length = 0;
    await persistYouTubeTurn({ thread: { ...thread, text: 'Is ApoB better than LDL? I am asking for my dad.' }, postedYoutubeId: null, outcome: { posted: false, skipReason: 'no-match' } });
    expect(rowOf('chat_conversations')?.title).toBe('Is ApoB better than LDL?');
  });
});
