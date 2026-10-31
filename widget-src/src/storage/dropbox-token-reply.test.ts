/**
 * US-09 AC1a: a Dropbox token reply is used only when it holds a non-empty
 * access token, a finite expiry and, at connect, a refresh token. Anything
 * else fails like a refused exchange or refresh, and nothing from it is kept.
 * Synthetic replies; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageError } from '@roadmap/health-core';
import { DropboxAdapter } from './dropbox';

const CONFIG = { clientId: 'test-app-key', redirectUri: 'https://example.com/' };
const TOKEN_KEY = 'health_roadmap_dropbox_tokens';
const PKCE_KEY = 'health_roadmap_dropbox_pkce';

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
const stored = () => JSON.parse(local.get(TOKEN_KEY) ?? 'null');

beforeEach(() => {
  local = new Map();
  vi.stubGlobal('localStorage', storage(local));
});
afterEach(() => { vi.unstubAllGlobals(); });

const GOOD = { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 14400 };

describe('US-09 AC1a: connect refuses an incomplete token reply', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', storage(new Map([[PKCE_KEY, JSON.stringify({ verifier: 'v', state: 's' })]])));
    vi.stubGlobal('window', { location: { search: '?code=c&state=s' }, history: { replaceState: vi.fn() } });
  });

  it.each([
    ['no access token', { refresh_token: 'rt', expires_in: 14400 }],
    ['an empty access token', { access_token: '', refresh_token: 'rt', expires_in: 14400 }],
    ['no refresh token', { access_token: 'at', expires_in: 14400 }],
    ['no expiry', { access_token: 'at', refresh_token: 'rt' }],
    ['an expiry that is not a number', { access_token: 'at', refresh_token: 'rt', expires_in: '14400' }],
  ])('%s', async (_name, reply) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(reply)));
    await expect(DropboxAdapter.completeRedirect(CONFIG)).rejects.toBeInstanceOf(StorageError);
    expect(local.has(TOKEN_KEY)).toBe(false);
  });

  it('a complete reply connects (control)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(GOOD)));
    expect(await DropboxAdapter.completeRedirect(CONFIG)).toBeInstanceOf(DropboxAdapter);
    expect(stored()).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
    expect(Number.isFinite(stored().expiresAt)).toBe(true);
  });
});

describe('US-09 AC1a: a refresh refuses an incomplete token reply and keeps the old tokens', () => {
  const OLD = { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() - 1000 };
  beforeEach(() => { local.set(TOKEN_KEY, JSON.stringify(OLD)); });

  it.each([
    ['no access token', { expires_in: 14400 }],
    ['no expiry', { access_token: 'at-new' }],
    ['an expiry that is not a number', { access_token: 'at-new', expires_in: null }],
  ])('%s', async (_name, reply) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(reply))
      .mockResolvedValue(json({ email: 'someone@example.com', email_verified: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new DropboxAdapter(CONFIG).accountEmail()).rejects.toBeInstanceOf(StorageError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(stored()).toEqual(OLD);
  });

  it('a complete reply refreshes (control)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'at-new', expires_in: 14400 }))
      .mockResolvedValue(json({ email: 'Someone@Example.com', email_verified: true })));
    expect(await new DropboxAdapter(CONFIG).accountEmail()).toBe('someone@example.com');
    expect(stored()).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-old' });
  });
});
