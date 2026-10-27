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

// In-memory provider only: no credentials, fetch, or live cloud account.
class ControlledCloud extends MemoryAdapter {
  gate: ReturnType<typeof deferred> | null = null;
  entered = deferred();
  fail = false;

  override async write(...args: Parameters<MemoryAdapter['write']>) {
    this.entered.resolve();
    if (this.gate) await this.gate.promise;
    if (this.fail) throw new Error('synthetic offline');
    return super.write(...args);
  }
}

function makeStorage(failKey?: string | ((key: string) => boolean), onChange?: (key: string) => void): Storage {
  const values = Object.create(null) as Record<string, string>;
  const fails = typeof failKey === 'function' ? failKey : (key: string) => key === failKey;
  Object.defineProperties(values, {
    length: { get() { return Object.keys(values).length; } },
    getItem: { value: (key: string) => values[key] ?? null },
    setItem: { value: (key: string, value: string) => {
      if (fails(key)) throw new Error('synthetic quota failure');
      const changed = values[key] !== String(value);
      values[key] = String(value);
      if (changed) onChange?.(key); // a browser signals real changes only
    } },
    removeItem: { value: (key: string) => {
      const changed = key in values;
      delete values[key];
      if (changed) onChange?.(key);
    } },
    clear: { value: () => { for (const key of Object.keys(values)) delete values[key]; } },
    key: { value: (index: number) => Object.keys(values)[index] ?? null },
  });
  return values as unknown as Storage;
}

let reload: ReturnType<typeof vi.fn>;
let data: typeof import('../src/lib/roadmap-data');
let connect: typeof import('./connect');
let storage: typeof import('../src/storage/roadmap-store');
let local: typeof import('../src/storage/local-storage-adapter');

beforeEach(async () => {
  // A fresh module graph represents a fresh page, including any logout latch.
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', makeStorage());
  vi.stubGlobal('window', new EventTarget());
  const document = new EventTarget();
  Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
  vi.stubGlobal('document', document);
  reload = vi.fn();
  vi.stubGlobal('location', { reload, search: '', href: 'http://localhost/' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in logout regression'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  data = await import('../src/lib/roadmap-data');
  connect = await import('./connect');
  storage = await import('../src/storage/roadmap-store');
  local = await import('../src/storage/local-storage-adapter');
  localStorage.setItem(UNRELATED_KEY, 'keep');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectDeviceEmpty() {
  expect(localStorage.getItem(FILE_KEY)).toBeNull();
  expect(localStorage.getItem(REV_KEY)).toBeNull();
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  expect(localStorage.getItem(UNRELATED_KEY)).toBe('keep');
}

async function installLifecycle(event: 'beforeunload' | 'visibilitychange') {
  // Real entrypoint handler; events/reload are simulated, not browser unload.
  const { registerPageDeparture } = await import('./page-departure');
  registerPageDeparture(vi.fn());
  reload.mockImplementation(() => {
    // Check the real wipe happened before simulating the navigation callback.
    expect(localStorage.getItem(FILE_KEY)).toBeNull();
    if (event === 'visibilitychange') document.dispatchEvent(new Event(event));
    else window.dispatchEvent(new Event(event));
  });
}

async function settleLifecycle() {
  // Drain only immediate persistence work; never advance the live-refresh poll.
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
}

describe('US-09 AC2c: logout is a barrier to late on-device roadmap persistence', () => {
  it('does not recreate a mirror when an in-flight cloud write fails after logout', async () => {
    const cloud = new ControlledCloud();
    const store = await storage.RoadmapStore.create(cloud);
    store.addMeasurement('weight', 71, '2026-01-01');
    cloud.gate = deferred();
    cloud.fail = true;
    const saving = store.flush().then(() => true, () => false);
    await cloud.entered.promise;
    await connect.logOff('github');
    expectDeviceEmpty();
    cloud.gate.resolve();
    expect(await saving).toBe(false);
    expectDeviceEmpty();
    expect((await storage.RoadmapStore.create(new local.LocalStorageAdapter())).loadAllHistory()).toEqual([]);
  });

  it('closes the barrier before awaiting cloud disconnect, not only before reload', async () => {
    const cloud = new ControlledCloud();
    const store = await storage.RoadmapStore.create(cloud);
    store.addMeasurement('weight', 70, '2026-01-01');
    cloud.gate = deferred();
    cloud.fail = true;
    const saving = store.flush().then(() => true, () => false);
    await cloud.entered.promise;
    const disconnectEntered = deferred();
    const disconnectGate = deferred();
    const { GitHubAdapter } = await import('../src/storage/github');
    vi.spyOn(GitHubAdapter.prototype, 'disconnect').mockImplementation(async () => {
      disconnectEntered.resolve();
      await disconnectGate.promise;
    });
    const loggingOff = connect.logOff('github');
    await disconnectEntered.promise;
    cloud.gate.resolve();
    expect(await saving).toBe(false);
    // Release teardown even if the pre-wipe assertion fails on the RED source.
    try {
      expectDeviceEmpty();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      disconnectGate.resolve();
      await loggingOff;
    }
    expectDeviceEmpty();
  });

  it('blocks a mirror already awaiting its local read when logout starts', async () => {
    const cloud = new ControlledCloud();
    const store = await storage.RoadmapStore.create(cloud);
    store.addMeasurement('weight', 72, '2026-01-01');
    const entered = deferred();
    const gate = deferred();
    const original = local.LocalStorageAdapter.prototype.read;
    vi.spyOn(local.LocalStorageAdapter.prototype, 'read').mockImplementation(async function (this: InstanceType<typeof local.LocalStorageAdapter>, fileName) {
      entered.resolve();
      await gate.promise;
      return original.call(this, fileName);
    });
    cloud.fail = true;
    const saving = store.flush().then(() => true, () => false);
    await entered.promise;
    expect(localStorage.getItem(PENDING_KEY)).not.toBeNull();
    await connect.logOff('github');
    gate.resolve();
    expect(await saving).toBe(false);
    expectDeviceEmpty();
  });

  it('blocks an in-flight local save that resumes after the wipe (API-only local logout)', async () => {
    const adapter = new local.LocalStorageAdapter();
    const store = await storage.RoadmapStore.create(adapter);
    store.addMeasurement('weight', 73, '2026-01-01');
    const entered = deferred();
    const gate = deferred();
    const original = adapter.read.bind(adapter);
    vi.spyOn(adapter, 'read').mockImplementation(async (fileName) => {
      entered.resolve();
      await gate.promise;
      return original(fileName);
    });
    const saving = store.flush().then(() => true, () => false);
    await entered.promise;
    await connect.logOff('local');
    gate.resolve();
    expect(await saving).toBe(false);
    expectDeviceEmpty();
  });

  it('allows an in-flight successful cloud save to finish without deleting remote health', async () => {
    const cloud = new ControlledCloud();
    const store = await storage.RoadmapStore.create(cloud);
    store.addMeasurement('weight', 74, '2026-01-01');
    cloud.gate = deferred();
    const saving = store.flush();
    await cloud.entered.promise;
    await connect.logOff('github');
    cloud.gate.resolve();
    await saving;
    expect((await storage.RoadmapStore.create(cloud)).loadAllHistory()).toEqual([
      expect.objectContaining({ metricType: 'weight', value: 74 }),
    ]);
    expectDeviceEmpty();
  });

  it('preserves the ordinary offline mirror and pending marker BEFORE logout', async () => {
    const cloud = new ControlledCloud();
    const store = await storage.RoadmapStore.create(cloud);
    store.addMeasurement('weight', 75, '2026-01-01');
    cloud.fail = true;
    await expect(store.flush()).rejects.toThrow('still on this device');
    expect(localStorage.getItem(PENDING_KEY)).not.toBeNull();
    expect((await storage.RoadmapStore.create(new local.LocalStorageAdapter())).loadAllHistory()).toEqual([
      expect.objectContaining({ metricType: 'weight', value: 75 }),
    ]);
  });

  for (const event of ['visibilitychange', 'beforeunload'] as const) {
    it(`${event}: failed cloud lifecycle flush cannot recreate the wiped mirror`, async () => {
      const cloud = new ControlledCloud();
      await data.initRoadmapStore(cloud);
      await data.addMeasurement('weight', 76, '2026-01-01');
      cloud.fail = true;
      await installLifecycle(event);
      await connect.logOff('github');
      await settleLifecycle();
      expect(reload).toHaveBeenCalledOnce();
      expectDeviceEmpty();
    });

    it(`${event}: successful cloud lifecycle flush still saves the dirty record`, async () => {
      const cloud = new ControlledCloud();
      await data.initRoadmapStore(cloud);
      await data.addMeasurement('weight', 77, '2026-01-01');
      await installLifecycle(event);
      await connect.logOff('github');
      await settleLifecycle();
      expect((await storage.RoadmapStore.create(cloud)).loadAllHistory()).toEqual([
        expect.objectContaining({ metricType: 'weight', value: 77 }),
      ]);
      expectDeviceEmpty();
    });

    it(`${event}: dirty local lifecycle cannot rewrite the file (API-only local logout)`, async () => {
      await data.initRoadmapStore(new local.LocalStorageAdapter());
      await data.addMeasurement('weight', 78, '2026-01-01');
      await installLifecycle(event);
      await connect.logOff('local');
      await settleLifecycle();
      expectDeviceEmpty();
    });
  }

  // US-09 AC2/AC2c, US-11 AC3b: a failed erase-fence write never stops log-off.
  for (const backend of ['github', 'local'] as const) {
    it(`${backend}: a failed erase-fence write still clears every key and reloads`, async () => {
      const seeded = {
        [FILE_KEY]: '{}', [REV_KEY]: '1', [PENDING_KEY]: '1',
        'health_roadmap_file_v2:chat-history.json': '{}',
        'health_roadmap_doc_v2:synthetic-ref': 'data:application/pdf;base64,AA==',
        health_roadmap_data: '{}', health_roadmap_authenticated: 'true',
      };
      vi.stubGlobal('localStorage', makeStorage('health_roadmap_local_erase_generation'));
      localStorage.setItem(UNRELATED_KEY, 'keep');
      for (const [key, value] of Object.entries(seeded)) localStorage.setItem(key, value);
      connect.rememberBackend(backend);
      const { Sentry } = await import('../src/lib/sentry');
      await connect.logOff(backend);
      for (const key of Object.keys(seeded)) expect(localStorage.getItem(key)).toBeNull();
      expect(connect.rememberedBackend()).toBeNull();
      expect(localStorage.getItem(UNRELATED_KEY)).toBe('keep');
      expect(reload).toHaveBeenCalledOnce();
      expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
        tags: { area: 'cloud-sync', op: 'log-off-device', backend: 'local' },
      });
    });
  }

  it('a clean local lifecycle remains empty after logout (negative control)', async () => {
    await data.initRoadmapStore(new local.LocalStorageAdapter());
    await data.addMeasurement('weight', 79, '2026-01-01');
    await data.flushRoadmapStore();
    expect(localStorage.getItem(FILE_KEY)).not.toBeNull();
    await installLifecycle('beforeunload');
    await connect.logOff('local');
    await settleLifecycle();
    expectDeviceEmpty();
  });
});

// Adversary R3: each guard has a test that fails on its own removal.
describe('US-09 AC2c: each barrier guard is load-bearing', () => {
  it('markSyncPending sets no marker once the barrier is closed', () => {
    storage.markSyncPending();
    expect(localStorage.getItem(PENDING_KEY)).not.toBeNull();
    localStorage.removeItem(PENDING_KEY);
    local.stopRoadmapLocalWrites();
    storage.markSyncPending();
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('a failed cloud save after the barrier does not even try the device mirror', async () => {
    const cloud = new ControlledCloud();
    const store = await storage.RoadmapStore.create(cloud);
    store.addMeasurement('weight', 80, '2026-01-01');
    const mirrorRead = vi.spyOn(local.LocalStorageAdapter.prototype, 'read');
    local.stopRoadmapLocalWrites();
    cloud.fail = true;
    await expect(store.flush()).rejects.toThrow();
    expect(mirrorRead).not.toHaveBeenCalled();
  });

  it('device disconnect removes documents before the erase-fence write that can throw', async () => {
    vi.stubGlobal('localStorage', makeStorage('health_roadmap_local_erase_generation'));
    const DOC_KEY = 'health_roadmap_doc_v2:synthetic-ref';
    localStorage.setItem(DOC_KEY, 'data:application/pdf;base64,AA==');
    await expect(new local.LocalStorageAdapter().disconnect()).rejects.toThrow('history cleanup');
    expect(localStorage.getItem(DOC_KEY)).toBeNull();
  });
});

// Adversary R2: another tab on this device latches too. Adversary re-check R2:
// only a tab whose roadmap backend is a cloud; a local-mode tab keeps saving.
describe('US-09 AC2c: log-off closes the barrier in every cloud-mode tab on the device', () => {
  const SIGNAL_KEY = 'health_roadmap_log_off_signal';
  /** Deliver each change to the page's listeners, as a browser does to other tabs. */
  function storageEventsReachOtherTabs(failKey?: (key: string) => boolean) {
    vi.stubGlobal('localStorage', makeStorage(failKey, (key) => {
      window.dispatchEvent(Object.assign(new Event('storage'), { key }));
    }));
    localStorage.setItem(UNRELATED_KEY, 'keep');
  }
  /** A second page: its own module graph, the same window and localStorage. */
  async function otherTab() {
    vi.resetModules();
    return {
      storage: await import('../src/storage/roadmap-store'),
      local: await import('../src/storage/local-storage-adapter'),
    };
  }
  function expectDeviceWriteRefused(other: Awaited<ReturnType<typeof otherTab>>) {
    expect(() => new other.local.LocalStorageAdapter().writeSync('health-roadmap.json', {}, null))
      .toThrow('stopped for logout');
    other.storage.markSyncPending();
    expectDeviceEmpty();
  }

  it('a cloud-mode tab cannot recreate the device file after this tab logs off, and no signal stays behind', async () => {
    storageEventsReachOtherTabs();
    const other = await otherTab();
    const cloud = new ControlledCloud();
    const store = await other.storage.RoadmapStore.create(cloud);
    expect(other.local.roadmapLocalWritesStopped()).toBe(false);

    await connect.logOff('local');
    expect(other.local.roadmapLocalWritesStopped()).toBe(true);
    expect(Object.keys(localStorage).filter((key) => key.includes('log_off'))).toEqual([]);
    // Its failed cloud save does not mirror the record back on-device.
    store.addMeasurement('weight', 81, '2026-01-01');
    cloud.fail = true;
    await expect(store.flush()).rejects.toThrow();
    expectDeviceWriteRefused(other);
  });

  it('Codex re-check R1: a signal lost to a full localStorage is sent again after the wipe frees space', async () => {
    // Full while the device file is there: the first signal write throws.
    let refusedSignals = 0;
    storageEventsReachOtherTabs((key) => {
      const full = key === SIGNAL_KEY && localStorage.getItem(FILE_KEY) != null;
      if (full) refusedSignals += 1;
      return full;
    });
    await data.initRoadmapStore(new local.LocalStorageAdapter());
    await data.addMeasurement('weight', 79, '2026-01-01');
    await data.flushRoadmapStore();
    const other = await otherTab();
    await other.storage.RoadmapStore.create(new ControlledCloud());

    await connect.logOff('local');
    expect(refusedSignals).toBe(1);
    expect(other.local.roadmapLocalWritesStopped()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expectDeviceWriteRefused(other);
  });

  it('a local-mode tab keeps saving after another tab logs off (its device copy is its only store)', async () => {
    storageEventsReachOtherTabs();
    const other = await otherTab();
    const store = await other.storage.RoadmapStore.create(new other.local.LocalStorageAdapter());

    await connect.logOff('local');
    expect(other.local.roadmapLocalWritesStopped()).toBe(false);
    store.addMeasurement('weight', 81, '2026-01-01');
    await store.flush();
    expect(localStorage.getItem(FILE_KEY)).not.toBeNull();
  });

  it('an unrelated storage event leaves a cloud-mode tab writing', async () => {
    await storage.RoadmapStore.create(new ControlledCloud());
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'health_roadmap_backend' }));
    window.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
    expect(local.roadmapLocalWritesStopped()).toBe(false);
    const store = await storage.RoadmapStore.create(new local.LocalStorageAdapter());
    store.addMeasurement('weight', 82, '2026-01-01');
    await store.flush();
    expect(localStorage.getItem(FILE_KEY)).not.toBeNull();
  });
});
