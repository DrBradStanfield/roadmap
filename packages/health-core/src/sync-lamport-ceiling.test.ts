/**
 * US-10 AC8b: migrate clamps meta.lamport to MAX_COUNTER ("garbage is clamped"), but
 * mergeFiles writes max(local, remote) + 1 unclamped, and verifyAfterWrite
 * compares the clamped re-read with that unclamped value. A record carrying an
 * out-of-range lamport (e.g. epoch millis from a hand or agent edit) then fails
 * every save as a "conflict storm" even though each write lands.
 */
import { describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { MAX_COUNTER } from './migrate';
import { mergeFiles } from './merge';
import { ROADMAP_DOC } from './roadmap-doc';
import { createEmptyFile } from './roadmap-file';
import { SyncManager } from './sync-manager';

const NOW = '2026-10-21T12:00:00.000Z';

describe('US-10 AC8b: a lamport at or above MAX_COUNTER', () => {
  it('still saves once (the clamp makes it harmless)', async () => {
    const cloud = new MemoryCloud();
    const file = createEmptyFile({ deviceId: 'hand-edit', now: NOW });
    file.meta.lamport = 1_761_609_600_000; // epoch millis, > MAX_COUNTER
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });

    const adapter = new MemoryAdapter(cloud);
    const sync = new SyncManager(adapter, 'device-a', ROADMAP_DOC, { now: () => NOW });
    const loaded = await sync.load();
    expect(loaded.meta.lamport).toBe(MAX_COUNTER);

    // Today: rejects with "Save failed after 5 attempts — a sync conflict storm".
    const result = await sync.save(loaded);
    expect(result.attempts).toBe(0);
    // One write, not one per retry.
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(2);

    // And it stays saveable: the next save is one write too.
    const again = await sync.save(result.file);
    expect(again.attempts).toBe(0);
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(3);
  });

  it('saves a record at exactly MAX_COUNTER', async () => {
    const cloud = new MemoryCloud();
    const file = createEmptyFile({ deviceId: 'hand-edit', now: NOW });
    file.meta.lamport = MAX_COUNTER;
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
    const sync = new SyncManager(new MemoryAdapter(cloud), 'device-a', ROADMAP_DOC, { now: () => NOW });
    const result = await sync.save(await sync.load());
    expect(result.attempts).toBe(0);
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(2);
  });

  it('caps the merged lamport in both merge branches (same erase, and across an erase)', () => {
    const at = (lamport: number, eraseEpoch: number) => {
      const f = createEmptyFile({ deviceId: 'd', now: NOW });
      f.meta.lamport = lamport;
      f.meta.eraseEpoch = eraseEpoch;
      return f;
    };
    const opts = { deviceId: 'device-a', now: NOW } as Parameters<typeof mergeFiles>[2];
    expect(mergeFiles(at(MAX_COUNTER, 0), at(MAX_COUNTER, 0), opts).meta.lamport).toBe(MAX_COUNTER);
    expect(mergeFiles(at(MAX_COUNTER, 0), at(MAX_COUNTER, 1), opts).meta.lamport).toBe(MAX_COUNTER);
    expect(mergeFiles(at(MAX_COUNTER, 1), at(MAX_COUNTER, 0), opts).meta.lamport).toBe(MAX_COUNTER);
    // Below the ceiling nothing changes: max + 1.
    expect(mergeFiles(at(7, 0), at(4, 0), opts).meta.lamport).toBe(8);
    expect(mergeFiles(at(7, 0), at(4, 1), opts).meta.lamport).toBe(8);
  });
});
