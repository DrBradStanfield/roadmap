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
import { MemoryAdapter, ROADMAP_FILE_NAME, StorageError, createEmptyFile, type RoadmapFile, type StorageAdapter } from '@roadmap/health-core';
import { LocalStorageAdapter, isSyncPending } from '../src/storage';
import { ERASE_UNREACHABLE, RoadmapStore } from '../src/storage/roadmap-store';
import * as data from '../src/lib/roadmap-data';
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
    vi.resetAllMocks();
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
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  class SaveFails extends MemoryAdapter {
    async write(): Promise<never> {
      throw new StorageError('cloud down');
    }
  }

  /** A cloud another device erased under US-09 AC23: it listed the rows it
   *  removed, none of them this device's. */
  async function listedCloud(): Promise<MemoryAdapter> {
    const cloud = new MemoryAdapter();
    const erased = createEmptyFile({ deviceId: 'other-device', now: '2026-06-01T10:00:01.000Z' });
    erased.schemaVersion = 2;
    erased.meta.eraseEpoch = 1;
    erased.meta.erasedAt = '2026-06-01T10:00:01.000Z';
    erased.erasedRows = { fromEpoch: 1, ids: ['row-the-other-device-erased'] };
    await cloud.write(ROADMAP_FILE_NAME, erased, null);
    return cloud;
  }

  it('US-09 AC23: a weight, a medication and a supplement typed against an erased cloud survive, with their histories', async () => {
    const guest = await RoadmapStore.create(new SaveFails());
    guest.saveMedication('statin', 'atorvastatin', 20, 'mg');
    guest.saveSupplement('omega3', 'Omega-3');
    guest.addMeasurement('weight', 80, '2026-06-01');
    await expect(guest.flush()).rejects.toThrow();
    expect(isSyncPending()).toBe(true);

    const cloud = await listedCloud();
    const { file } = (await RoadmapStore.create(cloud)) as unknown as { file: RoadmapFile };
    expect(file.medications.map((m) => m.medicationKey)).toEqual(['statin']);
    expect(file.medicationHistory.map((m) => m.medicationKey)).toEqual(['statin']);
    expect(file.supplements.map((m) => m.supplementKey)).toEqual(['omega3']);
    expect(file.supplementHistory.map((m) => m.supplementKey)).toEqual(['omega3']);
    expect(file.measurements.map((m) => m.value)).toEqual([80]);
    expect(file.meta.eraseEpoch).toBe(1); // the erase itself still stands
    expect(file.erasedRows).toEqual({ fromEpoch: 1, ids: ['row-the-other-device-erased'] });
  });

  // AC23 residual (b): typed BEFORE the erase on a device that had not sent
  // it. No erase saw it, so it is kept, as the AC14 marker kept it before.
  it('US-09 AC23: a row the session typed before another device\'s erase survives it too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z')); // a second before the erase
    const store = await RoadmapStore.create(new SaveFails());
    store.addMeasurement('weight', 80, '2026-06-01');
    await expect(store.flush()).rejects.toThrow();
    vi.useRealTimers();

    const recovered = await RoadmapStore.create(await listedCloud());
    expect(recovered.loadAllHistory().map((m) => m.value)).toEqual([80]);
  });

  it('US-09 AC23: an erased cloud still wins, but the edits made on-device survive', async () => {
    const started = await startOnBackend({ adapter: new RefusingCloud(), backend: 'dropbox' }, init);
    const onDevice = await RoadmapStore.create(started.adapter);
    onDevice.addMeasurement('weight', 80);
    await onDevice.flush();

    // The cloud comes back, and another device erased the record meanwhile.
    const cloud = await listedCloud();
    const store = await RoadmapStore.create(cloud);
    expect(store.loadAllHistory().map((m) => m.value)).toEqual([80]);
    await store.flush();
    expect(isSyncPending()).toBe(false); // lifted up, so the marker clears
    const { body } = (await cloud.read(ROADMAP_FILE_NAME)) as { body: RoadmapFile };
    expect(body.measurements).toHaveLength(1);
    expect(body.meta.eraseEpoch).toBe(1); // the erase itself still stands
  });

  // Stated in AC23: an erase made before the list existed listed nothing, so
  // only AC20's window speaks, and it rescues created rows alone.
  it('US-09 AC23: against a cloud erased before the list existed, a fallback medication is lost and a later weight is kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-01T10:00:05.000Z'));
    const guest = await RoadmapStore.create(new SaveFails());
    guest.saveMedication('statin', 'atorvastatin', 20, 'mg');
    guest.addMeasurement('weight', 80, '2026-06-01');
    await expect(guest.flush()).rejects.toThrow();
    vi.useRealTimers();

    const cloud = new MemoryAdapter();
    const legacy = createEmptyFile({ deviceId: 'other-device', now: '2026-06-01T10:00:01.000Z' });
    legacy.meta.eraseEpoch = 1;
    legacy.meta.erasedAt = '2026-06-01T10:00:01.000Z';
    await cloud.write(ROADMAP_FILE_NAME, legacy, null);
    const { file } = (await RoadmapStore.create(cloud)) as unknown as { file: RoadmapFile };
    expect(file.medications).toEqual([]);
    expect(file.measurements.map((m) => m.value)).toEqual([80]);
  });

  it('US-09 AC23: an erase in a fallback session is refused before the reminders hook and the chat erase, and changes nothing', async () => {
    vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
    const started = await startOnBackend({ adapter: new RefusingCloud(), backend: 'google-drive' }, data.initRoadmapStore);
    expect(started.reconnect).toBe('google-drive');
    await data.addMeasurement('weight', 80, '2026-06-01');
    await data.flushRoadmapStore();
    const before = localStorage.getItem('health_roadmap_file_v2');
    const hook = vi.fn(async () => {});
    data.setPreEraseHook(hook);

    expect(await data.deleteUserData()).toEqual({ success: false, error: ERASE_UNREACHABLE, chatErased: false });
    expect(hook).not.toHaveBeenCalled();
    expect(localStorage.getItem('health_roadmap_file_v2')).toBe(before);
    expect((await data.loadAllHistory()).map((m) => m.value)).toEqual([80]);
  });
});
