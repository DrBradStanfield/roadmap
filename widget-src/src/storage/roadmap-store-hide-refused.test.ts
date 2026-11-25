/** @vitest-environment jsdom */
/**
 * US-09 AC57 (lead A25, the web's half): after a cloud save is refused for the
 * grant, a page hide starts no cloud save of it, and the same refusal is sent
 * to Sentry once, however many later saves meet it. The cloud is a memory
 * store whose writes refuse with the adapter's revoked-grant reason; no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { StorageError } from '@roadmap/health-core/adapter';
import { RoadmapStore } from './roadmap-store';
import { Sentry } from '../lib/sentry';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));

class RevokedCloud extends MemoryAdapter {
  revoked = false;
  writes = 0;
  async write(fileName: string, body: object, expected: string | null) {
    this.writes += 1;
    if (this.revoked) throw new StorageError('Dropbox was disconnected — please reconnect.', undefined, undefined, undefined, 'reconnect', 'refused');
    return super.write(fileName, body, expected);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => { vi.mocked(Sentry.captureException).mockClear(); localStorage.clear(); });

describe('US-09 AC57: a refused grant is not retried on hide, and is reported once', () => {
  it('hides start no cloud save; a later edit meets the same refusal and sends no second report', async () => {
    const cloud = new RevokedCloud(new MemoryCloud());
    const store = await RoadmapStore.create(cloud);
    cloud.revoked = true;
    store.addMeasurement('weight', 80, '2026-11-01T09:00:00.000Z', store.shownErase);
    await expect(store.flush()).rejects.toThrow();
    expect(cloud.writes).toBe(1);

    store.flushSync();
    store.flushSync();
    await tick();
    expect(cloud.writes).toBe(1);

    store.addMeasurement('weight', 81, '2026-11-02T09:00:00.000Z', store.shownErase);
    await expect(store.flush()).rejects.toThrow();
    expect(cloud.writes).toBe(2);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
