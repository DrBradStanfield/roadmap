import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
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

function makeStorage(failKey?: string): Storage {
  const values = Object.create(null) as Record<string, string>;
  Object.defineProperties(values, {
    length: { get() { return Object.keys(values).length; } },
    getItem: { value: (key: string) => values[key] ?? null },
    setItem: { value: (key: string, value: string) => {
      if (key === failKey) throw new Error('synthetic quota failure');
      values[key] = String(value);
    } },
    removeItem: { value: (key: string) => { delete values[key]; } },
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

function installLifecycle(event: 'beforeunload' | 'visibilitychange') {
  // Actual entrypoint registration block, not a hand-copied handler. Events and
  // reload are SIMULATED EventTargets, not a real browser navigation/unload.
  const source = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
  const start = source.indexOf("  document.addEventListener('visibilitychange'");
  const end = source.indexOf('  // Keep the server', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  runInNewContext(source.slice(start, end), {
    document, window, flushRoadmapStoreSync: data.flushRoadmapStoreSync,
    pushReminderSchedule: vi.fn(), backend: 'github',
  });
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

describe('logout is a barrier to late on-device roadmap persistence', () => {
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
      installLifecycle(event);
      await connect.logOff('github');
      await settleLifecycle();
      expect(reload).toHaveBeenCalledOnce();
      expectDeviceEmpty();
    });

    it(`${event}: successful cloud lifecycle flush still saves the dirty record`, async () => {
      const cloud = new ControlledCloud();
      await data.initRoadmapStore(cloud);
      await data.addMeasurement('weight', 77, '2026-01-01');
      installLifecycle(event);
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
      installLifecycle(event);
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
        tags: { area: 'cloud-sync', op: 'log-off', backend: 'local' },
      });
    });
  }

  it('a clean local lifecycle remains empty after logout (negative control)', async () => {
    await data.initRoadmapStore(new local.LocalStorageAdapter());
    await data.addMeasurement('weight', 79, '2026-01-01');
    await data.flushRoadmapStore();
    expect(localStorage.getItem(FILE_KEY)).not.toBeNull();
    installLifecycle('beforeunload');
    await connect.logOff('local');
    await settleLifecycle();
    expectDeviceEmpty();
  });
});
