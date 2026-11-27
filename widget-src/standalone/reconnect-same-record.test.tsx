// @vitest-environment jsdom
/**
 * US-09 AC65: a Google Drive popup reconnect is kept only when it reaches the
 * record this browser was syncing. Before the grant is kept, the record file id
 * cached here is looked up with the new sign-in; only Drive's definite "not
 * found" (404) over a device copy that holds something keeps nothing.
 *
 * Real SyncControl, switch-flow, Drive adapter, Drive REST helpers and sign-in
 * storage. Fakes: the GIS token client, fetch (a Drive that answers the file
 * lookup), the record open on the page, the lift, product events and location.
 * Synthetic tokens and ids; no network.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

const lift = vi.hoisted(() => vi.fn(async () => {}));
const page = vi.hoisted(() => ({ live: null as unknown }));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/roadmap-data', () => ({
  currentSaveStatus: () => 'saved', currentRetryDue: () => false, recordFileSync: () => page.live,
  flushRoadmapStore: async () => undefined, copyRecordToDevice: async () => undefined, getBackendKind: () => 'local',
}));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', async (importOriginal) => ({ ...(await importOriginal<typeof import('./connect')>()), liftLocalInto: lift }));

import { SyncControl } from './sync-control';
import { getSwitchFlow, resetSwitchFlow } from './switch-flow';
import { bootSignIn, resetSignIn } from '../src/storage/sign-in-state';
import { copyEmpty } from '../src/storage/drive-reconnect-check';

const BACKEND_KEY = 'health_roadmap_backend';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DEVICE_FILE = 'health_roadmap_file_v2';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const CACHED_ID = 'cached-record-id';
const SENTENCE = 'Google Drive did not connect, so nothing changed. Please try again.';

const stamp = { updatedAt: '2026-11-25T00:00:00Z', lamport: 0 };
const emptyRecord = { schemaVersion: 3, meta: { ...stamp }, profile: { ...stamp }, screenings: { ...stamp, fieldStamps: {} }, measurements: [] };
const fullRecord = { ...emptyRecord, measurements: [{ id: 'm1', metricType: 'weight' }] };

/** How the fake Drive answers the cached file's lookup. */
type Lookup = 'visible' | 'notFound' | 'serverError' | 'forbidden' | 'network' | 'trashed';
let lookup: Lookup;
let fetchCalls: string[];
let reload: ReturnType<typeof vi.fn>;
let gisAnswer: ((r: object) => void) | null;

const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = vi.fn();
});

beforeEach(() => {
  resetSwitchFlow();
  localStorage.clear();
  page.live = null;
  lookup = 'visible';
  fetchCalls = [];
  gisAnswer = null;
  lift.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (!url.includes(`/drive/v3/files/${CACHED_ID}?fields=version`)) throw new TypeError('Failed to fetch');
    switch (lookup) {
      case 'visible': return json(200, { version: '7' });
      case 'trashed': return json(200, { version: '8' }); // Drive serves a trashed file by id to an account that can see it
      case 'notFound': return json(404, { error: { code: 404, message: 'File not found' } });
      case 'forbidden': return json(403, { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } });
      case 'serverError': return json(500, { error: { code: 500 } });
      case 'network': throw new TypeError('Failed to fetch');
    }
  }));
  Object.assign(window, { google: { accounts: { oauth2: { initTokenClient: (options: { callback: (r: object) => void }) => ({
    requestAccessToken: () => { gisAnswer = options.callback; },
  }) } } } });
  reload = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload, assign: vi.fn() }, writable: true, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A browser whose Drive sign-in expired: Drive is still its home, the old token and the cached id stay. */
function seed({ device, cachedId = true }: { device: object | null; cachedId?: boolean }): void {
  localStorage.setItem(BACKEND_KEY, 'google-drive');
  localStorage.setItem(DRIVE_TOKENS, JSON.stringify({ accessToken: 'test-token-old', expiresAt: 1 }));
  localStorage.setItem(DRIVE_CONFIG, JSON.stringify(cachedId ? { fileIds: { 'health-roadmap.json': CACHED_ID } } : {}));
  if (device) localStorage.setItem(DEVICE_FILE, JSON.stringify(device));
}

const storedState = () => Object.fromEntries(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)]));

async function reconnect(): Promise<void> {
  resetSignIn();
  bootSignIn({ kind: 'signedOut', provider: 'google-drive' });
  render(<SyncControl backend="local" hasData />);
  fireEvent.click(document.querySelector<HTMLButtonElement>('button.hr-sync-btn')!);
  await act(async () => { gisAnswer!({ access_token: 'test-token-good', expires_in: 3600, scope: DRIVE_SCOPE }); });
  await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
}

function expectKept(): void {
  expect(JSON.parse(localStorage.getItem(DRIVE_TOKENS)!)).toMatchObject({ accessToken: 'test-token-good' });
  expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
  expect(lift).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.hr-sync-error')).toBeNull();
}

describe('US-09 AC65: a Drive popup reconnect is kept only when it reaches this browser\'s record', () => {
  it.each([
    ['the stored device copy', fullRecord, null],
    ['the record open on the page, over no stored copy', null, fullRecord],
  ])('Drive answers 404 for the cached file while %s holds something: nothing kept, nothing uploaded, the sentence shown', async (_name, device, live) => {
    seed({ device });
    page.live = live;
    lookup = 'notFound';
    const before = storedState();
    await reconnect();
    expect(storedState()).toEqual(before); // tokens, config and the remembered home, byte for byte
    expect(lift).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(fetchCalls).toEqual([expect.stringContaining(`/files/${CACHED_ID}?fields=version`)]); // the one lookup: no upload, no other call
    expect(document.querySelector('.hr-sync-error')?.textContent).toBe(SENTENCE);
    expect(getSwitchFlow()).toMatchObject({ kind: 'idle' });
    expect(document.querySelector<HTMLButtonElement>('button.hr-sync-btn')!.disabled).toBe(false); // free to try again
  });

  it.each([
    ['no device copy and no open record', null, null],
    ['a stored record with nothing answered', emptyRecord, null],
    ['an open record with nothing answered', null, emptyRecord],
  ])('a 404 over an empty copy (%s) is kept, with no lookup', async (_name, device, live) => {
    seed({ device });
    page.live = live;
    lookup = 'notFound';
    await reconnect();
    expect(fetchCalls).toEqual([]);
    expectKept();
  });

  it('no cached record file id: kept, with no lookup', async () => {
    seed({ device: fullRecord, cachedId: false });
    lookup = 'notFound';
    await reconnect();
    expect(fetchCalls).toEqual([]);
    expectKept();
  });

  it.each<[string, Lookup]>([
    ['the cached file is visible to the new sign-in', 'visible'],
    ['the cached file is trashed (Drive still serves it by id to an account that can see it)', 'trashed'],
    ['the lookup fails with a network error', 'network'],
    ['the lookup fails with a 500', 'serverError'],
    ['the lookup fails with a 403 rate limit', 'forbidden'],
  ])('%s: kept as before, after one lookup', async (_name, answer) => {
    seed({ device: fullRecord });
    lookup = answer;
    await reconnect();
    expect(fetchCalls.filter((url) => url.includes(CACHED_ID))).toHaveLength(1);
    expectKept();
  });
});

describe('US-09 AC65: copyEmpty', () => {
  const table: Array<[string, unknown, boolean]> = [
    ['nothing stored', null, true],
    ['a record with nothing answered', emptyRecord, true],
    ['a profile answer only', { ...emptyRecord, profile: { ...stamp, birthYear: 1970 } }, false],
    ['a screening answer only', { ...emptyRecord, screenings: { ...stamp, colorectalMethod: 'fit' } }, false],
    ['a reminder choice only', { ...emptyRecord, reminderPreferences: [{ ...stamp, category: 'x', enabled: false }] }, false],
    ['a reminder opt-in only', { ...emptyRecord, reminderOptIn: { ...stamp, status: 'cancelled' } }, false],
    ['an empty erase list', { ...emptyRecord, erasedRows: { fromEpoch: 1, ids: [] } }, false],
    ['an erase epoch only', { ...emptyRecord, meta: { ...stamp, eraseEpoch: 1 } }, false],
    ['one row, even without an id', { ...emptyRecord, measurements: [{}] }, false],
    ['a row list that is not a list', { ...emptyRecord, measurements: { id: 'm1' } }, false],
    ['a reminder list that is not a list', { ...emptyRecord, reminderPreferences: { category: 'x' } }, false],
    ['a body that is not a record', 'unreadable', false],
  ];
  it.each(table)('%s', (_name, body, verdict) => {
    expect(copyEmpty(body)).toBe(verdict);
  });
});
