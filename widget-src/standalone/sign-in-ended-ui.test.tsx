// @vitest-environment jsdom
/**
 * US-09 AC48 (design §5 test 6, Brad B-1 and Q1 option a): when the page
 * learns a sign-in ended, the storage bar and the reconnect panel change on the
 * same mount, with no reload. Dropbox uses Drive's words with the name
 * swapped, and its button starts the Dropbox sign-in instead of a reload. A
 * Dropbox outage at load keeps "could not be reached" and Retry.
 *
 * Real SyncControl, StorageBar, switch-flow, connect.ts, sign-in state and
 * adapters; the data layer's save facts are stubbed as saved.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

const flush = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/lib/roadmap-data', () => ({
  currentSaveStatus: () => 'saved', currentRetryDue: () => false,
  flushRoadmapStore: flush, copyRecordToDevice: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false, clearAutoEnrolBlock: vi.fn() }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));

import { StorageBar, SyncControl } from './sync-control';
import { resetSwitchFlow } from './switch-flow';
import { bootSignIn, resetSignIn, signInEnded } from '../src/storage/sign-in-state';

const BACKEND_KEY = 'health_roadmap_backend';
let reload: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetSignIn();
  reload = vi.fn();
  assign = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload, assign }, writable: true, configurable: true });
});
afterEach(() => { cleanup(); resetSwitchFlow(); flush.mockClear(); });

const mount = (backend: 'google-drive' | 'dropbox' | 'local') => render(
  <>
    <StorageBar backend={backend} />
    <SyncControl backend={backend} hasData />
  </>,
);
const stateText = () => document.querySelector('.hr-storage-state')?.textContent;
const bar = () => document.querySelector('button.action-btn-small')?.textContent;
const status = () => document.querySelector('.hr-sync-status')?.textContent;
const panelButton = () => document.querySelector<HTMLButtonElement>('button.hr-sync-btn');
const detail = () => document.querySelector('.hr-sync-detail')?.textContent;

describe('US-09 AC48: the bar and the panel change in place when the sign-in ends', () => {
  it('Google Drive', () => {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    bootSignIn({ kind: 'signedIn', provider: 'google-drive' });
    const view = mount('google-drive');
    expect(stateText()).toBe('Synced to Google Drive');
    act(() => signInEnded('google-drive', null));
    expect(view.container.isConnected).toBe(true); // the same mount
    expect(bar()).toBe('Sign in to Google again');
    expect(status()).toBe('Google Drive is signed out');
    expect(panelButton()?.textContent).toBe('Reconnect Google Drive');
    expect(reload).not.toHaveBeenCalled();
  });

  it('Dropbox, in Drive\'s words with the name swapped (Brad, Q1 option a)', () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    bootSignIn({ kind: 'signedIn', provider: 'dropbox' });
    mount('dropbox');
    expect(stateText()).toBe('Synced to Dropbox');
    act(() => signInEnded('dropbox', null));
    expect(bar()).toBe('Sign in to Dropbox again');
    expect(status()).toBe('Dropbox is signed out');
    expect(panelButton()?.textContent).toBe('Reconnect Dropbox');
    expect(detail()).toBe('Your record is safe in your Dropbox. Sign in again to keep it in step. Anything you change meanwhile is kept in this browser and merges when you reconnect.');
    expect(reload).not.toHaveBeenCalled();
  });

  it('"Reconnect Dropbox" saves the session, then starts the Dropbox sign-in: a redirect, not a reload', async () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    bootSignIn({ kind: 'signedIn', provider: 'dropbox' });
    mount('dropbox');
    act(() => signInEnded('dropbox', null));
    fireEvent.click(panelButton()!);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0]);
    expect(String(assign.mock.calls[0][0])).toMatch(/^https:\/\/www\.dropbox\.com\/oauth2\/authorize\?/);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a Dropbox sign-in refused at load shows the same words', () => {
    bootSignIn({ kind: 'signedOut', provider: 'dropbox' });
    mount('local');
    expect([bar(), status(), panelButton()?.textContent]).toEqual(['Sign in to Dropbox again', 'Dropbox is signed out', 'Reconnect Dropbox']);
  });

  it('a Dropbox that could not be reached at load keeps its outage words, and Retry reloads', () => {
    bootSignIn({ kind: 'unreachable', provider: 'dropbox' });
    mount('local');
    expect([bar(), status(), panelButton()?.textContent]).toEqual(['Retry', 'Dropbox could not be reached', 'Retry']);
    fireEvent.click(panelButton()!);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a raise for a provider this page is not on changes nothing', () => {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    bootSignIn({ kind: 'signedIn', provider: 'google-drive' });
    mount('google-drive');
    act(() => signInEnded('dropbox', null));
    expect(stateText()).toBe('Synced to Google Drive');
  });
});
