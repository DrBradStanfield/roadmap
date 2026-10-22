/**
 * US-32 AC9 · the two bounds that keep one hung request or one chatty
 * connection from owning the issue tracker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubFiler, ISSUES_PER_HOUR, resetGithubIssues } from './github-issues.server';

const ISSUE = { title: 'Sync stalls on reconnect', body: 'It hangs.', labels: ['from-connector', 'bug'] };

beforeEach(() => {
  process.env.GITHUB_ISSUES_TOKEN = 'test-token';
  resetGithubIssues();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_ISSUES_TOKEN;
});

function created(number: number): Response {
  return new Response(JSON.stringify({ html_url: `https://github.com/x/issues/${number}`, number }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('concurrent reservations', () => {
  it('reserves the last daily slot without losing concurrent spending', async () => {
    const fetcher = vi.fn(async () => created(1));
    vi.stubGlobal('fetch', fetcher);
    const filer = githubFiler('dropbox', 'connection-a')!;
    for (let i = 0; i < 2; i++) await filer({ ...ISSUE, title: `Seed ${i}` });
    const pending = deferred<void>();
    fetcher.mockImplementation(async () => { await pending.promise; return created(3); });
    const first = filer({ ...ISSUE, title: 'First' });
    const second = filer({ ...ISSUE, title: 'Second' });
    const sends = fetcher.mock.calls.length;
    pending.resolve();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: false, refusal: expect.stringContaining('three reports today') });
    expect(sends).toBe(3);
    expect(await filer({ ...ISSUE, title: 'Still full' })).toMatchObject({ ok: false });
  });

  it('coalesces identical reports while the last slot is in flight', async () => {
    const fetcher = vi.fn(async () => created(1));
    vi.stubGlobal('fetch', fetcher);
    const filer = githubFiler('dropbox', 'connection-a')!;
    for (let i = 0; i < 2; i++) await filer({ ...ISSUE, title: `Seed ${i}` });
    const pending = deferred<Response>();
    fetcher.mockImplementation(() => pending.promise);
    const first = filer(ISSUE);
    const duplicate = filer({ ...ISSUE, title: '  SYNC stalls on reconnect  ' });
    pending.resolve(created(3));
    expect(await first).toMatchObject({ ok: true, number: 3 });
    expect(await duplicate).toEqual(await first);
    expect(await filer(ISSUE)).toEqual(await first);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps capacity and dedupe after timeout or an unusable accepted body', async () => {
    const fetcher = vi.fn(async () => created(1));
    vi.stubGlobal('fetch', fetcher);
    const filer = githubFiler('dropbox', 'ambiguous')!;
    for (let i = 0; i < 2; i++) await filer({ ...ISSUE, title: `Seed ${i}` });
    fetcher.mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const timedOut = filer(ISSUE);
    expect(await timedOut).toMatchObject({ ok: false });
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ html_url: '' }), { status: 200 }));
    const unusable = await filer({ ...ISSUE, title: 'Different report' });
    expect(unusable).toMatchObject({ ok: false });
    fetcher.mockImplementation(async () => created(3));
    expect(await filer({ ...ISSUE, title: 'No capacity remains' })).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('three reports today'),
    });
    expect(await filer(ISSUE)).toEqual(await timedOut);
  });

  for (const status of [403, 503]) {
    it(`releases both reservations after an explicit ${status} and retries without stale dedupe`, async () => {
      const fetcher = vi.fn(async () => created(1));
      vi.stubGlobal('fetch', fetcher);
      const filer = githubFiler('dropbox', 'retry')!;
      for (let i = 0; i < ISSUES_PER_HOUR - 1; i++) {
        await githubFiler('dropbox', i < 2 ? 'retry' : `seed-${i}`)!({ ...ISSUE, title: `Seed ${i}` });
      }
      const pending = deferred<Response>();
      fetcher.mockImplementation(() => pending.promise);
      const first = filer(ISSUE);
      const duplicate = filer(ISSUE);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      pending.resolve(new Response(null, { status }));
      expect(await first).toMatchObject({ ok: false });
      expect(await duplicate).toEqual(await first);
      fetcher.mockImplementation(async () => created(21));
      const retry = await filer(ISSUE);
      expect(retry).toMatchObject({ ok: true, number: 21 });
      expect(await filer(ISSUE)).toEqual(retry);
      expect(fetcher).toHaveBeenCalledTimes(ISSUES_PER_HOUR + 1);
      errors.mockRestore();
    });
  }

  it.each(['network error', 'unusable success'] as const)('reports an uncertain outcome after %s and retains the final allowance', async (outcome) => {
    const fetcher = vi.fn(async () => created(1));
    vi.stubGlobal('fetch', fetcher);
    const filer = githubFiler('dropbox', 'uncertain')!;
    for (let i = 0; i < 2; i++) await filer({ ...ISSUE, title: `Seed ${i}` });
    fetcher.mockImplementation(async () => {
      if (outcome === 'network error') throw new Error('synthetic lost response');
      return new Response(JSON.stringify({ html_url: '' }), { status: 201 });
    });
    const answer = await filer(ISSUE);
    expect(fetcher).toHaveBeenCalledTimes(3); // the ambiguous path was actually reached
    expect(answer).toMatchObject({ ok: false, refusal: expect.stringContaining('could not confirm') });
    expect(answer).not.toMatchObject({ refusal: expect.stringContaining('Nothing was posted') });
    expect(await filer(ISSUE)).toEqual(answer);
    expect(await filer({ ...ISSUE, title: 'No capacity' })).toMatchObject({ ok: false, refusal: expect.stringContaining('three reports today') });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reserves the last hourly slot before the provider answers', async () => {
    const fetcher = vi.fn(async () => created(1));
    vi.stubGlobal('fetch', fetcher);
    for (let i = 0; i < ISSUES_PER_HOUR - 1; i++) {
      expect(await githubFiler('dropbox', `seed-${i}`)!(ISSUE)).toMatchObject({ ok: true });
    }
    const pending = deferred<void>();
    fetcher.mockImplementation(async () => {
      await pending.promise;
      return created(20);
    });
    const first = githubFiler('dropbox', 'last-slot')!({ ...ISSUE, title: 'First' });
    const second = githubFiler('google', 'over-cap')!({ ...ISSUE, title: 'Second' });
    const sends = fetcher.mock.calls.length;
    pending.resolve();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: false, refusal: expect.stringContaining('paused for an hour') });
    expect(sends).toBe(ISSUES_PER_HOUR);
  });
});

describe('the GitHub call is bounded in time', () => {
  // Real timers: `AbortSignal.timeout` is Node's own clock and fake timers do
  // not move it, so the only honest test of the bound is to wait for it.
  it('refuses when GitHub never answers, without throwing', { timeout: 15_000 }, async () => {
    // A fetch that only ever settles when its signal aborts — what a hung
    // GitHub looks like from here.
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));

    const started = Date.now();
    const answer = await githubFiler('dropbox', 'connection-a')!(ISSUE);

    expect(answer).toEqual({ ok: false, refusal: 'We could not confirm whether GitHub filed the report. It may already be posted; do not submit it again right now.' });
    expect(Date.now() - started).toBeLessThan(12_000);
  });
});

describe('US-32 AC39 — a refusal from GitHub is answered honestly', () => {
  // GitHub flagged the account on 2026-09-18 and hides the repository from the
  // public; a POST it refuses (403, 410, 422) must not read as silence.
  for (const status of [403, 410, 422]) {
    it(`answers a ${status} with nothing posted, and logs the status alone`, async () => {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'quoted report text' }), { status }));
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      const answer = await githubFiler('dropbox', 'connection-a')!(ISSUE);

      expect(answer).toEqual({ ok: false, refusal: 'Feedback could not be filed right now. Nothing was posted. Try again later.' });
      for (const call of errors.mock.calls) expect(JSON.stringify(call)).not.toContain('quoted report text');
      errors.mockRestore();
    });
  }
});

describe('one connection files three reports a day', () => {
  it('refuses the fourth', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n += 1;
      return new Response(JSON.stringify({ html_url: `https://github.com/x/issues/${n}`, number: n }), { status: 200 });
    });

    const filer = githubFiler('dropbox', 'connection-a')!;
    // Distinct titles: the same title twice is the dedupe path, not a second file.
    for (let i = 1; i <= 3; i++) {
      expect(await filer({ ...ISSUE, title: `Report ${i}` })).toMatchObject({ ok: true });
    }
    expect(await filer({ ...ISSUE, title: 'Report 4' })).toEqual({
      ok: false,
      refusal: 'You have filed three reports today. Nothing was filed.',
    });
    expect(n).toBe(3);

    // Another connection is untouched by this one's spending.
    expect(await githubFiler('dropbox', 'connection-b')!({ ...ISSUE, title: 'Report 5' })).toMatchObject({ ok: true });
  });
});

describe('the dedupe is per connection', () => {
  it('files both when two connections report the same title — the second is a second user, not a repeat', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n += 1;
      return new Response(JSON.stringify({ html_url: `https://github.com/x/issues/${n}`, number: n }), { status: 200 });
    });

    const first = await githubFiler('dropbox', 'connection-a')!(ISSUE);
    const second = await githubFiler('google', 'connection-b')!({ ...ISSUE, title: '  sync stalls ON reconnect ' });
    expect(first).toMatchObject({ ok: true, number: 1 });
    expect(second).toMatchObject({ ok: true, number: 2 });
    expect(n).toBe(2);

    // Within one connection the dedupe still holds: same words, same issue, no second call.
    expect(await githubFiler('dropbox', 'connection-a')!({ ...ISSUE, title: 'sync stalls on reconnect' })).toMatchObject({ ok: true, number: 1 });
    expect(n).toBe(2);
  });
});
