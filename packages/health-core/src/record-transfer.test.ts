/**
 * The lift on connect and the copy-down before a switch, in the engine
 * (US-09 AC2, AC3, AC4, AC23). The widget's connect-migrate tests pin the
 * same rules through standalone/connect.ts.
 */
import { describe, expect, it } from 'vitest';
import { copyCloudDown, liftDeviceCopy } from './record-transfer';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ROADMAP_FILE_NAME, StorageError } from './adapter';
import type { RecordHost } from './record-host';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';

const NOW = Date.parse('2026-10-21T10:00:00.000Z');

function host(cloud: MemoryAdapter, device: MemoryAdapter) {
  const pending = { value: false };
  const h = {
    tier: 'cloud', store: cloud, deviceId: () => 'phone', clock: { now: () => NOW },
    timers: { set: () => 0, clear: () => {} }, remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
    clearOffFileData: () => {},
    mirror: {
      adapter: device, writesStopped: () => false, wipe: async () => {}, opened: () => {},
      pending: { get: () => pending.value, set: () => { pending.value = true; }, clear: () => { pending.value = false; } },
    },
  } as Extract<RecordHost, { tier: 'cloud' }>;
  return { host: h, pending };
}

function record(ids: string[], epoch = 0): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'd', now: '2026-10-01T00:00:00.000Z' });
  file.meta.eraseEpoch = epoch;
  file.measurements = ids.map((id, i) => createMeasurement({ id, metricType: 'weight', value: 70 + i, recordedAt: `2026-10-0${i + 1}`, createdAt: '2026-10-01T00:00:00.000Z' }));
  return file;
}
const put = (a: MemoryAdapter, file: RoadmapFile) => a.cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
const get = (a: MemoryAdapter): RoadmapFile => JSON.parse(a.cloud.files.get(ROADMAP_FILE_NAME)!.json);
const ids = (file: RoadmapFile) => file.measurements.map((m) => m.id).sort();

describe('liftDeviceCopy (US-09 AC3, AC4)', () => {
  it('merges the device copy into the cloud, never over it', async () => {
    const cloud = new MemoryAdapter(new MemoryCloud());
    const device = new MemoryAdapter(new MemoryCloud());
    put(cloud, record(['c']));
    put(device, record(['d']));
    expect(await liftDeviceCopy(host(cloud, device).host)).toBe('lifted');
    expect(ids(get(cloud))).toEqual(['c', 'd']);
  });

  it('writes nothing when the device holds no record, and skips one it cannot read', async () => {
    const cloud = new MemoryAdapter(new MemoryCloud());
    expect(await liftDeviceCopy(host(cloud, new MemoryAdapter(new MemoryCloud())).host)).toBe('empty');
    class Unreadable extends MemoryAdapter {
      async read(): Promise<never> { throw new StorageError('corrupt'); }
    }
    expect(await liftDeviceCopy(host(cloud, new Unreadable()).host)).toBe('unreadable');
    expect(cloud.cloud.files.size).toBe(0);
  });

  it('marks the device copy pending when the cloud refuses, and throws for the caller to report', async () => {
    class Refusing extends MemoryAdapter {
      async write(): Promise<never> { throw new StorageError('refused'); }
    }
    const device = new MemoryAdapter(new MemoryCloud());
    put(device, record(['d']));
    const { host: h, pending } = host(new Refusing(), device);
    await expect(liftDeviceCopy(h)).rejects.toThrow('refused');
    expect(pending.value).toBe(true);
  });

  it("keeps this device's rows when the cloud was erased elsewhere (AC23)", async () => {
    const cloud = new MemoryAdapter(new MemoryCloud());
    const device = new MemoryAdapter(new MemoryCloud());
    const erased = record([], 1);
    erased.schemaVersion = 2;
    erased.erasedRows = { fromEpoch: 1, ids: ['old'] };
    put(cloud, erased);
    put(device, record(['mine']));
    await liftDeviceCopy(host(cloud, device).host);
    expect(get(cloud).meta.eraseEpoch).toBe(1);
    expect(ids(get(cloud))).toEqual(['mine']);
  });
});

describe('copyCloudDown (US-09 AC2)', () => {
  it('merges the cloud record into the device copy and leaves the cloud as it was', async () => {
    const cloud = new MemoryAdapter(new MemoryCloud());
    const device = new MemoryAdapter(new MemoryCloud());
    put(cloud, record(['c']));
    put(device, record(['d']));
    const before = cloud.cloud.files.get(ROADMAP_FILE_NAME)!.json;
    await copyCloudDown(host(cloud, device).host);
    expect(ids(get(device))).toEqual(['c', 'd']);
    expect(cloud.cloud.files.get(ROADMAP_FILE_NAME)!.json).toBe(before);
  });

  it('does nothing for an empty cloud, and throws for one it cannot read', async () => {
    const device = new MemoryAdapter(new MemoryCloud());
    await copyCloudDown(host(new MemoryAdapter(new MemoryCloud()), device).host);
    expect(device.cloud.files.size).toBe(0);
    class Unreachable extends MemoryAdapter {
      async read(): Promise<never> { throw new StorageError('unreachable'); }
    }
    await expect(copyCloudDown(host(new Unreachable(), device).host)).rejects.toThrow('unreachable');
  });
});
