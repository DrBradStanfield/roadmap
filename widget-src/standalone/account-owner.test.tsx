// @vitest-environment jsdom
/**
 * US-09 AC55: a cloud sign-in stays with the account this browser connected;
 * another account is refused. Checked where a sign-in comes back to the
 * backend this browser still remembers: the Drive popup reconnect and the
 * Dropbox reconnect return.
 *
 * Real SyncControl, switch-flow, connect.ts, resolve-backend.ts, adapters,
 * account gate and sign-in storage. Fakes: fetch (each provider names the
 * account the test signs in as, serves a record, and logs every call), the
 * GIS token client, the lift, the copy-down, the data layer, Sentry, product
 * events and location. Every account id and token is synthetic.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

const lift = vi.hoisted(() => vi.fn(async () => {}));
const capture = vi.hoisted(() => vi.fn());
const track = vi.hoisted(() => vi.fn());
/** The working record open on the page (null: none), and what a failed save of it does: mirror it to this device. */
const session = vi.hoisted(() => ({ live: null as object | null, otherWriter: null as string | null }));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: capture } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: track }));
vi.mock('../src/lib/roadmap-data', () => ({
  currentSaveStatus: () => 'saved',
  flushRoadmapStore: async () => {
    if (session.live) localStorage.setItem('health_roadmap_file_v2', JSON.stringify(session.live));
    if (session.otherWriter) localStorage.setItem('health_roadmap_file_v2', session.otherWriter); // another tab's save lands meanwhile
  },
  copyRecordToDevice: async () => undefined,
  getBackendKind: () => 'cloud',
  recordFileSync: () => session.live,
}));
vi.mock('./reminders', () => ({ remindersSupported: () => false, clearAutoEnrolBlock: vi.fn() }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
// Every connect's lift reaches liftDeviceCopy; the copy-down is copyCloudDown.
vi.mock('@roadmap/health-core/record-transfer', async (original) => ({ ...(await original<object>()), copyCloudDown: async () => undefined, liftDeviceCopy: lift }));

const BACKEND_KEY = 'health_roadmap_backend';
const PIN_KEY = 'health_roadmap_account_pin';
const DEVICE_KEY = 'health_roadmap_file_v2';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const DROPBOX_CONFIG = 'health_roadmap_dropbox';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const STAMP = { updatedAt: '2026-11-25T00:00:00Z', lamport: 1 };
const record = (...ids: string[]) => ({ schemaVersion: 3, profile: { ...STAMP, birthYear: 1970 }, measurements: ids.map((id) => ({ id })) });
const DEVICE_COPY = JSON.stringify(record('row-a1', 'row-a2'));
const PROFILE_ONLY = JSON.stringify({ schemaVersion: 3, profile: { ...STAMP, birthYear: 1970 }, measurements: [] });
const A_EMAIL = 'person-a@example.test';
/** Synthetic account ids; none may reach a log, an event, an error report or a URL. */
const ID = { driveA: 'perm-aaaa', driveB: 'perm-bbbb', dropboxA: 'dbid:aaaa', dropboxB: 'dbid:bbbb' };
const REFUSED = (label: string) => `${label} did not connect, so nothing changed. Please try again.`;

/** Who the person signs in as, and what each signed-in account's cloud holds. */
let signedInAs: { drive: string; dropbox: string };
let cloud: { driveFiles: Record<string, object>; dropbox: object | null };
let calls: Array<{ method: string; url: string }>;
/** Runs once, inside the next cloud read: another tab acting meanwhile. */
let meanwhile: (() => void) | null;
let reload: ReturnType<typeof vi.fn>;
let gisAnswer: ((r: object) => void) | null;
let gisOverrides: Array<Record<string, unknown> | undefined>;

const DRIVE = 'https://www.googleapis.com/drive/v3';
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  calls.push({ method: init?.method ?? 'GET', url });
  if (url === `${DRIVE}/about?fields=user(permissionId)`) return Response.json({ user: { permissionId: signedInAs.drive } });
  if (url.endsWith('/api/google-token')) return Response.json({ accessToken: 'test-token-new', refreshToken: 'test-refresh-new', expiresIn: 3600 });
  if (url === 'https://api.dropboxapi.com/oauth2/token') return Response.json({ access_token: 'test-token-new', refresh_token: 'test-refresh-new', expires_in: 14400, account_id: signedInAs.dropbox });
  meanwhile?.();
  meanwhile = null;
  if (url.startsWith(`${DRIVE}/files?q=`)) return Response.json({ files: Object.keys(cloud.driveFiles).map((id) => ({ id, createdTime: '2026-01-01T00:00:00Z' })) });
  const file = /\/files\/([^?]+)\?(.*)$/.exec(url);
  if (file && url.startsWith(DRIVE)) {
    const body = cloud.driveFiles[file[1]];
    if (!body) return new Response('', { status: 404 });
    return file[2] === 'alt=media' ? new Response(JSON.stringify(body)) : Response.json({ version: '1' });
  }
  if (url === 'https://content.dropboxapi.com/2/files/download') {
    return cloud.dropbox ? new Response(JSON.stringify(cloud.dropbox), { headers: { 'dropbox-api-result': '{"rev":"r1"}' } })
      : new Response(JSON.stringify({ error_summary: 'path/not_found/' }), { status: 409 });
  }
  throw new TypeError('Failed to fetch');
}
/** Anything that could change a cloud: none may follow a refusal. */
const cloudWrites = () => calls.filter(({ method, url }) => /upload|PATCH|PUT|DELETE/.test(`${method} ${url}`));

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
  signedInAs = { drive: ID.driveA, dropbox: ID.dropboxA };
  cloud = { driveFiles: {}, dropbox: null };
  calls = [];
  meanwhile = null;
  session.live = null;
  session.otherWriter = null;
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
  vi.spyOn(window.history, 'replaceState').mockImplementation(() => { window.location.search = ''; });
  logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(() => {
  // The identity never reaches a log line, an error report, a product event or a URL.
  const said = JSON.stringify([...logSpies.map((spy) => spy.mock.calls), capture.mock.calls, track.mock.calls, calls.map(({ url }) => url), window.location.search], (_k, v: unknown) =>
    v instanceof Error ? `${v.name}: ${v.message}` : v);
  for (const id of Object.values(ID)) expect(said).not.toContain(id);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fresh page load's modules. */
async function page() {
  vi.resetModules();
  return { connect: await import('./connect'), resolve: await import('./resolve-backend') };
}

/** This browser is back from Dropbox's sign-in page, under the current log-off id. */
function returnedFrom(provider: 'dropbox' | 'google-drive'): void {
  const key = provider === 'dropbox' ? 'health_roadmap_dropbox_pkce' : 'health_roadmap_gdrive_pkce';
  sessionStorage.setItem(key, JSON.stringify({ verifier: 'v', state: 's', gen: localStorage.getItem('health_roadmap_log_off_id') }));
  window.location.search = `?code=c&state=s${provider === 'google-drive' ? `&scope=${encodeURIComponent(DRIVE_SCOPE)}` : ''}`;
}

/** Nothing of a refused sign-in was kept, lifted or written; this browser's copy is byte-identical. */
function expectNothingKept(keys: string[], device: string | null = DEVICE_COPY): void {
  for (const key of keys) expect(localStorage.getItem(key)).toBeNull();
  expect(lift).not.toHaveBeenCalled();
  expect(cloudWrites()).toEqual([]);
  expect(localStorage.getItem(DEVICE_KEY)).toBe(device);
  expect(window.location.search).toBe('');
  expect(capture).not.toHaveBeenCalled(); // the person's move, not a defect
}

const A_CONFIG = JSON.stringify({ fileIds: { 'health-roadmap.json': 'file-a' }, folderId: 'folder-a', accountEmail: A_EMAIL, gen: null });

/** The Drive reconnect panel of a signed-out session; Google answers the popup as `account`. */
async function popupReconnectAs(account: string) {
  const { SyncControl } = await import('./sync-control');
  const { bootSignIn, resetSignIn } = await import('../src/storage/sign-in-state');
  const { resetSwitchFlow } = await import('./switch-flow');
  resetSwitchFlow();
  localStorage.setItem(BACKEND_KEY, 'google-drive');
  localStorage.setItem(DRIVE_CONFIG, A_CONFIG);
  signedInAs.drive = account;
  resetSignIn();
  bootSignIn({ kind: 'signedOut', provider: 'google-drive' });
  render(<SyncControl backend="local" hasData />);
  fireEvent.click(document.querySelector<HTMLButtonElement>('button.hr-sync-btn')!);
  await act(async () => { gisAnswer!({ access_token: 'test-token-popup', expires_in: 3600, scope: DRIVE_SCOPE }); });
  await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
}

describe('US-09 AC55: the Drive popup reconnect', () => {
  it('another account keeps nothing, lifts nothing, writes nothing, and says the connect did not complete', async () => {
    pin('google-drive', ID.driveA);
    await popupReconnectAs(ID.driveB);
    expectNothingKept([DRIVE_TOKENS]);
    expect(localStorage.getItem(DRIVE_CONFIG)).toBe(A_CONFIG);
    expect(pinned()).toEqual({ provider: 'google-drive', account: ID.driveA });
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector('.hr-sync-error')?.textContent).toBe(REFUSED('Google Drive'));
    expect(track).toHaveBeenCalledWith('cloud_connect_refused', { provider: 'google-drive' });
  });

  it('the pinned account keeps the sign-in and lifts, and Google is offered it first', async () => {
    pin('google-drive', ID.driveA);
    await popupReconnectAs(ID.driveA);
    expect(localStorage.getItem(DRIVE_TOKENS)).toContain('test-token-popup');
    expect(pinned()).toEqual({ provider: 'google-drive', account: ID.driveA });
    expect(lift).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(gisOverrides).toEqual([{ prompt: '', login_hint: A_EMAIL }]);
  });

  it('no pin: a stale cached file id with a shared row adopts the account', async () => {
    cloud.driveFiles = { 'file-b': record('row-a1', 'row-b9') }; // file-a is not visible to this sign-in
    await popupReconnectAs(ID.driveB);
    expect(pinned()).toEqual({ provider: 'google-drive', account: ID.driveB });
    expect(lift).toHaveBeenCalledTimes(1);
  });

  it('no pin and no proof: refused, and "Use this browser only" still works', async () => {
    cloud.driveFiles = { 'file-b': record('row-b1') };
    await popupReconnectAs(ID.driveB);
    expectNothingKept([DRIVE_TOKENS, PIN_KEY]);
    expect(document.querySelector('.hr-sync-error')?.textContent).toBe(REFUSED('Google Drive'));

    const only = [...document.querySelectorAll<HTMLButtonElement>('button.hr-sync-link')].find((b) => b.textContent === 'Use this browser only')!;
    await act(async () => { fireEvent.click(only); await new Promise((done) => setTimeout(done, 20)); });
    expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
    expect(localStorage.getItem(DRIVE_CONFIG)).toBeNull();
    expect(localStorage.getItem(DEVICE_KEY)).toBe(DEVICE_COPY);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('no pin and no stored copy: the record open on the page, unsaved edit included, is what is judged, so another account is refused', async () => {
    localStorage.removeItem(DEVICE_KEY);
    session.live = record('row-a1', 'row-a2', 'row-a3-unsaved');
    cloud.driveFiles = { 'file-b': record('row-b1') };
    await popupReconnectAs(ID.driveB);
    expectNothingKept([DRIVE_TOKENS, PIN_KEY], null);
    expect(document.querySelector('.hr-sync-error')?.textContent).toBe(REFUSED('Google Drive'));
  });

  it('no pin and no stored copy: the open record\'s own cloud still keeps the sign-in', async () => {
    localStorage.removeItem(DEVICE_KEY);
    session.live = record('row-a1', 'row-a3-unsaved');
    cloud.driveFiles = { 'file-a': record('row-a1') };
    await popupReconnectAs(ID.driveA);
    expect(pinned()).toEqual({ provider: 'google-drive', account: ID.driveA });
    expect(lift).toHaveBeenCalledTimes(1);
  });

  it('an account Google cannot name is refused, counted, and reported once with the provider only', async () => {
    pin('google-drive', ID.driveA);
    await popupReconnectAs('');
    expect(localStorage.getItem(DRIVE_TOKENS)).toBeNull();
    expect(lift).not.toHaveBeenCalled();
    expect(cloudWrites()).toEqual([]);
    expect(document.querySelector('.hr-sync-error')?.textContent).toBe(REFUSED('Google Drive'));
    expect(track).toHaveBeenCalledWith('cloud_connect_refused', { provider: 'google-drive' });
    expect(capture).toHaveBeenCalledTimes(1);
    const [error, context] = capture.mock.calls[0] as [Error, { tags: object }];
    expect(error.message).toBe('Cloud connect failed');
    expect(context).toEqual({ tags: { area: 'cloud-connect', backend: 'google-drive' } });
  });

  it('a pin another tab writes between the decision and the write is refused', async () => {
    localStorage.setItem(DRIVE_CONFIG, A_CONFIG);
    cloud.driveFiles = { 'file-a': record('row-a1') }; // the proof this tab decides on
    meanwhile = () => pin('google-drive', ID.driveB);
    await popupReconnectAs(ID.driveA);
    expectNothingKept([DRIVE_TOKENS]);
    expect(pinned()).toEqual({ provider: 'google-drive', account: ID.driveB });
  });

  it('no pin and an empty copy that stays empty: kept and lifted', async () => {
    localStorage.removeItem(DEVICE_KEY);
    cloud.driveFiles = { 'file-b': record('row-b1') };
    await popupReconnectAs(ID.driveB);
    expect(pinned()).toEqual({ provider: 'google-drive', account: ID.driveB });
    expect(lift).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('no pin and an empty copy another writer fills before the lift: refused, the earlier sign-in put back, nothing lifted', async () => {
    localStorage.removeItem(DEVICE_KEY);
    const earlier = JSON.stringify({ accessToken: 'test-token-old', expiresAt: 1, gen: null });
    localStorage.setItem(DRIVE_TOKENS, earlier);
    cloud.driveFiles = { 'file-b': record('row-b1') };
    session.otherWriter = DEVICE_COPY;
    await popupReconnectAs(ID.driveB);
    expect(localStorage.getItem(DRIVE_TOKENS)).toBe(earlier);
    expect(localStorage.getItem(PIN_KEY)).toBeNull();
    expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
    expectNothingKept([PIN_KEY]);
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector('.hr-sync-error')?.textContent).toBe(REFUSED('Google Drive'));
    expect(track.mock.calls.filter(([name]) => name === 'cloud_connect_refused')).toEqual([['cloud_connect_refused', { provider: 'google-drive' }]]);
  });
});

describe('US-09 AC55: a form connect', () => {
  const DAV = 'https://dav.example.test/health/';
  it.each([
    ['github', 'GitHub', 'github'],
    ['self-host', 'Self-host (WebDAV)', 'webdav'],
  ] as const)('%s: credentials that validate and an account the provider cannot name: refused, counted once, reported once with the provider only', async (backend, label, event) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url });
      if (url === 'https://api.github.com/repos/someone/health') return Response.json({ private: true });
      if (url === 'https://api.github.com/user') return new Response('', { status: 401 });
      if (init?.method === 'PROPFIND') return new Response('', { status: 207 });
      throw new TypeError('Failed to fetch');
    }));
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('digest unavailable'));
    const { connect } = await page();
    const { GitHubAdapter, WebDavAdapter } = await import('../src/storage');
    const { logOffId } = await import('../src/lib/storage');
    const gen = logOffId();
    const adapter = backend === 'github'
      ? new GitHubAdapter({ token: 'test-token-good', owner: 'someone', repo: 'health' }, gen)
      : new WebDavAdapter({ url: DAV, username: 'someone', password: 'test-pass-this' }, gen);
    await expect(connect.finishFormConnect(adapter, backend, gen)).rejects.toThrow(REFUSED(label));
    expect(track.mock.calls).toEqual([['cloud_connect_refused', { provider: event }]]);
    expect(capture).toHaveBeenCalledTimes(1);
    const [error, context] = capture.mock.calls[0] as [Error, { tags: object }];
    expect(error.message).toBe('Cloud connect failed');
    expect(context).toEqual({ tags: { area: 'cloud-connect', backend } });
    expect(localStorage.getItem(PIN_KEY)).toBeNull();
    expect(lift).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    const said = JSON.stringify([...logSpies.map((spy) => spy.mock.calls), capture.mock.calls, track.mock.calls], (_k, v: unknown) => v instanceof Error ? `${v.name}: ${v.message}` : v);
    for (const secret of ['test-token-good', 'test-pass-this', 'someone', 'api.github.com', 'dav.example.test']) expect(said).not.toContain(secret);
  });
});

describe('US-09 AC55: the Dropbox reconnect return', () => {
  const signedOut = () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    localStorage.setItem(DROPBOX_CONFIG, JSON.stringify({ gen: null })); // the tokens are gone, the choice stays
  };

  it('another account keeps nothing, lifts nothing, writes nothing; the page opens as it was', async () => {
    signedOut();
    pin('dropbox', ID.dropboxA);
    signedInAs.dropbox = ID.dropboxB;
    returnedFrom('dropbox');
    const { resolved, refused } = await (await page()).resolve.resolveBackend();
    expect(refused).toBe(REFUSED('Dropbox'));
    expect(resolved.backend).toBe('dropbox');
    expectNothingKept([DROPBOX_TOKENS]);
    expect(pinned()).toEqual({ provider: 'dropbox', account: ID.dropboxA });
    expect(track).toHaveBeenCalledWith('cloud_connect_refused', { provider: 'dropbox' });
  });

  it('the pinned account keeps the sign-in and lifts', async () => {
    signedOut();
    pin('dropbox', ID.dropboxA);
    returnedFrom('dropbox');
    const { resolved, refused } = await (await page()).resolve.resolveBackend();
    expect(refused).toBeUndefined();
    expect(resolved.backend).toBe('dropbox');
    expect(localStorage.getItem(DROPBOX_TOKENS)).toContain('test-token-new');
    expect(lift).toHaveBeenCalledTimes(1);
  });

  it('no pin: a shared row adopts; none refuses', async () => {
    signedOut();
    cloud.dropbox = record('row-b1');
    returnedFrom('dropbox');
    expect((await (await page()).resolve.resolveBackend()).refused).toBe(REFUSED('Dropbox'));
    expectNothingKept([DROPBOX_TOKENS, PIN_KEY]);

    cloud.dropbox = record('row-a2');
    returnedFrom('dropbox');
    expect((await (await page()).resolve.resolveBackend()).refused).toBeUndefined();
    expect(pinned()).toEqual({ provider: 'dropbox', account: ID.dropboxA });
  });

  it('no pin and a copy holding only an erase: its erase history needs proof too, so refused and nothing lifted', async () => {
    const erased = JSON.stringify({ schemaVersion: 3, meta: { ...STAMP, eraseEpoch: 1 }, erasedRows: { fromEpoch: 1, ids: [] }, measurements: [] });
    localStorage.setItem(DEVICE_KEY, erased);
    signedOut();
    signedInAs.dropbox = ID.dropboxB;
    cloud.dropbox = record('row-b1');
    returnedFrom('dropbox');
    expect((await (await page()).resolve.resolveBackend()).refused).toBe(REFUSED('Dropbox'));
    expectNothingKept([DROPBOX_TOKENS, PIN_KEY], erased);
  });
});

describe('US-09 AC55: a guest\'s first connect is not checked', () => {
  it('a profile-only guest connects another account and lifts', async () => {
    localStorage.setItem(DEVICE_KEY, PROFILE_ONLY);
    signedInAs.dropbox = ID.dropboxB;
    returnedFrom('dropbox');
    const { resolved, refused } = await (await page()).resolve.resolveBackend();
    expect(refused).toBeUndefined();
    expect(resolved.backend).toBe('dropbox');
    expect(lift).toHaveBeenCalledTimes(1);
    expect(pinned()).toEqual({ provider: 'dropbox', account: ID.dropboxB });
  });

  it.each([
    ['another Google account', ID.driveB],
    ['the same person\'s own Google account', ID.driveA],
  ])('a switch cancelled at the provider leaves a guest page whose retry as %s connects', async (_name, account) => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000, gen: null }));
    pin('dropbox', ID.dropboxA);
    await (await page()).connect.prepareSwitch('dropbox');
    expect(pinned()).toBeNull(); // released once the copy-down succeeded
    // Cancelled at Google: the next load is a guest page on this browser's copy.
    expect((await (await page()).resolve.resolveBackend()).resolved.backend).toBe('local');

    signedInAs.drive = account;
    returnedFrom('google-drive');
    const { resolved, refused } = await (await page()).resolve.resolveBackend();
    expect(refused).toBeUndefined();
    expect(resolved.backend).toBe('google-drive');
    expect(lift).toHaveBeenCalledTimes(1);
    expect(pinned()).toEqual({ provider: 'google-drive', account });
  });
});

describe('US-09 AC55: the pin\'s life', () => {
  it('log-off removes it', async () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    pin('dropbox', ID.dropboxA);
    await (await page()).connect.logOff('dropbox');
    expect(localStorage.getItem(PIN_KEY)).toBeNull();
  });

  it('a Drive browser with no pin adopts its account at the next good load', async () => {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    localStorage.setItem(DRIVE_CONFIG, A_CONFIG);
    localStorage.setItem(DRIVE_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000, gen: null }));
    const { connect } = await page();
    await connect.startOnBackend(await connect.resolveRemembered(), async () => undefined);
    await vi.waitFor(() => expect(pinned()).toEqual({ provider: 'google-drive', account: ID.driveA }));
  });
});
