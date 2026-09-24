/**
 * US-09 AC16 (Sentry JAVASCRIPT-REMIX-6T / 6N / 6J): a browser that blocks
 * site storage still gets the widget. Every shape the field reported —
 * `localStorage` missing (Safari 26, "Can't find variable"), the getter
 * throwing a SecurityError (Chrome Mobile, "Access is denied"), and the
 * property being `null` (an old Android WebView) — resolves to the on-device
 * tier instead of rejecting `main()` before the mount is rendered.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GoogleDriveAdapter, LocalStorageAdapter } from '../src/storage';
import { BACKEND_KEY, forgetBackend, rememberBackend, rememberedBackend, resolveRemembered } from './connect';

const blockedStorage = {
  missing: () => {
    // `delete` only works when the property is configurable; stubGlobal then
    // covers the runtimes where it isn't. Either way there is no usable global.
    delete (globalThis as { localStorage?: unknown }).localStorage;
    if ('localStorage' in globalThis) vi.stubGlobal('localStorage', undefined);
  },
  denied: () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Failed to read the \'localStorage\' property from \'Window\': Access is denied for this document.', 'SecurityError'); },
    });
  },
  null: () => vi.stubGlobal('localStorage', null),
} as const;

const fakeStorage = (seed: Record<string, string> = {}) => {
  const backing = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
  return backing;
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('resolveRemembered on a browser that blocks storage (US-09 AC16)', () => {
  it.each(Object.keys(blockedStorage) as Array<keyof typeof blockedStorage>)('%s localStorage → the on-device tier, no throw', async shape => {
    blockedStorage[shape]();
    const resolved = await resolveRemembered();
    expect(resolved.backend).toBe('local');
    expect(resolved.adapter).toBeInstanceOf(LocalStorageAdapter);
    expect(resolved.reconnect).toBeUndefined();
    // The remembered-choice helpers are what the connect paths call next.
    expect(rememberedBackend()).toBeNull();
    expect(() => rememberBackend('dropbox')).not.toThrow();
    expect(() => forgetBackend()).not.toThrow();
  });
});

describe('resolveRemembered with working storage', () => {
  it('forgets a remembered cloud whose credentials are gone and runs on-device', async () => {
    vi.stubGlobal('location', { origin: 'https://example.test', pathname: '/roadmap' }); // the adapter's redirect URI
    const backing = fakeStorage({ [BACKEND_KEY]: 'dropbox' });
    const resolved = await resolveRemembered();
    expect(resolved.backend).toBe('local');
    expect(backing.has(BACKEND_KEY)).toBe(false);
  });

  it('ignores a value that names no backend, and forgets it', async () => {
    const backing = fakeStorage({ [BACKEND_KEY]: 'floppy' });
    expect((await resolveRemembered()).backend).toBe('local');
    expect(backing.has(BACKEND_KEY)).toBe(false);
  });

  // The Google Drive branches (review of PR #121): a connected Drive whose
  // token is valid or refreshes runs on Drive; one that cannot refresh runs
  // on-device with Reconnect offered and the remembered choice KEPT.
  describe('a remembered Google Drive', () => {
    const drive = (hasValidToken: boolean, refreshes: boolean) => {
      vi.stubGlobal('location', { origin: 'https://example.test', pathname: '/roadmap' });
      vi.spyOn(GoogleDriveAdapter.prototype, 'isConnected').mockReturnValue(true);
      vi.spyOn(GoogleDriveAdapter.prototype, 'hasValidToken').mockReturnValue(hasValidToken);
      vi.spyOn(GoogleDriveAdapter.prototype, 'tryServerRefresh').mockResolvedValue(refreshes);
      return fakeStorage({ [BACKEND_KEY]: 'google-drive' });
    };
    afterEach(() => { vi.restoreAllMocks(); });

    it.each([[true, false], [false, true]])('valid token %s, refresh %s → runs on Drive', async (valid, refreshes) => {
      const backing = drive(valid, refreshes);
      const resolved = await resolveRemembered();
      expect(resolved.backend).toBe('google-drive');
      expect(resolved.adapter).toBeInstanceOf(GoogleDriveAdapter);
      expect(backing.get(BACKEND_KEY)).toBe('google-drive');
    });

    it('no valid token and no refresh → on-device with Reconnect, choice kept', async () => {
      const backing = drive(false, false);
      const resolved = await resolveRemembered();
      expect(resolved.backend).toBe('local');
      expect(resolved.reconnect).toBe('google-drive');
      expect(backing.get(BACKEND_KEY)).toBe('google-drive');
    });
  });
});
