/**
 * @vitest-environment jsdom
 *
 * The device copy a cloud page writes as it goes away (US-06 AC13), with two
 * tabs' sessions on one localStorage, through the web host itself: another
 * tab's save never clears the marker for a change it did not carry, and a
 * save that carries all of it removes the copy (US-09 AC4).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConflictError, MemoryAdapter, MemoryCloud, RecordSession, ROADMAP_FILE_NAME, createMeasurement,
  type RoadmapFile, type WriteResult,
} from '@roadmap/health-core';
import { LocalStorageAdapter } from './local-storage-adapter';
import { isSyncPending, webRecordHost } from './web-record-host';

afterEach(() => localStorage.clear());

/** A cloud whose save never answers: the tab closes before it lands. */
class StalledCloud extends MemoryAdapter {
  async write(): Promise<WriteResult> {
    return new Promise<WriteResult>(() => {});
  }
}

const add = (session: RecordSession, id: string, value: number) =>
  session.edit((file) => void file.measurements.push(createMeasurement({
    id, metricType: 'weight', value, recordedAt: '2026-10-01', createdAt: '2026-10-01T10:00:00.000Z',
  })));
const ids = (file: RoadmapFile | null | undefined) => (file?.measurements ?? []).map((m) => m.id).sort();
const deviceCopy = () => new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body as RoadmapFile | null;

describe('two cloud tabs on one localStorage (US-06 AC13)', () => {
  it("tab B's save without tab A's departure keeps the copy and its marker; the next load lifts it up and removes both", async () => {
    const cloud = new MemoryCloud();
    const tabA = await RecordSession.open(webRecordHost(new StalledCloud(cloud)));
    const tabB = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    add(tabA, 'dose', 1.7);
    tabA.flushSync(); // tab A closes
    expect(ids(deviceCopy())).toEqual(['dose']);
    expect(isSyncPending()).toBe(true);

    add(tabB, 'other', 80);
    await tabB.flush();
    expect(isSyncPending()).toBe(true);
    expect(ids(deviceCopy())).toEqual(['dose']);

    const next = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    expect(ids(next.file)).toEqual(['dose', 'other']);
    await next.flush();
    expect(isSyncPending()).toBe(false);
    expect(deviceCopy()).toBeNull();
  });
});

describe('LocalStorageAdapter.removeSync', () => {
  it('removes the record and its revision only at the revision it was read at', () => {
    const device = new LocalStorageAdapter();
    const first = device.writeSync(ROADMAP_FILE_NAME, { schemaVersion: 1 }, null).version;
    const second = device.writeSync(ROADMAP_FILE_NAME, { schemaVersion: 1, other: true }, first).version;
    // Another tab wrote since `first` was read: its write stays.
    expect(() => device.removeSync(ROADMAP_FILE_NAME, first)).toThrow(ConflictError);
    expect(device.revision(ROADMAP_FILE_NAME)).toBe(second);
    device.removeSync(ROADMAP_FILE_NAME, second);
    expect(device.readSync(ROADMAP_FILE_NAME).body).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
