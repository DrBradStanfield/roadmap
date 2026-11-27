/**
 * US-15 AC82: the YouTube prompt template (app/lib/chat-youtube-prompt.md) is a
 * chat doc, read once with the others (AC80), never at import. Absent or blank,
 * the docs are degraded, one Sentry error names the file, and the bot does not
 * start (as before, when only a console line said so).
 */
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase-client.server', () => ({ supabaseAdmin: {} }));

const PROMPT_FILE = 'app/lib/chat-youtube-prompt.md';
const entry = { title: 'Creatine and the brain', handle: 'creatine-brain', url: 'u', tags: [], publishedAt: '2025-02-03T00:00:00Z' };

/** Fresh modules, every read of the YouTube prompt counted; `fail` makes that one file unreadable. */
async function fresh(fail = false) {
  vi.resetModules();
  const fs = (await import('fs')).default;
  const real = fs.readFileSync.bind(fs);
  let promptReads = 0;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: string, ...rest: unknown[]) => {
    if (String(file).endsWith(PROMPT_FILE)) {
      promptReads++;
      if (fail) throw new Error('ENOENT');
    }
    return (real as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const Sentry = await import('@sentry/react-router');
  vi.mocked(Sentry.captureMessage).mockClear();
  const context = await import('./youtube-context');
  return { context, captureMessage: vi.mocked(Sentry.captureMessage), reads: () => promptReads, real };
}

afterEach(() => vi.restoreAllMocks());

describe('US-15 AC82: the YouTube prompt template is a chat doc, read once with the others', () => {
  it('importing the context reads no prompt; two contexts carry the file with the video filled in, from one read', async () => {
    const { context, reads, real } = await fresh();
    expect(reads()).toBe(0);
    const file = real(path.join(process.cwd(), PROMPT_FILE), 'utf-8') as string;
    const expected = file
      .replace('{{VIDEO_TITLE}}', entry.title)
      .replace('{{VIDEO_URL}}', 'https://youtu.be/v1')
      .replace('{{VIDEO_PUBLISHED}}', '2025-02-03')
      .replace('{{VIDEO_CONTENT}}', 'Body.');
    expect(file).toContain('{{VIDEO_CONTENT}}');
    expect(context.buildYouTubePlatformContext('v1', entry, 'Body.', [])).toBe(expected);
    expect(context.buildYouTubePlatformContext('v1', entry, 'Body.', [], true).startsWith(expected)).toBe(true);
    expect(reads()).toBe(1);
  });

  it('an unreadable prompt file: one Sentry error names the file, and the bot does not start', async () => {
    // The bot reads its config at module load; every other start gate is open.
    Object.assign(process.env, {
      YOUTUBE_BOT_CHANNEL_ID: 'synthetic-channel', YOUTUBE_BOT_CLIENT_ID: 'synthetic-client',
      YOUTUBE_BOT_CLIENT_SECRET: 'synthetic-secret', YOUTUBE_BOT_REFRESH_TOKEN: 'synthetic-refresh', YOUTUBE_BOT_FORCE_START: 'true',
    });
    vi.useFakeTimers();
    try {
      const { captureMessage } = await fresh(true);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.mocked(console.warn);
      const error = vi.mocked(console.error);
      const { startYouTubeBot, stopYouTubeBot } = await import('./youtube-bot.server');
      startYouTubeBot();
      expect(log.mock.calls.some(([line]) => String(line).startsWith('YouTube bot started'))).toBe(false);
      // One fact, one log line: the docs load's, not a second one from the bot.
      const lines = [...warn.mock.calls, ...error.mock.calls].map(([line]) => String(line)).filter((line) => line.includes('chat-youtube-prompt.md'));
      expect(lines).toEqual([`CHAT KNOWLEDGE MISSING: ${PROMPT_FILE} missing or empty; what reads it runs without it or stays off`]);
      expect(captureMessage.mock.calls).toEqual([[`Chat knowledge file missing: ${PROMPT_FILE}`, { level: 'error', tags: { feature: 'chat', subsystem: 'system-prompt' } }]]);
      stopYouTubeBot();
    } finally {
      vi.useRealTimers();
      for (const key of ['YOUTUBE_BOT_CHANNEL_ID', 'YOUTUBE_BOT_CLIENT_ID', 'YOUTUBE_BOT_CLIENT_SECRET', 'YOUTUBE_BOT_REFRESH_TOKEN', 'YOUTUBE_BOT_FORCE_START']) delete process.env[key];
    }
  });
});
