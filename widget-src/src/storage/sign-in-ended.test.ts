// @vitest-environment jsdom
/**
 * US-09 AC48, lead A3 step 2 (design §5 tests 2-5 and 7, owner rulings Q2-Q4,
 * R6): where a Google Drive or Dropbox adapter names a sign-in dead, the page
 * learns it once, the watch stops asking, and nothing is posted again. A grant
 * moved by a log-off, a disconnect or a new sign-in never raises it.
 *
 * Real adapters, token flight, sign-in state and storage; fakes only at fetch
 * and the clock. Every credential is synthetic; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core/adapter';
import { saveFailureCause } from '@roadmap/health-core/save-state';
import { GoogleDriveAdapter } from './drive';
import { DropboxAdapter } from './dropbox';
import { bootSignIn, currentSignIn, resetSignIn, subscribeSignIn } from './sign-in-state';
import { pkceEntry } from './pkce';
import { sweepStaleSignIns } from '../lib/storage';

const BACKEND_KEY = 'health_roadmap_backend';
const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const DROPBOX_CONFIG = 'health_roadmap_dropbox';
const EXCHANGE = 'https://example.test/api/google-token';
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const DRIVE = { clientId: 'test-client-id', scope: 's', redirectUri: 'https://example.test/', exchangeUrl: EXCHANGE };
const DROPBOX = { clientId: 'test-app-key', redirectUri: 'https://example.test/' };
const FIVE_MINUTES = 5 * 60_000;

const EXPIRED = { accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: 0 };
const LIVE = () => ({ accessToken: 'test-token-live', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000 });

let calls: Array<{ url: string; method: string }>;
/** Answers a call; a test sets it. */
let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;
const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const posts = (url: string) => calls.filter((c) => c.url === url && c.method === 'POST').length;
const apiCalls = () => calls.filter((c) => c.url !== EXCHANGE && c.url !== DROPBOX_TOKEN_URL).length;

let raises: number;
let unsubscribe: () => void;
beforeEach(() => {
  localStorage.clear();
  resetSignIn();
  calls = [];
  answer = () => reply(500);
  raises = 0;
  unsubscribe = subscribeSignIn(() => { raises += 1; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, method: init?.method ?? 'GET' });
    init?.signal?.throwIfAborted();
    return answer(url, init);
  }));
});
afterEach(() => {
  unsubscribe();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** This browser chose `provider` and the page booted signed in to it. */
function chosen(provider: 'google-drive' | 'dropbox', tokens: object): void {
  localStorage.setItem(BACKEND_KEY, provider);
  if (provider === 'google-drive') {
    localStorage.setItem(DRIVE_CONFIG, JSON.stringify({}));
    localStorage.setItem(DRIVE_TOKENS, JSON.stringify(tokens));
  } else {
    localStorage.setItem(DROPBOX_CONFIG, JSON.stringify({}));
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify(tokens));
  }
  bootSignIn({ kind: 'signedIn', provider });
  raises = 0; // count the raises only
}
const failure = (run: Promise<unknown>) => run.then(() => null, (e: unknown) => e as StorageError);

describe('US-09 AC48 + US-34: a dead grant stops the watch after one raise', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });

  it('Google Drive: the refusal raises once, then no request over five minutes', async () => {
    chosen('google-drive', EXPIRED);
    answer = (url) => (url === EXCHANGE ? reply(400, { error: 'invalid_grant' }) : reply(200, { startPageToken: 't1' }));
    const stop = new AbortController();
    new GoogleDriveAdapter(DRIVE).watch(ROADMAP_FILE_NAME, vi.fn(), stop.signal);
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
    stop.abort();
    expect(currentSignIn()).toEqual({ kind: 'signedOut', provider: 'google-drive' });
    expect(raises).toBe(1);
    expect(posts(EXCHANGE)).toBe(1);
    expect(apiCalls()).toBe(0);
    expect(localStorage.getItem(DRIVE_TOKENS)).toBeNull(); // invalid_grant forgets the grant (AC47)
    expect(localStorage.getItem(DRIVE_CONFIG)).not.toBeNull(); // the account stays: a reload shows the panel
  });

  it('Dropbox: invalid_grant forgets the tokens, keeps the config, raises once, and posts no more', async () => {
    chosen('dropbox', EXPIRED);
    answer = (url) => (url === DROPBOX_TOKEN_URL ? reply(400, { error: 'invalid_grant' }) : reply(200, { cursor: 'c0' }));
    const stop = new AbortController();
    new DropboxAdapter(DROPBOX).watch(ROADMAP_FILE_NAME, vi.fn(), stop.signal);
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
    stop.abort();
    expect(currentSignIn()).toEqual({ kind: 'signedOut', provider: 'dropbox' });
    expect(raises).toBe(1);
    expect(posts(DROPBOX_TOKEN_URL)).toBe(1);
    expect(apiCalls()).toBe(0);
    expect(localStorage.getItem(DROPBOX_TOKENS)).toBeNull(); // B-2
    expect(localStorage.getItem(DROPBOX_CONFIG)).not.toBeNull();
  });
});

describe('US-09 AC48 (AC47): a save, a document write and the watch at once meet one refresh and one raise', () => {
  it.each(['google-drive', 'dropbox'] as const)('%s', async (provider) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    chosen(provider, EXPIRED);
    const tokenUrl = provider === 'dropbox' ? DROPBOX_TOKEN_URL : EXCHANGE;
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    answer = async (url) => {
      if (url !== tokenUrl) return reply(200, {});
      await held;
      return reply(400, { error: 'invalid_grant' });
    };
    const adapter = provider === 'dropbox' ? new DropboxAdapter(DROPBOX) : new GoogleDriveAdapter(DRIVE);
    const stop = new AbortController();
    const save = failure(adapter.write(ROADMAP_FILE_NAME, {}, null));
    const document = failure(adapter.writeDocument('Lab results/a.pdf', new Blob(['x'])));
    adapter.watch(ROADMAP_FILE_NAME, vi.fn(), stop.signal);
    await vi.advanceTimersByTimeAsync(0);
    release();
    const [saveError, documentError] = await Promise.all([save, document]);
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
    stop.abort();
    expect(posts(tokenUrl)).toBe(1);
    expect(raises).toBe(1);
    expect(saveFailureCause(saveError)).toBe('auth');
    expect(saveFailureCause(documentError)).toBe('auth');
  });
});

describe('US-09 AC48 (AC45, AC2f): a moved grant never raises', () => {
  it('Drive: a Disconnect that lands while the refusal is in the air', async () => {
    chosen('google-drive', EXPIRED);
    answer = () => { new GoogleDriveAdapter(DRIVE).disconnect(); return reply(400, { error: 'invalid_grant' }); };
    await failure(new GoogleDriveAdapter(DRIVE).read(ROADMAP_FILE_NAME));
    expect(currentSignIn()).toEqual({ kind: 'signedIn', provider: 'google-drive' });
  });

  it('Dropbox: a new sign-in that lands while the refusal is in the air', async () => {
    chosen('dropbox', EXPIRED);
    answer = () => {
      localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ ...LIVE(), refreshToken: 'test-refresh-new' }));
      return reply(400, { error: 'invalid_grant' });
    };
    await failure(new DropboxAdapter(DROPBOX).read(ROADMAP_FILE_NAME));
    expect(currentSignIn()).toEqual({ kind: 'signedIn', provider: 'dropbox' });
    expect(JSON.parse(localStorage.getItem(DROPBOX_TOKENS)!).refreshToken).toBe('test-refresh-new'); // never forgotten
  });

  it.each(['google-drive', 'dropbox'] as const)('%s: a log-off in another tab while the refusal is in the air', async (provider) => {
    chosen(provider, EXPIRED);
    answer = () => { localStorage.setItem(LOG_OFF_ID_KEY, 'gen-after-log-off'); return reply(400, { error: 'invalid_grant' }); };
    const adapter = provider === 'dropbox' ? new DropboxAdapter(DROPBOX) : new GoogleDriveAdapter(DRIVE);
    await failure(adapter.read(ROADMAP_FILE_NAME));
    expect(currentSignIn()).toEqual({ kind: 'signedIn', provider });
  });

  it.each(['google-drive', 'dropbox'] as const)('%s: another tab\'s disconnect (Use this browser only, a switch) found by the next refresh', async (provider) => {
    chosen(provider, EXPIRED);
    const adapter = provider === 'dropbox' ? new DropboxAdapter(DROPBOX) : new GoogleDriveAdapter(DRIVE);
    await (provider === 'dropbox' ? new DropboxAdapter(DROPBOX) : new GoogleDriveAdapter(DRIVE)).disconnect();
    answer = () => reply(400, { error: 'invalid_grant' });
    await failure(adapter.read(ROADMAP_FILE_NAME));
    expect(currentSignIn()).toEqual({ kind: 'signedIn', provider });
  });
});

describe('US-09 AC48 (Q4): another tab\'s invalid_grant clear raises here while the home and log-off are unchanged', () => {
  it.each(['google-drive', 'dropbox'] as const)('%s', async (provider) => {
    chosen(provider, EXPIRED);
    const adapter = provider === 'dropbox' ? new DropboxAdapter(DROPBOX) : new GoogleDriveAdapter(DRIVE);
    localStorage.removeItem(provider === 'dropbox' ? DROPBOX_TOKENS : DRIVE_TOKENS); // the other tab forgot it; the config stays
    answer = () => reply(400, { error: 'invalid_grant' });
    await failure(adapter.read(ROADMAP_FILE_NAME));
    expect(currentSignIn()).toEqual({ kind: 'signedOut', provider });
  });
});

describe('US-09 AC48 (Q2, N1): a refusal that keeps the grant raises once and posts nothing more', () => {
  it.each([
    ['google-drive', 401, 'unauthorized_client'],
    ['google-drive', 400, 'invalid_request'],
    ['dropbox', 400, 'invalid_request'],
    ['dropbox', 401, 'invalid_client'],
  ] as const)('%s, %i %s', async (provider, status, error) => {
    chosen(provider, EXPIRED);
    const tokenUrl = provider === 'dropbox' ? DROPBOX_TOKEN_URL : EXCHANGE;
    answer = (url) => (url === tokenUrl ? reply(status, { error }) : reply(200, {}));
    const adapter = provider === 'dropbox' ? new DropboxAdapter(DROPBOX) : new GoogleDriveAdapter(DRIVE);
    const first = await failure(adapter.read(ROADMAP_FILE_NAME));
    const second = await failure(adapter.write(ROADMAP_FILE_NAME, {}, null));
    expect(currentSignIn()).toEqual({ kind: 'signedOut', provider });
    expect(posts(tokenUrl)).toBe(1);
    expect(apiCalls()).toBe(0);
    expect([first?.reason, second?.reason]).toEqual(['reconnect', 'reconnect']);
    expect(localStorage.getItem(provider === 'dropbox' ? DROPBOX_TOKENS : DRIVE_TOKENS)).not.toBeNull(); // kept: a reload tries it again
  });
});

describe('US-09 AC48 (D2): a Drive popup grant raises once its token has expired, never before', () => {
  it('expired: the next call raises with no request', async () => {
    chosen('google-drive', { accessToken: 'test-token-popup', expiresAt: 0 });
    await failure(new GoogleDriveAdapter(DRIVE).read(ROADMAP_FILE_NAME));
    expect(currentSignIn()).toEqual({ kind: 'signedOut', provider: 'google-drive' });
    expect(calls).toEqual([]);
  });

  it('still valid: the reminders\' identity call raises nothing', async () => {
    chosen('google-drive', { accessToken: 'test-token-popup', expiresAt: Date.now() + 3_600_000 });
    await new GoogleDriveAdapter(DRIVE).getReminderIdToken();
    expect(currentSignIn()).toEqual({ kind: 'signedIn', provider: 'google-drive' });
  });
});

describe('US-09 AC48 (Q3): an API 401 on a cached token sends the next call to the refresh, which decides', () => {
  it.each(['google-drive', 'dropbox'] as const)('%s', async (provider) => {
    chosen(provider, LIVE());
    const tokenUrl = provider === 'dropbox' ? DROPBOX_TOKEN_URL : EXCHANGE;
    answer = (url) => (url === tokenUrl ? reply(400, { error: 'invalid_grant' }) : reply(401, { error: 'revoked' }));
    const adapter = provider === 'dropbox' ? new DropboxAdapter(DROPBOX) : new GoogleDriveAdapter(DRIVE);
    expect((await failure(adapter.read(ROADMAP_FILE_NAME)))?.status).toBe(401); // 1458: auth, no retry
    expect(posts(tokenUrl)).toBe(0);
    await failure(adapter.read(ROADMAP_FILE_NAME));
    expect(posts(tokenUrl)).toBe(1);
    expect(currentSignIn()).toEqual({ kind: 'signedOut', provider });
  });
});

describe('US-09 AC48 (test 7): after a Dropbox raise, every save fails as a sign-in failure, with no retry owed', () => {
  it('the save after the raise is refused with no request', async () => {
    chosen('dropbox', EXPIRED);
    answer = () => reply(400, { error: 'invalid_grant' });
    const adapter = new DropboxAdapter(DROPBOX);
    await failure(adapter.read(ROADMAP_FILE_NAME));
    calls = [];
    const error = await failure(adapter.write(ROADMAP_FILE_NAME, {}, null));
    expect(error?.reason).toBe('reconnect');
    expect(saveFailureCause(error)).toBe('auth');
    // A fresh adapter, as a reminder or the next session builds, is refused the same way.
    expect(saveFailureCause(await failure(new DropboxAdapter(DROPBOX).write(ROADMAP_FILE_NAME, {}, null)))).toBe('auth');
    expect(calls).toEqual([]);
  });
});

describe('US-09 AC48 (R6): the Dropbox config, an empty object whose presence says Dropbox was chosen', () => {
  const page = window.location;
  afterEach(() => {
    Object.defineProperty(window, 'location', { value: page, writable: true, configurable: true });
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  /** The page Dropbox sends the user back to, with this sign-in's code. */
  async function connectDropbox(gen: string | null): Promise<DropboxAdapter | null> {
    sessionStorage.setItem('health_roadmap_dropbox_pkce', pkceEntry('test-verifier', 'test-state', gen));
    Object.defineProperty(window, 'location', { value: { ...page, search: '?code=test-code&state=test-state' }, writable: true, configurable: true });
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    answer = () => reply(200, { access_token: 'test-token-live', refresh_token: 'test-refresh-new', expires_in: 14_400 });
    return DropboxAdapter.completeRedirect(DROPBOX);
  }

  it('is written at connect under the sign-in\'s log-off id, with no account data', async () => {
    localStorage.setItem(LOG_OFF_ID_KEY, 'gen-1');
    expect(await connectDropbox('gen-1')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(DROPBOX_CONFIG)!)).toEqual({ gen: 'gen-1' });
  });

  it('is not written when a log-off came during the sign-in', async () => {
    localStorage.setItem(LOG_OFF_ID_KEY, 'gen-2');
    expect(await connectDropbox('gen-1')).toBeNull();
    expect(localStorage.getItem(DROPBOX_CONFIG)).toBeNull();
    expect(localStorage.getItem(DROPBOX_TOKENS)).toBeNull();
  });

  it('keeps Dropbox connected with no tokens, so a reload shows the panel, not the guest pitch', () => {
    localStorage.setItem(DROPBOX_CONFIG, JSON.stringify({}));
    expect(new DropboxAdapter(DROPBOX).isConnected()).toBe(true);
    localStorage.clear();
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify(LIVE())); // a browser from before the config
    expect(new DropboxAdapter(DROPBOX).isConnected()).toBe(true);
  });

  it('is removed by disconnect, with the tokens', async () => {
    chosen('dropbox', LIVE());
    await new DropboxAdapter(DROPBOX).disconnect();
    expect([localStorage.getItem(DROPBOX_CONFIG), localStorage.getItem(DROPBOX_TOKENS)]).toEqual([null, null]);
  });

  it('is removed by the load sweep once saved under an older log-off id (AC45)', async () => {
    const { SIGN_IN_KEYS } = await import('../../standalone/providers');
    expect(SIGN_IN_KEYS).toContain(DROPBOX_CONFIG);
    localStorage.setItem(DROPBOX_CONFIG, JSON.stringify({ gen: 'gen-1' }));
    localStorage.setItem(LOG_OFF_ID_KEY, 'gen-2');
    sweepStaleSignIns(SIGN_IN_KEYS);
    expect(localStorage.getItem(DROPBOX_CONFIG)).toBeNull();
  });
});
