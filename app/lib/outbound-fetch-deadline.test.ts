/**
 * US-09 AC30: every call the server makes to another service carries a
 * deadline. A provider that accepts the socket and then says nothing must not
 * hold a route, a webhook or the YouTube tick for the socket's own timeout.
 *
 * Two halves. The scan reads every production file under app/ and checks that
 * each `fetch(` call passes a `signal`, so a new call without one fails here.
 * The behaviour cases stall a synthetic provider and check the callers give up
 * at their deadline, the YouTube tick through its first two calls. Synthetic
 * HTTP only; no live provider.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => {
  // youtube-bot.server reads its config at module load.
  Object.assign(process.env, {
    YOUTUBE_BOT_CHANNEL_ID: 'synthetic-channel', YOUTUBE_BOT_CLIENT_ID: 'synthetic-client',
    YOUTUBE_BOT_CLIENT_SECRET: 'synthetic-secret', YOUTUBE_BOT_REFRESH_TOKEN: 'synthetic-refresh',
  });
  return { captureException: vi.fn() };
});
vi.mock('@sentry/react-router', () => ({ captureException: sentry.captureException, captureMessage: vi.fn() }));
// The bot starts only with an admin client; the tick never reaches it here.
vi.mock('./supabase.server', () => ({ supabaseAdmin: {} }));

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return productionFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** The argument text of each global `fetch(...)` call in a source file:
 *  not a method such as `messages.fetch(`, not a comment, not a type. */
function fetchCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = /(?<![.\w])fetch\(/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const before = source.slice(lineStart, match.index).trim();
    if (before.startsWith('*') || /(^|\s)\/\//.test(before)) continue;
    let depth = 0;
    let quote = '';
    let end = match.index + 'fetch'.length;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (quote) {
        if (ch === '\\') end++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    const args = source.slice(match.index + 'fetch('.length, end);
    if (/^\)\s*:/.test(source.slice(end))) continue; // `fetch(): Promise<...>` is a type
    calls.push(args);
  }
  return calls;
}

describe('US-09 AC30: every server fetch passes a signal', () => {
  it('finds the calls it is meant to check', () => {
    expect(fetchCalls("await fetch(url, {\n  method: 'POST',\n  signal: AbortSignal.timeout(1),\n});")).toHaveLength(1);
    expect(fetchCalls('await fetch(`${base}?q=${encodeURIComponent(x)}`)')).toEqual(['`${base}?q=${encodeURIComponent(x)}`']);
    expect(fetchCalls('channel.messages.fetch(id); // fetch(x)\n * fetch(y)\n  fetch(): Promise<Uint8Array>;')).toEqual([]);
  });

  it('every fetch( call in app/ outside tests carries a signal', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of productionFiles(APP)) {
      const source = readFileSync(file, 'utf8');
      for (const args of fetchCalls(source)) {
        seen++;
        if (!/\bsignal\b/.test(args)) missing.push(`${path.relative(APP, file)}: fetch(${args.split('\n')[0]}`);
      }
    }
    expect(seen).toBeGreaterThan(15);
    expect(missing).toEqual([]);
  });
});

describe('US-09 AC30: a stalled provider is abandoned at the deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The fake clock drives the deadline, as in the widget's deadline tests.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('synthetic deadline', 'TimeoutError')), ms);
      return controller.signal;
    });
    // A provider that accepts the request and never answers: the promise
    // settles only when the caller's signal aborts, as Node's fetch does.
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.KLAVIYO_API_KEY = 'synthetic-key';
    process.env.KLAVIYO_LIST_ID = 'SYNTHETIC';
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'synthetic-client';
    process.env.GOOGLE_DRIVE_SECRET = 'synthetic-secret';
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  /** Settles `work` against the fake clock; reports whether it settled
   *  before `ms` and what it settled with. */
  async function settleBy<T>(work: Promise<T>, ms: number): Promise<{ early: boolean; outcome: unknown }> {
    let settled = false;
    const done = work.then((value) => value, (error: unknown) => ({ rejected: error })).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(ms - 1);
    const early = settled;
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    return { early, outcome: await done };
  }

  it('Google tokeninfo (reminder opt-in) gives up at 10 s and reads as unverified', async () => {
    const { verifyGoogleIdToken } = await import('./reminder-v2.server');
    const { early, outcome } = await settleBy(verifyGoogleIdToken('synthetic-id-token'), 10_000);
    expect(early).toBe(false);
    expect(outcome).toBeNull();
  });

  it('Klaviyo suppression (Resend webhook) gives up at 10 s as a retryable failure', async () => {
    const { suppressInKlaviyo } = await import('./klaviyo.server');
    const { early, outcome } = await settleBy(suppressInKlaviyo('synthetic@example.invalid'), 10_000);
    expect(early).toBe(false);
    expect(outcome).toEqual({ status: null, retryable: true });
  });

  it('Klaviyo subscribe gives up at 10 s without throwing', async () => {
    const { subscribeToKlaviyo } = await import('./klaviyo.server');
    const { early, outcome } = await settleBy(subscribeToKlaviyo({ email: 'synthetic@example.invalid' }), 10_000);
    expect(early).toBe(false);
    expect(outcome).toBeUndefined();
  });

  it('the Google token exchange gives up at 10 s', async () => {
    const { action } = await import('../routes/api.google-token');
    const request = new Request('https://health-tool-app.fly.dev/api/google-token', {
      method: 'POST',
      headers: { Origin: 'https://drstanfield.com', 'fly-client-ip': '203.0.113.60', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ grantType: 'refresh', refreshToken: 'synthetic-refresh' }),
    });
    const { early, outcome } = await settleBy(action({ request } as never), 10_000);
    expect(early).toBe(false);
    expect((outcome as { rejected: DOMException }).rejected.name).toBe('TimeoutError');
  });

  /** A token-exchange request from an allowed origin, as the browser sends it. */
  function exchangeRequest(): Request {
    return new Request('https://health-tool-app.fly.dev/api/google-token', {
      method: 'POST',
      headers: { Origin: 'https://drstanfield.com', 'fly-client-ip': '203.0.113.61', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ grantType: 'code', code: 'synthetic-code', codeVerifier: 'synthetic-verifier', redirectUri: 'https://drstanfield.com/pages/roadmap' }),
    });
  }

  it('the Google token exchange fails, not 200 with no tokens, when the 200 body passes the deadline', async () => {
    // Google sends 200 headers at once, then stalls the body. As Node's fetch
    // does, the caller's signal errors the body stream when it aborts.
    vi.mocked(fetch).mockImplementation((_url, init = {}) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"access_token":"synthetic-acc'));
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    const { action } = await import('../routes/api.google-token');
    const { early, outcome } = await settleBy(action({ request: exchangeRequest() } as never), 10_000);
    expect(early).toBe(false);
    const res = outcome as Response;
    expect(res.status).toBe(502);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toEqual({ error: 'exchange_failed', errorDescription: 'unreadable_response' });
    expect(json).not.toHaveProperty('accessToken');
  });

  it('the Google token exchange fails when a 200 body is not JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>proxy error</html>', { status: 200 }));
    const { action } = await import('../routes/api.google-token');
    const res = await action({ request: exchangeRequest() } as never);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'exchange_failed', errorDescription: 'unreadable_response' });
  });

  it('the Google token exchange still passes an unreadable error status through as exchange_failed', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>bad gateway</html>', { status: 503 }));
    const { action } = await import('../routes/api.google-token');
    const res = await action({ request: exchangeRequest() } as never);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'exchange_failed', errorDescription: '' });
  });

  it('the Google token exchange still passes a readable 200 through', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3599 }), { status: 200 }));
    const { action } = await import('../routes/api.google-token');
    const res = await action({ request: exchangeRequest() } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresIn: 3599 });
  });

  describe('the YouTube bot tick', () => {
    beforeEach(() => { process.env.YOUTUBE_BOT_FORCE_START = 'true'; sentry.captureException.mockClear(); });
    afterEach(async () => { (await import('./youtube-bot.server')).stopYouTubeBot(); delete process.env.YOUTUBE_BOT_FORCE_START; });

    /** Starts the bot, runs its first tick (30 s after start) and reports
     *  whether the tick had given up by 15 s less 1 ms, and by 15 s. */
    async function firstTick(): Promise<{ early: boolean; failure: unknown }> {
      (await import('./youtube-bot.server')).startYouTubeBot();
      await vi.advanceTimersByTimeAsync(30_000 + 15_000 - 1);
      const early = sentry.captureException.mock.calls.length > 0;
      await vi.advanceTimersByTimeAsync(1);
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
      return { early, failure: sentry.captureException.mock.calls[0][0] };
    }

    it('a stalled token refresh ends the tick at 15 s', async () => {
      const { early, failure } = await firstTick();
      expect(early).toBe(false);
      expect((failure as DOMException).name).toBe('TimeoutError');
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    });

    it('a stalled thread list ends the tick at 15 s', async () => {
      const stalled = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation((url, init) => String(url) === 'https://oauth2.googleapis.com/token'
        ? Promise.resolve(new Response(JSON.stringify({ access_token: 'synthetic-access', expires_in: 3600 })))
        : stalled(url, init));
      const { early, failure } = await firstTick();
      expect(early).toBe(false);
      expect((failure as DOMException).name).toBe('TimeoutError');
      expect(String(vi.mocked(fetch).mock.calls[1][0])).toContain('/youtube/v3/commentThreads');
    });
  });
});
