/**
 * @vitest-environment jsdom
 *
 * US-34 AC1 — Dropbox's change signal.
 *
 * The page keeps up because Dropbox tells it to, not because a timer came
 * round. These pin the long-poll loop: a cursor, a poll that says "changes",
 * a continue that advances the cursor, one call to the store — and the three
 * ways it must behave badly well: Dropbox asking for room, a failure, and an
 * abort when the tab goes away.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DropboxAdapter } from './dropbox';

const LIST = 'https://api.dropboxapi.com/2/files/list_folder';
const CONTINUE = 'https://api.dropboxapi.com/2/files/list_folder/continue';
const LONGPOLL = 'https://notify.dropboxapi.com/2/files/list_folder/longpoll';

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

let calls: Call[] = [];
/** Answers, per URL, for the next call to that URL. A function so a test can
 *  change its mind mid-loop. */
let answer: (url: string) => unknown | Promise<unknown> = () => ({});

function stubFetch(): void {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    init.signal?.throwIfAborted();
    const json = answer(url);
    if (json === null) return Promise.reject(new TypeError('network down'));
    // A quiet long-poll HOLDS the connection for its timeout — that is where
    // the loop's pacing comes from, so the stub must hold it too.
    const held = url === LONGPOLL && (json as { changes?: boolean }).changes !== true;
    return new Promise<Response>((resolve) =>
      setTimeout(() => resolve(new Response(JSON.stringify(json), { status: 200 })), held ? 30_000 : 0),
    );
  });
}

function adapter(): DropboxAdapter {
  localStorage.setItem(
    'health_roadmap_dropbox_tokens',
    JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 }),
  );
  return new DropboxAdapter({ clientId: 'k', redirectUri: 'https://example.test/' });
}

const at = (url: string) => calls.filter((c) => c.url === url);

/** Let the loop run its microtasks (each poll is two or three awaits). */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  // Each iteration is a chain of awaits with a zero-delay stub between them.
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1);
}
/** One quiet long-poll's worth of waiting. */
const HELD_MS = 30_000;

describe('US-34 AC1 — DropboxAdapter.watch', () => {
  beforeEach(() => {
    calls = [];
    vi.useFakeTimers();
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('turns one long-poll into one store re-read, on a cursor that has moved on', async () => {
    let polls = 0;
    answer = (url) => {
      if (url === LIST) return { cursor: 'c0' };
      if (url === CONTINUE) return { cursor: 'c1' };
      return { changes: ++polls === 1 }; // one change, then quiet
    };
    const onChange = vi.fn();
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', onChange, stop.signal);
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
    // The cursor is folder-root and non-recursive: the record lives there and
    // uploaded documents deliberately do not.
    expect(at(LIST)[0].body).toEqual({ path: '', recursive: false });
    expect(at(CONTINUE)[0].body).toEqual({ cursor: 'c0' });
    // The second poll uses the ADVANCED cursor, or the same change would
    // return for ever.
    expect(at(LONGPOLL)[1].body).toEqual({ cursor: 'c1', timeout: 30 });
    stop.abort();
  });

  it('sends no access token to the notify host', async () => {
    answer = (url) => (url === LIST ? { cursor: 'c0' } : { changes: false });
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', vi.fn(), stop.signal);
    await settle();

    expect(at(LIST)[0].headers.Authorization).toBe('Bearer at');
    expect(at(LONGPOLL)[0].headers.Authorization).toBeUndefined();
    stop.abort();
  });

  it('waits out a backoff Dropbox asks for before polling again', async () => {
    answer = (url) => (url === LIST ? { cursor: 'c0' } : { changes: false, backoff: 5 });
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', vi.fn(), stop.signal);
    await settle();
    expect(at(LONGPOLL)).toHaveLength(1);

    // The poll is held its full 30 seconds, and THEN the 5 seconds Dropbox asked for.
    await settle(HELD_MS + 4_000);
    expect(at(LONGPOLL)).toHaveLength(1);
    await settle(1_500);
    expect(at(LONGPOLL)).toHaveLength(2);
    stop.abort();
  });

  it('backs off, doubling, and re-establishes the cursor after a failure', async () => {
    answer = () => null; // every call fails
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', vi.fn(), stop.signal);
    await settle();
    expect(at(LIST)).toHaveLength(1);

    await settle(1_100); // first retry: one second
    expect(at(LIST)).toHaveLength(2);
    await settle(1_100); // the second waits two
    expect(at(LIST)).toHaveLength(2);
    await settle(1_100);
    expect(at(LIST)).toHaveLength(3);
    stop.abort();
  });

  it('makes no request once the signal is aborted', async () => {
    answer = (url) => (url === LIST ? { cursor: 'c0' } : { changes: false });
    const onChange = vi.fn();
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', onChange, stop.signal);
    await settle();
    const madeSoFar = calls.length;

    stop.abort();
    await settle(300_000);
    expect(calls).toHaveLength(madeSoFar);
    expect(onChange).not.toHaveBeenCalled();
  });
});
