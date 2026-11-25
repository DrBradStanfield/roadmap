// @vitest-environment jsdom
/**
 * US-10 AC13 (root fix R6, PR 2): what the page concludes today when the
 * remembered cloud's record read fails at load (connect.ts `lostAtLoad`,
 * through `startOnBackend`), and whether a session's save failing the same way
 * owes a retry (`retryDue`: 'auth' when it does not). Pins only: no production change. Real adapters over
 * synthetic HTTP; read through public behaviour, never hint words.
 * Includes the M8 pin: a Dropbox token refresh answered 5xx is no sign-in
 * refusal, so the save cause is 'other' and the page offers a retry, not a
 * new sign-in; a 400 refresh refuses the sign-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveAdapter } from '@roadmap/health-core/drive-rest';
import { ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core/adapter';
import { DropboxAdapter, TOKEN_KEY } from '../src/storage/dropbox';
import { GitHubAdapter } from '../src/storage/github';
import { WebDavAdapter } from '../src/storage/webdav';
import { logOffId, setSignIn } from '../src/lib/storage';
import { startOnBackend } from './connect';
import { saveCauseOf } from '../src/testing/save-cause';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

type Failure = number | 'drop';
type Provider = 'dropbox' | 'google-drive' | 'github' | 'self-host';

function failWith(failure: Failure): Response {
  if (failure === 'drop') throw new TypeError('Failed to fetch');
  return new Response('{"error":"synthetic"}', { status: failure });
}

/** Every request fails this way; with `refresh`, only the Dropbox token refresh does, and the token has expired. */
function stub(failure: Failure, refresh = false): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (refresh && !url.includes('oauth2/token')) throw new Error(`unexpected request ${url}`);
    return failWith(failure);
  }));
}

function adapterOf(provider: Provider, expired = false): StorageAdapter {
  if (provider === 'dropbox') {
    setSignIn(TOKEN_KEY, { accessToken: 'test-token-good', refreshToken: 'test-token-good', expiresAt: expired ? 0 : Date.now() + 3_600_000 }, logOffId());
    return new DropboxAdapter({ clientId: 'synthetic', redirectUri: 'https://example.test/' });
  }
  if (provider === 'github') return new GitHubAdapter({ token: 'test-token-good', owner: 'synthetic', repo: 'synthetic-private' });
  if (provider === 'self-host') return new WebDavAdapter({ url: 'https://synthetic.invalid/dav', username: 'synthetic', password: 'synthetic' });
  return new DriveAdapter('test-token-good');
}

/** The sign-in state the load ends in, and the save cause of the read's failure. */
async function atLoad(provider: Provider, adapter: StorageAdapter): Promise<[string, string]> {
  let failure: unknown;
  const started = await startOnBackend({ adapter, backend: provider }, async (used) => {
    if (used !== adapter) return; // the on-device fallback opens
    await adapter.read(ROADMAP_FILE_NAME).catch((error: unknown) => { failure = error; throw error; });
  });
  return [started.reconnect?.kind ?? 'none', await saveCauseOf(failure)];
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('US-10 AC13: a record read that fails at load, per provider and shape (lostAtLoad, retryDue)', () => {
  const rows: Array<[Provider, Failure, string, string]> = [
    ['dropbox', 401, 'signedOut', 'auth'],
    ['dropbox', 403, 'unreachable', 'other'],
    ['dropbox', 500, 'unreachable', 'other'],
    ['dropbox', 'drop', 'unreachable', 'other'],
    // Google Drive's panel always offers its sign-in (US-09 AC48), whatever the failure.
    ['google-drive', 401, 'signedOut', 'auth'],
    ['google-drive', 403, 'signedOut', 'other'],
    ['google-drive', 500, 'signedOut', 'other'],
    ['google-drive', 'drop', 'signedOut', 'other'],
    // GitHub and WebDAV: a reload retries every failure (US-09 AC13), though the save cause reads a 401 as auth.
    ['github', 401, 'unreachable', 'auth'],
    ['github', 500, 'unreachable', 'other'],
    ['github', 'drop', 'unreachable', 'other'],
    ['self-host', 401, 'unreachable', 'auth'],
    ['self-host', 500, 'unreachable', 'other'],
    ['self-host', 'drop', 'unreachable', 'other'],
  ];
  it.each(rows)('%s read answered %s: %s, cause %s', async (provider, failure, signIn, cause) => {
    stub(failure);
    expect(await atLoad(provider, adapterOf(provider))).toEqual([signIn, cause]);
  });
});

describe('US-10 AC13, M8: a Dropbox token refresh that fails at load', () => {
  const rows: Array<[Failure, string, string]> = [
    [500, 'unreachable', 'other'], // M8: a 5xx refresh carries no reason, so no new sign-in is asked for
    [503, 'unreachable', 'other'],
    ['drop', 'unreachable', 'other'],
    [400, 'signedOut', 'auth'], // the refresh refused the grant: reason 'reconnect'
    [401, 'signedOut', 'auth'],
  ];
  it.each(rows)('refresh answered %s: %s, cause %s', async (failure, signIn, cause) => {
    stub(failure, true);
    expect(await atLoad('dropbox', adapterOf('dropbox', true))).toEqual([signIn, cause]);
  });
});
