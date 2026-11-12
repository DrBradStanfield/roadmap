// @vitest-environment jsdom
/**
 * US-09 AC30 (lead A1 step d): what the storage line says as a cloud save
 * waits, runs, fails and lands, through the real data layer, record session,
 * web host event and pending marker. storage-bar.test.tsx pins the label
 * table against a mocked status and marker.
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
  rememberBackend: vi.fn(),
  forgetBackend: vi.fn(),
  useBusyRun: () => ({ busy: false, error: null, setError: vi.fn(), run: (fn: () => Promise<void>) => fn() }),
}));

import { StorageBar } from './sync-control';
import { addMeasurement, flushRoadmapStore, initRoadmapStore } from '../src/lib/roadmap-data';
import { LocalStorageAdapter } from '../src/storage/local-storage-adapter';
import { markSyncPending } from '../src/storage/web-record-host';

/** A cloud whose writes can fail or be held, counting each one tried. */
class TestCloud extends MemoryAdapter {
  failing = false;
  held: Promise<void> | null = null;
  writes = 0;
  async write(...args: Parameters<MemoryAdapter['write']>) {
    this.writes += 1;
    if (this.held) await this.held;
    if (this.failing) throw new StorageError('The network is down.');
    return super.write(...args);
  }
}

const line = () => document.querySelector('.hr-storage-state')?.textContent;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const add = (value: number, day: string) => act(async () => { await addMeasurement('weight', value, day); });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory'); // the page's cloud, as connect.ts remembers it
});
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

describe('US-09 AC30: the storage line says what the session knows (lead A1 step d)', () => {
  it('a cloud save that rejects says "Not synced yet." with the device line, tries no second save until an edit, and says Synced once one lands', async () => {
    const cloud = new TestCloud(new MemoryCloud());
    await initRoadmapStore(cloud);
    vi.useFakeTimers();
    render(<StorageBar backend="dropbox" />);
    expect(line()).toBe('Synced to Dropbox');

    cloud.failing = true;
    await add(80, '2026-06-01');
    await advance(PERSIST_DEBOUNCE_MS);
    expect(cloud.writes).toBe(1);
    expect(line()).toBe('Not synced yet. Your changes are on this device.'); // the failure mirror set the marker (US-09 AC4)

    await advance(PERSIST_DEBOUNCE_MS * 50);
    expect(cloud.writes).toBe(1); // no retry of its own (step e adds one)
    expect(line()).toBe('Not synced yet. Your changes are on this device.');

    cloud.failing = false;
    await add(81, '2026-06-02');
    await advance(PERSIST_DEBOUNCE_MS);
    expect(cloud.writes).toBe(2);
    expect(line()).toBe('Synced to Dropbox');
  });

  it('says "Saving to Dropbox…" while an edit waits on the debounce and while its save is in flight, never Synced', async () => {
    const cloud = new TestCloud(new MemoryCloud());
    await initRoadmapStore(cloud);
    vi.useFakeTimers();
    render(<StorageBar backend="dropbox" />);

    let release!: () => void;
    cloud.held = new Promise<void>((resolve) => { release = resolve; });
    await add(80, '2026-06-01');
    await advance(PERSIST_DEBOUNCE_MS - 1);
    expect(cloud.writes).toBe(0);
    expect(line()).toBe('Saving to Dropbox…'); // on the debounce
    await advance(1);
    expect(cloud.writes).toBe(1);
    expect(line()).toBe('Saving to Dropbox…'); // in flight
    release();
    await act(async () => { await flushRoadmapStore(); });
    expect(cloud.writes).toBe(1);
    expect(line()).toBe('Synced to Dropbox');
  });

  it('a failed save whose device copy was not written (another tab moved this browser off the cloud) says "Not synced yet." alone', async () => {
    const cloud = new TestCloud(new MemoryCloud());
    await initRoadmapStore(cloud);
    vi.useFakeTimers();
    render(<StorageBar backend="dropbox" problemsOnly />);
    expect(line()).toBeUndefined(); // all is well: nothing atop My health

    localStorage.setItem('health_roadmap_backend', 'local'); // US-09 AC13: another tab chose this browser
    cloud.failing = true;
    await add(80, '2026-06-01');
    expect(line()).toBeUndefined(); // saving: the phone bar never flashes for it (owner, 2026-11-12)
    await advance(PERSIST_DEBOUNCE_MS);
    expect(cloud.writes).toBe(1);
    expect(line()).toBe('Not synced yet.');
  });

  it('a marker an earlier session left, which this session cannot lift yet (a newer app wrote the device copy), shows the not-synced words while the session is saved', async () => {
    new LocalStorageAdapter().writeSync(ROADMAP_FILE_NAME, { schemaVersion: 9999 }, null);
    markSyncPending();
    const cloud = new TestCloud(new MemoryCloud());
    await initRoadmapStore(cloud);
    render(<StorageBar backend="dropbox" />);
    expect(line()).toBe('Not synced yet. Your changes are on this device.');
  });
});
