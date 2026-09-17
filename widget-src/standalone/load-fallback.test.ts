/**
 * US-09 AC13 (Sentry JAVASCRIPT-REMIX-6G / 6K, 2026-09-17): a cloud record
 * that cannot be read at load never leaves the mount empty — the session runs
 * on the device copy, offers Reconnect where one exists, and marks the
 * merge-up so those edits reach the cloud on the next good session.
 *
 * Real LocalStorageAdapter + RoadmapStore on a fake localStorage; the cloud is
 * a MemoryAdapter that refuses the way Drive did (StorageError, status 403).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryAdapter, ROADMAP_FILE_NAME, StorageError, createEmptyFile, type StorageAdapter } from '@roadmap/health-core';
import { LocalStorageAdapter, isSyncPending, syncPendingSince } from '../src/storage';
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
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    });
    captureException.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['google-drive', 'google-drive'],
    ['dropbox', 'dropbox'],
    ['github', 'github'],
  ] as const)('a %s record the provider refuses at load runs on-device, marker set, reported once', async (backend, reconnect) => {
    const started = await startOnBackend({ adapter: new RefusingCloud(), backend }, init);
    expect(started.backend).toBe('local');
    expect(started.adapter).toBeInstanceOf(LocalStorageAdapter);
    expect(started.reconnect).toBe(reconnect); // US-09 AC13: the provider is named, never the guest pitch
    expect(isSyncPending()).toBe(true); // the next good cloud session merges this one's edits up
    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0] as [Error, { tags: Record<string, string> }];
    expect(context.tags).toEqual({ area: 'cloud-sync', op: 'load', backend });
    expect(error.message).toBe('Cloud record could not be loaded');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(PROVIDER_BODY);
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

describe('a fallback session\'s edits reach the cloud (US-09 AC13)', () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('US-09 AC13: the marker records WHEN the session went on-device, and keeps the earliest', async () => {
    const before = new Date().toISOString();
    await startOnBackend({ adapter: new RefusingCloud(), backend: 'dropbox' }, init);
    const since = syncPendingSince();
    expect(since).not.toBeNull();
    expect(since! >= before).toBe(true);
    // A second failure in the same session must not move the start time forward
    // — everything written since the FIRST one is still waiting.
    await startOnBackend({ adapter: new RefusingCloud(), backend: 'dropbox' }, init);
    expect(syncPendingSince()).toBe(since);
  });

  it('US-09 AC13: a row typed before the save that failed is still unsynced, not stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-06-01T10:00:00.000Z');
    vi.setSystemTime(t0);

    class SaveFails extends MemoryAdapter {
      async write(): Promise<never> {
        throw new StorageError('cloud down');
      }
    }
    const store = await RoadmapStore.create(new SaveFails());
    store.addMeasurement('weight', 80); // typed at t0, while the two were in step
    vi.setSystemTime(new Date(t0.getTime() + 500)); // the debounce, then the doomed request
    await expect(store.flush()).rejects.toThrow();

    // The marker names the last moment device and cloud agreed (t0), NOT the
    // failure (t0+500ms) — the row was typed in between and must still travel.
    expect(syncPendingSince()).toBe(t0.toISOString());
    vi.useRealTimers();

    const cloud = new MemoryAdapter();
    const erased = createEmptyFile({ deviceId: 'other-device', now: '2026-01-01T00:00:00Z' });
    erased.meta.eraseEpoch = 1;
    await cloud.write(ROADMAP_FILE_NAME, erased, null);
    const recovered = await RoadmapStore.create(cloud);
    expect(recovered.loadAllHistory().map((m) => m.value)).toEqual([80]);
  });

  it('US-09 AC13: an erased cloud still wins, but the edits made on-device survive', async () => {
    const started = await startOnBackend({ adapter: new RefusingCloud(), backend: 'dropbox' }, init);
    const onDevice = await RoadmapStore.create(started.adapter);
    onDevice.addMeasurement('weight', 80);
    await onDevice.flush();

    // The cloud comes back — and another device erased the record at some point,
    // so its eraseEpoch outranks the empty file this session started from.
    const cloud = new MemoryAdapter();
    const erased = createEmptyFile({ deviceId: 'other-device', now: '2026-01-01T00:00:00Z' });
    erased.meta.eraseEpoch = 1;
    await cloud.write(ROADMAP_FILE_NAME, erased, null);

    const store = await RoadmapStore.create(cloud);
    expect(store.loadAllHistory().map((m) => m.value)).toEqual([80]);
    await store.flush();
    expect(isSyncPending()).toBe(false); // lifted up, so the marker clears
    const { body } = (await cloud.read(ROADMAP_FILE_NAME)) as { body: { measurements: unknown[]; meta: { eraseEpoch: number } } };
    expect(body.measurements).toHaveLength(1);
    expect(body.meta.eraseEpoch).toBe(1); // the erase itself still stands
  });
});
