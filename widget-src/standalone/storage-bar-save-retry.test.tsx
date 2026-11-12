// @vitest-environment jsdom
/**
 * US-09 AC30 (lead A1 step e): a failed cloud save is retried when the
 * browser comes back online, through the real data layer, record session,
 * live refresh and web host. The line goes back to "Synced to Dropbox", and
 * one `save_retry` product event says how it went. Settings says "It will
 * upload automatically." only while a retry will in fact happen: after a
 * failed save that was not a refused grant.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { PERSIST_DEBOUNCE_MS } from '@roadmap/health-core/record-session';
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core/adapter';

vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/lib/server-api', async (original) => ({
  ...(await original<typeof import('../src/lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', () => ({
  storageState: (backend: string, reconnect?: string) =>
    (reconnect ? 'reconnect' : backend === 'local' ? 'guest' : 'cloud'),
  prepareSwitch: vi.fn(),
  liftLocalInto: vi.fn(),
  adapterFor: () => null,
  finishFormConnect: vi.fn(),
  logOff: vi.fn(),
  connectRefusal: () => null,
  rememberSignIn: vi.fn(() => true),
  forgetBackend: vi.fn(),
  useBusyRun: () => ({ busy: false, error: null, setError: vi.fn(), run: (fn: () => Promise<void>) => fn() }),
}));

import { StorageBar, SyncControl } from './sync-control';
import { addMeasurement, flushRoadmapStore, initRoadmapStore } from '../src/lib/roadmap-data';
import { trackProductEvent } from '../src/lib/server-api';
import { GitHubAdapter } from '../src/storage/github';

/** A cloud whose writes can fail with a chosen error, counting each one tried. */
class TestCloud extends MemoryAdapter {
  fail: Error | null = null;
  /** Thrown by the first read after a write lands: the save's verify read. */
  failVerify: Error | null = null;
  private landed = false;
  writes = 0;
  async read(...args: Parameters<MemoryAdapter['read']>) {
    if (this.landed && this.failVerify) { this.landed = false; throw this.failVerify; }
    return super.read(...args);
  }
  async write(...args: Parameters<MemoryAdapter['write']>) {
    this.writes += 1;
    if (this.fail) throw this.fail;
    const result = await super.write(...args);
    this.landed = true;
    return result;
  }
}
const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
const OFFLINE = () => new StorageError('Dropbox did not answer', undefined, new TypeError('Failed to fetch'));
const REVOKED = () => new StorageError('Dropbox call failed (401).', undefined, undefined, 401);

const WAITING = 'Some data in this browser is still waiting to sync to your Dropbox.';
const RETRY_CLAUSE = 'It will upload automatically.';
const SAFE = 'Your data is safe in this browser meanwhile.';

const line = () => document.querySelector('.hr-storage-state')?.textContent;
/** Settings' waiting line, as a remount shows it. */
const settingsDetail = () => {
  cleanup();
  render(<SyncControl backend="dropbox" />);
  return document.querySelector('.hr-sync-detail')?.textContent ?? null;
};
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const online = () => act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(10); });
const saveRetries = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => (name as string) === 'save_retry');

/** A page whose one cloud save failed with `error`. */
async function failedSave(error: Error) {
  const cloud = new TestCloud(new MemoryCloud());
  await initRoadmapStore(cloud);
  vi.useFakeTimers();
  render(<StorageBar backend="dropbox" />);
  cloud.fail = error;
  await act(async () => { await addMeasurement('weight', 80, '2026-06-01'); });
  await advance(PERSIST_DEBOUNCE_MS);
  expect(cloud.writes).toBe(1);
  expect(line()).toBe('Not synced yet. Your changes are on this device.');
  return cloud;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory'); // the page's cloud, as connect.ts remembers it
  vi.mocked(trackProductEvent).mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

describe('US-09 AC30: a failed cloud save is retried when the browser comes back online (lead A1 step e)', () => {
  it('the online event lands the save: the line says Synced again, and one save_retry says landed', async () => {
    const cloud = await failedSave(OFFLINE());
    cloud.fail = null;
    await online();
    expect(cloud.writes).toBe(2);
    expect(line()).toBe('Synced to Dropbox');
    expect(saveRetries()).toEqual([['save_retry', { trigger: 'online', outcome: 'landed' }]]);
  });

  it('after a refused grant, the online event tries nothing and sends no save_retry', async () => {
    const cloud = await failedSave(REVOKED());
    cloud.fail = null;
    await online();
    expect(cloud.writes).toBe(1);
    expect(saveRetries()).toEqual([]);
  });

  // PR 1458 N1: a revoked GitHub token, as the real adapter throws it, is a refused sign-in.
  // Kept before any test that leaves an offline failed save: an earlier page's online listener
  // would answer this test's online event.
  it('a GitHub save refused 401: the online event tries nothing, and the waiting line never promises an upload', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{"message":"Bad credentials"}', { status: 401 }));
    const refused = await new GitHubAdapter({ token: 'test-token-good', owner: 'synthetic', repo: 'health' })
      .read(ROADMAP_FILE_NAME).then(() => null, (e: unknown) => e as Error).finally(() => { globalThis.fetch = realFetch; });
    expect(refused).toBeInstanceOf(StorageError);
    const cloud = await failedSave(refused!);
    cloud.fail = null;
    await online();
    expect(cloud.writes).toBe(1);
    expect(saveRetries()).toEqual([]);
    expect(settingsDetail()).toBe(`${WAITING} ${SAFE}`);
  });
});

describe('US-09 AC30: Settings says a retry will come only when one will (lead A1 step e)', () => {
  it('after a failed save (offline), the waiting line says it will upload automatically', async () => {
    await failedSave(OFFLINE());
    expect(settingsDetail()).toBe(`${WAITING} ${RETRY_CLAUSE} ${SAFE}`);
  });

  it('after a refused grant, the waiting line never promises an upload', async () => {
    await failedSave(REVOKED());
    const detail = settingsDetail();
    expect(detail).toBe(`${WAITING} ${SAFE}`);
    expect(detail).not.toContain(RETRY_CLAUSE);
  });

  // F7: a log-off in another tab stops this page's writes (US-09 AC2c), so no retry will come.
  // The sentence goes at once, with no save event to tell the line.
  it('a log-off in another tab takes the sentence away at once', async () => {
    await failedSave(OFFLINE());
    cleanup();
    render(<SyncControl backend="dropbox" />);
    const detail = () => document.querySelector('.hr-sync-detail')?.textContent ?? null;
    expect(detail()).toBe(`${WAITING} ${RETRY_CLAUSE} ${SAFE}`);
    act(() => {
      localStorage.setItem(LOG_OFF_ID_KEY, 'logged-off-elsewhere');
      window.dispatchEvent(new StorageEvent('storage', { key: LOG_OFF_ID_KEY }));
    });
    expect(detail()).not.toContain(RETRY_CLAUSE);
  });

  // Codex R2 (F3): a revoked grant met after the write landed keeps its reason through the rewrap.
  it('a revoked grant met by the verify read after the write landed never promises an upload', async () => {
    const cloud = new TestCloud(new MemoryCloud());
    await initRoadmapStore(cloud);
    vi.useFakeTimers();
    render(<StorageBar backend="dropbox" />);
    cloud.failVerify = new StorageError('Google Drive needs to be reconnected.', undefined, undefined, undefined, 'reconnect');
    await act(async () => { await addMeasurement('weight', 80, '2026-06-01'); });
    await advance(PERSIST_DEBOUNCE_MS);
    expect(cloud.writes).toBe(1);
    expect(settingsDetail()).toBe(`${WAITING} ${SAFE}`);
  });

  it('once saved, there is no waiting line', async () => {
    const cloud = new TestCloud(new MemoryCloud());
    await initRoadmapStore(cloud);
    await act(async () => { await addMeasurement('weight', 80, '2026-06-01'); await flushRoadmapStore(); });
    expect(cloud.writes).toBe(1);
    expect(settingsDetail()).toBeNull();
  });
});
