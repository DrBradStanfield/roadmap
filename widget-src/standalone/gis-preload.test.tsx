// @vitest-environment jsdom
/**
 * US-09 AC30: "Sign in to Google again" from the top bar, through the real
 * GoogleDriveAdapter and the real GIS loader; only the Google script itself is
 * stood in for. A script that loads after the click can outlast the click's
 * user activation and the popup is blocked, so GIS loads when the bar mounts,
 * and a click that still beats it says so instead of starting a doomed popup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';

vi.mock('./google-config', () => ({
  googleDriveConfig: () => ({ clientId: 'test-client', redirectUri: 'http://localhost/', exchangeUrl: 'http://localhost/x', scope: 'https://www.googleapis.com/auth/drive.file' }),
}));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', async (original) => ({
  ...(await original<typeof import('./connect')>()),
  liftLocalInto: vi.fn(),
  rememberBackend: vi.fn(),
}));

import { GIS_LOADING, StorageBar } from './sync-control';

// The GIS loader polls for window.google every 50 ms for up to 10 s, and the
// script never arrives here. On real timers those polls outlive the file and
// fire after jsdom has gone ("window is not defined", flaky in CI), so they run
// on fake timers and are dropped after each test.
beforeEach(() => { vi.useFakeTimers(); });

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  cleanup();
  delete (window as unknown as { google?: unknown }).google;
  document.querySelectorAll('script[src*="gsi/client"]').forEach((s) => s.remove());
});

const bar = () => document.querySelector('button.action-btn-small') as HTMLButtonElement;

describe('US-09 AC30 — the Drive popup opens inside the click', () => {
  it('starts loading GIS as soon as the bar shows the Drive reconnect', () => {
    render(<StorageBar backend="local" reconnect="google-drive" />);
    expect(bar().textContent).toBe('Sign in to Google again');
    expect(document.querySelector('script[src="https://accounts.google.com/gsi/client"]')).not.toBeNull();
  });

  it('a click before GIS has loaded says so and opens nothing; once loaded, the next click asks Google at once', () => {
    render(<StorageBar backend="local" reconnect="google-drive" />);
    fireEvent.click(bar());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(GIS_LOADING);

    // The Google script arrives.
    const requestAccessToken = vi.fn();
    const initTokenClient = vi.fn(() => ({ requestAccessToken }));
    (window as unknown as { google: unknown }).google = { accounts: { oauth2: { initTokenClient } } };

    fireEvent.click(bar());
    // Synchronously, inside the click: no await between the tap and the popup.
    expect(initTokenClient).toHaveBeenCalledWith(expect.objectContaining({ client_id: 'test-client' }));
    expect(requestAccessToken).toHaveBeenCalledTimes(1);
  });

  it('a Google script that failed to load is fetched again by the next tap, not waited on forever (US-09 AC30a)', () => {
    // The bar shows "Sign in to Google again" because Drive could not be
    // reached at page load, which is when the preload is most likely to fail.
    render(<StorageBar backend="local" reconnect="google-drive" />);
    const failed = document.querySelector('script[src*="gsi/client"]')!;
    failed.dispatchEvent(new Event('error')); // the network was down

    // The network is back. The tap still beats the new load, so it says so...
    fireEvent.click(bar());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(GIS_LOADING);
    // ...but it has asked for the script again, in place of the dead one.
    const scripts = document.querySelectorAll('script[src="https://accounts.google.com/gsi/client"]');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).not.toBe(failed);

    // A second failure is fetched again too: every tap can recover, not one.
    scripts[0].dispatchEvent(new Event('error'));
    fireEvent.click(bar());
    const again = document.querySelectorAll('script[src*="gsi/client"]');
    expect(again).toHaveLength(1);
    expect(again[0]).not.toBe(scripts[0]);
  });

  it('a script still loading is not fetched twice', () => {
    render(<StorageBar backend="local" reconnect="google-drive" />);
    const loading = document.querySelector('script[src*="gsi/client"]');
    fireEvent.click(bar());
    fireEvent.click(bar());
    const scripts = document.querySelectorAll('script[src*="gsi/client"]');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toBe(loading);
  });
});
