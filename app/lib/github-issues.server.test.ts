/**
 * US-32 AC9 · the two bounds that keep one hung request or one chatty
 * connection from owning the issue tracker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubFiler, resetGithubIssues } from './github-issues.server';

const ISSUE = { title: 'Sync stalls on reconnect', body: 'It hangs.', labels: ['from-connector', 'bug'] };

beforeEach(() => {
  process.env.GITHUB_ISSUES_TOKEN = 'test-token';
  resetGithubIssues();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_ISSUES_TOKEN;
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

    expect(answer).toEqual({ ok: false, refusal: 'GitHub did not answer. Nothing was filed. Try again later.' });
    expect(Date.now() - started).toBeLessThan(12_000);
  });
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
