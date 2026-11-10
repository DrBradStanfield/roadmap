// @vitest-environment jsdom
/**
 * Untangle fix 4, step 1 (pins only): the guarantee the erase machine rests
 * on. Whenever the store takes in a merge that moves the erase identity
 * (RecordSession.adopt), the page hears REMOTE_CHANGED in the same task, with
 * no await between the move and the dispatch (US-16 AC2a, US-34 AC1, AC6).
 * The machine may then defer its own-save on an erase, knowing every moved
 * identity reaches the page before anything else runs.
 *
 * How it is observed: adopt is wrapped. When it moves the identity, a
 * microtask is queued. If the event is heard before that microtask runs, the
 * dispatch happened in the move's own task with no await between (an await
 * would let the queued microtask run first). If the microtask runs first, the
 * move is LATE.
 *
 * One path per way adopt is reached: another tab's storage event, the minute
 * poll, a cloud's change signal (watch), a save that folds the change in
 * (one pass and two), and a tab's hide (flushSync). Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core/adapter';
import { migrateFile } from '@roadmap/health-core/migrate';
import { rowRootIds } from '@roadmap/health-core/merge';
import { RecordSession, REMOTE_POLL_MS } from '@roadmap/health-core/record-session';
import { CURRENT_SCHEMA_VERSION } from '@roadmap/health-core/roadmap-file';
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

/** A cloud with a change signal the test fires by hand. */
class WatchedCloud extends MemoryAdapter {
  listeners: Array<() => void> = [];
  watch(_fileName: string, onChange: () => void, signal: AbortSignal) {
    this.listeners.push(onChange);
    signal.addEventListener('abort', () => { this.listeners = this.listeners.filter(l => l !== onChange); });
  }
}

interface Probe {
  /** adopt calls that moved the erase identity. */
  moves: number;
  /** Moves heard in their own task, the store already at the new identity. */
  onTime: number;
  /** Moves whose microtask ran before the page heard of them. */
  late: number;
  /** Every REMOTE_CHANGED heard. */
  heard: number;
}

let stopProbe: () => void = () => {};
/** Watch adopt and REMOTE_CHANGED on `store`'s session. */
function probe(store: RoadmapStore): Probe {
  const p: Probe = { moves: 0, onTime: 0, late: 0, heard: 0 };
  let unheard: string | null = null; // the identity a move reached, not yet heard
  const proto = RecordSession.prototype as unknown as { adopt: (merged: unknown) => boolean };
  const adopt = proto.adopt;
  vi.spyOn(proto, 'adopt').mockImplementation(function (this: RecordSession, merged: unknown) {
    const before = this.eraseIdentity;
    const answer = adopt.call(this, merged);
    if (this.eraseIdentity !== before) {
      p.moves += 1;
      unheard = this.eraseIdentity;
      void Promise.resolve().then(() => { if (unheard !== null) { p.late += 1; unheard = null; } });
    }
    return answer;
  });
  const heard = () => {
    p.heard += 1;
    if (unheard !== null && store.eraseIdentity === unheard) p.onTime += 1;
    unheard = null;
  };
  window.addEventListener(REMOTE_CHANGED_EVENT, heard);
  stopProbe = () => window.removeEventListener(REMOTE_CHANGED_EVENT, heard);
  return p;
}

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };
const stops: Array<() => void> = [];

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  stopProbe();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Fix 4 guarantee (US-16 AC2a, US-34): a moved erase identity is announced in the same task, no await between', () => {
  it('US-34 AC6: another tab\'s erase, heard through the storage event', async () => {
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    stops.push(store.startLiveRefresh());
    await anotherWriterErases(new LocalStorageAdapter());
    const before = store.eraseIdentity;
    const p = probe(store);
    window.dispatchEvent(new StorageEvent('storage', { key: FILE_KEY }));
    await settle();
    expect(store.eraseIdentity).not.toBe(before);
    expect(p).toEqual({ moves: 1, onTime: 1, late: 0, heard: 1 });
  });

  it('US-34 AC1: another device\'s erase, read by the minute poll (a cloud with no change signal)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    stops.push(store.startLiveRefresh());
    await anotherWriterErases(new MemoryAdapter(cloud));
    const before = store.eraseIdentity;
    const p = probe(store);
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS + 10);
    expect(store.eraseIdentity).not.toBe(before);
    expect(p).toEqual({ moves: 1, onTime: 1, late: 0, heard: 1 });
  });

  it('US-34 AC1: another device\'s erase, read on the cloud\'s change signal (watch)', async () => {
    const cloud = new MemoryCloud();
    const adapter = new WatchedCloud(cloud);
    const store = await RoadmapStore.create(adapter);
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    stops.push(store.startLiveRefresh());
    expect(adapter.listeners).toHaveLength(1);
    await anotherWriterErases(new MemoryAdapter(cloud));
    const before = store.eraseIdentity;
    const p = probe(store);
    adapter.listeners[0]();
    await settle();
    expect(store.eraseIdentity).not.toBe(before);
    expect(p).toEqual({ moves: 1, onTime: 1, late: 0, heard: 1 });
  });

  it('US-34 AC1: a save that folds another device\'s erase in, in one pass', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    await anotherWriterErases(new MemoryAdapter(cloud));
    const before = store.eraseIdentity;
    const p = probe(store);
    store.addMeasurement('waist', 90, '2026-09-02');
    await store.flush();
    expect(store.eraseIdentity).not.toBe(before);
    expect(p).toEqual({ moves: 1, onTime: 1, late: 0, heard: 1 });
  });

  it('US-10 AC5: a tab\'s hide (flushSync) that merges another tab\'s erase in', async () => {
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    store.addMeasurement('waist', 90, '2026-09-02'); // unsaved, so the hide writes
    await anotherWriterErases(new LocalStorageAdapter());
    const before = store.eraseIdentity;
    const p = probe(store);
    store.flushSync();
    await settle();
    expect(store.eraseIdentity).not.toBe(before);
    expect(p).toEqual({ moves: 1, onTime: 1, late: 0, heard: 1 });
  });

  /**
   * FAILS THE GUARANTEE TODAY (record-session.ts saveLoop, ~705-735). The fold
   * moves the identity inside the loop (adopt, ~720), but the page hears of it
   * only once the loop ends (~725, or ~734 on a failure). An edit made while
   * the first write is out sends the loop round again, and that pass awaits
   * its own read and write before the dispatch. Written as it.fails: it pins
   * today's gap, and flips once a fix announces the move in its own pass.
   */
  for (const second of ['lands', 'fails'] as const) {
    it.fails(`US-34 AC1 (GAP, fix 4 decides): a save that folds another device's erase in, then goes round again because an edit came in meanwhile; the second pass ${second}`, async () => {
      const cloud = new MemoryCloud();
      const store = await RoadmapStore.create(new MemoryAdapter(cloud));
      store.addMeasurement('weight', 82, '2026-09-01');
      await store.flush();
      await anotherWriterErases(new MemoryAdapter(cloud));
      const before = store.eraseIdentity;
      let writes = 0;
      const write = MemoryAdapter.prototype.write;
      vi.spyOn(MemoryAdapter.prototype, 'write').mockImplementation(async function (this: MemoryAdapter, ...args) {
        writes += 1;
        if (writes === 1) store.addMeasurement('ldl', 3.1, '2026-09-03'); // made while the first write is out
        if (writes > 1 && second === 'fails') throw new Error('cloud did not answer');
        return write.apply(this, args);
      });
      const p = probe(store);
      store.addMeasurement('waist', 90, '2026-09-02');
      await store.flush().catch(() => {});
      expect(writes).toBeGreaterThan(1); // the loop went round
      expect(store.eraseIdentity).not.toBe(before);
      expect(p.heard).toBe(1); // heard, but late: this is the line that fails
      expect(p).toEqual({ moves: 1, onTime: 1, late: 0, heard: 1 });
    });
  }

  // The it.fails above passes for the right reason only if the move is heard
  // late, not missed or never made: this control pins exactly that.
  it('control for the gap: the two-pass fold moves the identity once and the page hears it once, after the move\'s microtask', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    await anotherWriterErases(new MemoryAdapter(cloud));
    let writes = 0;
    const write = MemoryAdapter.prototype.write;
    vi.spyOn(MemoryAdapter.prototype, 'write').mockImplementation(async function (this: MemoryAdapter, ...args) {
      writes += 1;
      if (writes === 1) store.addMeasurement('ldl', 3.1, '2026-09-03');
      return write.apply(this, args);
    });
    const p = probe(store);
    store.addMeasurement('waist', 90, '2026-09-02');
    await store.flush();
    expect(writes).toBe(2);
    expect(p).toEqual({ moves: 1, onTime: 0, late: 1, heard: 1 });
  });
});
