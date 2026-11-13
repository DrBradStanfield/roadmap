// @vitest-environment jsdom
/**
 * US-09 AC48, lead A3 step 2, owner rulings R1-R3: a sign-in that ends while
 * the page is open shows the reconnect panel at once, and every exit from it
 * keeps the edits made since, WITHOUT the page's departure save. Here no
 * departure is registered and a reload fires nothing, so an edit still on the
 * 800 ms save debounce reaches the exit's record only if the exit saves the
 * session first (R1).
 *
 * The page opens on a working Google Drive or Dropbox through the real boot
 * (resolveRemembered, startOnBackend, initRoadmapStore, the sign-in seed).
 * Then the provider revokes the app: its API answers 401 and its token
 * endpoint 400 invalid_grant. The watch meets the 401, its next turn refreshes
 * and the page raises (Q3). Then:
 *  - pin 2: one edit while the panel shows, saved by its debounce (it fails
 *    and lands on this browser's copy);
 *  - pin 1: one more, still on the debounce when the exit is taken.
 * Exits: (a) "Use this browser only"; (b) the picker's move to GitHub, refused
 * because the dead cloud cannot be copied down (R2); (c) the reconnect: Drive's
 * GIS popup, Dropbox's sign-in redirect and its return (R3). R3 also pins the
 * redirect return to a NEW Drive home, from a Dropbox that could not be reached
 * at load. Each pin reads the RECORD the exit ends in, never the UI text.
 *
 * Real SyncControl, StorageBar, picker, switch-flow, connect.ts, boot, the
 * data layer, record session, web host, sign-in state and the Drive, Dropbox,
 * GitHub and device adapters. Fakes: fetch (clouds that keep what is written),
 * the GIS token client, Sentry, product events, location. Timers are faked.
 * Every credential is synthetic.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { Blob as NodeBlob } from 'node:buffer';
import { PERSIST_DEBOUNCE_MS } from '@roadmap/health-core/record-session';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() }, initSentry: vi.fn() }));
vi.mock('../src/lib/server-api', async (original) => ({
  ...(await original<typeof import('../src/lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('./reminders', () => ({ remindersSupported: () => false, clearAutoEnrolBlock: vi.fn() }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));

const BACKEND_KEY = 'health_roadmap_backend';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const DROPBOX_CONFIG = 'health_roadmap_dropbox';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const GOOD_TOKEN = 'test-token-good';
const DRIVE_FOLDER = 'folder';

// ---------------------------------------------------------------- the clouds

let dropboxFile: { body: string; rev: number } | null;
let githubFile: { body: string; sha: number } | null;
let driveFiles: Array<{ id: string; name: string; content: string; version: number }>;
/** The provider revoked this app: its API refuses the token and its token endpoint the grant. */
let revoked: { drive: boolean; dropbox: boolean };
/** No answer at all, as in an outage. */
let dropboxDown: boolean;
/** Dropbox's long-poll reports a change, so the watch next makes a call that carries the token. */
let dropboxChanged: boolean;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refuse = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));

async function driveFetch(url: URL, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  if (url.pathname === '/drive/v3/changes/startPageToken') return json({ startPageToken: 't1' });
  if (url.pathname === '/drive/v3/changes') return json({ changes: [], newStartPageToken: 't1' });
  if (url.pathname === '/drive/v3/files' && method === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    if (q.includes('mimeType=')) return json({ files: [{ id: DRIVE_FOLDER, name: 'Health Plan by Dr Brad' }] });
    const name = /name='([^']+)'/.exec(q)?.[1];
    return json({ files: driveFiles.filter((f) => f.name === name).map(({ id }) => ({ id, createdTime: '2026-06-01T00:00:00.000Z' })) });
  }
  if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
    const text = await new Response(init!.body as BodyInit).text();
    const parts = text.split(/--rm_boundary_health_roadmap-*\r?\n?/).filter((part) => part.trim());
    const meta = JSON.parse(parts[0].split('\r\n\r\n')[1]) as { name: string };
    const content = parts[1].split('\r\n\r\n')[1].replace(/\r\n$/, '');
    const file = { id: `file-${driveFiles.length + 1}`, name: meta.name, content, version: 1 };
    driveFiles.push(file);
    return json({ id: file.id, version: '1' });
  }
  const id = /\/files\/([^/]+)$/.exec(url.pathname)?.[1];
  const file = driveFiles.find((entry) => entry.id === id);
  if (file && method === 'GET') {
    return url.searchParams.get('alt') === 'media'
      ? new Response(file.content)
      : json({ id: file.id, name: file.name, version: String(file.version), createdTime: '2026-06-01T00:00:00.000Z', trashed: false, parents: [DRIVE_FOLDER] });
  }
  if (!file && method === 'GET' && id) return new Response('not found', { status: 404 });
  if (file && method === 'PATCH' && url.pathname.startsWith('/upload/')) {
    file.content = String(init!.body);
    file.version += 1;
    return json({ id: file.id, version: String(file.version) });
  }
  throw new Error(`unexpected Drive request ${method} ${url.pathname}`);
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/api/google-token')) {
    const body = JSON.parse(String(init?.body)) as { grantType: string };
    if (body.grantType === 'code') return json({ accessToken: GOOD_TOKEN, refreshToken: 'test-refresh-new', expiresIn: 3600 });
    return revoked.drive ? json({ error: 'invalid_grant' }, 400) : json({ accessToken: GOOD_TOKEN, expiresIn: 3600 });
  }
  if (url === 'https://api.dropboxapi.com/oauth2/token') {
    if (dropboxDown) return refuse();
    const body = new URLSearchParams(String(init?.body));
    if (body.get('grant_type') === 'authorization_code') return json({ access_token: GOOD_TOKEN, refresh_token: 'test-refresh-new', expires_in: 14_400 });
    return revoked.dropbox ? json({ error: 'invalid_grant' }, 400) : json({ access_token: GOOD_TOKEN, expires_in: 14_400 });
  }
  if (url.startsWith('https://content.dropboxapi.com/') || url.startsWith('https://api.dropboxapi.com/')) {
    if (dropboxDown) return refuse();
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    if (revoked.dropbox && auth.includes('test-token-old')) return json({ error_summary: 'invalid_access_token/' }, 401);
    if (url === 'https://content.dropboxapi.com/2/files/download') {
      if (!dropboxFile) return json({ error_summary: 'path/not_found/..' }, 409);
      return new Response(dropboxFile.body, { status: 200, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: `r${dropboxFile.rev}` }) } });
    }
    if (url === 'https://content.dropboxapi.com/2/files/upload') {
      dropboxFile = { body: String(init?.body), rev: (dropboxFile?.rev ?? 0) + 1 };
      return json({ rev: `r${dropboxFile.rev}` });
    }
    if (url.endsWith('/list_folder') || url.endsWith('/list_folder/continue')) return json({ cursor: 'c0', entries: [] });
  }
  // Dropbox's long-poll: quiet, answered after its 30 seconds.
  if (url.startsWith('https://notify.dropboxapi.com/')) {
    return dropboxDown ? refuse() : new Promise<Response>((done) => setTimeout(() => done(json({ changes: dropboxChanged })), 30_000));
  }
  if (url.startsWith('https://www.googleapis.com/drive/') || url.startsWith('https://www.googleapis.com/upload/drive/')) {
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    if (revoked.drive && auth.includes('test-token-old')) return json({ error: { code: 401 } }, 401);
    return driveFetch(new URL(url), init);
  }
  if (url.startsWith('https://api.github.com/repos/someone/health')) {
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    if (!auth.includes(GOOD_TOKEN)) return json({ message: 'Bad credentials' }, 401);
    if (url === 'https://api.github.com/repos/someone/health') return json({ private: true });
    if (url.startsWith(`https://api.github.com/repos/someone/health/contents/${ROADMAP_FILE_NAME}`)) {
      if (init?.method === 'PUT') {
        const { content } = JSON.parse(String(init.body)) as { content: string };
        githubFile = { body: new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0))), sha: (githubFile?.sha ?? 0) + 1 };
        return json({ content: { sha: `s${githubFile.sha}` } }, 201);
      }
      if (!githubFile) return json({ message: 'Not Found' }, 404);
      const bytes = new TextEncoder().encode(githubFile.body);
      return json({ content: btoa(String.fromCharCode(...bytes)), sha: `s${githubFile.sha}`, encoding: 'base64', size: bytes.length });
    }
    return json({ message: 'Not Found' }, 404);
  }
  return refuse();
}

// ---------------------------------------------------------------- the page

type Cloud = 'google-drive' | 'dropbox';
interface Page {
  data: typeof import('../src/lib/roadmap-data');
  sync: typeof import('./sync-control');
  notice: typeof import('../src/lib/storage-notice');
  switchFlow: typeof import('./switch-flow');
  backend: import('./connect').Backend;
}

let page: Page | null;
let reload: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;
let gisAnswer: ((r: object) => void) | null;

/** A page load through the real boot (the sign-in seed included). No departure save is registered. */
async function loadPage(resolve?: () => Promise<{ resolved: import('./connect').ResolvedBackend }>): Promise<Page> {
  cleanup();
  vi.resetModules();
  const connect = await import('./connect');
  const data = await import('../src/lib/roadmap-data');
  const { boot } = await import('./boot');
  const { backend } = await boot(resolve ?? (async () => ({ resolved: await connect.resolveRemembered() })), data.initRoadmapStore);
  page = {
    data,
    sync: await import('./sync-control'),
    notice: await import('../src/lib/storage-notice'),
    switchFlow: await import('./switch-flow'),
    backend,
  };
  return page;
}

const turns = async (n = 20) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise<void>((r) => setImmediate(r)); }); };
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (done()) return;
    await act(async () => { await new Promise<void>((r) => setImmediate(r)); });
  }
  throw new Error(`timed out waiting for ${what}`);
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function weightsIn(body: unknown): Record<string, number> {
  const file = (typeof body === 'string' ? JSON.parse(body) : body ?? { measurements: [] }) as {
    measurements: { metricType: string; value: number; recordedAt: string; status?: string }[];
  };
  return Object.fromEntries(file.measurements
    .filter((m) => m.metricType === 'weight' && m.status !== 'entered-in-error')
    .map((m) => [m.recordedAt.slice(0, 10), m.value]));
}
async function deviceWeights(): Promise<Record<string, number>> {
  const { LocalStorageAdapter } = await import('../src/storage/local-storage-adapter');
  return weightsIn((await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body);
}
const driveWeights = () => weightsIn(driveFiles.find((f) => f.name === ROADMAP_FILE_NAME)?.content);

const PANEL_EDIT = { day: '2026-06-01', value: 81 };
const DEBOUNCED_EDIT = { day: '2026-06-02', value: 82 };
const BOTH = { [PANEL_EDIT.day]: PANEL_EDIT.value, [DEBOUNCED_EDIT.day]: DEBOUNCED_EDIT.value };

async function edit({ day, value }: { day: string; value: number }): Promise<void> {
  await act(async () => { expect((await page!.data.addMeasurement('weight', value, day)).status).toBe('inserted'); });
}

const status = () => document.querySelector('.hr-sync-status')?.textContent;
const barLabel = () => document.querySelector('button.action-btn-small')?.textContent;
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name);
const option = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button.hr-opt')].find((b) => b.textContent?.startsWith(name))!;

/** This browser chose `cloud` and holds a working sign-in to it. */
function chooseCloud(cloud: Cloud): void {
  localStorage.setItem(BACKEND_KEY, cloud);
  if (cloud === 'dropbox') {
    localStorage.setItem(DROPBOX_CONFIG, JSON.stringify({}));
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000 }));
  } else {
    localStorage.setItem(DRIVE_CONFIG, JSON.stringify({}));
    localStorage.setItem(DRIVE_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000 }));
  }
}

/** A page open on a working cloud, the bar and panel mounted as app.tsx mounts them; then the provider revokes the app. */
async function revokeMidSession(cloud: Cloud): Promise<void> {
  chooseCloud(cloud);
  const p = await loadPage();
  expect(p.backend).toBe(cloud);
  render(<><p.sync.StorageBar backend={p.backend} /><p.sync.SyncControl backend={p.backend} hasData /></>);
  expect(status()).toMatch(/lives in your/);

  revoked[cloud === 'dropbox' ? 'dropbox' : 'drive'] = true;
  if (cloud === 'dropbox') {
    // Dropbox's long-poll carries no token: the next save meets the 401, the one after it refreshes.
    await edit({ day: '2026-05-30', value: 79 });
    await advance(PERSIST_DEBOUNCE_MS);
    await turns();
    await edit({ day: '2026-05-31', value: 80 });
    await advance(PERSIST_DEBOUNCE_MS);
  } else {
    await advance(10_000); // the watch meets the 401, backs off, and its next turn refreshes
  }
  await until(() => status() === `${cloud === 'dropbox' ? 'Dropbox' : 'Google Drive'} is signed out`, 'the panel');
  expect(barLabel()).toBe(cloud === 'dropbox' ? 'Sign in to Dropbox again' : 'Sign in to Google again');
}

/** Pin 2, then pin 1: one edit saved (and failed onto this browser) while the panel shows, one still on the debounce. */
async function bothEdits(): Promise<void> {
  await edit(PANEL_EDIT);
  await advance(PERSIST_DEBOUNCE_MS);
  await turns();
  await edit(DEBOUNCED_EDIT);
  await advance(PERSIST_DEBOUNCE_MS - 1);
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = vi.fn();
});

beforeEach(() => {
  page = null;
  localStorage.clear();
  sessionStorage.clear();
  dropboxFile = null;
  githubFile = null;
  driveFiles = [];
  revoked = { drive: false, dropbox: false };
  dropboxDown = false;
  dropboxChanged = false;
  gisAnswer = null;
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  Object.assign(window, { google: { accounts: { oauth2: { initTokenClient: (options: { callback: (r: object) => void }) => ({
    requestAccessToken: () => { gisAnswer = options.callback; },
  }) } } } });
  // A reload or a redirect that fires nothing: no departure save can rescue an edit.
  reload = vi.fn();
  assign = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload, assign, search: '' }, writable: true, configurable: true });
  vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('US-09 AC48 (B-1): a sign-in revoked mid-session shows the reconnect panel on the same page, with no reload', () => {
  it.each(['google-drive', 'dropbox'] as const)('%s', async (cloud) => {
    await revokeMidSession(cloud);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('US-09 AC48 (R1): exit (a) "Use this browser only" saves the session first', () => {
  it.each(['google-drive', 'dropbox'] as const)('%s: both edits are in the device file, with no departure save', async (cloud) => {
    await revokeMidSession(cloud);
    await bothEdits();
    fireEvent.click(button('Use this browser only')!);
    await until(() => reload.mock.calls.length > 0, 'the reload');
    expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
    const next = await loadPage();
    expect(next.backend).toBe('local');
    expect(await deviceWeights()).toMatchObject(BOTH);
  });
});

describe('US-09 AC48 (R1, R2): exit (b) a picker move from a dead sign-in is refused, and both edits are on the device', () => {
  it.each(['google-drive', 'dropbox'] as const)('%s → GitHub', async (cloud) => {
    await revokeMidSession(cloud);
    await bothEdits();
    act(() => page!.notice.openBackendPicker());
    fireEvent.click(option('GitHub'));
    fireEvent.change(document.querySelector('input[placeholder^="Fine-grained token"]')!, { target: { value: GOOD_TOKEN } });
    fireEvent.change(document.querySelector('input[placeholder^="Owner"]')!, { target: { value: 'someone' } });
    fireEvent.change(document.querySelector('input[placeholder^="Repository name"]')!, { target: { value: 'health' } });
    fireEvent.click(button('Connect GitHub')!);
    await until(() => !!document.querySelector('dialog .hr-sync-error'), 'the refused move');
    expect(document.querySelector('dialog .hr-sync-error')?.textContent).toMatch(/could not be reached/);
    expect(reload).not.toHaveBeenCalled();
    expect(githubFile).toBeNull();
    expect(localStorage.getItem(BACKEND_KEY)).toBe(cloud);
    expect(await deviceWeights()).toMatchObject(BOTH); // no debounce has run since the second edit
  });

  it('google-drive: choosing Google Drive again only closes the picker; nothing moves and both edits are on the device', async () => {
    await revokeMidSession('google-drive');
    await bothEdits();
    act(() => page!.notice.openBackendPicker());
    fireEvent.click(option('Google Drive'));
    expect(page!.switchFlow.getSwitchFlow().kind).toBe('idle');
    expect(assign).not.toHaveBeenCalled();
    await advance(1); // the page stays: its debounce runs
    expect(await deviceWeights()).toMatchObject(BOTH);
  });
});

describe('US-09 AC48 (R1, R3): exit (c) the reconnect lifts the saved session into the cloud', () => {
  it('google-drive: the GIS popup, then the lift, then the reload: both edits are in the Drive file', async () => {
    await revokeMidSession('google-drive');
    await bothEdits();
    fireEvent.click(button('Reconnect Google Drive')!);
    expect(gisAnswer).not.toBeNull();
    revoked.drive = false;
    await act(async () => { gisAnswer!({ access_token: GOOD_TOKEN, expires_in: 3600, scope: DRIVE_SCOPE }); });
    await until(() => reload.mock.calls.length > 0, 'the reload');
    expect(driveWeights()).toMatchObject(BOTH); // the lift, before any next page
  });

  it('dropbox: "Reconnect Dropbox" starts the sign-in redirect, and its return lifts both edits into Dropbox', async () => {
    await revokeMidSession('dropbox');
    await bothEdits();
    fireEvent.click(button('Reconnect Dropbox')!);
    await until(() => assign.mock.calls.length > 0, 'the Dropbox redirect');
    expect(String(assign.mock.calls[0][0])).toMatch(/^https:\/\/www\.dropbox\.com\/oauth2\/authorize/);
    expect(reload).not.toHaveBeenCalled();
    // The return: Dropbox sends the browser back with this sign-in's code.
    const { state } = JSON.parse(sessionStorage.getItem('health_roadmap_dropbox_pkce') ?? '{}') as { state?: string };
    window.location.search = `?code=test-code&state=${state}`;
    revoked.dropbox = false;
    const { resolveBackend } = await import('./resolve-backend');
    const { resolved } = await resolveBackend();
    expect(resolved.backend).toBe('dropbox');
    expect(weightsIn(dropboxFile?.body)).toMatchObject(BOTH); // liftLocalInto, before the session opens
  });

  it('a new Drive home: from a Dropbox that could not be reached at load, the picker\'s move and its return lift both edits into Drive', async () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    localStorage.setItem(DROPBOX_CONFIG, JSON.stringify({}));
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000 }));
    dropboxDown = true;
    const p = await loadPage();
    expect(p.backend).toBe('local');
    render(<p.sync.SyncControl backend={p.backend} hasData />);
    expect(status()).toBe('Dropbox could not be reached'); // an outage keeps its words
    await bothEdits();
    dropboxDown = false; // it answers again by the time the user moves
    act(() => page!.notice.openBackendPicker());
    fireEvent.click(option('Google Drive'));
    await until(() => assign.mock.calls.length > 0, 'the Google redirect');
    const { state } = JSON.parse(sessionStorage.getItem('health_roadmap_gdrive_pkce') ?? '{}') as { state?: string };
    window.location.search = `?code=test-code&state=${state}&scope=${encodeURIComponent(DRIVE_SCOPE)}`;
    const { resolveBackend } = await import('./resolve-backend');
    const { resolved } = await resolveBackend();
    expect(resolved.backend).toBe('google-drive');
    expect(driveWeights()).toMatchObject(BOTH);
  });
});

// ------------------------------------------------- review round 1 (lead A3)

const SEEDED = { day: '2026-05-01', value: 75 };
const cloudWeights = (cloud: Cloud) => (cloud === 'dropbox' ? weightsIn(dropboxFile?.body) : driveWeights());
const panelText = (cloud: Cloud) => `${cloud === 'dropbox' ? 'Dropbox' : 'Google Drive'} is signed out`;

/** Codex R1: an earlier visit put the record in the cloud. This visit opens it clean, keeps no device copy
 *  and is never edited; then the provider revokes the app and the watch raises (Dropbox's after a change). */
async function revokeCleanSession(cloud: Cloud): Promise<void> {
  chooseCloud(cloud);
  await loadPage();
  await edit(SEEDED);
  await advance(PERSIST_DEBOUNCE_MS);
  await until(() => cloudWeights(cloud)[SEEDED.day] === SEEDED.value, 'the earlier visit\'s save');
  const p = await loadPage();
  expect(p.backend).toBe(cloud);
  render(<><p.sync.StorageBar backend={p.backend} /><p.sync.SyncControl backend={p.backend} hasData /></>);
  expect(status()).toMatch(/lives in your/);
  expect(await deviceWeights()).toEqual({}); // no device copy: the cloud holds the record alone
  revoked[cloud === 'dropbox' ? 'dropbox' : 'drive'] = true;
  dropboxChanged = cloud === 'dropbox';
  await advance(cloud === 'dropbox' ? 35_000 : 10_000);
  await until(() => status() === panelText(cloud), 'the panel');
}

function connectGitHub(): void {
  act(() => page!.notice.openBackendPicker());
  fireEvent.click(option('GitHub'));
  fireEvent.change(document.querySelector('input[placeholder^="Fine-grained token"]')!, { target: { value: GOOD_TOKEN } });
  fireEvent.change(document.querySelector('input[placeholder^="Owner"]')!, { target: { value: 'someone' } });
  fireEvent.change(document.querySelector('input[placeholder^="Repository name"]')!, { target: { value: 'health' } });
  fireEvent.click(button('Connect GitHub')!);
}

describe('US-09 AC48 (lead A3, Codex R1): every exit from a clean session keeps the record', () => {
  it.each(['google-drive', 'dropbox'] as const)('%s: "Use this browser only" copies the record to this browser first', async (cloud) => {
    await revokeCleanSession(cloud);
    fireEvent.click(button('Use this browser only')!);
    await until(() => reload.mock.calls.length > 0, 'the reload');
    expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
    const next = await loadPage();
    expect(next.backend).toBe('local');
    expect(await deviceWeights()).toMatchObject({ [SEEDED.day]: SEEDED.value });
  });

  it('google-drive: a copy this browser refuses stops "Use this browser only"; the panel stays as it was', async () => {
    await revokeCleanSession('google-drive');
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'health_roadmap_file_v2') throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    fireEvent.click(button('Use this browser only')!);
    await until(() => page!.switchFlow.getSwitchFlow().kind === 'idle', 'the move to end');
    await turns();
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
    expect(localStorage.getItem(DRIVE_CONFIG)).not.toBeNull(); // not disconnected
    expect(status()).toBe(panelText('google-drive'));
    expect(document.querySelector('.hr-sync-error')).toBeNull(); // no new words
  });

  it.each(['google-drive', 'dropbox'] as const)('%s: a picker move is refused, and the record stays in the cloud', async (cloud) => {
    await revokeCleanSession(cloud);
    connectGitHub();
    await until(() => !!document.querySelector('dialog .hr-sync-error'), 'the refused move');
    expect(reload).not.toHaveBeenCalled();
    expect(githubFile).toBeNull();
    expect(localStorage.getItem(BACKEND_KEY)).toBe(cloud);
    expect(cloudWeights(cloud)).toMatchObject({ [SEEDED.day]: SEEDED.value });
  });

  it('google-drive: the reconnect\'s lift keeps the Drive record', async () => {
    await revokeCleanSession('google-drive');
    fireEvent.click(button('Reconnect Google Drive')!);
    revoked.drive = false;
    await act(async () => { gisAnswer!({ access_token: GOOD_TOKEN, expires_in: 3600, scope: DRIVE_SCOPE }); });
    await until(() => reload.mock.calls.length > 0, 'the reload');
    expect(driveWeights()).toMatchObject({ [SEEDED.day]: SEEDED.value });
  });

  it('dropbox: the reconnect\'s return keeps the Dropbox record', async () => {
    await revokeCleanSession('dropbox');
    fireEvent.click(button('Reconnect Dropbox')!);
    await until(() => assign.mock.calls.length > 0, 'the Dropbox redirect');
    const { state } = JSON.parse(sessionStorage.getItem('health_roadmap_dropbox_pkce') ?? '{}') as { state?: string };
    window.location.search = `?code=test-code&state=${state}`;
    revoked.dropbox = false;
    const { resolveBackend } = await import('./resolve-backend');
    expect((await resolveBackend()).resolved.backend).toBe('dropbox');
    expect(weightsIn(dropboxFile?.body)).toMatchObject({ [SEEDED.day]: SEEDED.value });
  });
});

describe('US-09 AC48 (lead A3, Codex R3, owner order 2): a Dropbox sign-in from before the config key', () => {
  it('meets invalid_grant; the next load shows the signed-out panel, not the guest pitch, and keeps the choice', async () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: 0 }));
    revoked.dropbox = true;
    expect((await loadPage()).backend).toBe('local'); // the load's refresh meets invalid_grant, which forgets the tokens
    expect(localStorage.getItem(DROPBOX_TOKENS)).toBeNull();
    const p = await loadPage();
    render(<p.sync.SyncControl backend={p.backend} hasData />);
    expect(status()).toBe('Dropbox is signed out');
    expect(localStorage.getItem(BACKEND_KEY)).toBe('dropbox');
  });
});

describe('US-09 AC48 (lead A3, owner order 1): the guest\'s own GitHub connect saves the session before its lift', () => {
  it('an edit still on the debounce reaches the new GitHub record', async () => {
    const p = await loadPage();
    expect(p.backend).toBe('local');
    render(<p.sync.SyncControl backend={p.backend} hasData />);
    await bothEdits();
    connectGitHub();
    await until(() => reload.mock.calls.length > 0, 'the reload');
    expect(weightsIn(githubFile?.body)).toMatchObject(BOTH);
  });
});
