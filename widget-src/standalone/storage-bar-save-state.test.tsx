// @vitest-environment jsdom
/**
 * What the storage line says as a cloud save waits, runs and fails, through
 * the real record store and pending marker. Pinned before the
 * save mode becomes one union (lead A1, step a); storage-bar.test.tsx pins the
 * label against a mocked marker.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { PERSIST_DEBOUNCE_MS } from '@roadmap/health-core/record-session';
import { StorageError } from '@roadmap/health-core/adapter';

vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
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
  forgetClearedErase: vi.fn(),
  useBusyRun: () => ({ busy: false, error: null, setError: vi.fn(), run: (fn: () => Promise<void>) => fn() }),
}));

import { StorageBar } from './sync-control';
import { RoadmapStore } from '../src/storage/roadmap-store';

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

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory'); // the page's cloud, as connect.ts remembers it
});
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

describe('the storage line through a real cloud save (lead A1)', () => {
  it('a cloud save that rejects says Saving… (US-09 AC4), and tries no second save until an edit', async () => {
    const cloud = new TestCloud(new MemoryCloud());
    const store = await RoadmapStore.create(cloud);
    vi.useFakeTimers();
    render(<StorageBar backend="dropbox" />);
    expect(line()).toBe('Synced to Dropbox');

    cloud.failing = true;
    store.addMeasurement('weight', 80, '2026-06-01');
    await advance(PERSIST_DEBOUNCE_MS);
    expect(cloud.writes).toBe(1);
    expect(line()).toBe('Saving…');

    await advance(PERSIST_DEBOUNCE_MS * 50);
    expect(cloud.writes).toBe(1); // no retry of its own
    expect(line()).toBe('Saving…');

    cloud.failing = false;
    store.addMeasurement('weight', 81, '2026-06-02');
    await advance(PERSIST_DEBOUNCE_MS);
    expect(cloud.writes).toBe(2);
    expect(line()).toBe('Synced to Dropbox');
  });

  it('today (step d of lead A1 changes this, US-09 AC30): says Synced to the provider while an edit waits on the debounce and while its save is in flight', async () => {
    const cloud = new TestCloud(new MemoryCloud());
    const store = await RoadmapStore.create(cloud);
    vi.useFakeTimers();
    render(<StorageBar backend="dropbox" />);

    let release!: () => void;
    cloud.held = new Promise<void>((resolve) => { release = resolve; });
    store.addMeasurement('weight', 80, '2026-06-01');
    await advance(PERSIST_DEBOUNCE_MS - 1);
    expect(cloud.writes).toBe(0);
    expect(line()).toBe('Synced to Dropbox'); // on the debounce
    await advance(1);
    expect(cloud.writes).toBe(1);
    expect(line()).toBe('Synced to Dropbox'); // in flight
    release();
    await act(async () => { await store.flush(); });
    expect(cloud.writes).toBe(1);
    expect(line()).toBe('Synced to Dropbox');
  });
});
