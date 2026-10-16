/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core';
import type { RoadmapStore } from '../storage/roadmap-store';


// US-34 AC1b: replacing the data layer must retire its previous live reader.
describe('US-34 AC1b — data-layer live-refresh ownership', () => {
  const stops: Array<() => void> = [];
  beforeEach(async () => {
    vi.resetModules();
    const { RoadmapStore } = await import('../storage/roadmap-store');
    vi.useFakeTimers();
    localStorage.clear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const start = RoadmapStore.prototype.startLiveRefresh;
    vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: RoadmapStore) {
      const stop = start.call(this);
      stops.push(stop);
      return stop;
    });
  });
  afterEach(() => {
    stops.splice(0).forEach(stop => stop());
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('refuses replacement while an edit is debounced, keeping it available to save', async () => {
    const data = await import('./roadmap-data');
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    const next = new MemoryAdapter(new MemoryCloud());
    const readNext = vi.spyOn(next, 'read');
    await data.initRoadmapStore(adapter);
    data.setLpaUnit('nmol/L');
    await expect(data.initRoadmapStore(next)).rejects.toThrow('unsaved');
    expect(readNext).not.toHaveBeenCalled();
    expect(data.getLpaUnit()).toBe('nmol/L');
    await data.flushRoadmapStore();
    const { RoadmapStore } = await import('../storage/roadmap-store');
    expect((await RoadmapStore.create(adapter)).getLpaUnit()).toBe('nmol/L');
  });

  it('keeps edits made while the replacement is loading on the working store', async () => {
    const data = await import('./roadmap-data');
    const adapter = new MemoryAdapter(new MemoryCloud());
    await data.initRoadmapStore(adapter);
    const next = new MemoryAdapter(new MemoryCloud());
    const read = next.read.bind(next);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(next, 'read').mockImplementation(async file => { await gate; return read(file); });
    const replacing = data.initRoadmapStore(next);
    data.setLpaUnit('nmol/L');
    release();
    await expect(replacing).rejects.toThrow('unsaved');
    expect(data.getLpaUnit()).toBe('nmol/L');
    await data.flushRoadmapStore();
    const { RoadmapStore } = await import('../storage/roadmap-store');
    expect((await RoadmapStore.create(adapter)).getLpaUnit()).toBe('nmol/L');
  });

  it('cancels a rejected candidate’s mirror lift without retiring the working store', async () => {
    const data = await import('./roadmap-data');
    const { RoadmapStore, PENDING_MIRROR_KEY } = await import('../storage/roadmap-store');
    const { LocalStorageAdapter } = await import('../storage/local-storage-adapter');
    const adapter = new LocalStorageAdapter();
    let signal!: AbortSignal;
    const watch = adapter.watch.bind(adapter);
    vi.spyOn(adapter, 'watch').mockImplementation((file, changed, abort) => {
      signal = abort;
      watch(file, changed, abort);
    });
    await data.initRoadmapStore(adapter);
    // Seed AFTER init, so only the candidate recovers a pending mirror.
    const seed = await RoadmapStore.create(new LocalStorageAdapter());
    seed.markReportEmailCaptured();
    await seed.flush();
    const pending = new Date().toISOString();
    localStorage.setItem(PENDING_MIRROR_KEY, pending);
    const next = new MemoryAdapter(new MemoryCloud());
    const writeNext = vi.spyOn(next, 'write');
    const read = next.read.bind(next);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(next, 'read').mockImplementation(async file => { await gate; return read(file); });
    const timersBefore = vi.getTimerCount();
    const replacing = data.initRoadmapStore(next);
    data.setLpaUnit('nmol/L');
    release();
    await expect(replacing).rejects.toThrow('unsaved');
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(timersBefore + 1); // working debounce survives
    expect(data.getLpaUnit()).toBe('nmol/L');
    await data.flushRoadmapStore(); // local save cannot legitimately clear the cloud marker
    const mirror = adapter.readSync('health-roadmap.json');
    await vi.advanceTimersByTimeAsync(1_000);
    expect.soft(writeNext).not.toHaveBeenCalled();
    expect.soft(localStorage.getItem(PENDING_MIRROR_KEY)).toBe(pending);
    expect.soft(adapter.readSync('health-roadmap.json')).toEqual(mirror);
    expect(data.getLpaUnit()).toBe('nmol/L');
    expect((await RoadmapStore.create(adapter)).getLpaUnit()).toBe('nmol/L');
    const refresh = vi.spyOn(adapter, 'read');
    adapter.writeSync('health-roadmap.json', mirror.body as object, mirror.version);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalled();
  });

  it('keeps an accepted candidate’s scheduled pending-mirror lift', async () => {
    const data = await import('./roadmap-data');
    const { RoadmapStore, PENDING_MIRROR_KEY } = await import('../storage/roadmap-store');
    const { LocalStorageAdapter } = await import('../storage/local-storage-adapter');
    await data.initRoadmapStore(new LocalStorageAdapter());
    const seed = await RoadmapStore.create(new LocalStorageAdapter());
    seed.markReportEmailCaptured();
    await seed.flush();
    localStorage.setItem(PENDING_MIRROR_KEY, new Date().toISOString());
    const next = new MemoryAdapter(new MemoryCloud());
    const write = vi.spyOn(next, 'write');
    await data.initRoadmapStore(next);
    expect(data.getReportEmailCaptured()).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).toBeNull();
    expect((await RoadmapStore.create(next)).getReportEmailCaptured()).toBe(true);
  });

  it('cancels bootstrap persistence when starting the candidate reader throws', async () => {
    const data = await import('./roadmap-data');
    const { RoadmapStore, PENDING_MIRROR_KEY } = await import('../storage/roadmap-store');
    const { LocalStorageAdapter } = await import('../storage/local-storage-adapter');
    const adapter = new LocalStorageAdapter();
    await data.initRoadmapStore(adapter);
    const seed = await RoadmapStore.create(new LocalStorageAdapter());
    seed.markReportEmailCaptured();
    await seed.flush();
    const pending = new Date().toISOString();
    localStorage.setItem(PENDING_MIRROR_KEY, pending);
    const mirror = adapter.readSync('health-roadmap.json');
    const next = new MemoryAdapter(new MemoryCloud());
    const write = vi.spyOn(next, 'write');
    // Adapter.watch can throw synchronously during reader startup.
    vi.mocked(RoadmapStore.prototype.startLiveRefresh).mockImplementationOnce(() => {
      throw new Error('synthetic reader startup refusal');
    });
    await expect(data.initRoadmapStore(next)).rejects.toThrow('synthetic reader startup refusal');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).toBe(pending);
    expect(adapter.readSync('health-roadmap.json')).toEqual(mirror);
    expect(data.getBackendKind()).toBe('local');
    data.setLpaUnit('nmol/L');
    await data.flushRoadmapStore();
    expect((await RoadmapStore.create(adapter)).getLpaUnit()).toBe('nmol/L');
  });

  it('does not start live-refresh resources when the store factory is called directly', async () => {
    const { RoadmapStore } = await import('../storage/roadmap-store');
    const watch = vi.fn();
    const interval = vi.spyOn(globalThis, 'setInterval');
    const listen = vi.spyOn(window, 'addEventListener');
    await RoadmapStore.create(Object.assign(new MemoryAdapter(new MemoryCloud()), { watch }));
    expect(watch).not.toHaveBeenCalled();
    expect(RoadmapStore.prototype.startLiveRefresh).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(listen.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(0);
  });

  it('keeps the previous reader and working copy after replacement creation fails', async () => {
    const data = await import('./roadmap-data');
    let signal!: AbortSignal;
    const adapter = Object.assign(new MemoryAdapter(new MemoryCloud()), {
      watch: (_file: string, _changed: () => void, abort: AbortSignal) => { signal = abort; },
    });
    const read = vi.spyOn(adapter, 'read');
    await data.initRoadmapStore(adapter);
    data.setLpaUnit('nmol/L');
    await data.flushRoadmapStore();
    const next = new MemoryAdapter(new MemoryCloud());
    vi.spyOn(next, 'read').mockRejectedValue(new Error('synthetic load refusal'));
    await expect(data.initRoadmapStore(next)).rejects.toThrow('synthetic load refusal');
    expect(signal.aborted).toBe(false);
    expect(data.getLpaUnit()).toBe('nmol/L');
    const before = read.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.length).toBeGreaterThan(before);
  });

  it('clears the previous poll interval on a successful replacement', async () => {
    const data = await import('./roadmap-data');
    const adapter = new MemoryAdapter(new MemoryCloud());
    const read = vi.spyOn(adapter, 'read');
    await data.initRoadmapStore(adapter);
    const before = read.mock.calls.length;
    const timers = vi.getTimerCount();
    await data.initRoadmapStore(new MemoryAdapter(new MemoryCloud()));
    expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(read).toHaveBeenCalledTimes(before);
  });

  it('refuses replacement until an in-flight write finishes, without racing a new reader', async () => {
    const data = await import('./roadmap-data');
    const adapter = new MemoryAdapter(new MemoryCloud());
    await data.initRoadmapStore(adapter);
    const write = adapter.write.bind(adapter);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(adapter, 'write').mockImplementation(async (...args) => { await gate; return write(...args); });
    data.setLpaUnit('nmol/L');
    const saving = data.flushRoadmapStore();
    const next = new MemoryAdapter(new MemoryCloud());
    const readNext = vi.spyOn(next, 'read');
    await expect(data.initRoadmapStore(next)).rejects.toThrow('unsaved');
    expect(readNext).not.toHaveBeenCalled();
    expect(data.getLpaUnit()).toBe('nmol/L');
    release();
    await saving;
    const { RoadmapStore } = await import('../storage/roadmap-store');
    expect((await RoadmapStore.create(adapter)).getLpaUnit()).toBe('nmol/L');
    await data.initRoadmapStore(next);
  });

  it('does not race a clean store whose explicit flush is still in flight', async () => {
    const data = await import('./roadmap-data');
    const adapter = new MemoryAdapter(new MemoryCloud());
    await data.initRoadmapStore(adapter);
    const write = adapter.write.bind(adapter);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(adapter, 'write').mockImplementation(async (...args) => { await gate; return write(...args); });
    const saving = data.flushRoadmapStore();
    const rejected = expect(data.initRoadmapStore(new MemoryAdapter(new MemoryCloud()))).rejects.toThrow('pending');
    release();
    await saving;
    await rejected;
  });

  it('retains a failed save for retry instead of replacing it', async () => {
    const data = await import('./roadmap-data');
    const adapter = new MemoryAdapter(new MemoryCloud());
    await data.initRoadmapStore(adapter);
    const write = vi.spyOn(adapter, 'write').mockRejectedValue(new Error('synthetic write refusal'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    data.setLpaUnit('nmol/L');
    await expect(data.flushRoadmapStore()).rejects.toThrow('Cloud sync failed');
    await expect(data.initRoadmapStore(new MemoryAdapter(new MemoryCloud()))).rejects.toThrow('unsaved');
    expect(data.getLpaUnit()).toBe('nmol/L');
    write.mockRestore();
    await data.flushRoadmapStore();
    const { RoadmapStore } = await import('../storage/roadmap-store');
    expect((await RoadmapStore.create(adapter)).getLpaUnit()).toBe('nmol/L');
  });

  it('aborts the replaced watch, cancels its trailing read and removes its listeners', async () => {
    const data = await import('./roadmap-data');
    let push!: () => void;
    let signal!: AbortSignal;
    const adapter = Object.assign(new MemoryAdapter(new MemoryCloud()), {
      watch: vi.fn((_file: string, changed: () => void, abort: AbortSignal) => {
        push = changed;
        signal = abort;
      }),
    });
    const read = vi.spyOn(adapter, 'read');
    await data.initRoadmapStore(adapter);
    push();
    await vi.advanceTimersByTimeAsync(0);
    push(); // within the throttle: queue the trailing read
    expect(vi.getTimerCount()).toBe(1);
    const oldReads = read.mock.calls.length;
    await data.initRoadmapStore(new MemoryAdapter(new MemoryCloud()));
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(oldReads);
    expect(vi.getTimerCount()).toBe(1); // only the replacement's poll
  });
});
