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

  it('after a dropped long-poll, re-reads once on the fresh cursor: a change made in the gap is not lost (US-34 AC1b)', async () => {
    // The long-poll connection drops. The fresh cursor lists the folder as it
    // stands now, so a change another device made before it is never
    // announced by a later poll: the watch has to say "look" itself, once.
    let polls = 0;
    answer = (url) => {
      if (url === LIST) return { cursor: `c${at(LIST).length}` };
      if (url === LONGPOLL) return ++polls === 1 ? null : { changes: false };
      return { cursor: 'unused' };
    };
    const onChange = vi.fn();
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', onChange, stop.signal);
    await settle();
    expect(at(LONGPOLL)).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled(); // nothing to say while Dropbox cannot be asked

    await settle(1_100); // the retry lists the folder afresh
    expect(at(LIST)).toHaveLength(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(at(LONGPOLL)[1].body.cursor).toBe('c2');

    await settle(HELD_MS * 3); // quiet polls afterwards: no further re-reads
    expect(onChange).toHaveBeenCalledTimes(1);
    stop.abort();
  });

  it('a change the poll reported but the continue could not take is still read, once, after the retry (US-34 AC1b)', async () => {
    let continues = 0;
    let polls = 0;
    answer = (url) => {
      if (url === LIST) return { cursor: `c${at(LIST).length}` };
      if (url === LONGPOLL) return ++polls === 1 ? { changes: true } : { changes: false };
      return ++continues === 1 ? null : { cursor: 'unused' }; // the continue fails
    };
    const onChange = vi.fn();
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', onChange, stop.signal);
    await settle();
    expect(onChange).not.toHaveBeenCalled();

    await settle(1_100);
    expect(onChange).toHaveBeenCalledTimes(1);
    await settle(HELD_MS * 2);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop.abort();
  });

  it('a clean start, and quiet polls, owe no re-read (US-34 AC1b)', async () => {
    answer = (url) => (url === LIST ? { cursor: 'c0' } : { changes: false });
    const onChange = vi.fn();
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', onChange, stop.signal);
    await settle(HELD_MS * 3);
    expect(at(LONGPOLL).length).toBeGreaterThan(2);
    expect(onChange).not.toHaveBeenCalled();
    stop.abort();
  });

  it('a dropped long-poll, then an abort while the fresh listing is on its way: no re-read (US-34 AC1b)', async () => {
    // The tab is hidden (the watch is aborted) after a failure, while the
    // retry's folder listing is in the air. Its answer still arrives, but a
    // watch that has been stopped owes the store nothing.
    const stop = new AbortController();
    answer = (url) => {
      if (url === LONGPOLL) return null; // the long-poll drops
      if (at(LIST).length === 2) stop.abort(); // the retry's listing
      return { cursor: `c${at(LIST).length}` };
    };
    const onChange = vi.fn();
    adapter().watch('health-roadmap.json', onChange, stop.signal);
    await settle();
    await settle(1_100); // the retry lists the folder, and the abort lands meanwhile
    expect(at(LIST)).toHaveLength(2);
    await settle(HELD_MS * 3);
    expect(at(LIST)).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a listing that answers while the long-poll keeps failing: re-reads follow the back-off (US-34 AC1b)', async () => {
    // Only a whole good poll turn resets the back-off, so a working listing on
    // a failing long-poll re-reads at 1, 3, 7, 15, 31 and 63 s, then once a minute.
    answer = (url) => (url === LIST ? { cursor: 'c' } : null);
    const onChange = vi.fn();
    const stop = new AbortController();
    adapter().watch('health-roadmap.json', onChange, stop.signal);
    await settle();
    for (let i = 0; i < 60; i++) await settle(10_000); // ten minutes
    expect(onChange).toHaveBeenCalledTimes(14); // 6 while doubling, then 123 s, 183 s ... 543 s
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
