// @vitest-environment jsdom
/**
 * US-09 AC65: a Google Drive popup reconnect confirms the record file before
 * its grant is kept. The record file id cached here is looked up with the new
 * sign-in; Drive's definite "not found" (404) while this browser holds a record
 * keeps nothing, copies the page's record into this browser, and names the way
 * on. A lookup whose stored sign-in changed while it ran is set aside.
 *
 * Real SyncControl, switch-flow, Drive adapter, Drive REST helpers and sign-in
 * storage. Fakes: the GIS token client, fetch (a Drive that answers the file
 * lookup by bearer token), the record open on the page and its two device-copy
 * steps, the lift, product events and location. Synthetic tokens and ids.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

const DEVICE_FILE = 'health_roadmap_file_v2';
const lift = vi.hoisted(() => vi.fn(async () => {}));
const page = vi.hoisted(() => ({ live: null as unknown, kind: 'cloud' as 'cloud' | 'local' }));
/** The two ways the page's record reaches this browser: a cloud page copies it, a device page saves it. */
const toDevice = vi.hoisted(() => {
  const save = async () => { localStorage.setItem('health_roadmap_file_v2', JSON.stringify(page.live)); };
  return { copy: vi.fn(save), flush: vi.fn(save) };
});
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/roadmap-data', () => ({
  currentSaveStatus: () => 'saved', currentRetryDue: () => false, recordFileSync: () => page.live,
  flushRoadmapStore: toDevice.flush, copyRecordToDevice: toDevice.copy, getBackendKind: () => page.kind,
}));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', async (importOriginal) => ({ ...(await importOriginal<typeof import('./connect')>()), liftLocalInto: lift }));

import { SyncControl } from './sync-control';
import { dispatch, getSwitchFlow, resetSwitchFlow } from './switch-flow';
import { bootSignIn, resetSignIn } from '../src/storage/sign-in-state';
import { copyEmpty } from '../src/storage/drive-reconnect-check';
import { FULL } from '../src/storage/local-storage-adapter';

const BACKEND_KEY = 'health_roadmap_backend';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const CACHED_ID = 'cached-record-id';
const OLD_TOKEN = 'test-token-old';
const POPUP_TOKEN = 'test-token-good';
const CANNOT_OPEN = 'Google Drive did not connect: this sign-in cannot open the record saved in this browser. Nothing changed. To keep working, choose Use this browser only.';

const stamp = { updatedAt: '2026-11-25T00:00:00Z', lamport: 0 };
const emptyRecord = { schemaVersion: 3, meta: { ...stamp, createdAt: stamp.updatedAt, lastDeviceId: 'd' }, profile: { ...stamp }, screenings: { ...stamp, fieldStamps: {} }, measurements: [] };
const fullRecord = { ...emptyRecord, measurements: [{ id: 'm1', metricType: 'weight' }] };

/** How the fake Drive answers the popup token's lookup of the cached file. */
type Lookup = 'visible' | 'notFound' | 'serverError' | 'forbidden' | 'network' | 'trashed';
let lookup: Lookup;
/** While set, the lookup's answer waits for the test. */
let hold: { release: () => void } | null;
let holdNext: boolean;
let lookups: string[];
let fetchCalls: string[];
let reload: ReturnType<typeof vi.fn>;
let gisAnswer: ((r: object) => void) | null;
let popupsOpened: number;

const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function answer(): Response {
  switch (lookup) {
    case 'visible': return json(200, { version: '7' });
    case 'trashed': return json(200, { version: '8' }); // Drive serves a trashed file by id to an account that can see it
    case 'notFound': return json(404, { error: { code: 404, message: 'File not found' } });
    case 'forbidden': return json(403, { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } });
    case 'serverError': return json(500, { error: { code: 500 } });
    case 'network': throw new TypeError('Failed to fetch');
  }
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = vi.fn();
});

beforeEach(() => {
  resetSwitchFlow();
  localStorage.clear();
  page.live = null;
  page.kind = 'cloud';
  lookup = 'visible';
  hold = null;
  holdNext = false;
  lookups = [];
  fetchCalls = [];
  gisAnswer = null;
  popupsOpened = 0;
  lift.mockClear();
  toDevice.copy.mockClear();
  toDevice.flush.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push(url);
    if (!url.includes(`/drive/v3/files/${CACHED_ID}?fields=version`)) throw new TypeError('Failed to fetch');
    const bearer = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
    lookups.push(bearer);
    if (bearer !== `Bearer ${POPUP_TOKEN}`) return json(200, { version: '1' }); // the old sign-in still sees its file
    if (holdNext) await new Promise<void>((release) => { hold = { release }; });
    return answer();
  }));
  Object.assign(window, { google: { accounts: { oauth2: { initTokenClient: (options: { callback: (r: object) => void }) => ({
    requestAccessToken: () => { popupsOpened++; gisAnswer = options.callback; },
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
  localStorage.setItem(DRIVE_TOKENS, JSON.stringify({ accessToken: OLD_TOKEN, expiresAt: 1 }));
  localStorage.setItem(DRIVE_CONFIG, JSON.stringify(cachedId ? { fileIds: { 'health-roadmap.json': CACHED_ID } } : {}));
  if (device) localStorage.setItem(DEVICE_FILE, JSON.stringify(device));
}

const storedState = (keys = [BACKEND_KEY, DRIVE_TOKENS, DRIVE_CONFIG]) => keys.map((key) => localStorage.getItem(key));
const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 20)); });
const reconnectButton = () => document.querySelector<HTMLButtonElement>('button.hr-sync-btn')!;
const error = () => document.querySelector('.hr-sync-error')?.textContent ?? null;

async function reconnect(): Promise<void> {
  resetSignIn();
  bootSignIn({ kind: 'signedOut', provider: 'google-drive' });
  render(<SyncControl backend="local" hasData />);
  fireEvent.click(reconnectButton());
  await act(async () => { gisAnswer!({ access_token: POPUP_TOKEN, expires_in: 3600, scope: DRIVE_SCOPE }); });
  await settle();
}

function expectKept(): void {
  expect(JSON.parse(localStorage.getItem(DRIVE_TOKENS)!)).toMatchObject({ accessToken: POPUP_TOKEN });
  expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
  expect(lift).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(error()).toBeNull();
}

describe('US-09 AC65: a Drive popup reconnect confirms the record file', () => {
  it.each([
    ['the stored device copy', fullRecord, null],
    ['the record open on the page, over no stored copy', null, fullRecord],
  ])('Drive answers 404 while %s holds something: no sign-in kept, nothing sent, the record kept in this browser, the way on named', async (_name, device, live) => {
    seed({ device });
    page.live = live ?? device;
    lookup = 'notFound';
    const before = storedState();
    await reconnect();
    expect(storedState()).toEqual(before); // the stored sign-in and the remembered home, byte for byte
    expect(JSON.parse(localStorage.getItem(DEVICE_FILE)!)).toEqual(fullRecord); // the page's record is in this browser
    expect(toDevice.copy).toHaveBeenCalledTimes(1);
    expect(toDevice.flush).not.toHaveBeenCalled(); // no save that could reach Drive
    expect(lift).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(lookups).toEqual([`Bearer ${POPUP_TOKEN}`]); // the one call: the popup sign-in's lookup
    expect(fetchCalls).toHaveLength(1);
    expect(error()).toBe(CANNOT_OPEN);
    expect(getSwitchFlow()).toMatchObject({ kind: 'idle' });
    expect(reconnectButton().disabled).toBe(false);
  });

  it('on a page that fell back to this browser, the copy is the device store\'s own save (this browser\'s storage, nothing reaches Drive), and the only fetch is the lookup', async () => {
    seed({ device: fullRecord });
    page.kind = 'local';
    page.live = fullRecord;
    lookup = 'notFound';
    const before = storedState();
    await reconnect();
    expect(storedState()).toEqual(before);
    expect(toDevice.flush).toHaveBeenCalledTimes(1); // the device store's save: this page's store is this browser
    expect(toDevice.copy).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(1);
    expect(error()).toBe(CANNOT_OPEN);
  });

  it('a 404 whose copy into this browser fails for full storage: nothing kept, nothing sent, the storage-full sentence shown', async () => {
    seed({ device: null });
    page.live = fullRecord;
    lookup = 'notFound';
    toDevice.copy.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    const before = storedState();
    await reconnect();
    expect(storedState()).toEqual(before);
    expect(localStorage.getItem(DEVICE_FILE)).toBeNull();
    expect(toDevice.flush).not.toHaveBeenCalled();
    expect(lift).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(1);
    expect(error()).toBe(FULL);
    expect(reconnectButton().disabled).toBe(false);
  });

  it.each([
    ['no device copy and no open record', null, null],
    ['a stored fresh record', emptyRecord, null],
    ['an open fresh record', null, emptyRecord],
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
    ['the cached file is found by the popup sign-in', 'visible'],
    ['the cached file is trashed (Drive still serves it by id to an account that can see it)', 'trashed'],
    ['the lookup fails with a network error', 'network'],
    ['the lookup fails with a 500', 'serverError'],
    ['the lookup fails with a 403 rate limit', 'forbidden'],
  ])('%s: kept as before, after one lookup with the popup token', async (_name, answer) => {
    seed({ device: fullRecord });
    lookup = answer;
    await reconnect();
    expect(lookups).toEqual([`Bearer ${POPUP_TOKEN}`]);
    expectKept();
  });

  it('a device copy that cannot be read counts as held: a 404 is refused', async () => {
    seed({ device: null });
    localStorage.setItem(DEVICE_FILE, '{not json');
    lookup = 'notFound';
    await reconnect();
    expect(lift).not.toHaveBeenCalled();
    expect(error()).toBe(CANNOT_OPEN);
  });

  it('a storage read that throws once counts as held: a 404 is refused', async () => {
    seed({ device: null });
    lookup = 'notFound';
    const getItem = Storage.prototype.getItem;
    let thrown = false;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === DEVICE_FILE && !thrown) { thrown = true; throw new DOMException('denied', 'SecurityError'); }
      return getItem.call(this, key);
    });
    await reconnect();
    vi.restoreAllMocks();
    expect(thrown).toBe(true);
    expect(lift).not.toHaveBeenCalled();
    expect(error()).toBe(CANNOT_OPEN);
  });
});

describe('US-09 AC65: a lookup is kept only for the stored sign-in it was made for', () => {
  async function heldReconnect(): Promise<void> {
    seed({ device: fullRecord });
    page.live = fullRecord;
    lookup = 'notFound';
    holdNext = true;
    await reconnect();
    expect(hold).not.toBeNull();
  }
  const release = async () => { await act(async () => { hold!.release(); }); await settle(); };

  it('the Drive sign-in replaced in another tab while the lookup runs: the late 404 is set aside, no error, one reload onto it', async () => {
    await heldReconnect();
    const other = [JSON.stringify({ accessToken: 'test-token-other', expiresAt: 9e15 }), JSON.stringify({ fileIds: { 'health-roadmap.json': 'other-id' } })];
    localStorage.setItem(DRIVE_TOKENS, other[0]);
    localStorage.setItem(DRIVE_CONFIG, other[1]);
    await release();
    expect(storedState([DRIVE_TOKENS, DRIVE_CONFIG])).toEqual(other);
    expect(toDevice.copy).not.toHaveBeenCalled();
    expect(lift).not.toHaveBeenCalled();
    expect(error()).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('"Use this browser only" in another tab while a 404 is held: nothing kept, no error, one reload', async () => {
    await heldReconnect();
    localStorage.removeItem(BACKEND_KEY);
    localStorage.removeItem(DRIVE_TOKENS);
    localStorage.removeItem(DRIVE_CONFIG);
    await release();
    expect(storedState()).toEqual([null, null, null]);
    expect(toDevice.copy).not.toHaveBeenCalled();
    expect(error()).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('Stop during the lookup: the late 404 keeps nothing, copies nothing, says nothing and does not reload', async () => {
    await heldReconnect();
    const before = storedState();
    act(() => { dispatch({ type: 'cancel', run: 1 }); });
    await release();
    expect(storedState()).toEqual(before);
    expect(toDevice.copy).not.toHaveBeenCalled();
    expect(error()).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a second click during the lookup opens no second popup and starts no second lookup', async () => {
    await heldReconnect();
    expect(reconnectButton().disabled).toBe(true);
    fireEvent.click(reconnectButton());
    expect(popupsOpened).toBe(1);
    await release();
    expect(lookups).toHaveLength(1);
    expect(error()).toBe(CANNOT_OPEN);
  });
});

describe('US-09 AC65: copyEmpty matches a fresh record only', () => {
  const table: Array<[string, unknown, boolean]> = [
    ['nothing stored', null, true],
    ['a fresh record', emptyRecord, true],
    ['an erase epoch of 0', { ...emptyRecord, meta: { ...emptyRecord.meta, eraseEpoch: 0 } }, true],
    ['a profile answer', { ...emptyRecord, profile: { ...stamp, birthYear: 1970 } }, false],
    ['a screening answer', { ...emptyRecord, screenings: { ...stamp, colorectalMethod: 'fit' } }, false],
    ['a stamped clear (a field stamp, no value)', { ...emptyRecord, profile: { ...stamp, fieldStamps: { birthYear: stamp.updatedAt } } }, false],
    ['a reminder choice', { ...emptyRecord, reminderPreferences: [{ ...stamp, category: 'x', enabled: false }] }, false],
    ['a reminder opt-in', { ...emptyRecord, reminderOptIn: { ...stamp, status: 'cancelled' } }, false],
    ['an empty erase list', { ...emptyRecord, erasedRows: { fromEpoch: 1, ids: [] } }, false],
    ['an erase epoch', { ...emptyRecord, meta: { ...emptyRecord.meta, eraseEpoch: 1 } }, false],
    ['an erase time', { ...emptyRecord, meta: { ...emptyRecord.meta, erasedAt: stamp.updatedAt } }, false],
    ['one row, even without an id', { ...emptyRecord, measurements: [{}] }, false],
    ['a list that is not a list', { ...emptyRecord, reminderPreferences: { category: 'x' } }, false],
    ['an extension section this build does not know', { ...emptyRecord, extension: {} }, false],
    ['a profile key this build does not know', { ...emptyRecord, profile: { ...stamp, futureField: null } }, false],
    ['a body that is a list', [], false],
    ['a body that is not a record', 'unreadable', false],
  ];
  it.each(table)('%s', (_name, body, verdict) => {
    expect(copyEmpty(body)).toBe(verdict);
  });
});
