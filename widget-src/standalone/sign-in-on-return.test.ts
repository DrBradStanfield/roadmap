/**
 * US-09 AC45: once a log-off has begun, nothing saves a cloud sign-in or the
 * chosen provider. Here the sign-in is a Dropbox OAuth return, run by the real
 * boot() and resolveBackend(), in a tab that hears another tab's log-off while
 * it loads. A move's sign-in lands whole or not at all.
 *
 * Same harness as logout-latch-during-load.test.ts: a second module graph
 * stands in for the other tab, sharing one window and one localStorage whose
 * changes reach the window as `storage` events. Synthetic tokens; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const BACKEND_KEY = 'health_roadmap_backend';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const DROPBOX_PKCE = 'health_roadmap_dropbox_pkce';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

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
      const changed = values.delete(key);
      if (changed) onChange(key);
    },
    clear: () => values.clear(),
  } as unknown as Storage;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let holdExchange: Promise<void> | null;
let holdDownload: Promise<void> | null;
let calls: string[];

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  calls.push(url);
  if (url === 'https://api.dropboxapi.com/oauth2/token') {
    if (holdExchange) await holdExchange;
    return json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 14400 });
  }
  if (url === 'https://content.dropboxapi.com/2/files/download') {
    if (holdDownload) await holdDownload;
    return json({ error_summary: 'path/not_found/..' }, 409);
  }
  if (url === 'https://content.dropboxapi.com/2/files/upload') return json({ rev: 'r1' });
  return json({ error_summary: 'path/not_found/..' }, 409);
}

/** The tab that logs off. */
let other: typeof import('./connect');

beforeEach(async () => {
  vi.resetModules();
  const page = Object.assign(new EventTarget(), {
    location: { search: '?code=c&state=s', origin: 'https://example.test', pathname: '/roadmap/', hash: '' },
    history: { state: null, replaceState: vi.fn() },
  });
  vi.stubGlobal('window', page);
  vi.stubGlobal('location', Object.assign(page.location, { reload: vi.fn() }));
  vi.stubGlobal('history', page.history);
  vi.stubGlobal('localStorage', makeStorage((key) => {
    window.dispatchEvent(Object.assign(new Event('storage'), { key }));
  }));
  const session = new Map([[DROPBOX_PKCE, JSON.stringify({ verifier: 'v', state: 's' })]]);
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  });
  const document = new EventTarget();
  Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
  vi.stubGlobal('document', document);
  holdExchange = null;
  holdDownload = null;
  calls = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  other = await import('./connect');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** This tab: its own module graph, booting on the OAuth return. */
async function returningTab() {
  vi.resetModules();
  const { boot } = await import('./boot');
  const { resolveBackend } = await import('./resolve-backend');
  return boot(resolveBackend, async () => undefined);
}

/** A guest record on this device, so the connect's lift reads the cloud. */
async function guestRecord(): Promise<void> {
  vi.resetModules();
  const { RoadmapStore } = await import('../src/storage/roadmap-store');
  const { LocalStorageAdapter } = await import('../src/storage/local-storage-adapter');
  const guest = await RoadmapStore.create(new LocalStorageAdapter());
  guest.addMeasurement('weight', 80, '2026-01-01');
  await guest.flush();
}

const signIn = () => ({ tokens: localStorage.getItem(DROPBOX_TOKENS), remembered: localStorage.getItem(BACKEND_KEY) });

describe('US-09 AC45: a Dropbox return in a tab that hears another tab log off', () => {
  it('during its code exchange: nothing is saved', async () => {
    const exchange = deferred();
    holdExchange = exchange.promise;
    const booting = returningTab();
    await vi.waitFor(() => expect(calls).toContain('https://api.dropboxapi.com/oauth2/token'));

    await other.logOff('local');
    exchange.resolve();
    await booting;
    expect(signIn()).toEqual({ tokens: null, remembered: null });
  });

  it('after its tokens are saved, during the lift: the move is taken back whole', async () => {
    await guestRecord();
    const download = deferred();
    holdDownload = download.promise;
    const booting = returningTab();
    await vi.waitFor(() => expect(calls).toContain('https://content.dropboxapi.com/2/files/download'));
    expect(localStorage.getItem(DROPBOX_TOKENS)).not.toBeNull(); // the exchange has saved them

    await other.logOff('local');
    download.resolve();
    await booting;
    expect(signIn()).toEqual({ tokens: null, remembered: null });
  });

  it('control: with no log-off, the return saves the sign-in and remembers Dropbox', async () => {
    const booted = await returningTab();
    expect(booted.backend).toBe('dropbox');
    expect(JSON.parse(signIn().tokens ?? 'null')).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
    expect(signIn().remembered).toBe('dropbox');
  });
});
