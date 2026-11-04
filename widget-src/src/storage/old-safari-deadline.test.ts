/**
 * US-09 AC13g: the cloud adapters' own deadlines work on a browser without
 * `AbortSignal.timeout` (Safari 14/15, iOS 15).
 *
 * `fetchOrFail` already feature-detects it (docs/reference.md, d909fe2). Three
 * calls the adapters make themselves did not: Drive's token refresh (5 s) and
 * the Dropbox and GitHub account-email reads (10 s, US-17 AC7, AC12). Called
 * unguarded, `AbortSignal.timeout` throws a TypeError before the request is
 * made, so on those browsers a Drive refresh always failed (once the access
 * token's hour ran out, the page opened on-device with Reconnect instead of on
 * Drive) and the reminders email read always failed (no auto-enrolment).
 *
 * Each test removes `AbortSignal.timeout` the way an old Safari lacks it, then
 * drives the real adapter against a synthetic provider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDriveAdapter } from './drive';
import { DropboxAdapter } from './dropbox';
import { GitHubAdapter } from './github';

const DRIVE_CONFIG = {
  clientId: 'test-client-id',
  scope: 'openid email https://www.googleapis.com/auth/drive.file',
  redirectUri: 'https://example.com/',
  exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
};
const DROPBOX_CONFIG = { clientId: 'test-app-key', redirectUri: 'https://example.com/' };
const GITHUB_CONFIG = { token: 'fine-grained-test', owner: 'octocat', repo: 'health' };

function makeStorage(): Storage {
  const s = new Map<string, string>();
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}

/** A provider that accepts the request and never answers, until aborted. */
function hungFetch() {
  return vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  }));
}

/** Whether a promise has settled, without waiting for it. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

const nativeTimeout = AbortSignal.timeout;

function seedDrive(): void {
  // An access token past its hour, with the refresh token a redirect connect keeps.
  localStorage.setItem('health_roadmap_gdrive_tokens', JSON.stringify({ accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 }));
  localStorage.setItem('health_roadmap_gdrive', JSON.stringify({}));
}

function seedDropbox(): void {
  localStorage.setItem('health_roadmap_dropbox_tokens', JSON.stringify({ accessToken: 'live', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 }));
}

describe('US-09 AC13g: on a browser without AbortSignal.timeout (Safari 14/15)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeStorage());
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
  });

  afterEach(() => {
    Object.defineProperty(AbortSignal, 'timeout', { value: nativeTimeout, configurable: true, writable: true });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a Drive token refresh reaches the endpoint and keeps the new access token', async () => {
    seedDrive();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ accessToken: 'fresh', expiresIn: 3600 }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const adapter = new GoogleDriveAdapter(DRIVE_CONFIG);

    expect(await adapter.tryServerRefresh()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(adapter.hasValidToken()).toBe(true);
    // Persisted, so the next page load resumes on Drive (connect.ts resolveRemembered).
    expect(new GoogleDriveAdapter(DRIVE_CONFIG).hasValidToken()).toBe(true);
  });

  it('a Drive token refresh that gets no answer still gives up at 5 s, as a transient failure', async () => {
    vi.useFakeTimers();
    seedDrive();
    const fetch = hungFetch();
    vi.stubGlobal('fetch', fetch);
    const refresh = new GoogleDriveAdapter(DRIVE_CONFIG).tryServerRefresh();

    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await settled(refresh)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(refresh)).toBe(true); // checked first: a later deadline must fail here, not hang the run
    expect(await refresh).toBe(false);
    // Transient: the refresh token is kept for the next try.
    expect(JSON.parse(localStorage.getItem('health_roadmap_gdrive_tokens')!).refreshToken).toBe('refresh');
  });

  it('the Dropbox account email is read', async () => {
    seedDropbox();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ email: 'User@Example.com', email_verified: true }), { status: 200 })));

    await expect(new DropboxAdapter(DROPBOX_CONFIG).accountEmail()).resolves.toBe('user@example.com');
  });

  it('a Dropbox account-email read that gets no answer still gives up at 10 s', async () => {
    vi.useFakeTimers();
    seedDropbox();
    const fetch = hungFetch();
    vi.stubGlobal('fetch', fetch);
    const read = new DropboxAdapter(DROPBOX_CONFIG).accountEmail();
    read.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(await settled(read)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(read)).toBe(true);
    await expect(read).rejects.toThrow();
  });

  it('the GitHub account email is read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { email: 'other@example.com', primary: false, verified: true },
      { email: 'Me@Example.com', primary: true, verified: true },
    ]), { status: 200 })));

    await expect(new GitHubAdapter(GITHUB_CONFIG).accountEmail()).resolves.toBe('me@example.com');
  });

  it('a GitHub account-email read that gets no answer still gives up at 10 s', async () => {
    vi.useFakeTimers();
    const fetch = hungFetch();
    vi.stubGlobal('fetch', fetch);
    const read = new GitHubAdapter(GITHUB_CONFIG).accountEmail();
    read.catch(() => undefined);

    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(await settled(read)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(read)).toBe(true);
    await expect(read).rejects.toThrow();
  });
});

describe('US-09 AC13g control: a browser that has AbortSignal.timeout still uses it', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('Drive asks for 5 s and Dropbox for 10 s', async () => {
    vi.stubGlobal('localStorage', makeStorage());
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      url.includes('dropbox') ? JSON.stringify({ email: 'a@example.com', email_verified: true }) : JSON.stringify({ accessToken: 'fresh', expiresIn: 3600 }),
      { status: 200 },
    )));
    seedDrive();
    seedDropbox();

    expect(await new GoogleDriveAdapter(DRIVE_CONFIG).tryServerRefresh()).toBe(true);
    expect(timeout).toHaveBeenLastCalledWith(5_000);
    await new DropboxAdapter(DROPBOX_CONFIG).accountEmail();
    expect(timeout).toHaveBeenLastCalledWith(10_000);
  });
});
