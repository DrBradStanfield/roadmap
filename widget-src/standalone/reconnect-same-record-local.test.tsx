// @vitest-environment jsdom
/**
 * US-09 AC65 on a page that fell back to this browser: before the not-found
 * sentence shows, the device copy must read back. A real local session (the
 * real roadmap-data store on the real device adapter) whose stored bytes become
 * unreadable after it opened keeps those bytes and shows the device-storage
 * sentence instead. Fakes: the GIS token client, fetch (Drive answers 404 to
 * the record file lookup), the lift, product events and location.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

const lift = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../src/lib/server-api', async (importOriginal) => ({ ...(await importOriginal<object>()), trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false, clearAutoEnrolBlock: vi.fn() }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', async (importOriginal) => ({ ...(await importOriginal<typeof import('./connect')>()), liftLocalInto: lift }));

import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { createEmptyFile, createMeasurement } from '@roadmap/health-core/roadmap-file';
import { SyncControl } from './sync-control';
import { resetSwitchFlow } from './switch-flow';
import { bootSignIn, resetSignIn } from '../src/storage/sign-in-state';
import { FULL, LocalStorageAdapter } from '../src/storage/local-storage-adapter';
import { getBackendKind, initRoadmapStore } from '../src/lib/roadmap-data';

const BACKEND_KEY = 'health_roadmap_backend';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DEVICE_FILE = 'health_roadmap_file_v2';
const CACHED_ID = 'cached-record-id';
const NOW = '2026-11-25T00:00:00.000Z';
const CANNOT_OPEN = 'Google Drive did not connect: this sign-in cannot open the record saved in this browser. Nothing changed. To keep working, choose Use this browser only.';

let fetchCalls: string[];
let reload: ReturnType<typeof vi.fn>;
let gisAnswer: ((r: object) => void) | null;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = vi.fn();
});

beforeEach(async () => {
  resetSwitchFlow();
  localStorage.clear();
  lift.mockClear();
  fetchCalls = [];
  gisAnswer = null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.includes(`/drive/v3/files/${CACHED_ID}?fields=version`)) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
    throw new TypeError('Failed to fetch');
  }));
  Object.assign(window, { google: { accounts: { oauth2: { initTokenClient: (options: { callback: (r: object) => void }) => ({
    requestAccessToken: () => { gisAnswer = options.callback; },
  }) } } } });
  reload = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload, assign: vi.fn() }, writable: true, configurable: true });
  // A browser whose Drive sign-in expired, with a saved record; the page opened on this browser's copy.
  localStorage.setItem(BACKEND_KEY, 'google-drive');
  localStorage.setItem(DRIVE_TOKENS, JSON.stringify({ accessToken: 'test-token-old', expiresAt: 1 }));
  localStorage.setItem(DRIVE_CONFIG, JSON.stringify({ fileIds: { [ROADMAP_FILE_NAME]: CACHED_ID } }));
  const record = { ...createEmptyFile({ deviceId: 'd', now: NOW }), measurements: [createMeasurement({ id: 'm1', metricType: 'weight', value: 1, recordedAt: NOW, createdAt: NOW })] };
  new LocalStorageAdapter().writeSync(ROADMAP_FILE_NAME, record, null);
  await initRoadmapStore(new LocalStorageAdapter());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const signInKeys = () => [BACKEND_KEY, DRIVE_TOKENS, DRIVE_CONFIG].map((key) => localStorage.getItem(key));
const error = () => document.querySelector('.hr-sync-error')?.textContent ?? null;

async function reconnect(): Promise<void> {
  resetSignIn();
  bootSignIn({ kind: 'signedOut', provider: 'google-drive' });
  render(<SyncControl backend="local" hasData />);
  fireEvent.click(document.querySelector<HTMLButtonElement>('button.hr-sync-btn')!);
  await act(async () => { gisAnswer!({ access_token: 'test-token-good', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file' }); });
  await act(async () => { await new Promise((done) => setTimeout(done, 30)); });
}

describe('US-09 AC65: a 404 on a page that fell back to this browser', () => {
  it('a clean local session whose stored copy became unreadable after it opened: the bytes and the sign-in stay, nothing sent, the device-storage sentence shown', async () => {
    expect(getBackendKind()).toBe('local');
    localStorage.setItem(DEVICE_FILE, '{not json');
    const before = signInKeys();
    await reconnect();
    expect(localStorage.getItem(DEVICE_FILE)).toBe('{not json');
    expect(signInKeys()).toEqual(before);
    expect(fetchCalls).toHaveLength(1);
    expect(lift).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(error()).toBe(FULL);
  });

  it('control: a readable stored copy shows the not-found sentence and still holds the record', async () => {
    const before = signInKeys();
    await reconnect();
    expect(signInKeys()).toEqual(before);
    expect((JSON.parse(localStorage.getItem(DEVICE_FILE)!) as { measurements: { id: string }[] }).measurements.map((m) => m.id)).toEqual(['m1']);
    expect(fetchCalls).toHaveLength(1);
    expect(error()).toBe(CANNOT_OPEN);
  });
});
