/**
 * US-09 AC13h: a Dropbox token refresh that gets no answer fails within
 * 5 seconds as a `StorageError` ("Dropbox did not answer"), instead of holding
 * the read or save that needed it for good. A dead network fails the same way,
 * not as a bare `TypeError`. The stored grant is kept, so the next call tries
 * the refresh again; one Disconnect or another sign-in replaced while it
 * waited is still never adopted (AC2f). Real adapter; synthetic HTTP and a
 * fake clock, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core';
import { DropboxAdapter } from './dropbox';

const CONFIG = { clientId: 'test-app-key', redirectUri: 'https://example.com/' };
const TOKEN_KEY = 'health_roadmap_dropbox_tokens';
const expired = { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: 0 };
const REFRESH_MS = 5_000;

let local: Map<string, string>;

/** Each request gets `answer`'s reply. 'stall' hangs until the request's
 *  signal aborts, as a browser fetch does; with no signal it hangs for good.
 *  'offline' rejects as a dead network does. */
function provider(answer: () => 'stall' | 'offline') {
  const fetchMock = vi.fn((_url: string, init: RequestInit = {}) => {
    if (answer() === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Runs `work` on the fake clock: still pending 1 ms before `ms`, failed at `ms`. */
async function failureAt(work: Promise<unknown>, ms: number): Promise<unknown> {
  let failure: unknown = 'pending';
  void work.then(() => { failure = 'resolved'; }, (error: unknown) => { failure = error; });
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(failure).toBe('pending');
  await vi.advanceTimersByTimeAsync(1);
  return failure;
}

beforeEach(() => {
  local = new Map([[TOKEN_KEY, JSON.stringify(expired)]]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, String(v)),
    removeItem: (k: string) => void local.delete(k),
  });
  vi.useFakeTimers();
  // The fake clock drives the deadline, as in document-fetch-deadline.test.ts.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('synthetic deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('US-09 AC13h: the Dropbox token refresh has a deadline', () => {
  it('a refresh that never answers fails the read at 5 seconds and keeps the grant', async () => {
    const fetchMock = provider(() => 'stall');
    const failure = await failureAt(new DropboxAdapter(CONFIG).read(ROADMAP_FILE_NAME), REFRESH_MS);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as Error).message).toBe('Dropbox did not answer');
    expect(fetchMock).toHaveBeenCalledTimes(1); // the refresh only: no read went out
    expect(JSON.parse(local.get(TOKEN_KEY)!)).toEqual(expired);
  });

  it('a save behind a refresh that never answers fails at 5 seconds too', async () => {
    provider(() => 'stall');
    const failure = await failureAt(new DropboxAdapter(CONFIG).write(ROADMAP_FILE_NAME, {}, null), REFRESH_MS);
    expect(failure).toBeInstanceOf(StorageError);
  });

  it('the next call after a timed-out refresh tries the refresh again', async () => {
    const fetchMock = provider(() => 'stall');
    const adapter = new DropboxAdapter(CONFIG);
    expect(await failureAt(adapter.read(ROADMAP_FILE_NAME), REFRESH_MS)).toBeInstanceOf(StorageError);
    expect(await failureAt(adapter.read(ROADMAP_FILE_NAME), REFRESH_MS)).toBeInstanceOf(StorageError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/oauth2/token');
  });

  it('a dead network fails the refresh as a StorageError, not a TypeError', async () => {
    provider(() => 'offline');
    const pending = new DropboxAdapter(CONFIG).read(ROADMAP_FILE_NAME);
    await expect(pending).rejects.toBeInstanceOf(StorageError);
    await expect(pending).rejects.toThrow('Dropbox did not answer');
  });

  it('a refresh that times out after a Disconnect elsewhere keeps nothing (AC2f)', async () => {
    const fetchMock = provider(() => 'stall');
    const live = new DropboxAdapter(CONFIG);
    const pending = live.read(ROADMAP_FILE_NAME);
    await vi.advanceTimersByTimeAsync(0);
    await new DropboxAdapter(CONFIG).disconnect();
    const failure = await failureAt(pending, REFRESH_MS);
    expect((failure as Error).message).toMatch(/disconnected/);
    expect(local.has(TOKEN_KEY)).toBe(false);
    await expect(live.read(ROADMAP_FILE_NAME)).rejects.toThrow(/not connected/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
