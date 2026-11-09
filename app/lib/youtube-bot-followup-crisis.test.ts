/**
 * US-15 AC56: a short crisis or emergency follow-up gets the emergency reply,
 * like a top-level comment does (AC39 review N5). The follow-up scan used its
 * own word floor without the crisis exemption, so "chest pain" or "overdosed"
 * under the bot's reply was skipped as too short. Found by @robertaustinbell's
 * untangle audit (bug 1).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: {} }));

import { filterThread, followUpHygiene } from './youtube-bot-pipeline.server';
import type { YouTubeReply } from './youtube-bot-api.server';

const now = () => new Date().toISOString();
const followUp = (text: string, publishedAt = now()): YouTubeReply =>
  ({ id: 'r1', authorDisplayName: 'Viewer', authorChannelId: 'UC_viewer', text, publishedAt });

describe('US-15 AC56: the follow-up word floor keeps the crisis exemption', () => {
  it('a one- or two-word crisis follow-up goes on to the pipeline', () => {
    for (const text of ['chest pain', 'overdosed', 'suicidal', "can't breathe", 'kill me']) {
      expect(followUpHygiene(followUp(text)), text).toBeNull();
    }
  });

  it('a short follow-up that is not a crisis is still skipped as too short', () => {
    expect(followUpHygiene(followUp('thanks doc'))).toBe('too-short');
    expect(followUpHygiene(followUp('ok'))).toBe('too-short');
  });

  it('a normal follow-up goes on, and a stale one is skipped even when it reads as a crisis', () => {
    expect(followUpHygiene(followUp('does it cause blindness?'))).toBeNull();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    expect(followUpHygiene(followUp('chest pain', old))).toBe('stale');
  });

  it('the top-level floor still applies its own number with the same exemption', () => {
    const thread = { topLevelCommentId: 'c1', videoId: 'v1', authorDisplayName: 'A', authorChannelId: null, publishedAt: now() };
    expect(filterThread({ ...thread, text: 'does it cause blindness?' })).toEqual({ pass: false, reason: 'too short (4 words)' });
    expect(filterThread({ ...thread, text: 'chest pain' }).pass).toBe(true);
  });
});
