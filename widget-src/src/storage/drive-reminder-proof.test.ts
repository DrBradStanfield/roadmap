/**
 * US-17 AC1 — auto-enrolment may NEVER open a Google popup.
 *
 * Auto-enrolment runs unprompted at page load, where a popup is both blocked by
 * the browser and something the user never asked for. `getReminderProof(silent)`
 * is the one place that decision is enforced, so it gets a real test rather than
 * a mocked one: standalone/reminders.test.ts stubs this adapter out entirely and
 * can only prove that the SILENT FLAG IS PASSED, never that it is honoured.
 *
 * The differential is the assertion: same state, silent → null and no GIS call;
 * non-silent → the GIS token client IS invoked (the popup path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDriveAdapter } from './drive';

const CONFIG = {
  clientId: 'test-client-id',
  scope: 'openid email https://www.googleapis.com/auth/drive.file',
  redirectUri: 'https://example.com/',
  exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
};

const initTokenClient = vi.fn(() => ({ requestAccessToken: vi.fn() }));

function makeStorage(): Storage {
  const s = new Map<string, string>();
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}

describe('GoogleDriveAdapter.getReminderProof — the silent contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', makeStorage());
    // A GIS client that is READY: if the popup path is taken it will be reached
    // immediately, so "not called" means the code chose not to, not that it failed.
    vi.stubGlobal('window', { google: { accounts: { oauth2: { initTokenClient } } } });
    // No refresh token stored → tryServerRefresh() bails before any network call,
    // which is exactly the state where the old code fell through to the popup.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null and opens NO popup when no silent proof is available', async () => {
    const proof = await new GoogleDriveAdapter(CONFIG).getReminderProof(true);

    expect(proof).toBeNull();
    expect(initTokenClient).not.toHaveBeenCalled();
  });

  it('still falls back to the popup on the MANUAL path (a click can open one)', async () => {
    // Never resolves — the stub client's callback is never invoked. We only care
    // that the popup path was entered, which is the contrast with the case above.
    const pending = new GoogleDriveAdapter(CONFIG).getReminderProof(false);
    await vi.waitFor(() => expect(initTokenClient).toHaveBeenCalledTimes(1));
    void pending.catch(() => {}); // no unhandled rejection if the suite tears down
  });

  it('defaults to the non-silent (popup-capable) behaviour when called with no argument', async () => {
    const pending = new GoogleDriveAdapter(CONFIG).getReminderProof();
    await vi.waitFor(() => expect(initTokenClient).toHaveBeenCalledTimes(1));
    void pending.catch(() => {});
  });
});
