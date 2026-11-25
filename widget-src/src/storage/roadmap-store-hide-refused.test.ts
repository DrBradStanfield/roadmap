/** @vitest-environment jsdom */
/**
 * US-10 AC5, US-09 AC58: a page hide is the last chance to save, so it always
 * starts the cloud save of what is unsaved, whatever the last failure was. A
 * 401 is not a dead grant (the adapters drop the token, so the next call
 * refreshes it), and a page whose device copy is not its own has nowhere else
 * to keep its edits. The cloud is a memory store whose writes fail with a 401
 * until told otherwise; no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { StorageError } from '@roadmap/health-core/adapter';
import { isSyncPending, RoadmapStore } from './roadmap-store';
import { BACKEND_KEY } from '../lib/storage';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));

class RefusingCloud extends MemoryAdapter {
  refusing = false;
  writes = 0;
  async write(fileName: string, body: object, expected: string | null) {
    this.writes += 1;
    if (this.refusing) throw new StorageError('Dropbox call failed (401).', undefined, undefined, 401, undefined, 'refused');
    return super.write(fileName, body, expected);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => { localStorage.clear(); });

describe('US-10 AC5: a hide after a 401 still starts the cloud save', () => {
  it.each([
    { name: 'the device copy is this page\'s', ours: true },
    { name: 'the device copy is not this page\'s', ours: false },
  ])('$name', async ({ ours }) => {
    const cloud = new RefusingCloud(new MemoryCloud());
    if (ours) localStorage.setItem(BACKEND_KEY, cloud.id);
    const store = await RoadmapStore.create(cloud);
    cloud.refusing = true;
    store.addMeasurement('weight', 80, '2026-11-01T09:00:00.000Z', store.shownErase);
    await expect(store.flush()).rejects.toThrow();
    expect(cloud.writes).toBe(1);
    expect(isSyncPending()).toBe(ours); // only this page's device copy took the changes

    cloud.refusing = false; // the next call's refreshed token works
    store.flushSync(); // no edit since the failure
    await tick();
    expect(cloud.writes).toBe(2);
    expect(store.saveStatus).toBe('saved');
  });
});
