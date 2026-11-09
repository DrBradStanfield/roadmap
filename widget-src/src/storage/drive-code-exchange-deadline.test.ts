/**
 * US-09 AC37: the Google Drive OAuth code exchange has a deadline, as the
 * Dropbox one has since AC1a. The page awaits the exchange before it draws
 * anything, so an exchange endpoint that accepts the request and never answers
 * left the loading skeleton up for good. Now it fails at 10 seconds as a
 * `StorageError` ("Google Drive did not answer"), which the page reports as a
 * failed connect, and nothing is kept. A dead network fails the same way, not
 * as a bare `TypeError`. Real adapter; synthetic HTTP and a fake clock, no
 * live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageError } from '@roadmap/health-core/adapter';
import { failureTags } from '../lib/error-diagnostics';
import { DRIVE_FILE_SCOPE, GoogleDriveAdapter } from './drive';

const CONFIG = {
  clientId: 'test-client-id',
  scope: `openid email ${DRIVE_FILE_SCOPE}`,
  redirectUri: 'https://example.com/',
  exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
};
const TOKENS_KEY = 'health_roadmap_gdrive_tokens';
const CONFIG_KEY = 'health_roadmap_gdrive';
const PKCE_KEY = 'health_roadmap_gdrive_pkce';
const EXCHANGE_MS = 10_000;

let local: Map<string, string>;
const replaceState = vi.fn();

/** Each request gets `answer`'s reply. 'stall' hangs until the request's
 *  signal aborts, as a browser fetch does; with no signal it hangs for good.
 *  'offline' rejects as a dead network does. 'ok' is a good exchange. */
function endpoint(answer: 'stall' | 'offline' | 'ok') {
  const fetchMock = vi.fn((_url: string, init: RequestInit = {}) => {
    if (answer === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
    if (answer === 'ok') {
      return Promise.resolve(new Response(JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }), { status: 200 }));
    }
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Runs `work` on the fake clock: still pending 1 ms before `ms`, settled at `ms`. */
async function failureAt(work: Promise<unknown>, ms: number): Promise<unknown> {
  let failure: unknown = 'pending';
  void work.then(() => { failure = 'resolved'; }, (error: unknown) => { failure = error; });
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(failure).toBe('pending');
  await vi.advanceTimersByTimeAsync(1);
  return failure;
}

beforeEach(() => {
  local = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, String(v)),
    removeItem: (k: string) => void local.delete(k),
  });
  // The page as Google returns it: our PKCE entry in place, `?code` in the URL.
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => (k === PKCE_KEY ? JSON.stringify({ verifier: 'v', state: 's' }) : null),
    setItem: () => {},
    removeItem: () => {},
  });
  vi.stubGlobal('window', {
    location: { search: `?code=c&state=s&scope=${encodeURIComponent(DRIVE_FILE_SCOPE)}` },
    history: { replaceState },
  });
  replaceState.mockClear();
  vi.useFakeTimers();
  // The fake clock drives the deadline, as in dropbox-refresh-deadline.test.ts.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('synthetic deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('US-09 AC37: the Google Drive code exchange has a deadline', () => {
  it('an exchange that never answers fails at 10 seconds and keeps nothing', async () => {
    const fetchMock = endpoint('stall');
    const failure = await failureAt(GoogleDriveAdapter.completeRedirect(CONFIG), EXCHANGE_MS);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as Error).message).toBe('Google Drive did not answer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(CONFIG.exchangeUrl);
    expect(local.has(TOKENS_KEY)).toBe(false);
    expect(local.has(CONFIG_KEY)).toBe(false);
  });

  it('a dead network fails as a StorageError too, not a bare TypeError', async () => {
    endpoint('offline');
    const failure = await GoogleDriveAdapter.completeRedirect(CONFIG).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as Error).message).toBe('Google Drive did not answer');
    // AC6c's Sentry tags for the failed connect: no longer errorClass=other.
    expect(failureTags(failure)).toEqual({ errorClass: 'StorageError', httpStatus: 'none' });
    expect(local.has(TOKENS_KEY)).toBe(false);
  });

  it('control: an exchange that answers in time still connects', async () => {
    endpoint('ok');
    const adapter = await GoogleDriveAdapter.completeRedirect(CONFIG);
    expect(adapter?.isConnected()).toBe(true);
    expect(JSON.parse(local.get(TOKENS_KEY) ?? '{}')).toMatchObject({ accessToken: 'a', refreshToken: 'r' });
    expect(replaceState).toHaveBeenCalledTimes(1);
  });
});
