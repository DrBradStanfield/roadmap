/**
 * @vitest-environment jsdom
 *
 * The web's RecordHost (ios/architecture.md D4): localStorage is the device
 * tier, any other store is a cloud with localStorage as its mirror. The store
 * tests pin what each tier does; these pin which tier a store gets.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME } from '@roadmap/health-core';
import { LocalStorageAdapter } from './local-storage-adapter';
import { PENDING_MIRROR_KEY, webRecordHost } from './web-record-host';

afterEach(() => localStorage.clear());

describe('webRecordHost', () => {
  it('makes localStorage the device tier, with its synchronous reads and writes', () => {
    const store = new LocalStorageAdapter();
    const host = webRecordHost(store);
    expect(host.tier).toBe('device');
    expect(host.store).toBe(store);
    expect(host.sync).toBe(store);
  });

  it('makes any other store a cloud, mirrored on localStorage, with no synchronous path', async () => {
    const host = webRecordHost(new MemoryAdapter(new MemoryCloud()));
    if (host.tier !== 'cloud') throw new Error('expected the cloud tier');
    expect(host.sync).toBeUndefined();
    expect(host.mirror.adapter).toBeInstanceOf(LocalStorageAdapter);

    // The marker (US-09 AC4).
    expect(host.mirror.pending.get()).toBe(false);
    host.mirror.pending.set();
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();
    expect(host.mirror.pending.get()).toBe(true);
    host.mirror.pending.clear();
    expect(host.mirror.pending.get()).toBe(false);

    // An erase keeps the device copy, rewritten as the erased record, and
    // clears only the other record files beside it (US-11 AC3, AC9).
    await host.mirror.adapter.write(ROADMAP_FILE_NAME, { schemaVersion: 1 }, null);
    localStorage.setItem('health_roadmap_file_v2:chat-history.json', '{}');
    host.clearNamedFiles();
    expect(localStorage.getItem('health_roadmap_file_v2:chat-history.json')).toBeNull();
    expect((await host.mirror.adapter.read(ROADMAP_FILE_NAME)).body).toEqual({ schemaVersion: 1 });
  });
});
