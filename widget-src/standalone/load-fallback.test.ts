/**
 * US-09 AC13 (Sentry JAVASCRIPT-REMIX-6G / 6K, 2026-09-17): a cloud record
 * that cannot be read at load never leaves the mount empty. A Google Drive
 * grant without the `drive.file` scope refreshed fine and then answered every
 * lookup with a 403; `main()` awaited the first read with no catch, so the
 * widget never rendered for that user, on every visit. The session must run
 * on the device copy instead, offer Reconnect where a reconnect exists, and
 * mark the merge-up so those edits reach the cloud on the next good session.
 *
 * Real LocalStorageAdapter + RoadmapStore on a fake localStorage; the cloud is
 * a MemoryAdapter that refuses the way Drive did (StorageError, status 403).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryAdapter, StorageError, type StorageAdapter } from '@roadmap/health-core';
import { LocalStorageAdapter, isSyncPending } from '../src/storage';
import { RoadmapStore } from '../src/storage/roadmap-store';
import { startOnBackend, type ResolvedBackend } from './connect';

const captureException = vi.fn();
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: (...args: unknown[]) => captureException(...args) } }));

const PROVIDER_BODY = 'ACCESS_TOKEN_SCOPE_INSUFFICIENT';

class RefusingCloud extends MemoryAdapter {
  async read(): Promise<never> {
    throw new StorageError(`Google Drive lookup failed (403): ${PROVIDER_BODY}`, undefined, undefined, 403);
  }
}

const init = async (adapter: StorageAdapter): Promise<void> => {
  await RoadmapStore.create(adapter);
};

describe('startOnBackend (US-09 AC13)', () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    const store = {
      getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    };
    Object.defineProperty(globalThis, 'localStorage', { value: store, writable: true, configurable: true });
    captureException.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    vi.restoreAllMocks();
  });

  it('a Drive record the provider refuses at load runs the session on-device with Reconnect offered', async () => {
    const resolved: ResolvedBackend = { adapter: new RefusingCloud(), backend: 'google-drive' };
    const started = await startOnBackend(resolved, init);
    expect(started.backend).toBe('local');
    expect(started.reconnect).toBe('google-drive');
    expect(started.adapter).toBeInstanceOf(LocalStorageAdapter);
    // The next good cloud session merges this session's edits up.
    expect(isSyncPending()).toBe(true);
  });

  it('reports the failure once, scrub-shaped: closed tags, no provider text', async () => {
    await startOnBackend({ adapter: new RefusingCloud(), backend: 'google-drive' }, init);
    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0] as [Error, { tags: Record<string, string> }];
    expect(context.tags).toEqual({ area: 'cloud-sync', op: 'load', backend: 'google-drive' });
    expect(error.message).toBe('Cloud record could not be loaded');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(PROVIDER_BODY);
  });

  it('a backend with no in-page reconnect still falls back, marker set, no Reconnect offered', async () => {
    const started = await startOnBackend({ adapter: new RefusingCloud(), backend: 'dropbox' }, init);
    expect(started.backend).toBe('local');
    expect(started.reconnect).toBeUndefined();
    expect(isSyncPending()).toBe(true);
  });

  it('a healthy cloud starts as resolved and sets no marker', async () => {
    const resolved: ResolvedBackend = { adapter: new MemoryAdapter(), backend: 'google-drive' };
    await expect(startOnBackend(resolved, init)).resolves.toBe(resolved);
    expect(isSyncPending()).toBe(false);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('the on-device tier has nothing to fall back to, so its failure still throws', async () => {
    const failing = async (): Promise<void> => {
      throw new StorageError('Local data is corrupt and could not be read.');
    };
    await expect(startOnBackend({ adapter: new LocalStorageAdapter(), backend: 'local' }, failing)).rejects.toThrow(/corrupt/);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('a defect (not a storage failure) still throws instead of hiding on-device', async () => {
    const defect = async (): Promise<void> => {
      throw new TypeError('x is not a function');
    };
    await expect(startOnBackend({ adapter: new MemoryAdapter(), backend: 'google-drive' }, defect)).rejects.toThrow(TypeError);
    expect(isSyncPending()).toBe(false);
  });
});
