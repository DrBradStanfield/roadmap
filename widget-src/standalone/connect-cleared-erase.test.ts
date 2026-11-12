/**
 * US-11 AC6: the erase a device last cleared its off-file data for is kept
 * per record. A deliberate connect (a sign-in, or a switch of provider)
 * removes it, so the record connected to keeps its own erase at its first
 * load. A reload, a token refresh and a reconnect of the same record keep it.
 * (The reconnect and "use this browser only" pins live in storage-bar.test.tsx.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connect')>()),
  liftLocalInto: vi.fn(async () => {}),
}));

import { DropboxAdapter, GoogleDriveAdapter, LocalStorageAdapter } from '../src/storage';
import { CLEARED_ERASE_KEY } from '../src/lib/storage';
import { BACKEND_KEY, finishFormConnect } from './connect';
import { resolveBackend } from './resolve-backend';

const KEPT = '[3,"2026-10-21T10:05:00.000Z"]';
let backing: Map<string, string>;

beforeEach(() => {
  backing = new Map([[CLEARED_ERASE_KEY, KEPT]]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
  vi.stubGlobal('location', { origin: 'https://example.test', pathname: '/roadmap', search: '', reload: vi.fn() });
  vi.spyOn(DropboxAdapter, 'claimCancelledRedirect').mockReturnValue(false);
  vi.spyOn(GoogleDriveAdapter, 'claimCancelledRedirect').mockReturnValue(false);
  vi.spyOn(DropboxAdapter, 'completeRedirect').mockResolvedValue(null);
  vi.spyOn(GoogleDriveAdapter, 'completeRedirect').mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('US-11 AC6: a connect removes the kept erase', () => {
  it('a Dropbox sign-in (the OAuth return) removes it', async () => {
    vi.mocked(DropboxAdapter.completeRedirect).mockResolvedValue(Object.create(DropboxAdapter.prototype));
    expect((await resolveBackend()).resolved.backend).toBe('dropbox');
    expect(backing.has(CLEARED_ERASE_KEY)).toBe(false);
  });

  it('a Google Drive sign-in (the OAuth return) removes it', async () => {
    vi.mocked(GoogleDriveAdapter.completeRedirect).mockResolvedValue(Object.create(GoogleDriveAdapter.prototype));
    expect((await resolveBackend()).resolved.backend).toBe('google-drive');
    expect(backing.has(CLEARED_ERASE_KEY)).toBe(false);
  });

  it('a form connect (GitHub, self-host) removes it', async () => {
    const adapter = new LocalStorageAdapter();
    vi.spyOn(adapter, 'connect').mockResolvedValue();
    await finishFormConnect(adapter, 'github');
    expect(backing.has(CLEARED_ERASE_KEY)).toBe(false);
    expect(backing.get(BACKEND_KEY)).toBe('github');
  });
});

describe('US-11 AC6: a load that connects nothing keeps the kept erase', () => {
  it('a reload on the on-device record', async () => {
    expect((await resolveBackend()).resolved.backend).toBe('local');
    expect(backing.get(CLEARED_ERASE_KEY)).toBe(KEPT);
  });

  it('a reload on a remembered Google Drive that refreshes its token', async () => {
    backing.set(BACKEND_KEY, 'google-drive');
    vi.spyOn(GoogleDriveAdapter.prototype, 'isConnected').mockReturnValue(true);
    vi.spyOn(GoogleDriveAdapter.prototype, 'hasValidToken').mockReturnValue(false);
    vi.spyOn(GoogleDriveAdapter.prototype, 'tryServerRefresh').mockResolvedValue(true);
    expect((await resolveBackend()).resolved.backend).toBe('google-drive');
    expect(backing.get(CLEARED_ERASE_KEY)).toBe(KEPT);
  });

  it('a reload whose Drive cannot refresh runs on-device and keeps it', async () => {
    backing.set(BACKEND_KEY, 'google-drive');
    vi.spyOn(GoogleDriveAdapter.prototype, 'isConnected').mockReturnValue(true);
    vi.spyOn(GoogleDriveAdapter.prototype, 'hasValidToken').mockReturnValue(false);
    vi.spyOn(GoogleDriveAdapter.prototype, 'tryServerRefresh').mockResolvedValue(false);
    expect((await resolveBackend()).resolved.reconnect).toBe('google-drive');
    expect(backing.get(CLEARED_ERASE_KEY)).toBe(KEPT);
  });
});
