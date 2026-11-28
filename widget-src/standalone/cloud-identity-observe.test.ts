// @vitest-environment jsdom
/**
 * US-09 AC67: the once-a-day measurement on the full web app. Real adapters
 * over sign-ins seeded in localStorage; the network is a stub that records
 * every call; the event transport is a spy, so the exact metadata is asserted.
 * Fake, low-entropy tokens only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ SHOPIFY_SURFACE: true }));
vi.mock('../src/lib/build-flags', () => ({ LOCAL_FIRST: true, get SHOPIFY_SURFACE() { return flags.SHOPIFY_SURFACE; } }));
const { trackProductEvent } = vi.hoisted(() => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/server-api', async (real) => ({ ...(await real<object>()), trackProductEvent }));

import { DropboxAdapter, GitHubAdapter, GoogleDriveAdapter, LocalStorageAdapter } from '../src/storage';
import { bootSignIn, currentSignIn } from '../src/storage/sign-in-state';
import { IDENTITY_DAY_KEY, observeCloudIdentity } from './cloud-identity-observe';

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
const snapshot = (s: Storage) => Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)]));
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
afterEach(() => vi.unstubAllGlobals());

describe('observeCloudIdentity (US-09 AC67)', () => {
  it('Drive redirect grant: reads the id and the record copies, sends closed words only', async () => {
    answers = {
      [DRIVE_ABOUT]: { status: 200, body: { user: { permissionId: 'test-perm-id', emailAddress: 'a@example.test' } } },
      [DRIVE_FILES]: { status: 200, body: { files: [{ ownedByMe: true }, { ownedByMe: false }] } },
    };
    await observeCloudIdentity(seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR }));
    expect(urls()).toEqual([
      `${DRIVE_ABOUT}?fields=user(permissionId)`,
      `${DRIVE_FILES}?q=name%3D'health-roadmap.json'%20and%20trashed%3Dfalse&spaces=drive&fields=files(ownedByMe)%2CnextPageToken%2CincompleteSearch&pageSize=100`,
    ]);
    expect(trackProductEvent.mock.calls).toEqual([
      ['cloud_identity_read', { provider: 'google-drive', grant: 'redirect', outcome: 'ok' }],
      ['drive_record_copies', { outcome: 'ok', owned: '1', notOwned: '1' }],
    ]);
  });

  it('Drive popup grant, a partial search: incomplete with the counts seen, no second page asked', async () => {
    answers = {
      [DRIVE_ABOUT]: { status: 200, body: { user: {} } },
      [DRIVE_FILES]: { status: 200, body: { files: [{ ownedByMe: true }], incompleteSearch: true } },
    };
    await observeCloudIdentity(seedDrive({ accessToken: 'test-token-good', expiresAt: Date.now() + HOUR }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(trackProductEvent.mock.calls).toEqual([
      ['cloud_identity_read', { provider: 'google-drive', grant: 'popup', outcome: 'missing' }],
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
      ['cloud_identity_read', { provider: 'google-drive', grant: 'redirect', outcome: 'refused' }],
      ['drive_record_copies', { outcome: 'refused' }],
    ]);
  });

  it('an expired token: no call, no refresh, outcome skipped', async () => {
    await observeCloudIdentity(seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() - 1 }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trackProductEvent.mock.calls).toEqual([['cloud_identity_read', { provider: 'google-drive', grant: 'redirect', outcome: 'skipped' }]]);
  });

  it('Dropbox and GitHub: one identity call each, no copies event', async () => {
    answers = { [DROPBOX_ACCOUNT]: { status: 200, body: { account_id: 'dbid:test', email: 'a@example.test' } }, [GITHUB_USER]: { status: 200, body: { id: 42 } } };
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR }));
    localStorage.setItem(GITHUB_CONFIG, JSON.stringify({ token: 'test-token-good', owner: 'o', repo: 'r' }));
    await observeCloudIdentity(new DropboxAdapter({ clientId: 'c', redirectUri: 'https://example.test/' }));
    await observeCloudIdentity(new GitHubAdapter());
    expect(urls()).toEqual([DROPBOX_ACCOUNT, GITHUB_USER]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: 'null' });
    expect(trackProductEvent.mock.calls).toEqual([
      ['cloud_identity_read', { provider: 'dropbox', grant: 'redirect', outcome: 'ok' }],
      ['cloud_identity_read', { provider: 'github', grant: 'pat', outcome: 'ok' }],
    ]);
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

  it('writes nothing to storage but the day key, which holds the day alone', async () => {
    answers = { [DRIVE_ABOUT]: { status: 200, body: { user: { permissionId: 'test-perm-id' } } }, [DRIVE_FILES]: { status: 200, body: { files: [{ ownedByMe: true }] } } };
    const adapter = seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR });
    const before = snapshot(localStorage);
    await observeCloudIdentity(adapter);
    expect(snapshot(localStorage)).toEqual({ ...before, [`${IDENTITY_DAY_KEY}google-drive`]: today() });
    expect(snapshot(sessionStorage)).toEqual({});
  });

  it('no answer at all is unreachable, and nothing throws', async () => {
    const down = async (): Promise<Response> => { throw new TypeError('network down'); };
    fetchMock.mockImplementationOnce(down).mockImplementationOnce(down);
    await expect(observeCloudIdentity(seedDrive({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR }))).resolves.toBeUndefined();
    expect(trackProductEvent.mock.calls).toEqual([
      ['cloud_identity_read', { provider: 'google-drive', grant: 'redirect', outcome: 'unreachable' }],
      ['drive_record_copies', { outcome: 'unreachable' }],
    ]);
  });
});
