// @vitest-environment jsdom
/**
 * Untangle fix 4, the transport: REMOTE_CHANGED carries `{ erase }`, the erase
 * identity a merge moved the record to, or null for any other change (US-16
 * AC2a, US-34 AC1, AC6). The erase machine's `arrived` event reads it.
 * Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core/adapter';
import { migrateFile } from '@roadmap/health-core/migrate';
import { rowRootIds } from '@roadmap/health-core/merge';
import { CURRENT_SCHEMA_VERSION, type FileMeasurement } from '@roadmap/health-core/roadmap-file';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from './roadmap-store';
import { LocalStorageAdapter } from './local-storage-adapter';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const FILE_KEY = 'health_roadmap_file_v2';

/** Another device or tab erases the record, as its deleteUserData writes it. */
async function anotherWriterErases(adapter: StorageAdapter) {
  const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
  const now = new Date(Date.now() + 1000).toISOString();
  const prior = migrateFile(body, { deviceId: 'other', now });
  const erased = migrateFile(null, { deviceId: 'other', now });
  const epoch = (prior.meta.eraseEpoch ?? 0) + 1;
  erased.schemaVersion = CURRENT_SCHEMA_VERSION;
  erased.erasedRows = { fromEpoch: epoch, ids: [...new Set(rowRootIds(prior))].sort() };
  erased.meta.eraseEpoch = epoch;
  erased.meta.erasedAt = now;
  await adapter.write(ROADMAP_FILE_NAME, erased, version);
}

/** The arguments of another device's write that adds weight row `id` to the record as it is now, and erases nothing. */
async function rowWrite(adapter: StorageAdapter, id: string): Promise<[string, object, string | null]> {
  const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
  const now = new Date(Date.now() + 2000).toISOString();
  const file = migrateFile(body, { deviceId: 'other', now });
  const row: FileMeasurement = {
    id, metricType: 'weight', value: 77, recordedAt: '2026-09-05T00:00:00.000Z', createdAt: now,
    source: 'manual', status: 'active', correctsId: null, externalId: null,
  };
  file.measurements.push(row);
  return [ROADMAP_FILE_NAME, file, version];
}

let details: unknown[];
const listen = (e: Event) => { details.push((e as CustomEvent).detail); };
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };
const stops: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  details = [];
  window.addEventListener(REMOTE_CHANGED_EVENT, listen);
});
afterEach(() => {
  window.removeEventListener(REMOTE_CHANGED_EVENT, listen);
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
});

describe('Fix 4 transport (US-16 AC2a, US-34): REMOTE_CHANGED says which erase a merge brought in', () => {
  it('US-34 AC6: another tab\'s erase, through the storage event: { erase: the identity adopted }', async () => {
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    stops.push(store.startLiveRefresh());
    const before = store.eraseIdentity;
    await anotherWriterErases(new LocalStorageAdapter());
    window.dispatchEvent(new StorageEvent('storage', { key: FILE_KEY }));
    await settle();
    expect(store.eraseIdentity).not.toBe(before);
    expect(details).toEqual([{ erase: store.eraseIdentity }]);
  });

  it('US-34 AC6: another tab\'s row, no erase: { erase: null }', async () => {
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    stops.push(store.startLiveRefresh());
    const before = store.eraseIdentity;
    const other = new LocalStorageAdapter();
    await other.write(...(await rowWrite(other, 'other-weight')));
    window.dispatchEvent(new StorageEvent('storage', { key: FILE_KEY }));
    await settle();
    expect(store.eraseIdentity).toBe(before);
    expect(details).toEqual([{ erase: null }]);
  });

  it('US-34 AC1: a save that folds another device\'s erase in: { erase: the identity adopted }', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    const before = store.eraseIdentity;
    await anotherWriterErases(new MemoryAdapter(cloud));
    store.addMeasurement('waist', 90, '2026-09-02');
    await store.flush();
    expect(store.eraseIdentity).not.toBe(before);
    expect(details).toEqual([{ erase: store.eraseIdentity }]);
  });

  it('US-34 AC1: a save loop whose later pass brings a row and no erase keeps the erase an earlier pass brought', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    const before = store.eraseIdentity;
    await anotherWriterErases(new MemoryAdapter(cloud));
    let n = 0;
    const write = MemoryAdapter.prototype.write;
    vi.spyOn(MemoryAdapter.prototype, 'write').mockImplementation(async function (this: MemoryAdapter, ...args: Parameters<StorageAdapter['write']>) {
      if (args[0] === ROADMAP_FILE_NAME && this.constructor === MemoryAdapter) {
        n += 1;
        if (n === 1) store.addMeasurement('ldl', 3.1, '2026-09-03'); // sends the loop round again
        if (n === 2) { // another device's row lands first: the second pass folds it in
          const other = new MemoryAdapter(cloud);
          await write.call(other, ...(await rowWrite(other, 'other-weight-2')));
        }
      }
      return write.apply(this, args);
    });
    store.addMeasurement('waist', 90, '2026-09-02');
    await store.flush();
    expect(n).toBeGreaterThan(1);
    expect(store.eraseIdentity).not.toBe(before);
    expect(store.loadAllHistory().some(m => m.id === 'other-weight-2')).toBe(true); // the second pass folded the row in
    expect(details).toEqual([{ erase: store.eraseIdentity }]);
  });
});
