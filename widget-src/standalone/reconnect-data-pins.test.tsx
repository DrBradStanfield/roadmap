// @vitest-environment jsdom
/**
 * US-09 AC48 (Q6 pins), lead A3 step 2: edits made in the reconnect state are
 * not lost by any of its exits. Test only: these pins gate the change that
 * will also enter that state mid-session.
 *
 * The reconnect state is reached as a real page load reaches it: the real
 * resolveRemembered + startOnBackend + initRoadmapStore run against a cloud
 * that cannot be read, so the session runs on this browser's copy. Then:
 *  (a) "Use this browser only" on the panel;
 *  (b) the picker's move to another home (GitHub, by its form);
 *  (c) the reconnect: Drive's GIS popup, Dropbox's Retry.
 * Each exit that leaves the page fires the browser's departure (beforeunload,
 * which registerPageDeparture hears, as app.tsx registers it), and the next
 * page load runs the same real boot path again. The pins read the RECORD each
 * exit ends in, never the UI text.
 *
 * Pin 1: an edit still on the 800 ms save debounce when the exit is taken.
 * Pin 2: an edit made while the reconnect panel shows.
 *
 * Real SyncControl, picker, switch-flow, connect.ts, data layer, record
 * session, web host, page departure and the Drive, Dropbox, GitHub and device
 * adapters. Fakes: fetch (clouds that keep what is written to them, as in
 * switch-retry.test.tsx and drive-first-save.test.ts), the GIS token client
 * (reconnect-move.test.tsx), Sentry, product events, location. Timers are
 * faked so a debounce runs only when a test advances it, and a page that has
 * left never saves again. Every credential is synthetic.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { Blob as NodeBlob } from 'node:buffer';
import { PERSIST_DEBOUNCE_MS } from '@roadmap/health-core/record-session';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', async (original) => ({
  ...(await original<typeof import('../src/lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('./reminders', () => ({ remindersSupported: () => false, clearAutoEnrolBlock: vi.fn() }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));

const BACKEND_KEY = 'health_roadmap_backend';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const GOOD_TOKEN = 'test-token-good';
const DRIVE_FOLDER = 'folder';

// ---------------------------------------------------------------- the clouds

/** Each cloud keeps what is written to it; a cloud that is `down` refuses every request. */
let dropboxFile: { body: string; rev: number } | null;
let githubFile: { body: string; sha: number } | null;
let driveFiles: Array<{ id: string; name: string; content: string; version: number }>;
let dropboxDown: boolean;
let driveDown: boolean;

const refuse = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));

async function driveFetch(url: URL, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  if (url.pathname === '/drive/v3/files' && method === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    if (q.includes('mimeType=')) return Response.json({ files: [{ id: DRIVE_FOLDER, name: 'Health Plan by Dr Brad' }] });
    const name = /name='([^']+)'/.exec(q)?.[1];
    return Response.json({ files: driveFiles.filter((f) => f.name === name).map(({ id }) => ({ id, createdTime: '2026-06-01T00:00:00.000Z' })) });
  }
  if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
    const text = await new Response(init!.body as BodyInit).text();
    const parts = text.split(/--rm_boundary_health_roadmap-*\r?\n?/).filter((part) => part.trim());
    const meta = JSON.parse(parts[0].split('\r\n\r\n')[1]) as { name: string };
    const content = parts[1].split('\r\n\r\n')[1].replace(/\r\n$/, '');
    const file = { id: `file-${driveFiles.length + 1}`, name: meta.name, content, version: 1 };
    driveFiles.push(file);
    return Response.json({ id: file.id, version: '1' });
  }
  if (url.pathname.startsWith('/drive/v3/changes')) return new Promise<Response>(() => undefined); // the live re-read: never answered
  const id = /\/files\/([^/]+)$/.exec(url.pathname)?.[1];
  const file = driveFiles.find((entry) => entry.id === id);
  if (file && method === 'GET') {
    return url.searchParams.get('alt') === 'media'
      ? new Response(file.content)
      : Response.json({ id: file.id, name: file.name, version: String(file.version), createdTime: '2026-06-01T00:00:00.000Z', trashed: false });
  }
  if (!file && method === 'GET' && id) return new Response('not found', { status: 404 });
  if (file && method === 'PATCH' && url.pathname.startsWith('/upload/')) {
    file.content = String(init!.body);
    file.version += 1;
    return Response.json({ id: file.id, version: String(file.version) });
  }
  throw new Error(`unexpected Drive request ${method} ${url.pathname}`);
}

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://content.dropboxapi.com/')) {
    if (dropboxDown) return refuse();
    if (url === 'https://content.dropboxapi.com/2/files/download') {
      if (!dropboxFile) return Promise.resolve(new Response(JSON.stringify({ error_summary: 'path/not_found/..' }), { status: 409 }));
      return Promise.resolve(new Response(dropboxFile.body, {
        status: 200, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: `r${dropboxFile.rev}` }) },
      }));
    }
    if (url === 'https://content.dropboxapi.com/2/files/upload') {
      dropboxFile = { body: String(init?.body), rev: (dropboxFile?.rev ?? 0) + 1 };
      return Promise.resolve(new Response(JSON.stringify({ rev: `r${dropboxFile.rev}` }), { status: 200 }));
    }
  }
  // Dropbox's change signal: held open, never answered.
  if (url.startsWith('https://api.dropboxapi.com/') || url.startsWith('https://notify.dropboxapi.com/')) {
    return dropboxDown ? refuse() : new Promise<Response>(() => undefined);
  }
  if (url.startsWith('https://www.googleapis.com/drive/') || url.startsWith('https://www.googleapis.com/upload/drive/')) {
    return driveDown ? refuse() : driveFetch(new URL(url), init);
  }
  if (url.startsWith('https://api.github.com/repos/someone/health')) {
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    if (!auth.includes(GOOD_TOKEN)) return Promise.resolve(new Response('{"message":"Bad credentials"}', { status: 401 }));
    if (url === 'https://api.github.com/repos/someone/health') {
      return Promise.resolve(new Response(JSON.stringify({ private: true }), { status: 200 }));
    }
    if (url.startsWith(`https://api.github.com/repos/someone/health/contents/${ROADMAP_FILE_NAME}`)) {
      if (init?.method === 'PUT') {
        const { content } = JSON.parse(String(init.body)) as { content: string };
        githubFile = { body: new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0))), sha: (githubFile?.sha ?? 0) + 1 };
        return Promise.resolve(new Response(JSON.stringify({ content: { sha: `s${githubFile.sha}` } }), { status: 201 }));
      }
      if (!githubFile) return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }));
      const bytes = new TextEncoder().encode(githubFile.body);
      return Promise.resolve(new Response(JSON.stringify({
        content: btoa(String.fromCharCode(...bytes)), sha: `s${githubFile.sha}`, encoding: 'base64', size: bytes.length,
      }), { status: 200 }));
    }
    return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }));
  }
  // Everything else (Google's token exchange, userinfo) is unreachable: the Drive sign-in is dead.
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
  reconnect?: import('./connect').ResolvedBackend['reconnect'];
  leave: () => void;
}

let page: Page | null;
let reload: ReturnType<typeof vi.fn>;
let gisAnswer: ((r: object) => void) | null;

/** A page load: a fresh module graph through the real boot path (resolveRemembered,
 *  startOnBackend, initRoadmapStore), with app.tsx's departure save registered. */
async function loadPage(): Promise<Page> {
  page?.leave(); // the page before is gone: it hears no later departure
  cleanup();
  vi.resetModules();
  const connect = await import('./connect');
  const data = await import('../src/lib/roadmap-data');
  const { registerPageDeparture } = await import('./page-departure');
  const resolved = await connect.startOnBackend(await connect.resolveRemembered(), data.initRoadmapStore);
  (await import('../src/storage/sign-in-state')).bootSignIn(connect.signInAtBoot(resolved)); // as boot seeds it (US-09 AC48)
  const leave = registerPageDeparture(() => undefined);
  page = {
    data,
    sync: await import('./sync-control'),
    notice: await import('../src/lib/storage-notice'),
    switchFlow: await import('./switch-flow'),
    backend: resolved.backend,
    reconnect: resolved.reconnect,
    leave,
  };
  return page;
}

/** Real macrotask turns (fetch bodies, the departure), with the fake clock held still. */
/** Waits by the real clock, not a count of turns: off-main-thread work (crypto.subtle) can take
 *  more turns than any count on a busy CI runner. */
const UNTIL_MS = 10_000;
async function until(done: () => boolean, what: string): Promise<void> {
  for (const deadline = performance.now() + UNTIL_MS; performance.now() < deadline;) {
    if (done()) return;
    await act(async () => { await new Promise<void>((r) => setImmediate(r)); });
  }
  throw new Error(`timed out waiting for ${what}`);
}
const turns = async (n = 20) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise<void>((r) => setImmediate(r)); }); };
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** The weights a stored record holds, by day. */
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

/** Pin 2's edit: made while the panel shows, and saved to this browser by its debounce. */
const PANEL_EDIT = { day: '2026-06-01', value: 81 };
/** Pin 1's edit: made last, still on the save debounce when the exit is taken. */
const DEBOUNCED_EDIT = { day: '2026-06-02', value: 82 };

async function edit({ day, value }: { day: string; value: number }): Promise<void> {
  await act(async () => { expect((await page!.data.addMeasurement('weight', value, day)).status).toBe('inserted'); });
}

/** Pin 2: one edit while the reconnect panel shows, landed on this browser before the exit. */
async function panelEdit(): Promise<void> {
  await edit(PANEL_EDIT);
  await advance(PERSIST_DEBOUNCE_MS);
  expect(await deviceWeights()).toEqual({ [PANEL_EDIT.day]: PANEL_EDIT.value });
}
/** Pin 1: the panel edit, then one more still on the debounce as the exit is taken. */
async function panelEditThenDebounced(): Promise<void> {
  await panelEdit();
  await edit(DEBOUNCED_EDIT);
  await advance(PERSIST_DEBOUNCE_MS - 1);
  expect(await deviceWeights()).toEqual({ [PANEL_EDIT.day]: PANEL_EDIT.value }); // not yet saved anywhere
}
const BOTH = { [PANEL_EDIT.day]: PANEL_EDIT.value, [DEBOUNCED_EDIT.day]: DEBOUNCED_EDIT.value };
const PANEL_ONLY = { [PANEL_EDIT.day]: PANEL_EDIT.value };

/** The first load, on a cloud that cannot be read: the session runs on this browser (US-09 AC13). */
async function openReconnectPanel(cloud: Cloud): Promise<Page> {
  localStorage.setItem(BACKEND_KEY, cloud);
  if (cloud === 'dropbox') {
    dropboxDown = true;
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() + 3_600_000 }));
  } else {
    // A grant whose access token expired and whose refresh cannot be reached.
    localStorage.setItem(DRIVE_CONFIG, JSON.stringify({}));
    localStorage.setItem(DRIVE_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() - 1_000 }));
  }
  const p = await loadPage();
  expect(p.backend).toBe('local');
  expect(p.reconnect?.provider).toBe(cloud);
  render(<p.sync.SyncControl backend={p.backend} hasData />);
  expect(document.querySelector('.hr-sync-status')?.textContent).toMatch(cloud === 'dropbox' ? /could not be reached/ : /signed out/);
  return p;
}

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name);
const option = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button.hr-opt')].find((b) => b.textContent?.startsWith(name))!;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = vi.fn();
});

beforeEach(() => {
  page = null;
  localStorage.clear();
  dropboxFile = null;
  githubFile = null;
  driveFiles = [];
  dropboxDown = false;
  driveDown = false;
  gisAnswer = null;
  vi.stubGlobal('Blob', NodeBlob); // Node's fetch/Response need Node's Blob
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  Object.assign(window, { google: { accounts: { oauth2: { initTokenClient: (options: { callback: (r: object) => void }) => ({
    requestAccessToken: () => { gisAnswer = options.callback; },
  }) } } } });
  // A reload leaves the page as a browser does: its departure fires on a later turn.
  reload = vi.fn(() => { setImmediate(() => window.dispatchEvent(new Event('beforeunload'))); });
  Object.defineProperty(window, 'location', { value: { ...window.location, reload, assign: vi.fn() }, writable: true, configurable: true });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  page?.leave();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The page left by a reload, and its departure ran. */
async function reloaded(): Promise<void> {
  await until(() => reload.mock.calls.length > 0, 'the reload');
  await turns(); // the departure's turn
}

// ---------------------------------------------------------------- (a)

describe('US-09 AC48 (Q6 pins), lead A3: exit (a) "Use this browser only" keeps every edit on this device', () => {
  async function useThisBrowserOnly(cloud: Cloud): Promise<Record<string, number>> {
    fireEvent.click(button('Use this browser only')!);
    await reloaded();
    expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
    // The next load opens on this browser's copy: the record this exit ends in.
    const next = await loadPage();
    expect(next.backend).toBe('local');
    expect(next.reconnect).toBeUndefined();
    expect(localStorage.getItem(cloud === 'dropbox' ? DROPBOX_TOKENS : DRIVE_TOKENS)).toBeNull();
    return deviceWeights();
  }

  it.each(['google-drive', 'dropbox'] as const)('%s, pin 1: an edit still on the save debounce is in the device file', async (cloud) => {
    await openReconnectPanel(cloud);
    await panelEditThenDebounced();
    expect(await useThisBrowserOnly(cloud)).toEqual(BOTH);
  });

  it.each(['google-drive', 'dropbox'] as const)('%s, pin 2: an edit made while the panel shows is in the device file', async (cloud) => {
    await openReconnectPanel(cloud);
    await panelEdit();
    expect(await useThisBrowserOnly(cloud)).toEqual(PANEL_ONLY);
  });
});

describe('US-09 AC48 (Codex re-check R1, owner): exit (a) from a load-time fallback needs its save to land', () => {
  const pageWeights = () => Object.fromEntries(page!.data.loadAllHistorySync()
    .filter((m) => m.metricType === 'weight').map((m) => [m.recordedAt.slice(0, 10), m.value]));

  it('google-drive: an edit this browser refuses to store stops "Use this browser only"; the edit stays in the page', async () => {
    await openReconnectPanel('google-drive');
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'health_roadmap_file_v2') throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    await edit(PANEL_EDIT);
    fireEvent.click(button('Use this browser only')!);
    await until(() => reload.mock.calls.length > 0 || page!.switchFlow.getSwitchFlow().kind === 'idle', 'the move to end');
    await turns();
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
    expect(localStorage.getItem(DRIVE_CONFIG)).not.toBeNull(); // not disconnected
    expect(pageWeights()).toMatchObject({ [PANEL_EDIT.day]: PANEL_EDIT.value });
    expect(document.querySelector('.hr-sync-error')?.textContent).toBe('Could not save on this device (local storage may be full).');
  });

  it('google-drive: after another tab logs off, the refused save is nothing to copy and the exit finishes', async () => {
    await openReconnectPanel('google-drive');
    await edit(PANEL_EDIT);
    localStorage.setItem('health_roadmap_log_off_id', 'id-after');
    window.dispatchEvent(new StorageEvent('storage', { key: 'health_roadmap_log_off_signal' }));
    const { healthWritesAllowed } = await import('../src/lib/storage');
    expect(healthWritesAllowed()).toBe(false);
    fireEvent.click(button('Use this browser only')!);
    await reloaded();
    expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
    expect(await deviceWeights()).toEqual({}); // nothing written after the log-off
  });
});

// ---------------------------------------------------------------- (b)

describe('US-09 AC48 (Q6 pins), lead A3: exit (b) the picker\'s move to another home keeps every edit', () => {
  async function chooseGitHub(): Promise<void> {
    act(() => page!.notice.openBackendPicker());
    fireEvent.click(option('GitHub'));
    fireEvent.change(document.querySelector('input[placeholder^="Fine-grained token"]')!, { target: { value: GOOD_TOKEN } });
    fireEvent.change(document.querySelector('input[placeholder^="Owner"]')!, { target: { value: 'someone' } });
    fireEvent.change(document.querySelector('input[placeholder^="Repository name"]')!, { target: { value: 'health' } });
    fireEvent.click(button('Connect GitHub')!);
  }

  /** Dropbox answers again by the time the user moves: the copy-down runs, then
   *  GitHub's connect lifts this browser's copy up and reloads. The record this
   *  exit ends in is GitHub's file once the next load has opened on it and saved. */
  async function moveDropboxToGitHub(): Promise<Record<string, number>> {
    dropboxDown = false;
    await chooseGitHub();
    await reloaded();
    expect(localStorage.getItem(BACKEND_KEY)).toBe('github');
    const next = await loadPage();
    expect(next.backend).toBe('github');
    await act(async () => { await next.data.flushRoadmapStore(); });
    return weightsIn(githubFile?.body);
  }

  it('dropbox, pin 1: an edit still on the save debounce is in the new home\'s file', async () => {
    await openReconnectPanel('dropbox');
    await panelEditThenDebounced();
    expect(await moveDropboxToGitHub()).toEqual(BOTH);
  });

  it('dropbox, pin 2: an edit made while the panel shows is in the new home\'s file', async () => {
    await openReconnectPanel('dropbox');
    await panelEdit();
    expect(await moveDropboxToGitHub()).toEqual(PANEL_ONLY);
  });

  /** A Drive whose sign-in died cannot be read, so today the move stops at its
   *  copy-down (US-09 AC13) and no new home is written: the record stays this
   *  browser's copy, which must still hold every edit. */
  async function moveDriveToGitHub(): Promise<Record<string, number>> {
    await chooseGitHub();
    await until(() => !!document.querySelector('dialog .hr-sync-error'), 'the refused move');
    expect(document.querySelector('dialog .hr-sync-error')?.textContent).toMatch(/Google Drive could not be reached/);
    expect(page!.switchFlow.getSwitchFlow().kind).toBe('idle');
    expect(reload).not.toHaveBeenCalled();
    expect(githubFile).toBeNull();
    expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
    await advance(PERSIST_DEBOUNCE_MS); // the page stays: its debounce runs
    return deviceWeights();
  }

  it('google-drive, pin 1: the refused move keeps an edit still on the save debounce in the device file', async () => {
    await openReconnectPanel('google-drive');
    await panelEditThenDebounced();
    expect(await moveDriveToGitHub()).toEqual(BOTH);
  });

  it('google-drive, pin 2: the refused move keeps an edit made while the panel shows in the device file', async () => {
    await openReconnectPanel('google-drive');
    await panelEdit();
    expect(await moveDriveToGitHub()).toEqual(PANEL_ONLY);
  });
});

// ---------------------------------------------------------------- (c)

describe('US-09 AC48 (Q6 pins), lead A3: exit (c) the reconnect puts every edit in the cloud file', () => {
  /** Drive: the GIS popup's grant is saved, this browser's copy is lifted up,
   *  the page reloads, and the next load opens on Drive and saves. */
  async function reconnectDrive(): Promise<Record<string, number>> {
    fireEvent.click(document.querySelector<HTMLButtonElement>('button.hr-sync-btn')!);
    expect(gisAnswer).not.toBeNull();
    await act(async () => { gisAnswer!({ access_token: GOOD_TOKEN, expires_in: 3600, scope: DRIVE_SCOPE }); });
    await reloaded();
    expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
    const next = await loadPage();
    expect(next.backend).toBe('google-drive');
    expect(next.reconnect).toBeUndefined();
    await act(async () => { await next.data.flushRoadmapStore(); });
    return driveWeights();
  }

  /** Dropbox: Retry reloads; Dropbox answers again, and the next load opens on
   *  it and merges this browser's copy up (the marker the fallback set). */
  async function retryDropbox(): Promise<Record<string, number>> {
    fireEvent.click(button('Retry')!);
    await reloaded();
    dropboxDown = false;
    const next = await loadPage();
    expect(next.backend).toBe('dropbox');
    expect(next.reconnect).toBeUndefined();
    await act(async () => { await next.data.flushRoadmapStore(); });
    return weightsIn(dropboxFile?.body);
  }

  it('google-drive, pin 1: an edit still on the save debounce is in the Drive file', async () => {
    await openReconnectPanel('google-drive');
    await panelEditThenDebounced();
    expect(await reconnectDrive()).toEqual(BOTH);
  });

  it('google-drive, pin 2: an edit made while the panel shows is in the Drive file', async () => {
    await openReconnectPanel('google-drive');
    await panelEdit();
    expect(await reconnectDrive()).toEqual(PANEL_ONLY);
  });

  it('dropbox, pin 1: an edit still on the save debounce is in the Dropbox file', async () => {
    await openReconnectPanel('dropbox');
    await panelEditThenDebounced();
    expect(await retryDropbox()).toEqual(BOTH);
  });

  it('dropbox, pin 2: an edit made while the panel shows is in the Dropbox file', async () => {
    await openReconnectPanel('dropbox');
    await panelEdit();
    expect(await retryDropbox()).toEqual(PANEL_ONLY);
  });
});

// ---------------------------------------------------------------- (a) with nothing to copy

describe('US-09 AC49 (lead A28, owner ruling): exit (a) at load time when this browser holds no copy asks first', () => {
  const SAVED = { '2026-05-01': 80, '2026-05-02': 79 };
  const cloudWeights = (cloud: Cloud) => (cloud === 'dropbox' ? weightsIn(dropboxFile?.body) : driveWeights());

  /** A real healthy cloud session saves two weights and the page leaves; then
   *  this browser's copy is gone (health_roadmap_file_v2 absent). */
  async function seedFullySavedCloud(cloud: Cloud): Promise<void> {
    localStorage.setItem(BACKEND_KEY, cloud);
    if (cloud === 'dropbox') {
      localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({ accessToken: GOOD_TOKEN, refreshToken: 'test-refresh-good', expiresAt: Date.now() + 3_600_000 }));
    } else {
      localStorage.setItem(DRIVE_CONFIG, JSON.stringify({}));
      localStorage.setItem(DRIVE_TOKENS, JSON.stringify({ accessToken: GOOD_TOKEN, refreshToken: 'test-refresh-good', expiresAt: Date.now() + 3_600_000 }));
    }
    const healthy = await loadPage();
    expect(healthy.backend).toBe(cloud);
    for (const [day, value] of Object.entries(SAVED)) await edit({ day, value });
    await advance(PERSIST_DEBOUNCE_MS);
    await act(async () => { await healthy.data.flushRoadmapStore(); });
    window.dispatchEvent(new Event('beforeunload'));
    await turns();
    expect(cloudWeights(cloud)).toEqual(SAVED);
    localStorage.removeItem('health_roadmap_file_v2');
  }

  const LABEL = { 'google-drive': 'Google Drive', dropbox: 'Dropbox' } as const;
  const question = (cloud: Cloud) =>
    `This browser has no copy of your record yet. It stays safe in your ${LABEL[cloud as 'google-drive' | 'dropbox']}. Start empty in this browser?`;
  const shown = (text: string) => document.body.textContent?.includes(text) ?? false;

  /** A fully saved cloud, then a load whose sign-in is dead: the panel over an empty tool. */
  async function arriveSignedOut(cloud: Cloud, keepDeviceCopy = false): Promise<Page> {
    await seedFullySavedCloud(cloud);
    // An earlier visit's copy of the same record, as a failed save leaves one.
    const cloudBody = cloud === 'dropbox' ? dropboxFile!.body : driveFiles.find((f) => f.name === ROADMAP_FILE_NAME)!.content;
    if (keepDeviceCopy) localStorage.setItem('health_roadmap_file_v2', cloudBody);
    // The sign-in dies: Drive's token expired and its exchange is unreachable; Dropbox's content API refuses.
    if (cloud === 'dropbox') dropboxDown = true;
    else localStorage.setItem(DRIVE_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() - 1_000 }));
    const p = await loadPage();
    expect(p.backend).toBe('local');
    expect(p.reconnect?.provider).toBe(cloud);
    if (!keepDeviceCopy) expect(p.data.loadAllHistorySync()).toEqual([]); // the cloud was never read: the tool is empty
    render(<p.sync.SyncControl backend={p.backend} hasData={false} />);
    return p;
  }

  it.each(['google-drive', 'dropbox'] as const)('%s: "Use this browser only" asks first, naming the cloud; Cancel changes nothing', async (cloud) => {
    await arriveSignedOut(cloud);
    // Each provider's sign-in entries: tokens and the config key (US-09 AC48's 'health_roadmap_dropbox').
    const SIGN_IN = [DRIVE_CONFIG, DRIVE_TOKENS, 'health_roadmap_dropbox', DROPBOX_TOKENS];
    const signInBefore = SIGN_IN.map((key) => localStorage.getItem(key));
    expect(signInBefore[cloud === 'dropbox' ? 2 : 0]).not.toBeNull();
    fireEvent.click(button('Use this browser only')!);
    expect(shown(question(cloud))).toBe(true);
    await turns();
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(BACKEND_KEY)).toBe(cloud);
    fireEvent.click(button('Cancel')!);
    expect(shown(question(cloud))).toBe(false);
    expect(button('Use this browser only')).toBeDefined(); // back on the panel
    await turns();
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(BACKEND_KEY)).toBe(cloud);
    expect(SIGN_IN.map((key) => localStorage.getItem(key))).toEqual(signInBefore); // config keys and tokens kept
    expect(document.querySelector('.hr-sync-error')).toBeNull(); // no error line
  });

  it.each(['google-drive', 'dropbox'] as const)('%s: a browser that holds a copy is not asked', async (cloud) => {
    await arriveSignedOut(cloud, true);
    fireEvent.click(button('Use this browser only')!);
    expect(shown(question(cloud))).toBe(false);
    await reloaded();
    expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
    expect(await deviceWeights()).toEqual(SAVED); // the copy here is kept, as before
  });

  it.each(['google-drive', 'dropbox'] as const)(
    '%s: confirmed, the exit leaves this browser empty and forgets the cloud; the record is only in the cloud file',
    async (cloud) => {
      await arriveSignedOut(cloud);
      fireEvent.click(button('Use this browser only')!);
      expect(shown(question(cloud))).toBe(true);
      fireEvent.click(button('Use this browser only')!);
      await reloaded();
      expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
      expect(localStorage.getItem('health_roadmap_file_v2')).toBeNull(); // the exit wrote no device copy
      dropboxDown = false;
      const next = await loadPage();
      expect(next.backend).toBe('local');
      expect(next.reconnect).toBeUndefined();
      expect(localStorage.getItem(cloud === 'dropbox' ? DROPBOX_TOKENS : DRIVE_TOKENS)).toBeNull();
      expect(next.data.loadAllHistorySync()).toEqual([]);
      expect(await next.data.loadAllHistory()).toEqual([]);
      expect(await deviceWeights()).toEqual({});
      expect(cloudWeights(cloud)).toEqual(SAVED); // the record sits only in the cloud
    },
  );
});
