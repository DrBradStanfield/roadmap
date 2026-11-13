/**
 * US-09 AC45: a cloud sign-in that began before a log-off on this device, in
 * any tab, does not complete. One tab starts a Dropbox or Google Drive sign-in
 * and leaves for the provider; another tab logs off; the first tab comes back
 * as a fresh page and opens as a guest, with nothing saved. A log-off and an
 * erase both keep the log-off id, and the id names no account.
 *
 * Real pkce, adapters, connect.ts, boot() and resolveBackend(); fakes only at
 * fetch, Sentry and reload. Each module graph stands in for one page, sharing
 * one window, localStorage and sessionStorage. Synthetic tokens; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), Sentry: { captureException: capture } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const BACKEND_KEY = 'health_roadmap_backend';
const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
const EMAIL = 'person@example.test';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const PROVIDER = {
  dropbox: { pkce: 'health_roadmap_dropbox_pkce', saved: ['health_roadmap_dropbox_tokens'], exchange: 'https://api.dropboxapi.com/oauth2/token' },
  'google-drive': { pkce: 'health_roadmap_gdrive_pkce', saved: ['health_roadmap_gdrive_tokens', 'health_roadmap_gdrive'], exchange: '/api/google-token' },
} as const;
type Cloud = keyof typeof PROVIDER;

function makeStorage(onChange: (key: string) => void): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const changed = values.get(key) !== String(value);
      values.set(key, String(value));
      if (changed) onChange(key);
    },
    removeItem: (key: string) => {
      if (values.delete(key)) onChange(key);
    },
    clear: () => values.clear(),
  } as unknown as Storage;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const idToken = () => `h.${btoa(JSON.stringify({ email: EMAIL, email_verified: true })).replace(/=+$/, '')}.s`;

let calls: string[];
async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  calls.push(url);
  if (url === PROVIDER.dropbox.exchange) return json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 14400 });
  if (url.endsWith(PROVIDER['google-drive'].exchange)) return json({ accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 3600, idToken: idToken() });
  return json({ error_summary: 'path/not_found/..' }, 409);
}

let session: Map<string, string>;
/** The tab that logs off. */
let other: typeof import('./connect');

beforeEach(async () => {
  vi.resetModules();
  const page = Object.assign(new EventTarget(), {
    location: { search: '', origin: 'https://example.test', pathname: '/roadmap/', hash: '' },
    history: { state: null, replaceState: vi.fn() },
  });
  vi.stubGlobal('window', page);
  vi.stubGlobal('location', Object.assign(page.location, { reload: vi.fn(), assign: vi.fn() }));
  vi.stubGlobal('history', page.history);
  vi.stubGlobal('localStorage', makeStorage((key) => {
    window.dispatchEvent(Object.assign(new Event('storage'), { key }));
  }));
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
  capture.mockClear();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  other = await import('./connect');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A tab presses connect and leaves for the provider. */
async function startSignIn(cloud: Cloud): Promise<void> {
  vi.resetModules();
  const { adapterFor } = await import('./connect');
  void adapterFor(cloud)!.connect();
  await vi.waitFor(() => expect(location.assign).toHaveBeenCalled());
}

/** The same tab back from the provider: a fresh page on the redirect URL. */
async function returningTab(cloud: Cloud) {
  const { state } = JSON.parse(session.get(PROVIDER[cloud].pkce) ?? '{}') as { state?: string };
  const scope = cloud === 'google-drive' ? `&scope=${encodeURIComponent(DRIVE_SCOPE)}` : '';
  location.search = `?code=c&state=${state}${scope}`;
  vi.resetModules();
  const { boot } = await import('./boot');
  const { resolveBackend } = await import('./resolve-backend');
  return boot(resolveBackend, async () => undefined);
}

const saved = (cloud: Cloud) => [...PROVIDER[cloud].saved, BACKEND_KEY].map((key) => localStorage.getItem(key));

describe.each(['dropbox', 'google-drive'] as const)('US-09 AC45: a %s sign-in across a log-off in another tab', (cloud) => {
  it('a return whose sign-in began before the log-off saves nothing and opens as a guest', async () => {
    await startSignIn(cloud);
    await other.logOff('local');

    const booted = await returningTab(cloud);
    expect(booted.backend).toBe('local');
    expect((await import('../src/storage/sign-in-state')).currentSignIn()).toEqual({ kind: 'none' }); // a guest (US-09 AC48)
    expect(booted.refused).toBeUndefined();
    expect(saved(cloud)).toEqual(saved(cloud).map(() => null));
    expect(calls.some((url) => url.endsWith(PROVIDER[cloud].exchange))).toBe(false);
    expect(session.get(PROVIDER[cloud].pkce)).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });

  it('control: a return with no log-off in between signs in', async () => {
    await other.logOff('local'); // an earlier log-off, before the sign-in began
    await startSignIn(cloud);

    const booted = await returningTab(cloud);
    expect(booted.backend).toBe(cloud);
    expect(JSON.parse(localStorage.getItem(PROVIDER[cloud].saved[0]) ?? 'null')).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
    expect(localStorage.getItem(BACKEND_KEY)).toBe(cloud);
    if (cloud === 'google-drive') expect(localStorage.getItem('health_roadmap_gdrive')).toContain(EMAIL);
  });
});

describe('US-09 AC45: the log-off id', () => {
  it('survives an erase and a log-off', async () => {
    await other.logOff('local');
    const id = localStorage.getItem(LOG_OFF_ID_KEY);
    expect(id).not.toBeNull();

    vi.resetModules();
    const { RoadmapStore } = await import('../src/storage/roadmap-store');
    const { LocalStorageAdapter } = await import('../src/storage/local-storage-adapter');
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    store.addMeasurement('weight', 80, '2026-01-01');
    await store.flush();
    expect((await store.deleteAllData()).success).toBe(true);
    expect(localStorage.getItem('health_roadmap_local_erase_generation')).not.toBeNull(); // the erase ran its device wipe
    expect(localStorage.getItem(LOG_OFF_ID_KEY)).toBe(id);

    await other.logOff('local');
    const next = localStorage.getItem(LOG_OFF_ID_KEY);
    expect(next).not.toBeNull();
    expect(next).not.toBe(id);
  });

  it('holds no account or token, only a random id, after a sign-in and a log-off', async () => {
    await startSignIn('google-drive');
    await returningTab('google-drive');
    expect(localStorage.getItem('health_roadmap_gdrive')).toContain(EMAIL);

    await other.logOff('google-drive');
    const id = localStorage.getItem(LOG_OFF_ID_KEY) ?? '';
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id).not.toContain(EMAIL);
    expect(id).not.toContain('at-new');
    expect(id).not.toContain('rt-new');
  });
});
