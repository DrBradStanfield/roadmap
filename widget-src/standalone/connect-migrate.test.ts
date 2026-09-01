/**
 * US-09 AC3 (guest data lifts up on first connect) + AC2 (copy-down before a
 * switch) — pinned after the 2026-08-14 sentry-fix run found migrateLocalInto()
 * and copyDownToDevice() silently no-oping: both called `adapter.read()` without
 * the required file name and destructured `{file}` from a ReadResult whose shape
 * is `{body, version}`, so the local body was always undefined and the lift/copy
 * never ran. No error, no Sentry event — the connect flow "succeeded" while the
 * user's on-device data never reached their cloud. (Nothing typechecks
 * standalone/, so tsc never caught it: see docs/loops/sentry-fix/2026-08-14.md.)
 *
 * These tests drive the REAL LocalStorageAdapter + SyncManager against a
 * MemoryAdapter cloud — no mocks — so a regression to the broken call shape
 * fails on the observable outcome (the cloud/local file contents).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RoadmapFile } from '@roadmap/health-core';
import { MemoryAdapter, MemoryCloud, LocalStorageAdapter } from '../src/storage';
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core';
import { RoadmapStore, PENDING_MIRROR_KEY } from '../src/storage/roadmap-store';
import { migrateLocalInto, copyDownFrom, liftLocalInto } from './connect';

function readCloudFile(cloud: MemoryCloud): RoadmapFile {
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
}

describe('connect helpers lift/copy real data (US-09 AC2/AC3)', () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    const store = {
      getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    };
    Object.defineProperty(globalThis, 'localStorage', { value: store, writable: true, configurable: true });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('migrateLocalInto lifts on-device guest data into a freshly-connected cloud (AC3)', async () => {
    // Guest session: data entered on the local tier before any cloud existed.
    const local = await RoadmapStore.create(new LocalStorageAdapter());
    local.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    await local.flush();

    const cloud = new MemoryCloud();
    await migrateLocalInto(new MemoryAdapter(cloud));

    const file = readCloudFile(cloud);
    expect(file.measurements.map((m) => [m.metricType, m.value])).toEqual([['weight', 80]]);
  });

  it('migrateLocalInto merges with existing cloud data, never overwrites (AC3)', async () => {
    const cloud = new MemoryCloud();
    const seeded = await RoadmapStore.create(new MemoryAdapter(cloud));
    seeded.addMeasurement('ldl', 3.2, '2024-02-01T00:00:00.000Z');
    await seeded.flush();

    const local = await RoadmapStore.create(new LocalStorageAdapter());
    local.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    await local.flush();

    await migrateLocalInto(new MemoryAdapter(cloud));

    const rows = readCloudFile(cloud).measurements.map((m) => [m.metricType, m.value]).sort();
    expect(rows).toEqual([['ldl', 3.2], ['weight', 80]]);
  });

  it('migrateLocalInto with no on-device data is a no-op (nothing created in the cloud)', async () => {
    const cloud = new MemoryCloud();
    await migrateLocalInto(new MemoryAdapter(cloud));
    expect(cloud.files.size).toBe(0);
  });

  it('a corrupt on-device file never breaks the connect flow (resolves, cloud untouched)', async () => {
    localStorage.setItem('health_roadmap_file_v2', '{not valid json');
    const cloud = new MemoryCloud();
    await expect(migrateLocalInto(new MemoryAdapter(cloud))).resolves.toBeUndefined();
    expect(cloud.files.size).toBe(0);
  });

  it('a failed lift sets the pending-mirror marker, so the store recovery path retries it (US-09 AC4 wiring)', async () => {
    const local = await RoadmapStore.create(new LocalStorageAdapter());
    local.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    await local.flush();

    class WriteFailsAdapter extends MemoryAdapter {
      async write(): Promise<never> {
        throw new StorageError('cloud down');
      }
    }
    await liftLocalInto(new WriteFailsAdapter(), 'google-drive');

    // The connect flow was not blocked (liftLocalInto resolved) and the marker
    // is set — RoadmapStore.create() on the next line of app.tsx merges the
    // on-device file up (pinned by 'the next cloud session merges…' above).
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();
    // Local data untouched.
    const { body } = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
    expect((body as RoadmapFile).measurements).toHaveLength(1);
  });

  it('copyDownFrom copies the cloud file down to this device, merged (AC2)', async () => {
    const cloud = new MemoryCloud();
    const seeded = await RoadmapStore.create(new MemoryAdapter(cloud));
    seeded.addMeasurement('ldl', 3.2, '2024-02-01T00:00:00.000Z');
    await seeded.flush();

    const local = await RoadmapStore.create(new LocalStorageAdapter());
    local.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    await local.flush();

    await copyDownFrom(new MemoryAdapter(cloud));

    const { body } = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
    const rows = (body as RoadmapFile).measurements.map((m) => [m.metricType, m.value]).sort();
    expect(rows).toEqual([['ldl', 3.2], ['weight', 80]]);
  });
});
