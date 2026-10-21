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
import { PENDING_MIRROR_KEY, beginRoadmapLogOff, webRecordHost } from './web-record-host';

afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

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

    // The wipe removes the device copy (US-11).
    await host.mirror.adapter.write(ROADMAP_FILE_NAME, { schemaVersion: 1 }, null);
    await host.mirror.wipe();
    expect((await host.mirror.adapter.read(ROADMAP_FILE_NAME)).body).toBeNull();
  });

  it("keeps this tab's unconfirmed erase in sessionStorage, untouched by the wipe, and drops it at log-off (US-11 AC9)", async () => {
    const host = webRecordHost(new MemoryAdapter(new MemoryCloud()));
    if (host.tier !== 'cloud') throw new Error('expected the cloud tier');
    const mark = host.mirror.unconfirmedErase!;
    mark.set('{"backend":"memory"}');
    expect(sessionStorage.getItem('health_roadmap_erase_unconfirmed')).toBe('{"backend":"memory"}');
    await host.mirror.wipe();
    expect(mark.get()).toBe('{"backend":"memory"}');
    beginRoadmapLogOff();
    expect(mark.get()).toBeNull();
  });
});
