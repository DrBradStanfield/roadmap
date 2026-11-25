// @vitest-environment jsdom
/**
 * US-11 AC14: after a render crash the whole app's fallback still offers
 * "Delete all my data" and, on a connected cloud, the log-off, each through
 * its existing action: the erase's own confirm and store call, the picker's
 * own log-off step. The store and the log-off are fakes; the fallback, the
 * erase hook and the picker's step are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const data = vi.hoisted(() => ({ identity: 'e1', shown: 'e1', result: { success: true, chatErased: true } as Record<string, unknown> }));
vi.mock('../src/lib/roadmap-data', () => ({
  getEraseIdentity: () => data.identity,
  getShownErase: () => data.shown,
  askedUnder: () => data.shown,
  markEraseShown: (e: string) => { data.shown = e; },
  getBackendKind: () => 'cloud',
  deleteUserData: vi.fn(async () => { data.identity = 'e2'; return data.result; }),
  clearOffFileAfterErase: vi.fn(),
}));
vi.mock('./connect', async (importOriginal) => ({
  ...await importOriginal<typeof import('./connect')>(),
  storageState: vi.fn(() => 'cloud'),
  logOff: vi.fn(async () => {}),
}));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { CrashScreen } from './crash-screen';
import { clearOffFileAfterErase, deleteUserData } from '../src/lib/roadmap-data';
import { ERASE_CONFIRM } from '../src/lib/erase-copy';
import { logOff, storageState, type Backend } from './connect';

function Crash(): never {
  throw new Error('render crash (test)');
}

function crashed(backend: Backend) {
  return render(<ErrorBoundary fallback={<CrashScreen backend={backend} />}><Crash /></ErrorBoundary>);
}

let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  data.identity = 'e1'; data.shown = 'e1';
  vi.spyOn(console, 'error').mockImplementation(() => {}); // React's own report of the crash
  reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  vi.stubGlobal('alert', vi.fn());
  vi.mocked(storageState).mockReturnValue('cloud');
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('US-11 AC14: the crash screen keeps delete and log off within reach', () => {
  it('a render crash shows the sentence, Delete all my data and Log off this device', () => {
    crashed('dropbox');
    expect(screen.getByText('Something went wrong. Reload the page to try again. You can still delete your data or log off.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete all my data' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log off this device' })).toBeTruthy();
  });

  it('Delete all my data asks the erase confirm, erases through the store, says it, forgets the device copy and reloads', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    crashed('dropbox');
    fireEvent.click(screen.getByRole('button', { name: 'Delete all my data' }));
    expect(confirm).toHaveBeenCalledWith(ERASE_CONFIRM);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(deleteUserData).toHaveBeenCalledTimes(1);
    expect(clearOffFileAfterErase).toHaveBeenCalled();
    expect(vi.mocked(window.alert).mock.calls[0][0]).toMatch(/^Your health record and chat history are deleted\./);
  });

  it('a cancelled confirm erases nothing; a failed erase stays on the screen', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    crashed('dropbox');
    fireEvent.click(screen.getByRole('button', { name: 'Delete all my data' }));
    expect(deleteUserData).not.toHaveBeenCalled();
    vi.stubGlobal('confirm', vi.fn(() => true));
    data.result = { success: false, error: 'Already deleting your data.', chatErased: false };
    vi.mocked(deleteUserData).mockImplementationOnce(async () => data.result as never);
    fireEvent.click(screen.getByRole('button', { name: 'Delete all my data' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Already deleting your data.'));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete all my data' })).toBeTruthy();
    data.result = { success: true, chatErased: true };
  });

  it('Log off this device opens the picker\'s confirm, whose Log off runs the log-off for that cloud', async () => {
    crashed('dropbox');
    fireEvent.click(screen.getByRole('button', { name: 'Log off this device' }));
    expect(screen.getByRole('heading', { name: 'Log off this device?' })).toBeTruthy();
    expect(logOff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Log off' }));
    await waitFor(() => expect(logOff).toHaveBeenCalledWith('dropbox'));
  });

  it.each([
    ['a guest', 'local' as Backend, 'guest'],
    ['a cloud this session could not read', 'dropbox' as Backend, 'reconnect'],
  ])('for %s, no log-off is offered, as the picker offers none, and the sentence says delete only', (_name, backend, state) => {
    vi.mocked(storageState).mockReturnValue(state as ReturnType<typeof storageState>);
    crashed(backend);
    expect(screen.getByText('Something went wrong. Reload the page to try again. You can still delete your data.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /log off/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete all my data' })).toBeTruthy();
  });
});
