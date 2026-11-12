/**
 * US-09 AC45: a sign-in begun before the latest log-off this page heard, in
 * any tab, is not kept, and a later sign-in in another tab is left alone.
 * Once a log-off has begun on this page, nothing it does saves a sign-in.
 *
 * Each tab is its own module graph. They share one window and one
 * localStorage; `storage` events reach the window only when a test delivers
 * them, as a browser delivers another tab's changes some time after they land.
 * Synthetic tokens; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const BACKEND_KEY = 'health_roadmap_backend';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DRIVE_PKCE = 'health_roadmap_gdrive_pkce';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const DROPBOX_PKCE = 'health_roadmap_dropbox_pkce';
const GITHUB_CONFIG = 'health_roadmap_github';
const LOG_OFF_SIGNAL = 'health_roadmap_log_off_signal';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE = {
  clientId: 'test-client-id',
  scope: `openid email ${DRIVE_SCOPE}`,
  redirectUri: 'https://example.test/roadmap/',
  exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
};
const DROPBOX = { clientId: 'test-app-key', redirectUri: 'https://example.test/roadmap/' };
const LIVE = { accessToken: 'at-live', refreshToken: 'rt-live', expiresAt: 0 };

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = `${b64({ alg: 'RS256' })}.${b64({ email: 'a@example.com', email_verified: true })}.sig`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let session: Map<string, string>;
/** Deliver another tab's log-off to this window, as the browser does. */
const hearLogOff = () => window.dispatchEvent(Object.assign(new Event('storage'), { key: LOG_OFF_SIGNAL }));
const read = (key: string) => JSON.parse(localStorage.getItem(key) ?? 'null');

beforeEach(() => {
  vi.resetModules();
  const page = Object.assign(new EventTarget(), {
    location: { search: `?code=c&state=s&scope=${encodeURIComponent(DRIVE_SCOPE)}`, origin: 'https://example.test', pathname: '/roadmap/', hash: '' },
    history: { state: null, replaceState: vi.fn() },
  });
  vi.stubGlobal('window', page);
  vi.stubGlobal('location', Object.assign(page.location, { reload: vi.fn() }));
  vi.stubGlobal('history', page.history);
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() { return values.size; },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, String(v)),
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A tab: a fresh module graph. A loaded cloud page listens for other tabs' log-offs. */
async function tab(loadedCloudPage = true) {
  vi.resetModules();
  const t = {
    drive: await import('../src/storage/drive'),
    dropbox: await import('../src/storage/dropbox'),
    github: await import('../src/storage/github'),
    local: await import('../src/storage/local-storage-adapter'),
    connect: await import('./connect'),
    lib: await import('../src/lib/storage'),
  };
  if (loadedCloudPage) {
    t.local.noteOtherTabsLogOffWhileLoading();
    t.local.latchOnOtherTabsLogOff();
  }
  return t;
}

/** A Google Drive OAuth return in tab `t`, as resolve-backend.ts runs it. */
async function driveReturn(t: Awaited<ReturnType<typeof tab>>, accessToken: string) {
  session.set(DRIVE_PKCE, JSON.stringify({ verifier: 'v', state: 's' }));
  vi.stubGlobal('fetch', vi.fn(async () => json({ accessToken, refreshToken: `rt-${accessToken}`, expiresIn: 3600, idToken })));
  const startedAt = t.lib.signInStamp();
  const adapter = await t.drive.GoogleDriveAdapter.completeRedirect(DRIVE, startedAt);
  t.connect.rememberBackend('google-drive', startedAt);
  return adapter!;
}

describe('US-09 AC45: a later sign-in in another tab is left alone', () => {
  it('tab B logs off and signs in to Drive again; tab A, still open, keeps writing with its old sign-in', async () => {
    const a = await tab();
    const aDrive = await driveReturn(a, 'at-a');
    expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');

    const b = await tab();
    await b.connect.logOff('google-drive');
    hearLogOff(); // tab A hears it
    const b2 = await tab(); // tab B after its reload
    await driveReturn(b2, 'at-b');
    const signedIn = { backend: localStorage.getItem(BACKEND_KEY), config: localStorage.getItem(DRIVE_CONFIG), tokens: localStorage.getItem(DRIVE_TOKENS) };

    // Tab A's adapter still holds its token in memory and updates its file-id cache.
    (aDrive as unknown as { rememberFileId: (name: string, id: string) => void }).rememberFileId('health-roadmap.json', 'file-a');

    expect({ backend: localStorage.getItem(BACKEND_KEY), config: localStorage.getItem(DRIVE_CONFIG), tokens: localStorage.getItem(DRIVE_TOKENS) })
      .toEqual(signedIn);
    const next = await tab(false); // the next load
    expect((await next.connect.resolveRemembered()).backend).toBe('google-drive');
  });
});

describe('US-09 AC45: a loaded cloud page that hears another tab log off', () => {
  it('saves nothing from its live Drive and Dropbox adapters afterwards', async () => {
    localStorage.setItem(DRIVE_TOKENS, JSON.stringify(LIVE));
    localStorage.setItem(DRIVE_CONFIG, JSON.stringify({ accountEmail: 'a@example.com' }));
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify(LIVE));
    const a = await tab();
    const drive = new a.drive.GoogleDriveAdapter(DRIVE);
    const dropbox = new a.dropbox.DropboxAdapter(DROPBOX);
    hearLogOff();

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('oauth2/token')) return json({ access_token: 'at-new', expires_in: 14400 });
      if (url.includes('google-token')) return json({ accessToken: 'at-new', expiresIn: 3600, idToken });
      return json({ email: 'a@example.com', email_verified: true });
    }));
    await drive.tryServerRefresh();
    await dropbox.accountEmail();
    (drive as unknown as { rememberFileId: (name: string, id: string) => void }).rememberFileId('health-roadmap.json', 'file-a');
    expect([read(DRIVE_TOKENS).accessToken, read(DROPBOX_TOKENS).accessToken, read(DRIVE_CONFIG)])
      .toEqual(['at-live', 'at-live', { accountEmail: 'a@example.com' }]);
  });
});

describe('US-09 AC45: once a log-off has begun on this page', () => {
  it('a connect and an OAuth return it starts afterwards save nothing', async () => {
    const a = await tab();
    (await import('../src/storage/web-record-host')).beginRoadmapLogOff(); // log-off's first step
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('https://api.github.com/')
      ? json({ private: true })
      : json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 14400 }))));
    await new a.github.GitHubAdapter({ token: 'test-token-good', owner: 'someone', repo: 'health' }).connect();
    session.set(DROPBOX_PKCE, JSON.stringify({ verifier: 'v', state: 's' }));
    const { resolveBackend } = await import('./resolve-backend');
    const { resolved } = await resolveBackend();
    expect(resolved.backend).toBe('local');
    expect([localStorage.getItem(GITHUB_CONFIG), localStorage.getItem(DROPBOX_TOKENS), localStorage.getItem(BACKEND_KEY)])
      .toEqual([null, null, null]);
  });
});

describe('US-09 AC45: a write that lands before this page hears another tab log off', () => {
  it('is taken back when the log-off is heard', async () => {
    localStorage.setItem(DRIVE_TOKENS, JSON.stringify(LIVE));
    localStorage.setItem(DRIVE_CONFIG, JSON.stringify({ accountEmail: 'a@example.com' }));
    const a = await tab();
    const drive = new a.drive.GoogleDriveAdapter(DRIVE);
    // The other tab's log-off wipes the Drive sign-in; its event has not reached this page yet.
    localStorage.removeItem(DRIVE_TOKENS);
    localStorage.removeItem(DRIVE_CONFIG);
    (drive as unknown as { rememberFileId: (name: string, id: string) => void }).rememberFileId('health-roadmap.json', 'file-a');
    expect(read(DRIVE_CONFIG)).toMatchObject({ accountEmail: 'a@example.com' }); // it landed

    hearLogOff();
    expect(localStorage.getItem(DRIVE_CONFIG)).toBeNull();
  });
});
