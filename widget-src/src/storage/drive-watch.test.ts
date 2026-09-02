/**
 * @vitest-environment jsdom
 *
 * US-34 AC1 — Google Drive's change signal.
 *
 * Drive gives a browser no long-poll, so the signal is its changes feed read
 * on a three-second beat. These pin what that loop owes the store: a re-read
 * when the feed names OUR file and silence when it names someone else's, a
 * page token that moves forward, backoff on failure, and an abort that ends it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GoogleDriveAdapter } from './drive';

const START = 'https://www.googleapis.com/drive/v3/changes/startPageToken';
const FILE_ID = 'file-abc';

let urls: string[] = [];
let answer: (url: string) => unknown = () => ({});

function adapter(): GoogleDriveAdapter {
  localStorage.setItem(
    'health_roadmap_gdrive',
    JSON.stringify({ fileIds: { 'health-roadmap.json': FILE_ID } }),
  );
  localStorage.setItem(
    'health_roadmap_gdrive_tokens',
    JSON.stringify({ accessToken: 'at', expiresAt: Date.now() + 3_600_000 }),
  );
  return new GoogleDriveAdapter({
    clientId: 'c',
    scope: 's',
    redirectUri: 'https://example.test/',
    exchangeUrl: 'https://example.test/exchange',
  });
}

const changesCalls = () => urls.filter((u) => u.includes('/changes?'));

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

describe('US-34 AC1 — GoogleDriveAdapter.watch', () => {
  beforeEach(() => {
    urls = [];
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      urls.push(url);
      init.signal?.throwIfAborted();
      const json = answer(url);
      if (json === null) return Promise.reject(new TypeError('network down'));
      return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('re-reads when the feed names our file, and moves the page token on', async () => {
    let pages = 0;
    answer = (url) => {
      if (url === START) return { startPageToken: 't1' };
      return ++pages === 1
        ? { changes: [{ fileId: FILE_ID }], newStartPageToken: 't2' }
        : { changes: [], newStartPageToken: 't2' };
    };
    const onChange = vi.fn();
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', onChange, stop.signal);
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(changesCalls()[0]).toContain('pageToken=t1');
    expect(changesCalls()[0]).toContain('fields=newStartPageToken,nextPageToken,changes(fileId)');

    // Three seconds is the beat; nothing happens before it.
    await settle(2_000);
    expect(changesCalls()).toHaveLength(1);
    await settle(1_500);
    expect(changesCalls()[1]).toContain('pageToken=t2');
    stop.abort();
  });

  it('says nothing when the change belongs to another file', async () => {
    answer = (url) =>
      url === START
        ? { startPageToken: 't1' }
        : { changes: [{ fileId: 'chat-history-file' }], newStartPageToken: 't2' };
    const onChange = vi.fn();
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', onChange, stop.signal);
    await settle(10_000);

    expect(changesCalls().length).toBeGreaterThan(1);
    expect(onChange).not.toHaveBeenCalled();
    stop.abort();
  });

  it('backs off, doubling, and starts from a fresh page token after a failure', async () => {
    answer = () => null;
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', vi.fn(), stop.signal);
    await settle();
    expect(urls.filter((u) => u === START)).toHaveLength(1);

    await settle(3_100); // first retry: three seconds
    expect(urls.filter((u) => u === START)).toHaveLength(2);
    await settle(3_100); // the second waits six
    expect(urls.filter((u) => u === START)).toHaveLength(2);
    await settle(3_100);
    expect(urls.filter((u) => u === START)).toHaveLength(3);
    stop.abort();
  });

  it('makes no request once the signal is aborted', async () => {
    answer = (url) => (url === START ? { startPageToken: 't1' } : { changes: [], newStartPageToken: 't1' });
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', vi.fn(), stop.signal);
    await settle();
    const madeSoFar = urls.length;

    stop.abort();
    await settle(300_000);
    expect(urls).toHaveLength(madeSoFar);
  });
});
