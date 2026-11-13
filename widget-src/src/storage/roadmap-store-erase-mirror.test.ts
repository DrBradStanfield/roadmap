// @vitest-environment jsdom
/**
 * Lead S57 on the web (US-11 AC3b, AC7; US-16 AC2a): "Delete all my data" on a
 * cloud page whose cloud refuses the write AND whose device copy cannot be written
 * (private browsing, a full or blocked localStorage). The erase lived only in
 * memory, so a reload brought every value back while the page showed an empty
 * record. Now the store puts its copy back and answers `{ success: false }`
 * with no reason, so useErase says ERASE_FAILED and keeps the record on screen
 * (useErase.test.tsx F2). A failed erase no longer leaves the record half-erased.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { BT_TIMELINE_DRAFT_KEY } from '../lib/storage';
import { RoadmapStore } from './roadmap-store';
import { BACKEND_KEY, PENDING_MIRROR_KEY } from './web-record-host';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

/** A cloud whose writes can be made to fail, refused. */
class FailingCloud extends MemoryAdapter {
  failWrites = false;
  async write(...args: Parameters<MemoryAdapter['write']>) {
    // A definite refusal (a revoked grant): nothing was stored (write-refusal.ts).
    if (this.failWrites) throw new StorageError('Dropbox write failed (403)', undefined, undefined, 403);
    return super.write(...args);
  }
}

const DEVICE_KEY = 'health_roadmap_file_v2';
const cloudFile = (cloud: MemoryAdapter) => JSON.parse(cloud.cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
const deviceFile = () => JSON.parse(localStorage.getItem(DEVICE_KEY)!) as RoadmapFile;
const fileOf = (store: RoadmapStore) => (store as unknown as { file: RoadmapFile }).file;
const days = (file: RoadmapFile) => file.measurements.map((m) => m.recordedAt.slice(0, 10)).sort();

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(BACKEND_KEY, 'memory');
});
afterEach(() => vi.restoreAllMocks());

describe('Delete all my data when neither the cloud nor this browser takes it (lead S57)', () => {
  it('keeps the record as it was in memory, in the cloud and in this browser, and the next good save erases nothing', async () => {
    const cloud = new FailingCloud();
    const store = await RoadmapStore.create(cloud);
    store.addMeasurement('weight', 82, '2026-09-01');
    store.setReminderOptIn({ status: 'active', token: 'test-token-good', email: 'a@example.com', provider: 'dropbox' });
    await store.flush();
    // An edit the cloud has not taken: its failed save is held in this browser.
    cloud.failWrites = true;
    store.addMeasurement('weight', 81, '2026-09-02');
    await expect(store.flush()).rejects.toThrow();
    expect(days(deviceFile())).toEqual(['2026-09-01', '2026-09-02']);
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, '{"draft":"typed"}');

    const before = store.eraseIdentity;
    const deviceBefore = localStorage.getItem(DEVICE_KEY);
    const teardown = vi.fn(async () => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const result = await store.deleteAllData({ teardown });
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(result).toEqual({ success: false, chatErased: true });
    expect(teardown).toHaveBeenCalledTimes(1); // the irreversible step ran before the write; see the PR's list
    // In memory: the same record at the same erase, its opt-in still active.
    expect(store.eraseIdentity).toBe(before);
    expect(days(fileOf(store))).toEqual(['2026-09-01', '2026-09-02']);
    expect(store.getReminderOptIn()?.status).toBe('active');
    // In this browser: the record, the marker and the draft untouched; in the cloud: as before.
    expect(localStorage.getItem(DEVICE_KEY)).toBe(deviceBefore);
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBe('{"draft":"typed"}');
    expect(days(cloudFile(cloud))).toEqual(['2026-09-01']);

    // The next good save: both copies hold the record as before plus the unsynced edit, nothing erased.
    cloud.failWrites = false;
    await store.flush();
    for (const copy of [cloudFile(cloud), deviceFile()]) {
      expect(days(copy)).toEqual(['2026-09-01', '2026-09-02']);
      expect(copy.meta.eraseEpoch ?? 0).toBe(0);
    }
  });
});
