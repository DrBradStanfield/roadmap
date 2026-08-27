import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assessThreadFollowUp,
  buildThreadHistory,
  addressReply,
  readPostingCaps,
  type YouTubeReply,
} from './youtube-bot.server';

// Chainable PostgREST-builder stub: every filter returns the chain, awaiting it
// resolves to whatever response the test staged.
const supa = vi.hoisted(() => ({
  countRes: { count: 0 as number | null, error: null as unknown },
  listRes: { data: [] as Array<{ video_id: string | null }> | null, error: null as unknown },
}));

vi.mock('./supabase.server', () => ({
  supabaseAdmin: {
    from: () => ({
      select: (_cols: string, opts?: { head?: boolean }) => {
        const res = opts?.head ? supa.countRes : supa.listRes;
        type Chain = {
          eq: () => Chain;
          gte: () => Chain;
          then: (onOk: (v: unknown) => unknown) => Promise<unknown>;
        };
        const chain: Chain = {
          eq: () => chain,
          gte: () => chain,
          then: (onOk) => Promise.resolve(res).then(onOk),
        };
        return chain;
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
