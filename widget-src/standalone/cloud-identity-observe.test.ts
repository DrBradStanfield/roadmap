// @vitest-environment jsdom
/**
 * US-09 AC67: the once-a-day measurement on the full web app. Real adapters
 * over sign-ins seeded in localStorage; the network is a stub that records
 * every call; the event transport is a spy, so the exact metadata is asserted
 * (the real transport and the storage check: cloud-identity-observe.transport.test.ts;
 * the barrier and sign-in guards: cloud-identity-observe.guards.test.ts).
 * Fake, low-entropy tokens only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const flags = vi.hoisted(() => ({ SHOPIFY_SURFACE: true }));
vi.mock('../src/lib/build-flags', () => ({ LOCAL_FIRST: true, get SHOPIFY_SURFACE() { return flags.SHOPIFY_SURFACE; } }));
const { trackProductEvent } = vi.hoisted(() => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/server-api', async (real) => ({ ...(await real<object>()), trackProductEvent }));

import { DropboxAdapter, GitHubAdapter, GoogleDriveAdapter, LocalStorageAdapter } from '../src/storage';
import { bootSignIn, currentSignIn } from '../src/storage/sign-in-state';
import { CloudIdentityObserver, IDENTITY_DAY_KEY, observeCloudIdentity } from './cloud-identity-observe';

const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const GITHUB_CONFIG = 'health_roadmap_github';
const driveConfig = { clientId: 'c', scope: 's', redirectUri: 'https://example.test/', exchangeUrl: 'https://example.test/x' };
const HOUR = 3_600_000;

type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer>;
const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
  const key = Object.keys(answers).find((k) => String(url).startsWith(k));
  const a = key ? answers[key] : { status: 500 };
  return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status });
});
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));
const DRIVE_ABOUT = 'https://www.googleapis.com/drive/v3/about';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DROPBOX_ACCOUNT = 'https://api.dropboxapi.com/2/users/get_current_account';
const GITHUB_USER = 'https://api.github.com/user';

function seedDrive(tokens: object): GoogleDriveAdapter {
  localStorage.setItem(DRIVE_CONFIG, JSON.stringify({}));
  localStorage.setItem(DRIVE_TOKENS, JSON.stringify(tokens));
  localStorage.setItem('health_roadmap_backend', 'google-drive');
  bootSignIn({ kind: 'signedIn', provider: 'google-drive' });
  return new GoogleDriveAdapter(driveConfig);
}
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  flags.SHOPIFY_SURFACE = true;
  answers = {};
  fetchMock.mockClear();
  trackProductEvent.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('observeCloudIdentity (US-09 AC67)', () => {
  it('Drive grant with a refresh token: reads the id and the record copies, uncached, sends closed words only', async () => {
    answers = {
      [DRIVE_ABOUT]: { status: 200, body: { user: { permissionId: 'test-perm-id', emailAddress: 'a@example.test' } } },
      [DRIVE_FILES]: { status: 200, body: { files: [{ ownedByMe: true }, { ownedByMe: false }] } },
    };
    await observeCloudIdentity(seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR }));
    expect(urls()).toEqual([
      `${DRIVE_ABOUT}?fields=user(permissionId)`,
      `${DRIVE_FILES}?q=name%3D'health-roadmap.json'%20and%20trashed%3Dfalse&spaces=drive&fields=files(ownedByMe)%2CnextPageToken%2CincompleteSearch&pageSize=100`,
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.cache)).toEqual(['no-store', 'no-store']);
    expect(trackProductEvent.mock.calls).toEqual([
      ['cloud_identity_read', { provider: 'google-drive', grant: 'refreshable', outcome: 'ok' }],
      ['drive_record_copies', { outcome: 'ok', owned: '1', notOwned: '1' }],
    ]);
  });

  it('Drive grant without a refresh token, a partial search: incomplete with the counts seen, no second page asked', async () => {
    answers = {
      [DRIVE_ABOUT]: { status: 200, body: { user: {} } },
      [DRIVE_FILES]: { status: 200, body: { files: [{ ownedByMe: true }], incompleteSearch: true } },
    };
    await observeCloudIdentity(seedDrive({ accessToken: 'test-token-good', expiresAt: Date.now() + HOUR }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(trackProductEvent.mock.calls).toEqual([
      ['cloud_identity_read', { provider: 'google-drive', grant: 'access_only', outcome: 'missing' }],
      ['drive_record_copies', { outcome: 'incomplete', owned: '1', notOwned: '0' }],
    ]);
  });

  it('Drive, a next page token: incomplete with the counts seen, the page is not followed', async () => {
    answers = {
      [DRIVE_ABOUT]: { status: 200, body: { user: { permissionId: 'p' } } },
      [DRIVE_FILES]: { status: 200, body: { files: [{ ownedByMe: true }, { ownedByMe: true }], nextPageToken: 'page-two' } },
    };
    await observeCloudIdentity(seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR }));
    expect(urls().filter((u) => u.includes('pageToken='))).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(trackProductEvent).toHaveBeenLastCalledWith('drive_record_copies', { outcome: 'incomplete', owned: '2+', notOwned: '0' });
  });

  it('a 401 from both calls leaves the sign-in, the stored token and the held token as they were', async () => {
    answers = { [DRIVE_ABOUT]: { status: 401, body: { error: 'x' } }, [DRIVE_FILES]: { status: 401 } };
    const adapter = seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR });
    const signIn = currentSignIn();
    const stored = localStorage.getItem(DRIVE_TOKENS);
    await observeCloudIdentity(adapter);
    expect(currentSignIn()).toEqual(signIn);
    expect(currentSignIn()).toEqual({ kind: 'signedIn', provider: 'google-drive' });
    expect(localStorage.getItem(DRIVE_TOKENS)).toBe(stored);
    expect(adapter.heldToken().token).toBe('test-token-good');
    expect(urls().some((u) => u.includes('example.test'))).toBe(false); // no refresh posted
    expect(trackProductEvent.mock.calls).toEqual([
      ['cloud_identity_read', { provider: 'google-drive', grant: 'refreshable', outcome: 'refused' }],
      ['drive_record_copies', { outcome: 'refused' }],
    ]);
  });

  it('an expired token: no call, no refresh, outcome skipped', async () => {
    await observeCloudIdentity(seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() - 1 }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trackProductEvent.mock.calls).toEqual([['cloud_identity_read', { provider: 'google-drive', grant: 'refreshable', outcome: 'skipped' }]]);
  });

  it('Dropbox and GitHub: one identity call each, no copies event', async () => {
    answers = { [DROPBOX_ACCOUNT]: { status: 200, body: { account_id: 'dbid:test', email: 'a@example.test' } }, [GITHUB_USER]: { status: 200, body: { id: 42 } } };
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR }));
    localStorage.setItem(GITHUB_CONFIG, JSON.stringify({ token: 'test-token-good', owner: 'o', repo: 'r' }));
    await observeCloudIdentity(new DropboxAdapter({ clientId: 'c', redirectUri: 'https://example.test/' }));
    await observeCloudIdentity(new GitHubAdapter());
    expect(urls()).toEqual([DROPBOX_ACCOUNT, GITHUB_USER]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: 'null', cache: 'no-store' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: 'no-store' });
    expect(trackProductEvent.mock.calls).toEqual([
      ['cloud_identity_read', { provider: 'dropbox', grant: 'refreshable', outcome: 'ok' }],
      ['cloud_identity_read', { provider: 'github', grant: 'pat', outcome: 'ok' }],
    ]);
  });

  describe('a Dropbox redirect return', () => {
    const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
    async function returnFromDropbox(reply: object): Promise<DropboxAdapter> {
      sessionStorage.setItem('health_roadmap_dropbox_pkce', JSON.stringify({ verifier: 'v', state: 's', gen: null }));
      window.history.replaceState({}, '', '/?code=c&state=s');
      answers[DROPBOX_TOKEN_URL] = { status: 200, body: { access_token: 'test-token-good', refresh_token: 'test-refresh', expires_in: 14400, ...reply } };
      answers[DROPBOX_ACCOUNT] = { status: 200, body: { account_id: 'dbid:test' } };
      const adapter = await DropboxAdapter.completeRedirect({ clientId: 'c', redirectUri: `${window.location.origin}/` });
      fetchMock.mockClear();
      return adapter!;
    }

    it('sends had_id, and reads though today was already read', async () => {
      localStorage.setItem(`${IDENTITY_DAY_KEY}dropbox`, today());
      await observeCloudIdentity(await returnFromDropbox({ account_id: 'dbid:test' }));
      expect(urls()).toEqual([DROPBOX_ACCOUNT]);
      expect(trackProductEvent.mock.calls).toEqual([['cloud_identity_read', { provider: 'dropbox', grant: 'refreshable', outcome: 'ok', tokenReply: 'had_id' }]]);
    });

    it('sends no_id when the reply had no account id', async () => {
      await observeCloudIdentity(await returnFromDropbox({}));
      expect(trackProductEvent.mock.calls).toEqual([['cloud_identity_read', { provider: 'dropbox', grant: 'refreshable', outcome: 'ok', tokenReply: 'no_id' }]]);
    });

    it('is read once: the next run that day is skipped as usual, with no tokenReply', async () => {
      const adapter = await returnFromDropbox({ account_id: 'dbid:test' });
      await observeCloudIdentity(adapter);
      trackProductEvent.mockClear();
      fetchMock.mockClear();
      await observeCloudIdentity(adapter);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(trackProductEvent).not.toHaveBeenCalled();
    });
  });

  it('a failed save of the new grant: the stored grant resumes, with no tokenReply and no day-key bypass', async () => {
    const OLD = { accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + HOUR };
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify(OLD));
    localStorage.setItem(`${IDENTITY_DAY_KEY}dropbox`, today());
    sessionStorage.setItem('health_roadmap_dropbox_pkce', JSON.stringify({ verifier: 'v', state: 's', gen: null }));
    window.history.replaceState({}, '', '/?code=c&state=s');
    answers = {
      'https://api.dropboxapi.com/oauth2/token': { status: 200, body: { access_token: 'test-token-new', refresh_token: 'test-refresh-new', expires_in: 14400, account_id: 'dbid:test' } },
      [DROPBOX_ACCOUNT]: { status: 200, body: { account_id: 'dbid:test' } },
    };
    const realSet = Storage.prototype.setItem;
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === DROPBOX_TOKENS) throw new DOMException('full', 'QuotaExceededError');
      realSet.call(this, k, v);
    });
    const config = { clientId: 'c', redirectUri: `${window.location.origin}/` };
    expect(await DropboxAdapter.completeRedirect(config)).toBeNull();
    refuse.mockRestore();
    fetchMock.mockClear();
    // What boot does next: the remembered Dropbox sign-in, from storage.
    const resumed = new DropboxAdapter(config);
    expect(resumed.heldToken().token).toBe('test-token-old');
    await observeCloudIdentity(resumed);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalled();
    localStorage.removeItem(`${IDENTITY_DAY_KEY}dropbox`);
    await observeCloudIdentity(resumed);
    expect(trackProductEvent.mock.calls).toEqual([['cloud_identity_read', { provider: 'dropbox', grant: 'refreshable', outcome: 'ok' }]]);
  });

  it('a day key that does not store: no call and no event', async () => {
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith(IDENTITY_DAY_KEY)) throw new DOMException('full', 'QuotaExceededError');
      realSet.call(this, k, v);
    });
    await observeCloudIdentity(seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('the full app starts it after the first commit, and once under Strict Mode', async () => {
    answers = { [DRIVE_ABOUT]: { status: 200, body: { user: { permissionId: 'p' } } }, [DRIVE_FILES]: { status: 200, body: { files: [] } } };
    const adapter = seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement('div'));
    await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(CloudIdentityObserver, { adapter }))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(trackProductEvent.mock.calls.map(([name]) => name)).toEqual(['cloud_identity_read', 'drive_record_copies']);
    act(() => root.unmount());
  });

  it('a load that is not a redirect return carries no tokenReply', async () => {
    answers = { [DROPBOX_ACCOUNT]: { status: 200, body: { account_id: 'dbid:test' } } };
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR }));
    await observeCloudIdentity(new DropboxAdapter({ clientId: 'c', redirectUri: 'https://example.test/' }));
    expect(trackProductEvent.mock.calls).toEqual([['cloud_identity_read', { provider: 'dropbox', grant: 'refreshable', outcome: 'ok' }]]);
  });

  it('a guest page: no call, no event, no key', async () => {
    await observeCloudIdentity(new LocalStorageAdapter());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalled();
    expect(Object.keys(localStorage).filter((k) => k.startsWith(IDENTITY_DAY_KEY))).toEqual([]);
  });

  it('the Pages build: no call, no event, no key', async () => {
    flags.SHOPIFY_SURFACE = false;
    await observeCloudIdentity(seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalled();
    expect(localStorage.getItem(`${IDENTITY_DAY_KEY}google-drive`)).toBeNull();
  });

  it('a second run the same day: no call, no event', async () => {
    answers = { [DRIVE_ABOUT]: { status: 200, body: { user: { permissionId: 'p' } } }, [DRIVE_FILES]: { status: 200, body: { files: [] } } };
    const adapter = seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR });
    await observeCloudIdentity(adapter);
    fetchMock.mockClear();
    trackProductEvent.mockClear();
    await observeCloudIdentity(adapter);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('no answer at all is unreachable, and nothing throws', async () => {
    const down = async (): Promise<Response> => { throw new TypeError('network down'); };
    fetchMock.mockImplementationOnce(down).mockImplementationOnce(down);
    await expect(observeCloudIdentity(seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR }))).resolves.toBeUndefined();
    expect(trackProductEvent.mock.calls).toEqual([
      ['cloud_identity_read', { provider: 'google-drive', grant: 'refreshable', outcome: 'unreachable' }],
      ['drive_record_copies', { outcome: 'unreachable' }],
    ]);
  });
});
