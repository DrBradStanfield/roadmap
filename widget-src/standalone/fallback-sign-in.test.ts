/**
 * US-09 AC2c, AC3 — a tab for user 1's cloud, running on its device copy
 * because the cloud could not be read (a fallback tab), writes nothing to the
 * device after another tab logs off. So user 2, who signs in next on this
 * device, lifts none of user 1's rows into their cloud: not through the
 * connect's lift (AC3) and not through the pending merge on their first open.
 *
 * Each tab is its own module graph over one window and one localStorage, as
 * in logout-persistence.test.ts. In-memory clouds; no network; synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const FILE_KEY = 'health_roadmap_file_v2';
const BACKEND_KEY = 'health_roadmap_backend';
const USER_ONE_WEIGHT = 81;

/** A localStorage whose every change reaches the window, as a browser sends it to other tabs. */
function sharedStorage(): Storage {
  const values = new Map<string, string>();
  const changed = (key: string) => window.dispatchEvent(Object.assign(new Event('storage'), { key }));
  return {
    get length() { return values.size; },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (values.get(key) !== String(value)) { values.set(key, String(value)); changed(key); } },
    removeItem: (key: string) => { if (values.delete(key)) changed(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
  } as Storage;
}

/** A fresh page: its own module graph. */
async function tab() {
  vi.resetModules();
  return {
    connect: await import('./connect'),
    storage: await import('../src/storage/roadmap-store'),
    local: await import('../src/storage/local-storage-adapter'),
    lib: await import('../src/lib/storage'),
    adapter: await import('@roadmap/health-core/adapter'),
  };
}

/** A cloud whose read fails, in `page`'s own StorageError: another graph's class is not one to its catch. */
const unreachable = (page: Awaited<ReturnType<typeof tab>>) => Object.assign(new MemoryAdapter(), {
  read: async () => { throw new page.adapter.StorageError('synthetic outage', undefined, undefined, 503); },
});

/** The weights a file holds. */
const weights = (file: { measurements?: Array<{ metricType: string; value: number }> } | null) =>
  (file?.measurements ?? []).filter((m) => m.metricType === 'weight').map((m) => m.value);

beforeEach(() => {
  vi.stubGlobal('localStorage', sharedStorage());
  vi.stubGlobal('window', new EventTarget());
  const document = new EventTarget();
  Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
  vi.stubGlobal('document', document);
  vi.stubGlobal('location', { reload: vi.fn(), search: '', href: 'http://localhost/' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** User 1's tab: their cloud is chosen, and its first read fails, so it runs on its device copy. */
async function userOneFallback() {
  localStorage.setItem(BACKEND_KEY, 'github');
  const userOne = await tab();
  let fallback!: Awaited<ReturnType<typeof userOne.storage.RoadmapStore.create>>;
  await userOne.connect.startOnBackend({ adapter: unreachable(userOne), backend: 'github' }, async (adapter) => {
    fallback = await userOne.storage.RoadmapStore.create(adapter);
  });
  return fallback;
}
/** User 1's tab saves a weight and is put away. */
async function saveWeight(fallback: Awaited<ReturnType<typeof userOneFallback>>) {
  fallback.addMeasurement('weight', USER_ONE_WEIGHT, '2026-01-01');
  await fallback.flush().catch(() => {});
  fallback.flushSync();
}
/** The reloaded page signs user 2 in to their own cloud: remembered, marked pending, the device copy lifted (AC3). */
async function userTwoSignsIn() {
  const signIn = await tab();
  const cloud = Object.defineProperty(new MemoryAdapter(new MemoryCloud()), 'id', { value: 'dropbox' });
  expect(signIn.connect.rememberSignIn(true, 'dropbox', signIn.lib.logOffId())).toBe(true);
  signIn.storage.markSyncPending();
  await signIn.connect.liftLocalInto(cloud, 'dropbox');
  return cloud;
}
/** User 2's page opens their cloud record (the pending merge runs); neither it nor the device holds user 1's weight. */
async function expectNothingOfUserOne(cloud: MemoryAdapter) {
  const userTwo = await tab();
  const store = await userTwo.storage.RoadmapStore.create(cloud);
  await store.flush();
  expect(store.loadAllHistory().map((m) => m.value)).not.toContain(USER_ONE_WEIGHT);
  expect(weights((await cloud.read(ROADMAP_FILE_NAME)).body as never)).not.toContain(USER_ONE_WEIGHT);
  expect(weights(new userTwo.local.LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body as never)).not.toContain(USER_ONE_WEIGHT);
}

describe('US-09 AC2c, AC3: a sign-in after a log-off lifts nothing of a fallback tab\'s user', () => {
  it("user 2's sign-in lifts nothing of user 1's, through the connect's lift or the pending merge", async () => {
    const fallback = await userOneFallback();
    await (await tab()).connect.logOff('github'); // another tab logs user 1 off
    const cloud = await userTwoSignsIn();
    await saveWeight(fallback);
    expect(localStorage.getItem(FILE_KEY)).toBeNull();
    await expectNothingOfUserOne(cloud);
  });

  it("a weight user 1's tab saves after the log-off and before user 2's sign-in is lifted nowhere", async () => {
    const fallback = await userOneFallback();
    await (await tab()).connect.logOff('github');
    await saveWeight(fallback);
    expect(localStorage.getItem(FILE_KEY)).toBeNull();
    await expectNothingOfUserOne(await userTwoSignsIn());
  });
});
