/**
 * Lead A1-4: the record's sync is built one way, by `recordSync`. Each site
 * that built a SyncManager over ROADMAP_DOC by hand now asks the builder, with
 * the same clock it passed before: a fixed instant for a one-shot write, a
 * live clock for a session that lives across many writes.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ROADMAP_FILE_NAME } from './adapter';
import type { RecordHost } from './record-host';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';
import { recordSync } from './roadmap-doc';
import { RecordSession, saveRecordInto } from './record-session';
import { copyCloudDown } from './record-transfer';
import { runStorageSelfTest } from './storage-self-test';

vi.mock('./roadmap-doc', async (importOriginal) => {
  const real = await importOriginal<typeof import('./roadmap-doc')>();
  return { ...real, recordSync: vi.fn(real.recordSync) };
});
const built = vi.mocked(recordSync);

const T0 = Date.parse('2026-11-25T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const get = (a: MemoryAdapter): RoadmapFile => JSON.parse(a.cloud.files.get(ROADMAP_FILE_NAME)!.json);
const put = (a: MemoryAdapter, file: RoadmapFile) => a.cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
function record(id: string): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'd', now: '2026-10-01T00:00:00.000Z' });
  file.measurements = [createMeasurement({ id, metricType: 'weight', value: 70, recordedAt: '2026-10-01', createdAt: '2026-10-01T00:00:00.000Z' })];
  return file;
}

function cloudHost(cloud: MemoryAdapter, device: MemoryAdapter, clock: { now: () => number }) {
  return {
    tier: 'cloud', store: cloud, deviceId: () => 'phone', clock,
    timers: { set: () => 0, clear: () => {} }, remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
    clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {},
    mirror: {
      adapter: device, writesStopped: () => false, wipe: async () => {}, opened: () => {},
      pending: { get: () => false, set: () => {}, clear: () => {} },
    },
  } as unknown as Extract<RecordHost, { tier: 'cloud' }>;
}

describe('the record sync is built one way (lead A1-4)', () => {
  it('saveRecordInto asks the builder, stamped with the context\'s instant', async () => {
    built.mockClear();
    const target = new MemoryAdapter(new MemoryCloud());
    const ctx = { deviceId: 'dev', now: iso(T0) };
    await saveRecordInto(target, record('a'), ctx);
    expect(built).toHaveBeenCalledOnce();
    expect(built).toHaveBeenCalledWith(target, 'dev', ctx.now);
    expect(get(target).meta.updatedAt).toBe(ctx.now);
  });

  it('copyCloudDown asks the builder for the device copy, stamped with one instant', async () => {
    built.mockClear();
    const cloud = new MemoryAdapter(new MemoryCloud());
    const device = new MemoryAdapter(new MemoryCloud());
    put(cloud, record('c'));
    await copyCloudDown(cloudHost(cloud, device, { now: () => T0 }));
    expect(built).toHaveBeenCalledOnce();
    expect(built).toHaveBeenCalledWith(device, 'phone', iso(T0));
    expect(get(device).meta.updatedAt).toBe(iso(T0));
  });

  it('RecordSession.open asks the builder for a live clock, read at each write', async () => {
    built.mockClear();
    let now = T0;
    const cloud = new MemoryAdapter(new MemoryCloud());
    const session = await RecordSession.open(cloudHost(cloud, new MemoryAdapter(new MemoryCloud()), { now: () => now }));
    expect(built).toHaveBeenCalledOnce();
    const [adapter, deviceId, clock] = built.mock.calls[0];
    expect([adapter, deviceId, typeof clock]).toEqual([cloud, 'phone', 'function']);
    now = T0 + 60_000;
    session.edit((file) => { file.measurements.push(record('later').measurements[0]); }, session.shownErase);
    await session.flush();
    expect(get(cloud).meta.updatedAt).toBe(iso(T0 + 60_000));
  });

  it('the storage self-test builds every sync through the builder', async () => {
    built.mockClear();
    await runStorageSelfTest();
    expect(built.mock.calls.length).toBeGreaterThanOrEqual(8);
    for (const [, , now] of built.mock.calls) expect(typeof now).toBe('function');
  });
});
