/**
 * US-09 AC45: a cloud sign-in is kept only while the log-off id it began
 * under is still this device's current one. A tab still holding an older
 * sign-in saves nothing over a newer one, whether or not it heard the
 * log-off; a cloud copy is filled from this device only after its sign-in is
 * saved; entries saved before the device's first log-off still sign in, and a
 * page load removes those saved under any other id.
 *
 * Each tab is its own module graph. They share one window, one localStorage
 * and one sessionStorage; `storage` events reach the window only when a test
 * delivers them, as a browser delivers another tab's changes some time after
 * they land. Real adapters, connect.ts, boot() and resolveBackend(); fakes only
 * at fetch, Sentry, product events and reload. Synthetic tokens; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const BACKEND_KEY = 'health_roadmap_backend';
const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
const LOG_OFF_SIGNAL = 'health_roadmap_log_off_signal';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DRIVE_PKCE = 'health_roadmap_gdrive_pkce';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const DROPBOX_PKCE = 'health_roadmap_dropbox_pkce';
const GITHUB_CONFIG = 'health_roadmap_github';
const SELFHOST_CONFIG = 'health_roadmap_selfhost';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const DROPBOX_EXCHANGE = 'https://api.dropboxapi.com/oauth2/token';
const DROPBOX_UPLOAD = 'https://content.dropboxapi.com/2/files/upload';
const EMAIL = 'person@example.test';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = `${b64({ alg: 'RS256' })}.${b64({ email: EMAIL, email_verified: true })}.sig`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

let session: Map<string, string>;
let calls: string[];
let holdExchange: Promise<void> | null;
/** Keys whose writes this localStorage drops, as a full one does. */
let dropped: Set<string>;
/** What a Drive code exchange hands back: the same account each time. */
let driveAccess: string;

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  calls.push(url);
  if (url === DROPBOX_EXCHANGE) {
    if (holdExchange) await holdExchange;
    return json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 14400 });
  }
  if (url.endsWith('/api/google-token')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as { grantType?: string };
    if (body.grantType === 'code') return json({ accessToken: driveAccess, refreshToken: 'rt-same', expiresIn: 3600, idToken });
    return json({ accessToken: 'at-refreshed', expiresIn: 3600, idToken });
  }
  if (url === DROPBOX_UPLOAD) return json({ rev: 'r1' });
  return json({ error_summary: 'path/not_found/..' }, 409);
}

beforeEach(() => {
  vi.resetModules();
  const page = Object.assign(new EventTarget(), {
    location: { search: '', origin: 'https://example.test', pathname: '/roadmap/', hash: '' },
    history: { state: null, replaceState: vi.fn() },
  });
  vi.stubGlobal('window', page);
  vi.stubGlobal('location', Object.assign(page.location, { reload: vi.fn(), assign: vi.fn() }));
  vi.stubGlobal('history', page.history);
  const values = new Map<string, string>();
  dropped = new Set();
  vi.stubGlobal('localStorage', {
    get length() { return values.size; },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (dropped.has(k)) throw new DOMException('quota', 'QuotaExceededError');
      values.set(k, String(v));
    },
    removeItem: (k: string) => void values.delete(k),
    clear: () => values.clear(),
  });
  session = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  });
  const document = new EventTarget();
  Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
  vi.stubGlobal('document', document);
  calls = [];
  holdExchange = null;
  driveAccess = 'at-first';
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Deliver another tab's log-off to this window, as the browser does. */
const hearLogOff = () => window.dispatchEvent(Object.assign(new Event('storage'), { key: LOG_OFF_SIGNAL }));

/** Another tab logs off: its own module graph. */
async function logOffElsewhere(backend: 'local' | 'google-drive' | 'dropbox' = 'local') {
  vi.resetModules();
  await (await import('./connect')).logOff(backend);
}

/** A tab presses connect for `cloud` and leaves for the provider. */
async function startSignIn(cloud: 'dropbox' | 'google-drive') {
  vi.resetModules();
  const { adapterFor } = await import('./connect');
  void adapterFor(cloud)!.connect();
  await vi.waitFor(() => expect(session.get(cloud === 'dropbox' ? DROPBOX_PKCE : DRIVE_PKCE)).toBeDefined());
}

/** The same tab back from the provider: a fresh page on the redirect URL. */
async function returningPage(cloud: 'dropbox' | 'google-drive') {
  const { state } = JSON.parse(session.get(cloud === 'dropbox' ? DROPBOX_PKCE : DRIVE_PKCE) ?? '{}') as { state?: string };
  location.search = `?code=c&state=${state}${cloud === 'google-drive' ? `&scope=${encodeURIComponent(DRIVE_SCOPE)}` : ''}`;
  vi.resetModules();
  const page = {
    boot: (await import('./boot')).boot,
    resolveBackend: (await import('./resolve-backend')).resolveBackend,
    local: await import('../src/storage/local-storage-adapter'),
  };
  return page;
}

/** A full Drive sign-in in one tab; returns that tab's live adapter. */
async function driveSignIn() {
  await startSignIn('google-drive');
  const page = await returningPage('google-drive');
  const { resolved } = await page.resolveBackend();
  expect(resolved.backend).toBe('google-drive');
  page.local.noteOtherTabsLogOffWhileLoading();
  page.local.latchOnOtherTabsLogOff(); // a loaded cloud page listens for other tabs' log-offs
  return resolved.adapter as unknown as { tryServerRefresh(): Promise<boolean>; rememberFileId(name: string, id: string): void };
}

const driveKeys = () => [BACKEND_KEY, DRIVE_CONFIG, DRIVE_TOKENS].map((key) => localStorage.getItem(key));

describe('US-09 AC45: a tab still holding an older sign-in leaves a newer one alone', () => {
  it.each([
    ['hears the log-off late', true],
    ['never hears the log-off', false],
  ])('tab A %s, then refreshes its token: tab B\'s sign-in to the same account is unchanged', async (_name, hears) => {
    const a = await driveSignIn();
    await logOffElsewhere('google-drive');
    driveAccess = 'at-second';
    await driveSignIn(); // tab B signs in to the same account again
    const signedIn = driveKeys();
    expect(signedIn.every((value) => value !== null)).toBe(true);

    if (hears) hearLogOff();
    await a.tryServerRefresh();

    expect(driveKeys()).toEqual(signedIn);
  });

  it('a file id tab A caches afterwards is not saved', async () => {
    const a = await driveSignIn();
    await logOffElsewhere('google-drive');
    await driveSignIn();
    const signedIn = driveKeys();

    a.rememberFileId('health-roadmap.json', 'file-a');

    expect(driveKeys()).toEqual(signedIn);
  });
});

describe('US-09 AC45: a cloud copy is filled from this device only after its sign-in is saved', () => {
  it('a log-off in another tab during the code exchange: no tokens, no lift, the page opens on the device', async () => {
    await startSignIn('dropbox');
    const exchange = deferred();
    holdExchange = exchange.promise;
    const page = await returningPage('dropbox');
    const booted = page.boot(page.resolveBackend, async () => undefined);
    await vi.waitFor(() => expect(calls).toContain(DROPBOX_EXCHANGE));

    await logOffElsewhere();
    // The next person's guest data, on the device the log-off wiped.
    vi.resetModules();
    const { RoadmapStore } = await import('../src/storage/roadmap-store');
    const { LocalStorageAdapter } = await import('../src/storage/local-storage-adapter');
    const guest = await RoadmapStore.create(new LocalStorageAdapter());
    guest.addMeasurement('weight', 80, '2026-01-01');
    await guest.flush();

    exchange.resolve();
    const { backend } = await booted;
    expect(backend).toBe('local');
    expect([localStorage.getItem(DROPBOX_TOKENS), localStorage.getItem(BACKEND_KEY)]).toEqual([null, null]);
    expect(calls).not.toContain(DROPBOX_UPLOAD);
  });

  it('control: with no log-off, the return saves its sign-in and lifts the device copy', async () => {
    vi.resetModules();
    const { RoadmapStore } = await import('../src/storage/roadmap-store');
    const { LocalStorageAdapter } = await import('../src/storage/local-storage-adapter');
    const guest = await RoadmapStore.create(new LocalStorageAdapter());
    guest.addMeasurement('weight', 80, '2026-01-01');
    await guest.flush();
    await startSignIn('dropbox');

    const page = await returningPage('dropbox');
    const { backend } = await page.boot(page.resolveBackend, async () => undefined);
    expect(backend).toBe('dropbox');
    expect(localStorage.getItem(BACKEND_KEY)).toBe('dropbox');
    expect(calls).toContain(DROPBOX_UPLOAD);
  });
});

describe('US-09 AC45: entries saved before this device\'s first log-off', () => {
  const later = () => Date.now() + 3_600_000;
  it.each([
    ['google-drive', { [DRIVE_TOKENS]: { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: later() }, [DRIVE_CONFIG]: { accountEmail: EMAIL } }],
    ['dropbox', { [DROPBOX_TOKENS]: { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: later() } }],
    ['github', { [GITHUB_CONFIG]: { token: 'test-token-good', owner: 'someone', repo: 'health' } }],
    ['self-host', { [SELFHOST_CONFIG]: { url: 'https://dav.example.test/health/', username: 'someone', password: 'test-pass-good' } }],
  ] as const)('%s still opens signed in', async (backend, entries) => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, JSON.stringify(value));
    localStorage.setItem(BACKEND_KEY, backend);
    const { resolveRemembered } = await import('./connect');
    const resolved = await resolveRemembered();
    expect([resolved.backend, resolved.reconnect]).toEqual([backend, undefined]);
  });
});

describe('US-09 AC45: a page load removes sign-ins saved under another log-off id', () => {
  it('the stale ones go; the current one is left byte for byte', async () => {
    localStorage.setItem(LOG_OFF_ID_KEY, 'id-now');
    const current = JSON.stringify({ accessToken: 'at-now', refreshToken: 'rt-now', expiresAt: Date.now() + 3_600_000, gen: 'id-now' });
    localStorage.setItem(DROPBOX_TOKENS, current);
    localStorage.setItem(DRIVE_TOKENS, JSON.stringify({ accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: 0, gen: 'id-before' }));
    localStorage.setItem(DRIVE_CONFIG, JSON.stringify({ accountEmail: EMAIL, gen: 'id-before' }));
    localStorage.setItem(GITHUB_CONFIG, JSON.stringify({ token: 'test-token-good', owner: 'someone', repo: 'health' })); // no id: before the first log-off
    localStorage.setItem(BACKEND_KEY, 'dropbox');

    const { resolveRemembered } = await import('./connect');
    expect((await resolveRemembered()).backend).toBe('dropbox');
    expect([DRIVE_TOKENS, DRIVE_CONFIG, GITHUB_CONFIG].map((key) => localStorage.getItem(key))).toEqual([null, null, null]);
    expect(localStorage.getItem(DROPBOX_TOKENS)).toBe(current);
  });
});

describe('US-09 AC45: once a log-off has begun on this page', () => {
  it('nothing it does saves a sign-in or the chosen provider, even when the new log-off id could not be written', async () => {
    dropped.add(LOG_OFF_ID_KEY);
    await startSignIn('dropbox');
    const page = await returningPage('dropbox');
    const github = await import('../src/storage/github');
    (await import('../src/storage/web-record-host')).beginRoadmapLogOff(); // log-off's first step
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith('https://api.github.com/')
      ? json({ private: true })
      : fakeFetch(input, init))));

    await new github.GitHubAdapter({ token: 'test-token-good', owner: 'someone', repo: 'health' }).connect();
    const { resolved } = await page.resolveBackend();

    expect(resolved.backend).toBe('local');
    expect([GITHUB_CONFIG, DROPBOX_TOKENS, BACKEND_KEY].map((key) => localStorage.getItem(key))).toEqual([null, null, null]);
  });
});
