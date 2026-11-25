// @vitest-environment jsdom
/**
 * US-11 AC14: after a render crash the whole app's fallback still offers
 * "Delete all my data" and, where the picker would, the log-off, each through
 * its existing action: the erase's own confirm and store call, the picker's
 * own log-off step and move. The two lock each other out while one runs, and
 * a throw inside the screen shows the static message. The store and the
 * log-off are fakes; the screen, the erase hook, the move and the picker's
 * step are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The answer's shape is deleteUserData's (`chat`, PR 2148); `chatErased` until that lands.
const data = vi.hoisted(() => ({
  identity: 'e1', shown: 'e1',
  result: { success: true, chatErased: true, chat: 'erased' } as Record<string, unknown>,
}));
vi.mock('../src/lib/roadmap-data', () => ({
  getEraseIdentity: () => data.identity,
  getShownErase: () => data.shown,
  askedUnder: () => data.shown,
  markEraseShown: (e: string) => { data.shown = e; },
  getBackendKind: () => 'cloud',
  deleteUserData: vi.fn(async () => { data.identity = 'e2'; return data.result; }),
  clearOffFileAfterErase: vi.fn(),
}));
vi.mock('./connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./connect')>();
  return { ...actual, storageState: vi.fn(actual.storageState), logOff: vi.fn(async () => {}) };
});
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { CrashBoundary, transition, type CrashEvent, type CrashState } from './crash-screen';
import { clearOffFileAfterErase, deleteUserData } from '../src/lib/roadmap-data';
import { ERASE_CONFIRM } from '../src/lib/erase-copy';
import { logOff, storageState, type Backend } from './connect';
import { resetSwitchFlow, runMove } from './switch-flow';
import { bootSignIn, resetSignIn, signInEnded } from '../src/storage/sign-in-state';

function Crash(): never {
  throw new Error('render crash (test)');
}

function crashed(backend: Backend) {
  return render(<CrashBoundary backend={backend}><Crash /></CrashBoundary>);
}

function held<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

let reload: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  // A page signed in to Dropbox, as boot leaves it: the picker's rule offers the log-off (real sign-in state).
  vi.mocked(storageState).mockImplementation((await vi.importActual<typeof import('./connect')>('./connect')).storageState);
  resetSignIn();
  localStorage.setItem('health_roadmap_backend', 'dropbox');
  bootSignIn({ kind: 'signedIn', provider: 'dropbox' });
  data.identity = 'e1'; data.shown = 'e1';
  data.result = { success: true, chatErased: true, chat: 'erased' };
  resetSwitchFlow();
  vi.spyOn(console, 'error').mockImplementation(() => {}); // React's own report of the crash
  reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('US-11 AC14: the crash screen\'s one state', () => {
  const IDLE: CrashState = { kind: 'idle', focusTrigger: false };
  const BACK: CrashState = { kind: 'idle', focusTrigger: true };
  const ERASING: CrashState = { kind: 'erasing' };
  const CONFIRMING: CrashState = { kind: 'confirmingLogOff', error: null };
  const FAILED: CrashState = { kind: 'confirmingLogOff', error: 'Connection failed.' };
  const LOGGING_OFF: CrashState = { kind: 'loggingOff' };
  const cases: Array<[CrashState, CrashEvent, CrashState]> = [
    [IDLE, { type: 'erase-began' }, ERASING],
    [CONFIRMING, { type: 'erase-began' }, ERASING],
    [LOGGING_OFF, { type: 'erase-began' }, LOGGING_OFF],
    [ERASING, { type: 'erase-began' }, ERASING],
    [ERASING, { type: 'erase-ended' }, IDLE],
    [IDLE, { type: 'erase-ended' }, IDLE],
    [IDLE, { type: 'log-off-asked' }, CONFIRMING],
    [ERASING, { type: 'log-off-asked' }, ERASING],
    [LOGGING_OFF, { type: 'log-off-asked' }, LOGGING_OFF],
    [CONFIRMING, { type: 'back' }, BACK],
    [LOGGING_OFF, { type: 'back' }, LOGGING_OFF],
    [CONFIRMING, { type: 'log-off-began' }, LOGGING_OFF],
    [FAILED, { type: 'log-off-began' }, LOGGING_OFF],
    [ERASING, { type: 'log-off-began' }, ERASING],
    [IDLE, { type: 'log-off-began' }, IDLE],
    [LOGGING_OFF, { type: 'log-off-failed', error: 'Connection failed.' }, FAILED],
    [LOGGING_OFF, { type: 'log-off-failed', error: null }, CONFIRMING],
    [ERASING, { type: 'log-off-failed', error: 'x' }, ERASING],
  ];
  it.each(cases)('%j + %j -> %j', (from, event, to) => {
    expect(transition(from, event)).toEqual(to);
  });
});

describe('US-11 AC14: the crash screen keeps delete and log off within reach', () => {
  it('a render crash shows the sentence, Delete all my data and Log off this device', () => {
    crashed('dropbox');
    expect(screen.getByText('Something went wrong. Reload the page to try again. You can still delete your data or log off.')).toBeTruthy();
    expect(button('Delete all my data')).toBeTruthy();
    expect(button('Log off this device')).toBeTruthy();
  });

  it('Delete all my data asks the erase confirm, erases through the store, says it, forgets the device copy and reloads', async () => {
    crashed('dropbox');
    fireEvent.click(button('Delete all my data'));
    expect(window.confirm).toHaveBeenCalledWith(ERASE_CONFIRM);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(deleteUserData).toHaveBeenCalledTimes(1);
    expect(clearOffFileAfterErase).toHaveBeenCalled();
    expect(vi.mocked(window.alert).mock.calls[0][0]).toMatch(/^Your health record and chat history are deleted\./);
  });

  it('a cancelled confirm erases nothing; a failed erase stays on the screen, unlocked', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    crashed('dropbox');
    fireEvent.click(button('Delete all my data'));
    expect(deleteUserData).not.toHaveBeenCalled();
    await waitFor(() => expect(button('Log off this device').disabled).toBe(false));
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.mocked(deleteUserData).mockImplementationOnce(async () => ({ success: false, error: 'Already deleting your data.', chat: null }) as never);
    fireEvent.click(button('Delete all my data'));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Already deleting your data.'));
    expect(reload).not.toHaveBeenCalled();
    await waitFor(() => expect(button('Delete all my data').disabled).toBe(false));
  });

  it('while the erase runs, Log off this device is disabled', async () => {
    const erase = held<Record<string, unknown>>();
    vi.mocked(deleteUserData).mockImplementationOnce(() => erase.promise as never);
    crashed('dropbox');
    fireEvent.click(button('Delete all my data'));
    await waitFor(() => expect(button('Deleting...').disabled).toBe(true));
    expect(button('Log off this device').disabled).toBe(true);
    fireEvent.click(button('Log off this device'));
    expect(screen.queryByRole('heading', { name: 'Log off this device?' })).toBeNull();
    await act(async () => { data.identity = 'e2'; erase.resolve(data.result); });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('Log off this device opens the picker\'s confirm; Back returns the focus to it; Log off runs the log-off for that cloud and locks Delete', async () => {
    const move = held<void>();
    vi.mocked(logOff).mockImplementationOnce(() => move.promise);
    crashed('dropbox');
    fireEvent.click(button('Log off this device'));
    expect(screen.getByRole('heading', { name: 'Log off this device?' })).toBeTruthy();
    fireEvent.click(button('← Back'));
    expect(document.activeElement).toBe(button('Log off this device'));

    fireEvent.click(button('Log off this device'));
    expect(logOff).not.toHaveBeenCalled();
    fireEvent.click(button('Log off'));
    await waitFor(() => expect(logOff).toHaveBeenCalledWith('dropbox'));
    expect(button('Logging off…').disabled).toBe(true);
    expect(button('Delete all my data').disabled).toBe(true);
    fireEvent.click(button('Delete all my data'));
    expect(window.confirm).not.toHaveBeenCalled();
    await act(async () => { move.resolve(); });
  });

  it('a failed log-off says the move\'s words, as the picker does, and unlocks', async () => {
    vi.mocked(logOff).mockImplementationOnce(async () => { throw new Error('Dropbox could not be reached.'); });
    crashed('dropbox');
    fireEvent.click(button('Log off this device'));
    fireEvent.click(button('Log off'));
    await waitFor(() => expect(screen.getByText('Dropbox could not be reached.')).toBeTruthy());
    expect(button('Log off').disabled).toBe(false);
    expect(button('Delete all my data').disabled).toBe(false);
  });

  it('a sign-in that ends while the confirm is open takes the log-off away: nothing is logged off, and Delete stays', () => {
    crashed('dropbox');
    fireEvent.click(button('Log off this device'));
    act(() => signInEnded('dropbox', null));
    expect(screen.queryByRole('button', { name: /log off/i })).toBeNull();
    expect(screen.getByText('Something went wrong. Reload the page to try again. You can still delete your data.')).toBeTruthy();
    expect(button('Delete all my data').disabled).toBe(false);
    expect(logOff).not.toHaveBeenCalled();
  });

  it('the press itself reads the sign-in again: ended under it, the press logs off nothing', async () => {
    crashed('dropbox');
    fireEvent.click(button('Log off this device'));
    vi.mocked(storageState).mockReturnValue('reconnect'); // the press's own read sees the ended sign-in
    fireEvent.click(button('Log off'));
    await act(async () => {});
    expect(logOff).not.toHaveBeenCalled();
  });

  it('"Logging off…" is this screen\'s own: with another move running, the button says Log off, and pressing it runs nothing', async () => {
    void runMove({ type: 'start', to: 'github', step: 'github' }, () => new Promise<void>(() => {}));
    crashed('dropbox');
    fireEvent.click(button('Log off this device'));
    expect(button('Log off')).toBeTruthy();
    fireEvent.click(button('Log off'));
    await waitFor(() => expect(button('Log off').disabled).toBe(false));
    expect(logOff).not.toHaveBeenCalled();
  });

  it.each([
    ['a guest', 'local' as Backend, 'guest'],
    ['a cloud whose sign-in ended', 'dropbox' as Backend, 'reconnect'],
  ])('for %s, no log-off is offered, as the picker offers none, and the sentence says delete only', (_name, backend, state) => {
    vi.mocked(storageState).mockReturnValue(state as ReturnType<typeof storageState>);
    crashed(backend);
    expect(screen.getByText('Something went wrong. Reload the page to try again. You can still delete your data.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /log off/i })).toBeNull();
    expect(button('Delete all my data')).toBeTruthy();
  });

  it('a throw inside the crash screen shows the static message, never a blank page', () => {
    vi.mocked(storageState).mockImplementation(() => { throw new Error('store failed (test)'); });
    crashed('dropbox');
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('The health tool encountered an error. Please refresh the page to try again.')).toBeTruthy();
  });
});
