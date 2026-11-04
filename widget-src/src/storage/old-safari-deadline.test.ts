/**
 * US-09 AC13g: the cloud adapters' own deadlines work on a browser without
 * `AbortSignal.timeout` (Safari 14/15, iOS 15).
 *
 * Three calls the adapters make themselves used it bare: Drive's token refresh
 * (5 s) and the Dropbox and GitHub account-email reads (10 s, US-17 AC7, AC12).
 * Called unguarded, `AbortSignal.timeout` throws a TypeError before the request
 * is made, so on those browsers a Drive refresh always failed (once the access
 * token's hour ran out, the page opened on-device with Reconnect instead of on
 * Drive) and the reminders email read always failed (no auto-enrolment).
 * `fetchOrFail` feature-detected it (docs/reference.md, d909fe2) but then ran
 * with no deadline. Review of #788: the Drive refresh's body read must sit
 * inside the same deadline and catch, or a stalled 200 body blanks startup.
 *
 * Each test removes `AbortSignal.timeout` the way an old Safari lacks it, then
 * drives the real adapter against a synthetic provider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDriveAdapter } from './drive';
import { DropboxAdapter } from './dropbox';
import { GitHubAdapter } from './github';
import { BACKEND_KEY, resolveRemembered } from '../../standalone/connect';

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

/**
 * A provider that sends 200 headers at once and then never finishes the body,
 * until the request's signal aborts it, as a real fetch's body read does.
 */
function stalledBodyFetch() {
  return vi.fn((_url: string, init?: RequestInit) => Promise.resolve(new Response(new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
    },
  }), { status: 200 })));
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
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DRIVE_CONFIG.exchangeUrl);
    expect(JSON.parse(init.body as string)).toEqual({ grantType: 'refresh', refreshToken: 'refresh' });
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

  // Merged with #840 (US-09 AC13h): the token refresh the email read runs
  // first goes through fetchOrFail at 5 s, so here it is bounded by this
  // PR's fallback timer, not left open as before.
  it('a Dropbox account-email read behind a token refresh that gets no answer gives up at 5 s, grant kept', async () => {
    vi.useFakeTimers();
    localStorage.setItem('health_roadmap_dropbox_tokens', JSON.stringify({ accessToken: 'live', refreshToken: 'refresh', expiresAt: Date.now() + 30_000 }));
    const fetch = hungFetch();
    vi.stubGlobal('fetch', fetch);
    const read = new DropboxAdapter(DROPBOX_CONFIG).accountEmail();
    read.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://api.dropboxapi.com/oauth2/token');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await settled(read)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(read)).toBe(true);
    await expect(read).rejects.toThrow('Dropbox did not answer');
    expect(fetch).toHaveBeenCalledTimes(1); // the email request is never sent
    expect(JSON.parse(localStorage.getItem('health_roadmap_dropbox_tokens')!).refreshToken).toBe('refresh');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the 10 s of a Dropbox email read counts the refresh before it: a slow refresh then no answer ends at 10 s, not 14', async () => {
    vi.useFakeTimers();
    localStorage.setItem('health_roadmap_dropbox_tokens', JSON.stringify({ accessToken: 'live', refreshToken: 'refresh', expiresAt: Date.now() + 30_000 }));
    const hung = hungFetch();
    const fetch = vi.fn((url: string, init?: RequestInit) => (url.includes('oauth2/token')
      ? new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ access_token: 'fresh', expires_in: 14_400 }), { status: 200 })), 4_000))
      : hung(url, init)));
    vi.stubGlobal('fetch', fetch);
    const read = new DropboxAdapter(DROPBOX_CONFIG).accountEmail();
    read.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetch).toHaveBeenCalledTimes(2); // the refresh, then the email request
    await vi.advanceTimersByTimeAsync(5_999);
    expect(await settled(read)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(read)).toBe(true);
    await expect(read).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
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

  // Review of #788 (Brad, 2026-11-04, finding 1): the body read is bounded by
  // the same 5 s, so a 200 whose body stalls must also end as a transient
  // failure, never as a rejection. resolveRemembered awaits the refresh before
  // the widget is rendered, so a rejection there is a blank widget.
  it('a Drive refresh whose 200 body stalls gives up at 5 s, as a transient failure', async () => {
    vi.useFakeTimers();
    seedDrive();
    vi.stubGlobal('fetch', stalledBodyFetch());
    const refresh = new GoogleDriveAdapter(DRIVE_CONFIG).tryServerRefresh();
    refresh.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(await settled(refresh)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(refresh).resolves.toBe(false);
    expect(JSON.parse(localStorage.getItem('health_roadmap_gdrive_tokens')!).refreshToken).toBe('refresh');
  });

  it('page load with a stalled refresh body opens on this device with Reconnect, choice kept', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('location', { origin: 'https://example.test', pathname: '/roadmap' });
    seedDrive();
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    vi.stubGlobal('fetch', stalledBodyFetch());
    const startup = resolveRemembered();
    startup.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(5_000);
    const resolved = await startup;
    expect(resolved.backend).toBe('local');
    expect(resolved.reconnect).toBe('google-drive');
    expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
  });

  it.each([
    ['Dropbox', () => { seedDropbox(); return new DropboxAdapter(DROPBOX_CONFIG).accountEmail(); }],
    ['GitHub', () => new GitHubAdapter(GITHUB_CONFIG).accountEmail()],
  ])('a %s email read whose 200 body stalls rejects at 10 s, not before', async (_name, start) => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', stalledBodyFetch());
    const read = start();
    read.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(await settled(read)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).rejects.toThrow();
  });

  // Finding 2: fetchOrFail ran with no deadline at all here.
  it('a GitHub record read through fetchOrFail that gets no answer gives up at 30 s', async () => {
    vi.useFakeTimers();
    const fetch = hungFetch();
    vi.stubGlobal('fetch', fetch);
    const read = new GitHubAdapter(GITHUB_CONFIG).read('health-roadmap.json');
    read.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await settled(read)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(read)).toBe(true);
    await expect(read).rejects.toThrow('GitHub did not answer');
  });

  // Finding 2: the fallback timer is freed once the call is over.
  it('leaves no deadline timer behind after a Drive refresh, an email read and a record read succeed', async () => {
    vi.useFakeTimers();
    seedDrive();
    seedDropbox();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      url.includes('dropbox') ? JSON.stringify({ email: 'a@example.com', email_verified: true })
        : url.includes('github') ? JSON.stringify(url.includes('emails') ? [{ email: 'a@example.com', primary: true, verified: true }] : { content: '', sha: 'abc' })
          : JSON.stringify({ accessToken: 'fresh', expiresIn: 3600 }),
      { status: 200 },
    )));

    expect(await new GoogleDriveAdapter(DRIVE_CONFIG).tryServerRefresh()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await new DropboxAdapter(DROPBOX_CONFIG).accountEmail();
    expect(vi.getTimerCount()).toBe(0);
    await new GitHubAdapter(GITHUB_CONFIG).accountEmail();
    expect(vi.getTimerCount()).toBe(0);
    await new GitHubAdapter(GITHUB_CONFIG).read('health-roadmap.json').catch(() => undefined);
    expect(vi.getTimerCount()).toBe(0);
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

describe('#788 review, finding 1: a Drive refresh whose 200 body cannot be read is transient on every browser', () => {
  beforeEach(() => vi.stubGlobal('localStorage', makeStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['is not JSON', () => new Response('<html>gateway</html>', { status: 200 })],
    ['dies mid-download', () => new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated')); } }), { status: 200 })],
    ['is JSON null', () => new Response('null', { status: 200 })],
  ])('a 200 whose body %s: false, refresh token kept', async (_label, answer) => {
    seedDrive();
    vi.stubGlobal('fetch', vi.fn(async () => answer()));

    await expect(new GoogleDriveAdapter(DRIVE_CONFIG).tryServerRefresh()).resolves.toBe(false);
    expect(JSON.parse(localStorage.getItem('health_roadmap_gdrive_tokens')!).refreshToken).toBe('refresh');
  });

  it.each([400, 401])('a %s (refresh token revoked) clears the tokens, and the reminder identity is null, not a retry', async (status) => {
    seedDrive();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));

    await expect(new GoogleDriveAdapter(DRIVE_CONFIG).tryServerRefresh()).resolves.toBe(false);
    expect(localStorage.getItem('health_roadmap_gdrive_tokens')).toBeNull();
    seedDrive();
    await expect(new GoogleDriveAdapter(DRIVE_CONFIG).getReminderIdToken()).resolves.toBeNull();
  });

  it('a 503 from the endpoint is transient and its body is not read', async () => {
    seedDrive();
    const answer = new Response('{"accessToken":"never-used","expiresIn":3600}', { status: 503 });
    vi.stubGlobal('fetch', vi.fn(async () => answer));

    await expect(new GoogleDriveAdapter(DRIVE_CONFIG).tryServerRefresh()).resolves.toBe(false);
    expect(answer.bodyUsed).toBe(false);
    expect(JSON.parse(localStorage.getItem('health_roadmap_gdrive_tokens')!)).toMatchObject({ accessToken: 'old', refreshToken: 'refresh' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(new GoogleDriveAdapter(DRIVE_CONFIG).getReminderIdToken()).rejects.toThrow('retry later');
  });
});
