/**
 * US-09 AC2f: a token refresh that ends after Disconnect (or log-off) keeps
 * nothing. Disconnect runs on a fresh adapter (`adapterFor` in
 * standalone/connect.ts), so the adapter that started the refresh never hears
 * of it; the stored tokens are the only thing both share. Synthetic tokens;
 * no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropboxAdapter } from './dropbox';
import { GoogleDriveAdapter } from './drive';

let local: Map<string, string>;
function storage(s: Map<string, string>): Storage {
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** A fetch whose first call waits until `release` answers it. */
function heldFetch(reply: () => Response) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fetchMock = vi.fn(async () => { await gate; return reply(); });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, release: () => release() };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  local = new Map();
  vi.stubGlobal('localStorage', storage(local));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('US-09 AC2f: Dropbox', () => {
  const CONFIG = { clientId: 'test-app-key', redirectUri: 'https://example.com/' };
  const TOKEN_KEY = 'health_roadmap_dropbox_tokens';
  const expired = { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: 0 };

  it('a refresh that resolves after Disconnect writes no token back', async () => {
    local.set(TOKEN_KEY, JSON.stringify(expired));
    const { fetchMock, release } = heldFetch(() => json({ access_token: 'at-late', expires_in: 14400 }));
    const live = new DropboxAdapter(CONFIG);
    const pending = live.accountEmail();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the refresh is in flight
    await new DropboxAdapter(CONFIG).disconnect();
    release();
    await expect(pending).rejects.toThrow();
    expect(local.has(TOKEN_KEY)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing used the late token
  });

  it('a refresh that resolves after a new sign-in leaves the new tokens alone', async () => {
    local.set(TOKEN_KEY, JSON.stringify(expired));
    const { release } = heldFetch(() => json({ access_token: 'at-late', expires_in: 14400 }));
    const pending = new DropboxAdapter(CONFIG).accountEmail();
    await flush();
    const fresh = { accessToken: 'at-other', refreshToken: 'rt-other', expiresAt: Date.now() + 3_600_000 };
    local.set(TOKEN_KEY, JSON.stringify(fresh));
    release();
    await expect(pending).rejects.toThrow();
    expect(JSON.parse(local.get(TOKEN_KEY)!)).toEqual(fresh);
  });

  it('control: a refresh with no Disconnect is kept', async () => {
    local.set(TOKEN_KEY, JSON.stringify(expired));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('oauth2/token')
      ? json({ access_token: 'at-new', expires_in: 14400 })
      : json({ email: 'a@example.com', email_verified: true }))));
    await expect(new DropboxAdapter(CONFIG).accountEmail()).resolves.toBe('a@example.com');
    expect(JSON.parse(local.get(TOKEN_KEY)!)).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-old' });
  });
});

describe('US-09 AC2f: Google Drive', () => {
  const CONFIG = {
    clientId: 'test-client-id',
    scope: 'openid email https://www.googleapis.com/auth/drive.file',
    redirectUri: 'https://example.com/',
    exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
  };
  const TOKENS_KEY = 'health_roadmap_gdrive_tokens';
  const CONFIG_KEY = 'health_roadmap_gdrive';
  const expired = { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: 0 };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const idToken = `${b64({ alg: 'RS256' })}.${b64({ email: 'b@example.com', email_verified: true })}.sig`;

  it('a refresh that resolves after Disconnect writes no token or account back', async () => {
    local.set(TOKENS_KEY, JSON.stringify(expired));
    local.set(CONFIG_KEY, JSON.stringify({ accountEmail: 'a@example.com' }));
    const { fetchMock, release } = heldFetch(() => json({ accessToken: 'at-late', expiresIn: 3600, idToken }));
    const pending = new GoogleDriveAdapter(CONFIG).tryServerRefresh();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await new GoogleDriveAdapter(CONFIG).disconnect();
    release();
    expect(await pending).toBe(false);
    expect(local.has(TOKENS_KEY)).toBe(false);
    expect(local.has(CONFIG_KEY)).toBe(false);
  });

  it('a refresh that resolves after a new sign-in leaves the new tokens alone', async () => {
    local.set(TOKENS_KEY, JSON.stringify(expired));
    const { release } = heldFetch(() => json({ accessToken: 'at-late', expiresIn: 3600 }));
    const pending = new GoogleDriveAdapter(CONFIG).tryServerRefresh();
    await flush();
    const fresh = { accessToken: 'at-other', refreshToken: 'rt-other', expiresAt: Date.now() + 3_600_000 };
    local.set(TOKENS_KEY, JSON.stringify(fresh));
    release();
    expect(await pending).toBe(false);
    expect(JSON.parse(local.get(TOKENS_KEY)!)).toEqual(fresh);
  });

  it('control: a refresh with no Disconnect is kept', async () => {
    local.set(TOKENS_KEY, JSON.stringify(expired));
    vi.stubGlobal('fetch', vi.fn(async () => json({ accessToken: 'at-new', expiresIn: 3600 })));
    expect(await new GoogleDriveAdapter(CONFIG).tryServerRefresh()).toBe(true);
    expect(JSON.parse(local.get(TOKENS_KEY)!)).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-old' });
  });
});
