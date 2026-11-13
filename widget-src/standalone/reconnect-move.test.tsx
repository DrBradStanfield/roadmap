// @vitest-environment jsdom
/**
 * US-09 AC45: the Drive reconnect is a move, one at a time with the picker,
 * and so is "Use this browser only". While the reconnect runs, the picker
 * shows "Reconnecting Google Drive…" with "Stop reconnecting", and a popup
 * answer after the reconnect stopped saves nothing.
 *
 * Real SyncControl, picker, switch-flow, Drive adapter and sign-in storage.
 * Fakes: the GIS token client (its answer held until the test releases it),
 * fetch, the lift, product events and location. Synthetic tokens; no network.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

const lift = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/roadmap-data', () => ({ currentSaveStatus: () => 'saved', flushRoadmapStore: async () => undefined, copyRecordToDevice: async () => undefined, getBackendKind: () => 'cloud' }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', async (importOriginal) => ({ ...(await importOriginal<typeof import('./connect')>()), liftLocalInto: lift }));

import { SyncControl } from './sync-control';
import { GoogleDriveAdapter } from '../src/storage';
import { dispatch, getSwitchFlow, HAND_OFF_MS, resetSwitchFlow } from './switch-flow';
import { openBackendPicker } from '../src/lib/storage-notice';
import { bootSignIn, resetSignIn } from '../src/storage/sign-in-state';

const BACKEND_KEY = 'health_roadmap_backend';
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';

let fetchCalls: string[];
let reload: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;
/** The GIS popup's answer, held until the test releases it. */
let gisAnswer: ((r: object) => void) | null;
let popupsOpened: number;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = vi.fn();
});

beforeEach(() => {
  resetSwitchFlow();
  localStorage.clear();
  localStorage.setItem(BACKEND_KEY, 'google-drive'); // a reconnect session: Drive is still the chosen home
  fetchCalls = [];
  gisAnswer = null;
  popupsOpened = 0;
  lift.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    throw new TypeError('Failed to fetch');
  }));
  Object.assign(window, { google: { accounts: { oauth2: { initTokenClient: (options: { callback: (r: object) => void }) => ({
    requestAccessToken: () => { popupsOpened++; gisAnswer = options.callback; },
  }) } } } });
  reload = vi.fn();
  assign = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload, assign }, writable: true, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A load whose Drive sign-in could not be used, as boot seeds it (US-09 AC48). */
const mount = () => {
  resetSignIn();
  bootSignIn({ kind: 'signedOut', provider: 'google-drive' });
  return render(<SyncControl backend="local" hasData />);
};
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name);
const reconnectButton = () => document.querySelector<HTMLButtonElement>('button.hr-sync-btn')!;
const option = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button.hr-opt')].find((b) => b.textContent?.startsWith(name))!;
const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 20)); });
/** The person finishes the Google popup. */
const answerPopup = async () => {
  await act(async () => { gisAnswer!({ access_token: 'test-token-good', expires_in: 3600, scope: DRIVE_SCOPE }); });
  await settle();
};
const driveKeys = () => [DRIVE_TOKENS, DRIVE_CONFIG].map((key) => localStorage.getItem(key));
const googleCalls = () => fetchCalls.filter((url) => url.includes('googleapis.com'));

/** Nothing of the popup's grant was kept, and the page did not move. */
function expectNothingSaved(): void {
  expect(driveKeys()).toEqual([null, null]); // no half-saved grant either
  expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
  expect(lift).not.toHaveBeenCalled();
  expect(googleCalls()).toEqual([]);
  expect(reload).not.toHaveBeenCalled();
}

describe('US-09 AC45: the Drive reconnect is a move, one at a time with the picker', () => {
  it('the popup opens inside the click, and the reconnect claims the one move', () => {
    mount();
    fireEvent.click(reconnectButton());
    expect(popupsOpened).toBe(1); // the click's user gesture reaches the GIS popup
    expect(getSwitchFlow()).toEqual({ kind: 'reconnecting', run: 1 });
    expect(reconnectButton().textContent).toBe('Reconnecting…');
    expect(reconnectButton().disabled).toBe(true);
  });

  it('while it runs, the picker shows its moves locked, says so, and choosing Dropbox is refused', async () => {
    mount();
    fireEvent.click(reconnectButton());
    act(() => openBackendPicker());
    expect(document.querySelector('dialog')!.textContent).toContain('Reconnecting Google Drive…');
    expect(button('Stop reconnecting')).toBeDefined();
    expect(option('Dropbox').disabled).toBe(true);
    expect(option('This browser only').disabled).toBe(true);
    fireEvent.click(option('Dropbox'));
    await settle();
    expect(getSwitchFlow()).toEqual({ kind: 'reconnecting', run: 1 });
    expect(assign).not.toHaveBeenCalled();
    expect(fetchCalls).toEqual([]);
  });

  it('Stop reconnecting frees the picker with no error, and a popup answer after the reconnect stopped saves nothing', async () => {
    mount();
    fireEvent.click(reconnectButton());
    act(() => openBackendPicker());
    fireEvent.click(button('Stop reconnecting')!);
    expect(getSwitchFlow()).toEqual({ kind: 'idle', run: 1, error: null });
    expect(option('Dropbox').disabled).toBe(false);
    expect(document.querySelector('dialog')!.textContent).not.toContain('Reconnecting Google Drive…');
    expect(document.querySelector('.hr-sync-error')).toBeNull();
    await answerPopup();
    expectNothingSaved();
    expect(reconnectButton().textContent).toBe('Reconnect Google Drive');
  });

  it.each([
    ['a picker move to Dropbox', () => dispatch({ type: 'start', to: 'dropbox', step: 'list' })],
    ['"Use this browser only"', () => dispatch({ type: 'start', to: 'local', step: 'list' })],
    ['a log-off', () => dispatch({ type: 'logOff' })],
    ['a move that handed the page to a sign-in', () => { dispatch({ type: 'start', to: 'dropbox', step: 'list' }); dispatch({ type: 'navigating', run: 2 }); }],
    ['a newer reconnect', () => dispatch({ type: 'reconnect' })],
  ])('a popup answer after the reconnect stopped, during %s, saves nothing', async (_name, next) => {
    mount();
    fireEvent.click(reconnectButton());
    act(() => { dispatch({ type: 'cancel', run: 1 }); next(); });
    await answerPopup();
    expectNothingSaved();
  });

  it('control: an uninterrupted reconnect saves, remembers, lifts and reloads', async () => {
    mount();
    fireEvent.click(reconnectButton());
    await answerPopup();
    expect(JSON.parse(localStorage.getItem(DRIVE_TOKENS)!)).toMatchObject({ accessToken: 'test-token-good' });
    expect(localStorage.getItem(DRIVE_CONFIG)).not.toBeNull();
    expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
    expect(lift).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getSwitchFlow()).toEqual({ kind: 'navigating', run: 1, step: 'list' });
  });
});

describe('US-09 AC45: once the popup answer is saved, the reconnect runs to its reload', () => {
  it('Stop is gone and the moves stay locked while local edits go up; then it reloads once, still on Drive', async () => {
    let release!: () => void;
    lift.mockImplementationOnce(() => new Promise<void>((done) => { release = done; }));
    mount();
    fireEvent.click(reconnectButton());
    await answerPopup();
    expect(lift).toHaveBeenCalledTimes(1);
    act(() => openBackendPicker());
    expect(document.querySelector('dialog')!.textContent).toContain('Reconnecting Google Drive…');
    expect(button('Stop reconnecting')).toBeUndefined();
    expect(option('Dropbox').disabled).toBe(true);
    expect(option('This browser only').disabled).toBe(true);
    act(() => { dispatch({ type: 'cancel', run: 1 }); }); // a Stop sent anyway changes nothing
    fireEvent.click(option('Dropbox'));
    expect(getSwitchFlow()).toEqual({ kind: 'reconnected', run: 1 });
    expect(reload).not.toHaveBeenCalled();
    await act(async () => { release(); });
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
    expect(getSwitchFlow()).toEqual({ kind: 'navigating', run: 1, step: 'list' });
  });

  it('a reconnect that fails after it saved ends as a failure: the picker unlocks and the panel says why', async () => {
    lift.mockRejectedValueOnce(new Error('Google Drive could not be reached.'));
    mount();
    fireEvent.click(reconnectButton());
    await answerPopup();
    expect(lift).toHaveBeenCalledTimes(1);
    expect(getSwitchFlow()).toEqual({ kind: 'idle', run: 1, error: 'Google Drive could not be reached.' });
    expect(document.querySelector('.hr-sync-error')?.textContent).toBe('Google Drive could not be reached.');
    act(() => openBackendPicker());
    expect(document.querySelector('dialog')!.textContent).not.toContain('Reconnecting Google Drive…');
    expect(document.querySelector('dialog .hr-sync-error')?.textContent).toBe('Google Drive could not be reached.');
    expect(option('Dropbox').disabled).toBe(false);
    expect(reconnectButton().disabled).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('an answer after another tab left Drive saves nothing and reloads onto what that tab chose', async () => {
    mount();
    fireEvent.click(reconnectButton());
    localStorage.removeItem(BACKEND_KEY); // another tab chose "This browser only"
    await answerPopup();
    expect(driveKeys()).toEqual([null, null]);
    expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
    expect(lift).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('US-09 AC45 (lead C27): the panel and the picker share one move', () => {
  it('while a picker move is mid-flight, Reconnect is disabled and a click opens no popup', () => {
    mount();
    act(() => { dispatch({ type: 'start', to: 'dropbox', step: 'list' }); });
    expect(reconnectButton().disabled).toBe(true);
    expect(button('Use this browser only')!.disabled).toBe(true);
    fireEvent.click(reconnectButton());
    expect(popupsOpened).toBe(0);
    expect(getSwitchFlow()).toEqual({ kind: 'switching', run: 1, to: 'dropbox', step: 'list' });
  });
});

describe('US-09 AC45a: a reconnect whose reload never happens frees the panel and the picker', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('after the wait, Reconnect works again, and so does the picker, with nothing closed or reopened', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    fireEvent.click(reconnectButton());
    await answerPopup();
    expect(reload).toHaveBeenCalledTimes(1); // the reload the browser never carries out
    expect(reconnectButton().disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(HAND_OFF_MS); });

    expect(reconnectButton().disabled).toBe(false);
    expect(reconnectButton().textContent).toBe('Reconnect Google Drive');
    expect(button('Use this browser only')!.disabled).toBe(false);
    act(() => openBackendPicker());
    expect(option('Dropbox').disabled).toBe(false);
    fireEvent.click(reconnectButton());
    expect(popupsOpened).toBe(2);
  });
});

describe('US-09 AC45: "Use this browser only" is a move too', () => {
  it('is disabled and refused while the reconnect runs', async () => {
    mount();
    fireEvent.click(reconnectButton());
    const link = button('Use this browser only')!;
    expect(link.disabled).toBe(true);
    fireEvent.click(link);
    await settle();
    expect(getSwitchFlow()).toEqual({ kind: 'reconnecting', run: 1 });
    expect(localStorage.getItem(BACKEND_KEY)).toBe('google-drive');
    expect(reload).not.toHaveBeenCalled();
  });

  it('runs as a move, and a reconnect is refused while it runs', async () => {
    localStorage.setItem(DRIVE_CONFIG, JSON.stringify({ accountEmail: 'person@example.test' }));
    mount();
    fireEvent.click(button('Use this browser only')!);
    await settle();
    expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
    expect(localStorage.getItem(DRIVE_CONFIG)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getSwitchFlow()).toMatchObject({ kind: 'navigating', run: 1 });
    expect(reconnectButton().disabled).toBe(true);
    fireEvent.click(reconnectButton());
    expect(popupsOpened).toBe(0);
  });

  it('a failure is said in the panel and on the picker, and frees the move', async () => {
    vi.spyOn(GoogleDriveAdapter.prototype, 'disconnect').mockRejectedValueOnce(new Error('Could not forget Google Drive.'));
    mount();
    fireEvent.click(button('Use this browser only')!);
    await settle();
    expect(document.querySelector('.hr-sync-error')?.textContent).toBe('Could not forget Google Drive.');
    expect(getSwitchFlow()).toEqual({ kind: 'idle', run: 1, error: 'Could not forget Google Drive.' });
    expect(reload).not.toHaveBeenCalled();
  });
});
