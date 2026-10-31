/**
 * US-27 AC3: one YouTube tick at a time per machine. The daily cap is read at
 * the start of a tick, so a second tick that starts while the first is still
 * running would budget against the same count and could post past the cap.
 * A tick that is due while the last one runs is skipped; the next one after
 * it finishes runs as normal. Synthetic HTTP and a fake clock; no live call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // youtube-bot.server reads its config at module load.
  Object.assign(process.env, {
    YOUTUBE_BOT_CHANNEL_ID: 'synthetic-channel', YOUTUBE_BOT_CLIENT_ID: 'synthetic-client',
    YOUTUBE_BOT_CLIENT_SECRET: 'synthetic-secret', YOUTUBE_BOT_REFRESH_TOKEN: 'synthetic-refresh',
  });
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
// The bot starts only with an admin client; these ticks never reach it.
vi.mock('./supabase.server', () => ({ supabaseAdmin: {} }));

const TICK_MS = 30 * 60_000;
const FIRST_TICK_MS = 30_000;

/** Every request waits until the test releases it; then it fails, which ends
 *  the tick at its first call (the token refresh). */
let releases: Array<() => void> = [];
function tokenCalls(): number {
  return vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === 'https://oauth2.googleapis.com/token').length;
}

beforeEach(() => {
  vi.useFakeTimers();
  process.env.YOUTUBE_BOT_FORCE_START = 'true';
  releases = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
    releases.push(() => resolve(new Response('synthetic outage', { status: 503 })));
  })));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  (await import('./youtube-bot.server')).stopYouTubeBot();
  releases.forEach((release) => release()); // let any tick still waiting end
  await vi.advanceTimersByTimeAsync(0);
  delete process.env.YOUTUBE_BOT_FORCE_START;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('US-27 AC3: one tick at a time', () => {
  it('a tick that is due while the last one still runs is skipped', async () => {
    (await import('./youtube-bot.server')).startYouTubeBot();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS);
    expect(tokenCalls()).toBe(1); // the first tick is waiting on Google

    await vi.advanceTimersByTimeAsync(TICK_MS); // the next tick is due
    expect(tokenCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(tokenCalls()).toBe(1);
  });

  it('the next tick after a finished one runs as normal', async () => {
    (await import('./youtube-bot.server')).startYouTubeBot();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(tokenCalls()).toBe(1);

    releases.forEach((release) => release()); // the first tick ends (refresh failed)
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(tokenCalls()).toBe(2);
  });

  it('a tick that throws still lets the next one run', async () => {
    const Sentry = await import('@sentry/react-router');
    // The first tick's error report throws, so that tick rejects instead of returning.
    vi.mocked(Sentry.captureException).mockImplementationOnce(() => { throw new Error('synthetic report failure'); });
    (await import('./youtube-bot.server')).startYouTubeBot();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS);
    releases.forEach((release) => release()); // the refresh fails; its report throws
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(tokenCalls()).toBe(2);
  });
});
