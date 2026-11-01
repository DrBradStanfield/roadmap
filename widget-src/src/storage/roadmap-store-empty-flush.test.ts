/**
 * US-10 AC5a: an awaited flush with nothing unsaved writes nothing. Before, every
 * `flush()` ran a full read-merge-write-verify, and each one moved the stored
 * `meta.lamport` on by 2 with no change made: on a cloud, a write and a
 * version bump per call (a GitHub commit each time).
 */
import { describe, expect, it } from 'vitest';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME, StorageError, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';

class CountingAdapter extends MemoryAdapter {
  writes = 0;
  failWrites = false;
  async write(fileName: string, body: object, expected: string | null) {
    if (fileName === ROADMAP_FILE_NAME) this.writes += 1;
    if (this.failWrites) throw new StorageError('unreachable');
    return super.write(fileName, body, expected);
  }
}

const stored = (cloud: MemoryCloud): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);

describe('RoadmapStore.flush with nothing unsaved (US-10 AC5a)', () => {
  it('writes once for a change, then nothing for repeated empty flushes', async () => {
    const cloud = new MemoryCloud();
    const adapter = new CountingAdapter(cloud);
    const store = await RoadmapStore.create(adapter);

    store.markReportEmailCaptured();
    await store.flush();
    expect(adapter.writes).toBe(1);
    const lamport = stored(cloud).meta.lamport;

    for (let i = 0; i < 3; i++) await store.flush();
    expect(adapter.writes).toBe(1);
    expect(stored(cloud).meta.lamport).toBe(lamport);
  });

  it('still writes a change made after an empty flush, exactly once', async () => {
    const cloud = new MemoryCloud();
    const adapter = new CountingAdapter(cloud);
    const store = await RoadmapStore.create(adapter);
    await store.flush();
    expect(adapter.writes).toBe(0);

    store.markReportEmailCaptured();
    await store.flush();
    expect(adapter.writes).toBe(1);
    expect(stored(cloud).profile.reportEmailCaptured).toBe(true);
  });

  it('retries a save that failed, though nothing changed since', async () => {
    const cloud = new MemoryCloud();
    const adapter = new CountingAdapter(cloud);
    const store = await RoadmapStore.create(adapter);
    store.markReportEmailCaptured();
    adapter.failWrites = true;
    await expect(store.flush()).rejects.toThrow();

    adapter.failWrites = false;
    await store.flush();
    expect(stored(cloud).profile.reportEmailCaptured).toBe(true);
    await store.flush();
    expect(adapter.writes).toBe(2); // the failed one and its retry, then nothing
  });
});
