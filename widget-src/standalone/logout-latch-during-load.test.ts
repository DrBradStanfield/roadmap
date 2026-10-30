/**
 * US-09 AC2f: a cloud-mode tab whose first cloud read is still in flight
 * when another tab logs off must latch the log-off barrier too.
 *
 * The listener (latchOnOtherTabsLogOff, via mirror.opened()) was added only
 * after `await sync.load()` in RecordSession.open, and the signal key is set
 * and removed at once, so a tab still loading hears neither signal. Its later
 * failed cloud save then writes health_roadmap_file_v2 and the pending marker
 * back onto the device that just logged off. The AC2c residual covers only a
 * write already running in the other tab, not a tab that never latches.
 *
 * Same harness as logout-persistence.test.ts (second module graph standing in
 * for another tab, simulated `storage` events, in-memory provider only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter } from '@roadmap/health-core';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const FILE_KEY = 'health_roadmap_file_v2';
const REV_KEY = `${FILE_KEY}_rev`;
const PENDING_KEY = 'health_roadmap_pending_cloud_sync';
const UNRELATED_KEY = 'another_app_preference';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A provider whose FIRST read waits for the test, and whose writes can fail. */
class SlowFirstReadCloud extends MemoryAdapter {
  readonly firstRead = deferred();
  private reads = 0;
  fail = false;

  /** Make the first read fail the way an unreachable cloud does. */
  firstReadError: Error | null = null;

  override async read(...args: Parameters<MemoryAdapter['read']>) {
    if (this.reads++ === 0) {
      await this.firstRead.promise;
      if (this.firstReadError) throw this.firstReadError;
    }
    return super.read(...args);
  }

  override async write(...args: Parameters<MemoryAdapter['write']>) {
    if (this.fail) throw new Error('synthetic offline');
    return super.write(...args);
  }
}

/** A storage whose changes reach this window's listeners, as a browser
 *  delivers them to other tabs. */
function makeStorage(onChange: (key: string) => void): Storage {
  const values = Object.create(null) as Record<string, string>;
  Object.defineProperties(values, {
    length: { get() { return Object.keys(values).length; } },
    getItem: { value: (key: string) => values[key] ?? null },
    setItem: { value: (key: string, value: string) => {
      const changed = values[key] !== String(value);
      values[key] = String(value);
      if (changed) onChange(key);
    } },
    removeItem: { value: (key: string) => {
      const changed = key in values;
      delete values[key];
      if (changed) onChange(key);
    } },
    clear: { value: () => { for (const key of Object.keys(values)) delete values[key]; } },
    key: { value: (index: number) => Object.keys(values)[index] ?? null },
  });
  return values as unknown as Storage;
}

let connect: typeof import('./connect');

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', makeStorage((key) => {
    window.dispatchEvent(Object.assign(new Event('storage'), { key }));
  }));
  const document = new EventTarget();
  Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
  vi.stubGlobal('document', document);
  vi.stubGlobal('location', { reload: vi.fn(), search: '', href: 'http://localhost/' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in logout regression'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  connect = await import('./connect');
  localStorage.setItem(UNRELATED_KEY, 'keep');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('US-09 AC2f: a tab still loading when another tab logs off', () => {
  it('latches, so its later failed cloud save does not recreate the device copy', async () => {
    // The other tab: its own module graph, the same window and localStorage.
    vi.resetModules();
    const other = {
      storage: await import('../src/storage/roadmap-store'),
      local: await import('../src/storage/local-storage-adapter'),
      lib: await import('../src/lib/storage'),
    };
    const cloud = new SlowFirstReadCloud();
    const opening = other.storage.RoadmapStore.create(cloud); // first cloud read pending

    await connect.logOff('local'); // both log-off signals fire while it loads

    cloud.firstRead.resolve();
    const store = await opening;
    expect(other.local.roadmapLocalWritesStopped()).toBe(true);

    store.addMeasurement('weight', 81, '2026-01-01');
    cloud.fail = true;
    await expect(store.flush()).rejects.toThrow();
    expect(localStorage.getItem(FILE_KEY)).toBeNull();
    expect(localStorage.getItem(REV_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(localStorage.getItem(UNRELATED_KEY)).toBe('keep');

    // The latch is AC2e's shared flag, so the chat-and-plan mirror stays gone too.
    other.lib.saveToLocalStorage({ heightCm: 180 });
    expect(localStorage.getItem(other.lib.MIRROR_KEY)).toBeNull();
  });

  it('does not latch when its cloud load then fails and it runs on the device copy', async () => {
    // US-09 AC2c / record-host.ts opened(): a page that falls back to the
    // device keeps that copy as its only store, so a log-off heard while it
    // was loading must not stop its writes.
    vi.resetModules();
    const other = {
      storage: await import('../src/storage/roadmap-store'),
      local: await import('../src/storage/local-storage-adapter'),
      connect: await import('./connect'),
      core: await import('@roadmap/health-core'), // its own StorageError class
    };
    const cloud = new SlowFirstReadCloud();
    cloud.firstReadError = new other.core.StorageError('synthetic unreachable cloud', undefined, undefined, 503);
    let store!: Awaited<ReturnType<typeof other.storage.RoadmapStore.create>>;
    const starting = other.connect.startOnBackend({ adapter: cloud, backend: 'google-drive' }, async (adapter) => {
      store = await other.storage.RoadmapStore.create(adapter);
    });

    await connect.logOff('local'); // both log-off signals fire while it loads

    cloud.firstRead.resolve();
    const started = await starting;
    expect(started.backend).toBe('local'); // fell back to the device copy
    expect(other.local.roadmapLocalWritesStopped()).toBe(false);

    store.addMeasurement('weight', 81, '2026-01-01');
    await store.flush();
    expect(localStorage.getItem(FILE_KEY)).not.toBeNull(); // its only copy is kept
  });

  it('latches when the log-off comes during the connect-time lift, before the store opens', async () => {
    // The OAuth return (app.tsx) runs liftLocalInto(adapter), then
    // RoadmapStore.create(adapter): two cloud hosts in a row. A note heard
    // during the first must still latch the second. (Found in review.)
    vi.resetModules();
    const other = {
      storage: await import('../src/storage/roadmap-store'),
      local: await import('../src/storage/local-storage-adapter'),
      connect: await import('./connect'),
    };
    const guest = await other.storage.RoadmapStore.create(new other.local.LocalStorageAdapter());
    guest.addMeasurement('weight', 80, '2026-01-01');
    await guest.flush(); // a guest record, so the lift has something to send up

    const cloud = new SlowFirstReadCloud();
    const lifting = other.connect.liftLocalInto(cloud, 'dropbox'); // its cloud read is pending

    await connect.logOff('local'); // another tab logs off during the lift

    cloud.firstRead.resolve();
    await lifting;
    const store = await other.storage.RoadmapStore.create(cloud);
    expect(other.local.roadmapLocalWritesStopped()).toBe(true);

    store.addMeasurement('weight', 81, '2026-01-02');
    cloud.fail = true;
    await expect(store.flush()).rejects.toThrow();
    expect(localStorage.getItem(FILE_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });
});
