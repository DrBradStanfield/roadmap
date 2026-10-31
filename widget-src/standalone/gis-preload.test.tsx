// @vitest-environment jsdom
/**
 * US-09 AC30: "Sign in to Google again" from the top bar, through the real
 * GoogleDriveAdapter and the real GIS loader; only the Google script itself is
 * stood in for. A script that loads after the click can outlast the click's
 * user activation and the popup is blocked, so GIS loads when the bar mounts,
 * and a click that still beats it says so instead of starting a doomed popup.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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

afterEach(() => {
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
});
