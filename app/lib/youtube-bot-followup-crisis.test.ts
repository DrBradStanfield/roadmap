/**
 * US-15 AC56: a short crisis or emergency follow-up reaches the pipeline, like
 * a top-level comment does (AC39 review N5). The follow-up scan had its own word
 * floor without the crisis exemption, so "chest pain" under the bot's reply was
 * skipped as too short; and the scan only ever looked at the oldest addressed
 * reply, so a crisis after a short "thanks" was never seen. Found by
 * @robertaustinbell's untangle audit (bug 1). These drive assessThreadFollowUp,
 * the one decision processFollowUps acts on.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: {} }));

import { assessThreadFollowUp, filterThread } from './youtube-bot-pipeline.server';
import type { YouTubeReply } from './youtube-bot-api.server';

const CHANNEL = 'UC_brad';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const bot = { id: 'bot1', authorDisplayName: 'Dr Brad Stanfield', authorChannelId: CHANNEL, text: 'Answer.', publishedAt: minutesAgo(120) };
const viewer = (id: string, text: string, publishedAt: string): YouTubeReply =>
  ({ id, authorDisplayName: 'Viewer', authorChannelId: 'UC_viewer', text, publishedAt });
const decide = (...after: YouTubeReply[]) => assessThreadFollowUp({
  replies: [bot, ...after], botPostedIds: new Set(['bot1']), channelId: CHANNEL,
  originalAuthor: 'Viewer', channelHandle: '@drbradstanfield',
});

describe('US-15 AC56: a short crisis follow-up reaches the pipeline', () => {
  it('a one- or two-word crisis follow-up is the candidate', () => {
    for (const text of ['chest pain', 'overdosed', 'suicidal', "can't breathe", 'kill me']) {
      expect(decide(viewer('r1', text, minutesAgo(60))), text).toEqual({ candidate: expect.objectContaining({ id: 'r1' }) });
    }
  });

  it('a crisis after an earlier short reply is still seen', () => {
    const d = decide(viewer('r1', 'thanks doc', minutesAgo(90)), viewer('r2', 'now I have chest pain', minutesAgo(30)));
    expect(d).toEqual({ candidate: expect.objectContaining({ id: 'r2' }) });
  });

  it('a short follow-up that is not a crisis is skipped as too short', () => {
    expect(decide(viewer('r1', 'thanks doc', minutesAgo(60)))).toEqual({ skip: 'too-short' });
  });

  it('a stale follow-up is skipped even when it reads as a crisis', () => {
    const oldBot = { ...bot, publishedAt: minutesAgo(9 * 24 * 60) };
    const d = assessThreadFollowUp({
      replies: [oldBot, viewer('r1', 'chest pain', minutesAgo(8 * 24 * 60))], botPostedIds: new Set(['bot1']),
      channelId: CHANNEL, originalAuthor: 'Viewer', channelHandle: null,
    });
    expect(d).toEqual({ skip: 'stale' });
  });

  it('the top-level floor keeps its own number with the same exemption', () => {
    const thread = { topLevelCommentId: 'c1', videoId: 'v1', authorDisplayName: 'A', authorChannelId: null, publishedAt: minutesAgo(5) };
    expect(filterThread({ ...thread, text: 'does it cause blindness?' })).toEqual({ pass: false, reason: 'too short (4 words)' });
    expect(filterThread({ ...thread, text: 'chest pain' }).pass).toBe(true);
  });
});
