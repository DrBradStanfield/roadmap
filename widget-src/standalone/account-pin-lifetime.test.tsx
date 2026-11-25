// @vitest-environment jsdom
/**
 * US-09 AC54: when the account pin is set, kept, replaced and cleared. A
 * sign-in is kept only with its pin, after its credentials are validated; a
 * switch keeps the old pin until the new sign-in is kept; "Use this browser
 * only" clears it; a browser with no pin that holds a copy from an earlier
 * cloud session adopts a new sign-in only when it reaches the same record;
 * adoption at load stays with the load's own sign-in.
 *
 * Real connect.ts, resolve-backend.ts, sync-control, adapters and sign-in
 * storage. Fakes: fetch (each token names one synthetic account and reaches
 * that account's record), the GIS token client, the lift, the copy-down, the
 * data layer, Sentry, product events and location.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

const lift = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/roadmap-data', () => ({ currentSaveStatus: () => 'saved', flushRoadmapStore: async () => undefined, copyRecordToDevice: async () => undefined, getBackendKind: () => 'cloud' }));
vi.mock('./reminders', () => ({ remindersSupported: () => false, clearAutoEnrolBlock: vi.fn() }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('@roadmap/health-core/record-transfer', async (original) => ({ ...(await original<object>()), copyCloudDown: async () => undefined, liftDeviceCopy: lift }));

const BACKEND_KEY = 'health_roadmap_backend';
const PIN_KEY = 'health_roadmap_account_pin';
const DEVICE_KEY = 'health_roadmap_file_v2';
const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const GITHUB_CONFIG = 'health_roadmap_github';
const SELFHOST_CONFIG = 'health_roadmap_selfhost';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const REFUSED = (label: string) => `${label} did not connect, so nothing changed. Please try again.`;
/** This browser's copy: one row of person A's record. */
const DEVICE_COPY = JSON.stringify({ schemaVersion: 1, measurements: [{ id: 'row-a1' }] });
/** Each record a token reaches. A's shares this browser's row; B's does not. */
const RECORDS = { a: { schemaVersion: 1, measurements: [{ id: 'row-a1' }, { id: 'row-a2' }] }, b: { schemaVersion: 1, measurements: [{ id: 'row-b1' }] } };
const ACCOUNT = { a: { drive: 'perm-aaaa', dropbox: 'dbid:aaaa', github: 7001 }, b: { drive: 'perm-bbbb', dropbox: 'dbid:bbbb', github: 7002 } };

/** Who the next sign-in at a provider is. Every token names its person: `test-token-a-…`, `test-token-b-…`. */
let next: 'a' | 'b';
/** The account read waits on this when set. */
let holdAccount: Promise<void> | null;
let writes: string[];
let reload: ReturnType<typeof vi.fn>;
let replaceState: ReturnType<typeof vi.spyOn>;
let gisAnswer: ((r: object) => void) | null;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
function personOf(init?: RequestInit): 'a' | 'b' | null {
  const auth = new Headers(init?.headers).get('Authorization') ?? '';
  return /test-token-a/.test(auth) ? 'a' : /test-token-b/.test(auth) ? 'b' : null;
}
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const who = personOf(init);
  const method = init?.method ?? 'GET';
  if (url.endsWith('/api/google-token')) return json({ accessToken: `test-token-${next}-new`, refreshToken: 'test-refresh-new', expiresIn: 3600 });
  if (url === 'https://api.dropboxapi.com/oauth2/token') return json({ access_token: `test-token-${next}-new`, refresh_token: 'test-refresh-new', expires_in: 14400, account_id: ACCOUNT[next].dropbox });
  if (url.includes('/about?fields=user(permissionId)') || url.endsWith('/users/get_current_account') || url === 'https://api.github.com/user') {
    if (holdAccount) await holdAccount;
    if (!who) return json({}, 401);
    return json({ user: { permissionId: ACCOUNT[who].drive }, account_id: ACCOUNT[who].dropbox, id: ACCOUNT[who].github });
  }
  if (url.includes('/drive/v3/files/file-a?fields=version')) return who === 'a' ? json({ version: '3' }) : json({}, 404);
  if (url === 'https://content.dropboxapi.com/2/files/download') {
    return who ? json(RECORDS[who], 200, { 'dropbox-api-result': JSON.stringify({ rev: 'r1' }) }) : json({}, 401);
  }
  if (url === 'https://api.github.com/repos/someone/health') return json({ private: true });
  if (url.startsWith('https://api.github.com/repos/someone/health/contents/')) return method === 'GET' ? json({ message: 'Not Found' }, 404) : (writes.push(url), json({ content: { sha: 's1' } }, 201));
  if (url.startsWith('https://api.github.com/repos/')) return json({ message: 'Not Found' }, 404);
  if (url.startsWith('https://dav.example.test/health/')) return method === 'PROPFIND' ? new Response('', { status: 207 }) : new Response('', { status: 404 });
  if (url.startsWith('https://dav.example.test/')) return new Response('', { status: 404 });
  if (method !== 'GET') writes.push(url);
  throw new TypeError('Failed to fetch');
}

const pin = (provider: string, account: string) => localStorage.setItem(PIN_KEY, JSON.stringify({ provider, account, gen: null }));
const pinned = () => {
  const raw = localStorage.getItem(PIN_KEY);
  return raw ? (({ provider, account }) => ({ provider, account }))(JSON.parse(raw) as { provider: string; account: string }) : null;
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = vi.fn();
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(DEVICE_KEY, DEVICE_COPY);
  next = 'a';
  holdAccount = null;
  writes = [];
  gisAnswer = null;
  lift.mockClear();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  Object.assign(window, { google: { accounts: { oauth2: { initTokenClient: (options: { callback: (r: object) => void }) => ({
    requestAccessToken: () => { gisAnswer = options.callback; },
  }) } } } });
  reload = vi.fn();
  replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  const here = { origin: 'http://localhost:3000', pathname: '/', search: '', hash: '', href: 'http://localhost:3000/', reload, assign: vi.fn() };
  Object.defineProperty(window, 'location', { value: here, writable: true, configurable: true });
  for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function page() {
  vi.resetModules();
  return { connect: await import('./connect'), resolve: await import('./resolve-backend'), storage: await import('../src/storage') };
}

/** Back from the provider's sign-in page as `who`, under the current log-off id. */
async function returnAs(cloud: 'dropbox' | 'google-drive', who: 'a' | 'b') {
  next = who;
  sessionStorage.setItem(cloud === 'dropbox' ? 'health_roadmap_dropbox_pkce' : 'health_roadmap_gdrive_pkce', JSON.stringify({ verifier: 'v', state: 's', gen: localStorage.getItem(LOG_OFF_ID_KEY) }));
  window.location.search = `?code=c&state=s${cloud === 'google-drive' ? `&scope=${encodeURIComponent(DRIVE_SCOPE)}` : ''}`;
  replaceState.mockClear();
  return (await page()).resolve.resolveBackend();
}

/** A refusal keeps no token, writes nothing to any cloud, lifts nothing, leaves this browser's copy and cleans the address. */
function expectRefusedClean(refused: string | undefined, label: string, tokenKey: string) {
  expect(refused).toBe(REFUSED(label));
  expect(localStorage.getItem(tokenKey)).toBeNull();
  expect(writes).toEqual([]);
  expect(lift).not.toHaveBeenCalled();
  expect(localStorage.getItem(DEVICE_KEY)).toBe(DEVICE_COPY);
  expect(replaceState).toHaveBeenCalledWith({}, '', 'http://localhost:3000/');
}

describe('US-09 AC54: a form connect pins only once its credentials are valid', () => {
  it.each([
    ['GitHub', 'github', GITHUB_CONFIG, (s: Awaited<ReturnType<typeof page>>['storage'], repo: string) => new s.GitHubAdapter({ token: 'test-token-a-gh', owner: 'someone', repo }, null), 'wrong', 'health'],
    ['Self-host', 'self-host', SELFHOST_CONFIG, (s: Awaited<ReturnType<typeof page>>['storage'], folder: string) => new s.WebDavAdapter({ url: `https://dav.example.test/${folder}/`, username: 'someone', password: 'test-password' }, null), 'wrong', 'health'],
  ] as const)('%s: a wrong repository or folder fails and pins nothing; the corrected one connects', async (_name, backend, configKey, build, wrong, right) => {
    localStorage.removeItem(DEVICE_KEY); // a guest's first connect
    const first = await page();
    await expect(first.connect.finishFormConnect(build(first.storage, wrong), backend, null)).rejects.toThrow();
    expect(localStorage.getItem(PIN_KEY)).toBeNull();
    expect(localStorage.getItem(configKey)).toBeNull();

    const second = await page();
    await second.connect.finishFormConnect(build(second.storage, right), backend, null);
    expect(localStorage.getItem(configKey)).not.toBeNull();
    expect(pinned()?.provider).toBe(backend);
    expect(reload).toHaveBeenCalledTimes(1); // the failed one stayed on the page
  });

  it('a fresh connect whose account cannot be read is refused and keeps nothing', async () => {
    localStorage.removeItem(DEVICE_KEY);
    const { connect, storage } = await page();
    const adapter = new storage.GitHubAdapter({ token: 'test-unnamed', owner: 'someone', repo: 'health' }, null);
    await expect(connect.finishFormConnect(adapter, 'github', null)).rejects.toThrow(REFUSED('GitHub'));
    expect([GITHUB_CONFIG, PIN_KEY, BACKEND_KEY].map((key) => localStorage.getItem(key))).toEqual([null, null, null]);
  });
});

describe('US-09 AC54: a switch of provider', () => {
  /** Dropbox, as person A, chose Google Drive in the picker: copied down and signed out of Dropbox. */
  async function switchStarted() {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-a-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000, gen: null }));
    pin('dropbox', ACCOUNT.a.dropbox);
    await (await page()).connect.prepareSwitch('dropbox', 'google-drive');
    expect(pinned()).toEqual({ provider: 'dropbox', account: ACCOUNT.a.dropbox });
  }

  it('cancelled: the old pin stays, another account is refused and the old account still reconnects', async () => {
    await switchStarted();
    window.location.search = '';
    await (await page()).resolve.resolveBackend(); // back without a sign-in
    expect(pinned()).toEqual({ provider: 'dropbox', account: ACCOUNT.a.dropbox });

    const other = await returnAs('google-drive', 'b');
    expectRefusedClean(other.refused, 'Google Drive', DRIVE_TOKENS);
    const same = await returnAs('dropbox', 'a');
    expect(same.refused).toBeUndefined();
    expect(same.resolved.backend).toBe('dropbox');
    expect(pinned()).toEqual({ provider: 'dropbox', account: ACCOUNT.a.dropbox });
  });

  it('completed: the new sign-in replaces the pin', async () => {
    await switchStarted();
    const { refused, resolved } = await returnAs('google-drive', 'b');
    expect(refused).toBeUndefined();
    expect(resolved.backend).toBe('google-drive');
    expect(pinned()).toEqual({ provider: 'google-drive', account: ACCOUNT.b.drive });
  });
});

describe('US-09 AC54: "Use this browser only" makes the record this browser\'s alone', () => {
  it('clears the pin, so the next connect is a first connect', async () => {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    localStorage.setItem(DRIVE_CONFIG, JSON.stringify({ gen: null }));
    pin('google-drive', ACCOUNT.a.drive);
    vi.resetModules();
    const { SyncControl } = await import('./sync-control');
    (await import('../src/storage/sign-in-state')).bootSignIn({ kind: 'signedOut', provider: 'google-drive' });
    render(<SyncControl backend="local" hasData />);
    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Use this browser only')!);
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(localStorage.getItem(PIN_KEY)).toBeNull();
    expect(localStorage.getItem(BACKEND_KEY)).toBeNull();

    const { refused } = await returnAs('dropbox', 'b');
    expect(refused).toBeUndefined();
    expect(pinned()).toEqual({ provider: 'dropbox', account: ACCOUNT.b.dropbox });
  });
});

describe('US-09 AC54: a browser with no pin that holds a copy from an earlier cloud session', () => {
  /** Drive, signed out at load: a popup grant that has expired, and the record file id it cached. */
  async function popupReconnectAs(who: 'a' | 'b') {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    localStorage.setItem(DRIVE_CONFIG, JSON.stringify({ fileIds: { 'health-roadmap.json': 'file-a' }, gen: null }));
    localStorage.setItem(DRIVE_TOKENS, JSON.stringify({ accessToken: 'test-token-a-expired', expiresAt: Date.now() - 1000, gen: null }));
    vi.resetModules();
    const { SyncControl } = await import('./sync-control');
    (await import('../src/storage/sign-in-state')).bootSignIn({ kind: 'signedOut', provider: 'google-drive' });
    render(<SyncControl backend="local" hasData />);
    fireEvent.click(document.querySelector<HTMLButtonElement>('button.hr-sync-btn')!);
    await act(async () => { gisAnswer!({ access_token: `test-token-${who}-popup`, expires_in: 3600, scope: DRIVE_SCOPE }); });
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
  }

  it('(ii) a Drive popup reconnect as another account, which cannot see the cached record file, is refused', async () => {
    await popupReconnectAs('b');
    expect(document.querySelector('.hr-sync-error')?.textContent).toBe(REFUSED('Google Drive'));
    expect(localStorage.getItem(DRIVE_TOKENS)).toContain('test-token-a-expired');
    expect([localStorage.getItem(PIN_KEY), writes, lift.mock.calls.length, reload.mock.calls.length]).toEqual([null, [], 0, 0]);
    expect(localStorage.getItem(DEVICE_KEY)).toBe(DEVICE_COPY);
  });

  it('(ii) the same account adopts and lifts', async () => {
    await popupReconnectAs('a');
    expect(pinned()).toEqual({ provider: 'google-drive', account: ACCOUNT.a.drive });
    expect(lift).toHaveBeenCalledTimes(1);
  });

  /** Dropbox signed out with its earlier tokens still stored. */
  const dropboxSignedOut = () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-a-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000, gen: null }));
  };

  it('(i) a Dropbox redirect as another account, named by the earlier tokens, is refused', async () => {
    dropboxSignedOut();
    const { refused } = await returnAs('dropbox', 'b');
    expect(refused).toBe(REFUSED('Dropbox'));
    expect(localStorage.getItem(DROPBOX_TOKENS)).toContain('test-token-a-old'); // the new tokens were not kept
    expect([localStorage.getItem(PIN_KEY), writes, lift.mock.calls.length]).toEqual([null, [], 0]);
    expect(localStorage.getItem(DEVICE_KEY)).toBe(DEVICE_COPY);
    expect(replaceState).toHaveBeenCalledWith({}, '', 'http://localhost:3000/');
  });

  it('(i) the same account adopts and lifts', async () => {
    dropboxSignedOut();
    const { refused } = await returnAs('dropbox', 'a');
    expect(refused).toBeUndefined();
    expect(pinned()).toEqual({ provider: 'dropbox', account: ACCOUNT.a.dropbox });
    expect(lift).toHaveBeenCalledTimes(1);
  });

  /** Dropbox was this browser's home; its sign-in is gone, so this load opens as a guest on the copy. */
  async function credentialsLost() {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    expect((await (await page()).resolve.resolveBackend()).resolved.backend).toBe('local');
  }

  it('(iii) lost credentials, then another account whose cloud holds an unrelated record: refused', async () => {
    await credentialsLost();
    expectRefusedClean((await returnAs('dropbox', 'b')).refused, 'Dropbox', DROPBOX_TOKENS);
    expect(localStorage.getItem(PIN_KEY)).toBeNull();
  });

  it('(iii) lost credentials, then the same account, whose record shares a row: adopts and lifts', async () => {
    await credentialsLost();
    const { refused } = await returnAs('dropbox', 'a');
    expect(refused).toBeUndefined();
    expect(pinned()).toEqual({ provider: 'dropbox', account: ACCOUNT.a.dropbox });
    expect(lift).toHaveBeenCalledTimes(1);
  });
});

describe('US-09 AC54: the popup reconnect keeps its pin with its grant', () => {
  it('stopped during the account read: no pin is adopted', async () => {
    localStorage.removeItem(DEVICE_KEY);
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    const { storage } = await page();
    const config = { clientId: 'test-client-id', scope: DRIVE_SCOPE, redirectUri: 'http://localhost:3000/', exchangeUrl: 'https://example.test/api/google-token' };
    expect(await storage.savePopupGrant({ accessToken: 'test-token-a-popup', expiresAt: Date.now() + 3_600_000 }, config, null, () => false)).toBe(false);
    expect([localStorage.getItem(PIN_KEY), localStorage.getItem(DRIVE_TOKENS)]).toEqual([null, null]);
  });
});

describe('US-09 AC54: adoption at load stays with the load\'s own sign-in', () => {
  const connected = () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-a-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000, gen: null }));
  };

  it('a log-off in another tab during the load: nothing is pinned under the new log-off id', async () => {
    connected();
    const { connect } = await page();
    await connect.startOnBackend(await connect.resolveRemembered(), async () => { localStorage.setItem(LOG_OFF_ID_KEY, 'id-new'); });
    await new Promise((done) => setTimeout(done, 20));
    expect(localStorage.getItem(PIN_KEY)).toBeNull();
  });

  it('a log-off in another tab during the account read: nothing is pinned', async () => {
    connected();
    let release = () => {};
    holdAccount = new Promise((done) => { release = done; });
    const { connect } = await page();
    await connect.startOnBackend(await connect.resolveRemembered(), async () => undefined);
    localStorage.setItem(LOG_OFF_ID_KEY, 'id-new');
    release();
    await new Promise((done) => setTimeout(done, 20));
    expect(localStorage.getItem(PIN_KEY)).toBeNull();
  });

  it('control: with no log-off, the load adopts its account', async () => {
    connected();
    const { connect } = await page();
    await connect.startOnBackend(await connect.resolveRemembered(), async () => undefined);
    await vi.waitFor(() => expect(pinned()).toEqual({ provider: 'dropbox', account: ACCOUNT.a.dropbox }));
  });
});
