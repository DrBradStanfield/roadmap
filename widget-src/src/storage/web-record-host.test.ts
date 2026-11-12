/**
 * @vitest-environment jsdom
 *
 * The web's RecordHost (ios/architecture.md D4): localStorage is the device
 * tier, any other store is a cloud with localStorage as its mirror. The store
 * tests pin what each tier does; these pin which tier a store gets.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { LocalStorageAdapter } from './local-storage-adapter';
import { PENDING_MIRROR_KEY, webRecordHost } from './web-record-host';
import { Sentry } from '../lib/sentry';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.mocked(Sentry.captureException).mockClear();
});

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

  // US-11 AC7: a clear that keeps failing is reported once per erase.
  it('sends a repeating off-file clear failure only to the console, and the first one to Sentry', () => {
    const host = webRecordHost(new LocalStorageAdapter());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    host.report(new Error('clear refused'), { op: 'clear-off-file', repeat: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Record upkeep failed');
    expect(Sentry.captureException).not.toHaveBeenCalled();
    host.report(new Error('clear refused'), { op: 'clear-off-file', repeat: false });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
