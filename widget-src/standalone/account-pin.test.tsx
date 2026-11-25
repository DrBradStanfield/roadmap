// @vitest-environment jsdom
/**
 * US-09 AC54: a cloud sign-in stays with the account this browser first
 * connected; another account is refused until the person logs off. Checked
 * before any sign-in is kept and before anything on this device is lifted:
 * the Drive popup reconnect, the Drive and Dropbox redirect returns, and the
 * GitHub form connect. A refused sign-in keeps nothing, lifts nothing, writes
 * nothing to the cloud, and leaves this browser's copy as it was.
 *
 * Real SyncControl, switch-flow, connect.ts, resolve-backend.ts, adapters,
 * pkce and sign-in storage. Fakes: fetch (each provider names the account the
 * test signs in as, and records every call), the GIS token client, the lift,
 * the copy-down, the data layer, Sentry, product events and location. Every
 * account id and token is synthetic.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

const lift = vi.hoisted(() => vi.fn(async () => {}));
const capture = vi.hoisted(() => vi.fn());
const track = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: capture } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: track }));
vi.mock('../src/lib/roadmap-data', () => ({ currentSaveStatus: () => 'saved', flushRoadmapStore: async () => undefined, copyRecordToDevice: async () => undefined, getBackendKind: () => 'cloud' }));
vi.mock('./reminders', () => ({ remindersSupported: () => false, clearAutoEnrolBlock: vi.fn() }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
// The lift and the copy-down at their source: every connect's lift reaches liftDeviceCopy.
vi.mock('@roadmap/health-core/record-transfer', async (original) => ({ ...(await original<object>()), copyCloudDown: async () => undefined, liftDeviceCopy: lift }));

const BACKEND_KEY = 'health_roadmap_backend';
const PIN_KEY = 'health_roadmap_account_pin';
const DEVICE_KEY = 'health_roadmap_file_v2';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const DROPBOX_CONFIG = 'health_roadmap_dropbox';
const GITHUB_CONFIG = 'health_roadmap_github';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const DEVICE_COPY = JSON.stringify({ schemaVersion: 1, note: 'this browser copy' });
const A_EMAIL = 'person-a@example.test';
/** Synthetic account ids, one pair per provider; none may reach a log, an event or a URL. */
const ID = { driveA: 'perm-aaaa', driveB: 'perm-bbbb', dropboxA: 'dbid:aaaa', dropboxB: 'dbid:bbbb' };
const GITHUB_USER = { a: 7001, b: 7002 };

const REFUSED = (label: string) => `${label} did not connect, so nothing changed. Please try again.`;

/** Who the person signs in as at each provider. */
let signedInAs: { drive: string; dropbox: string; github: number };
let calls: Array<{ method: string; url: string }>;
let reload: ReturnType<typeof vi.fn>;
let gisAnswer: ((r: object) => void) | null;
let gisOverrides: Array<Record<string, unknown> | undefined>;

const json = (body: unknown) => Response.json(body);
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  calls.push({ method: init?.method ?? 'GET', url });
  if (url === 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)') return json({ user: { permissionId: signedInAs.drive } });
  if (url.endsWith('/api/google-token')) return json({ accessToken: 'test-token-new', refreshToken: 'test-refresh-new', expiresIn: 3600 });
  if (url === 'https://api.dropboxapi.com/oauth2/token') return json({ access_token: 'test-token-new', refresh_token: 'test-refresh-new', expires_in: 14400, account_id: signedInAs.dropbox });
  if (url === 'https://api.dropboxapi.com/2/users/get_current_account') return json({ account_id: signedInAs.dropbox, email: A_EMAIL, email_verified: true });
  if (url === 'https://api.github.com/user') return json({ id: signedInAs.github });
  if (url === 'https://api.github.com/repos/someone/health') return json({ private: true });
  throw new TypeError('Failed to fetch');
}
/** The calls that mint or validate the sign-in or name its account: the only calls a refused sign-in may make. */
const SIGN_IN_CALLS = [/\/about\?fields=user\(permissionId\)$/, /\/api\/google-token$/, /\/oauth2\/token$/, /\/users\/get_current_account$/, /api\.github\.com\/user$/, /api\.github\.com\/repos\/someone\/health$/];
const cloudCalls = () => calls.filter(({ url }) => !SIGN_IN_CALLS.some((r) => r.test(url)));

const pin = (provider: string, account: string) => localStorage.setItem(PIN_KEY, JSON.stringify({ provider, account, gen: null }));
const pinned = () => {
  const raw = localStorage.getItem(PIN_KEY);
  if (!raw) return null;
  const { provider, account } = JSON.parse(raw) as { provider: string; account: string };
  return { provider, account };
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = vi.fn();
});

let logSpies: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(DEVICE_KEY, DEVICE_COPY);
  signedInAs = { drive: ID.driveA, dropbox: ID.dropboxA, github: GITHUB_USER.a };
  calls = [];
  gisAnswer = null;
  gisOverrides = [];
  lift.mockClear();
  capture.mockClear();
  track.mockClear();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  Object.assign(window, { google: { accounts: { oauth2: { initTokenClient: (options: { callback: (r: object) => void }) => ({
    requestAccessToken: (overrides?: Record<string, unknown>) => { gisOverrides.push(overrides); gisAnswer = options.callback; },
  }) } } } });
  reload = vi.fn();
  const here = { origin: 'http://localhost:3000', pathname: '/', search: '', hash: '', href: 'http://localhost:3000/', reload, assign: vi.fn() };
  Object.defineProperty(window, 'location', { value: here, writable: true, configurable: true });
  logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(() => {
  // The identity never reaches a log line, an error report, a product event or a URL.
  const said = JSON.stringify([...logSpies.map((spy) => spy.mock.calls), capture.mock.calls, track.mock.calls, calls.map(({ url }) => url)], (_k, v: unknown) =>
    v instanceof Error ? `${v.name}: ${v.message}` : v);
  for (const id of [...Object.values(ID), ...Object.values(GITHUB_USER).map(String)]) expect(said).not.toContain(id);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fresh page load's modules. */
async function page() {
  vi.resetModules();
  return {
    connect: await import('./connect'),
    resolve: await import('./resolve-backend'),
    storage: await import('../src/storage'),
  };
}

/** This browser is back from the provider's sign-in page, under the current log-off id. */
function returnedFrom(cloud: 'dropbox' | 'google-drive'): void {
  const key = cloud === 'dropbox' ? 'health_roadmap_dropbox_pkce' : 'health_roadmap_gdrive_pkce';
  sessionStorage.setItem(key, JSON.stringify({ verifier: 'v', state: 's', gen: localStorage.getItem('health_roadmap_log_off_id') }));
  const scope = cloud === 'google-drive' ? `&scope=${encodeURIComponent(DRIVE_SCOPE)}` : '';
  window.location.search = `?code=c&state=s${scope}`;
}

/** Nothing of a refused sign-in was kept, lifted or written. */
function expectNothingKept(keys: string[]): void {
  for (const key of keys) expect(localStorage.getItem(key)).toBeNull();
  expect(lift).not.toHaveBeenCalled();
  expect(cloudCalls()).toEqual([]);
  expect(localStorage.getItem(DEVICE_KEY)).toBe(DEVICE_COPY);
  expect(capture).not.toHaveBeenCalled(); // the person's move, not a defect
}

describe('US-09 AC54: the Drive popup reconnect', () => {
  const A_CONFIG = JSON.stringify({ fileIds: { 'health-roadmap.json': 'file-a' }, folderId: 'folder-a', accountEmail: A_EMAIL, gen: null });
  async function reconnectAs(account: string) {
    const { SyncControl } = await import('./sync-control');
    const { bootSignIn, resetSignIn } = await import('../src/storage/sign-in-state');
    const { resetSwitchFlow } = await import('./switch-flow');
    resetSwitchFlow();
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    localStorage.setItem(DRIVE_CONFIG, A_CONFIG); // the signed-out session's stored config
    pin('google-drive', ID.driveA);
    signedInAs.drive = account;
    resetSignIn();
    bootSignIn({ kind: 'signedOut', provider: 'google-drive' });
    render(<SyncControl backend="local" hasData />);
    fireEvent.click(document.querySelector<HTMLButtonElement>('button.hr-sync-btn')!);
    await act(async () => { gisAnswer!({ access_token: 'test-token-popup', expires_in: 3600, scope: DRIVE_SCOPE }); });
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
  }

  it('another account keeps nothing, lifts nothing, writes nothing, and says the connect did not complete', async () => {
    await reconnectAs(ID.driveB);
    expectNothingKept([DRIVE_TOKENS]);
    expect(localStorage.getItem(DRIVE_CONFIG)).toBe(A_CONFIG); // as it was
    expect(pinned()).toEqual({ provider: 'google-drive', account: ID.driveA });
    expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector('.hr-sync-error')?.textContent).toBe(REFUSED('Google Drive'));
    expect(track).toHaveBeenCalledWith('cloud_connect_refused', { provider: 'google-drive' });
  });

  it('the pinned account is kept, lifted and reloaded, and Google is offered it first', async () => {
    await reconnectAs(ID.driveA);
    expect(localStorage.getItem(DRIVE_TOKENS)).toContain('test-token-popup');
    expect(lift).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(gisOverrides).toEqual([{ prompt: '', login_hint: A_EMAIL }]);
  });
});

describe('US-09 AC54: the redirect returns', () => {
  it('Dropbox reconnect as another account: nothing kept, lifted or written; the page opens as it was', async () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    localStorage.setItem(DROPBOX_CONFIG, JSON.stringify({ gen: null })); // signed out: the tokens are gone, the choice stays
    pin('dropbox', ID.dropboxA);
    signedInAs.dropbox = ID.dropboxB;
    returnedFrom('dropbox');
    const { resolve } = await page();
    const { resolved, refused } = await resolve.resolveBackend();
    expect(refused).toBe(REFUSED('Dropbox'));
    expect(resolved.backend).toBe('dropbox'); // the remembered choice, as before the sign-in
    expectNothingKept([DROPBOX_TOKENS]);
    expect(pinned()).toEqual({ provider: 'dropbox', account: ID.dropboxA });
    expect(track).toHaveBeenCalledWith('cloud_connect_refused', { provider: 'dropbox' });
  });

  it('Google Drive redirect as another account: nothing kept, lifted or written', async () => {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    pin('google-drive', ID.driveA);
    signedInAs.drive = ID.driveB;
    returnedFrom('google-drive');
    const { resolve } = await page();
    const { refused } = await resolve.resolveBackend();
    expect(refused).toBe(REFUSED('Google Drive'));
    expectNothingKept([DRIVE_TOKENS, DRIVE_CONFIG]);
    expect(pinned()).toEqual({ provider: 'google-drive', account: ID.driveA });
  });

  it('a first connect pins the account it signed in as, and Google is offered the stored email', async () => {
    returnedFrom('dropbox');
    const { resolve } = await page();
    const { resolved } = await resolve.resolveBackend();
    expect(resolved.backend).toBe('dropbox');
    expect(lift).toHaveBeenCalledTimes(1);
    expect(pinned()).toEqual({ provider: 'dropbox', account: ID.dropboxA });

    localStorage.setItem(DRIVE_CONFIG, JSON.stringify({ accountEmail: A_EMAIL, gen: null }));
    const { connect } = await page();
    void connect.adapterFor('google-drive')!.connect();
    await vi.waitFor(() => expect(window.location.assign).toHaveBeenCalled());
    const authorize = new URL(String(vi.mocked(window.location.assign).mock.calls[0][0]));
    expect(authorize.searchParams.get('login_hint')).toBe(A_EMAIL);
  });
});

describe('US-09 AC54: after lost credentials', () => {
  /** Dropbox was this browser's home, and its sign-in is gone: the next load opens as a guest on this browser's copy. */
  async function credentialsLost() {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    pin('dropbox', ID.dropboxA);
    const { resolve } = await page();
    expect((await resolve.resolveBackend()).resolved.backend).toBe('local');
    expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
    expect(pinned()).toEqual({ provider: 'dropbox', account: ID.dropboxA }); // the pin outlives the fallback
  }

  it('another account, at the same provider or another, is refused', async () => {
    await credentialsLost();
    signedInAs.dropbox = ID.dropboxB;
    returnedFrom('dropbox');
    expect((await (await page()).resolve.resolveBackend()).refused).toBe(REFUSED('Dropbox'));
    signedInAs.drive = ID.driveA;
    returnedFrom('google-drive');
    expect((await (await page()).resolve.resolveBackend()).refused).toBe(REFUSED('Google Drive'));
    expectNothingKept([DROPBOX_TOKENS, DRIVE_TOKENS, DRIVE_CONFIG, BACKEND_KEY]);
  });

  it('a GitHub form connect is refused the same way, before its sign-in is kept', async () => {
    await credentialsLost();
    const { connect, storage } = await page();
    const adapter = new storage.GitHubAdapter({ token: 'test-token-good', owner: 'someone', repo: 'health' }, null);
    await expect(connect.finishFormConnect(adapter, 'github', null)).rejects.toThrow(REFUSED('GitHub'));
    expectNothingKept([GITHUB_CONFIG, BACKEND_KEY]);
    expect(reload).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith('cloud_connect_refused', { provider: 'github' });
  });

  it('the same account still connects and lifts', async () => {
    await credentialsLost();
    returnedFrom('dropbox');
    const { resolved, refused } = await (await page()).resolve.resolveBackend();
    expect(refused).toBeUndefined();
    expect(resolved.backend).toBe('dropbox');
    expect(localStorage.getItem(DROPBOX_TOKENS)).toContain('test-token-new');
    expect(lift).toHaveBeenCalledTimes(1);
  });
});

describe('US-09 AC54: what ends a pin', () => {
  it('log-off clears it: another account then connects cleanly and pins itself', async () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    pin('dropbox', ID.dropboxA);
    await (await page()).connect.logOff('dropbox');
    expect(localStorage.getItem(PIN_KEY)).toBeNull();
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();

    signedInAs.drive = ID.driveB;
    returnedFrom('google-drive');
    const { resolved, refused } = await (await page()).resolve.resolveBackend();
    expect(refused).toBeUndefined();
    expect(resolved.backend).toBe('google-drive');
    expect(lift).toHaveBeenCalledTimes(1);
    expect(pinned()).toEqual({ provider: 'google-drive', account: ID.driveB });
  });

  it('a deliberate switch keeps it until the new sign-in is kept, which then replaces it', async () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000, gen: null }));
    pin('dropbox', ID.dropboxA);
    await (await page()).connect.prepareSwitch('dropbox', 'google-drive');
    expect(pinned()).toEqual({ provider: 'dropbox', account: ID.dropboxA });

    signedInAs.drive = ID.driveB;
    returnedFrom('google-drive');
    const { refused } = await (await page()).resolve.resolveBackend();
    expect(refused).toBeUndefined();
    expect(pinned()).toEqual({ provider: 'google-drive', account: ID.driveB });
  });

  it('a guest page\'s picker move keeps it: no cloud was left', async () => {
    pin('dropbox', ID.dropboxA);
    await (await page()).connect.prepareSwitch('local');
    expect(pinned()).toEqual({ provider: 'dropbox', account: ID.dropboxA });
  });
});

describe('US-09 AC54: a browser that connected before the pin', () => {
  const connected = () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000, gen: null }));
  };

  it('adopts the account it is signed in to at the next good load', async () => {
    connected();
    const { connect } = await page();
    await connect.startOnBackend(await connect.resolveRemembered(), async () => undefined);
    await vi.waitFor(() => expect(pinned()).toEqual({ provider: 'dropbox', account: ID.dropboxA }));
  });

  it('adopts nothing at a load that fell back to this browser', async () => {
    connected();
    const { connect, storage } = await page();
    const init = vi.fn(async (adapter: { id: string }) => { if (adapter.id === 'dropbox') throw new storage.StorageError('down'); });
    expect((await connect.startOnBackend(await connect.resolveRemembered(), init)).backend).toBe('local');
    await new Promise((done) => setTimeout(done, 20));
    expect(localStorage.getItem(PIN_KEY)).toBeNull();
    expect(calls.map(({ url }) => url)).not.toContain('https://api.dropboxapi.com/2/users/get_current_account');
  });
});
