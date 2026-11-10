// @vitest-environment jsdom
/**
 * Untangle fix 4: the guarantee the erase machine rests on (US-16 AC2a, US-34
 * AC1, AC6). Whenever the store takes in a merge that moves the erase identity
 * (RecordSession.adopt), the page hears REMOTE_CHANGED EXACTLY ONCE: never
 * missed, never twice. The machine may then defer its own-save on an erase,
 * knowing every moved identity reaches the page.
 *
 * On every path but one it also comes in the same task, with no await between
 * the move and the dispatch. The one is a save-loop fold that goes round
 * twice: it hears the erase one pass late, by design (fix 4 D2, state-leads
 * H25; the second describe below).
 *
 * How it is observed: adopt is wrapped. When it moves the identity, a
 * microtask is queued. If the event is heard before that microtask runs, the
 * dispatch happened in the move's own task with no await between (an await
 * would let the queued microtask run first): onTime. If the microtask runs
 * first, the move is late. `heard` counts every REMOTE_CHANGED.
 *
 * One path per way adopt is reached: another tab's storage event, the minute
 * poll, a cloud's change signal (watch), a save that folds the change in
 * (one pass and two), and a tab's hide (flushSync). Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ConflictError, ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core/adapter';
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

describe('Fix 4 guarantee (US-16 AC2a, US-34): a moved erase identity is heard exactly once, in the same task, no await between', () => {
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
});

/**
 * Untangle fix 4, D2 (Brad's ruling): the two-pass save-loop fold hears the
 * erase ONE PASS LATE, by design. Do not "fix" these into same-task without
 * reading state-leads H25. The fold moves the identity inside the loop
 * (record-session.ts saveLoop, adopt ~720), but the page hears of it only
 * once the loop ends (~725, or ~734 when a later pass fails). An edit made
 * while the first write is out sends the loop round again, and that pass
 * awaits its own read and write before the dispatch.
 *
 * What the erase machine needs is that the arrival is NEVER MISSED, not that
 * it comes in the same task: the own-save defers its read when the erase
 * moved. In the one-pass window the page shows the old record whole, and a
 * write carries the old erase, which the store refuses
 * (HealthTool.erase-event-pins.test.tsx "the two-pass fold's window").
 *
 * So each pin below asserts heard EXACTLY ONCE and late, on every way the loop
 * can end after the move: the second pass lands, throws (a cloud that does not
 * answer, an abort, a conflict storm), the page hides mid-loop, or a third
 * pass. An abort reaches the loop only as an adapter rejection: saveLoop hands
 * sync.save no signal, so there is no abort of the loop itself to reach. A
 * throw at the second pass's read takes the same try/catch as one at its
 * write (~708-734), so the write stands for both.
 */
const LATE = { moves: 1, onTime: 0, late: 1, heard: 1 };

/** Script this tab's record writes: `during(n)` runs as write n goes out, before it lands. */
function scriptWrites(proto: { write: StorageAdapter['write'] }, during: (n: number) => void) {
  let n = 0;
  const write = proto.write;
  vi.spyOn(proto, 'write').mockImplementation(async function (this: StorageAdapter, ...args: Parameters<StorageAdapter['write']>) {
    if (args[0] === ROADMAP_FILE_NAME) { n += 1; during(n); }
    return write.apply(this, args);
  });
  return () => n;
}

/** A cloud record, saved, then erased by another device. */
async function cloudErasedElsewhere() {
  const cloud = new MemoryCloud();
  const store = await RoadmapStore.create(new MemoryAdapter(cloud));
  store.addMeasurement('weight', 82, '2026-09-01');
  await store.flush();
  await anotherWriterErases(new MemoryAdapter(cloud));
  return store;
}

describe('Fix 4 D2 (US-34 AC1): a two-pass save-loop fold hears the erase one pass late, exactly once, never missed', () => {
  const ways: Record<string, (store: RoadmapStore, n: number) => void> = {
    'the second pass lands': () => {},
    'the second pass throws (record-session.ts ~734)': (_s, n) => { if (n === 2) throw new Error('cloud did not answer'); },
    'the second pass is aborted (the adapter rejects with AbortError)': (_s, n) => { if (n === 2) throw new DOMException('aborted', 'AbortError'); },
    'the second pass meets a conflict on every attempt (a conflict storm)': (_s, n) => { if (n >= 2) throw new ConflictError('remote moved'); },
    'the page hides mid-loop (flushSync during the second write)': (s, n) => { if (n === 2) s.flushSync(); },
  };
  for (const [way, during] of Object.entries(ways)) {
    it(`two-pass fold: the erase arrives one pass late, never missed (by design, fix 4 D2; see state-leads H25); ${way}`, async () => {
      const store = await cloudErasedElsewhere();
      const before = store.eraseIdentity;
      const writes = scriptWrites(MemoryAdapter.prototype, n => {
        if (n === 1) store.addMeasurement('ldl', 3.1, '2026-09-03'); // made while the first write is out
        during(store, n);
      });
      const p = probe(store);
      store.addMeasurement('waist', 90, '2026-09-02');
      await store.flush().catch(() => {});
      await settle();
      expect(writes()).toBeGreaterThan(1); // the loop went round
      expect(store.eraseIdentity).not.toBe(before);
      expect(p).toEqual(LATE);
    });
  }

  it('two-pass fold: the erase arrives one pass late, never missed (by design, fix 4 D2; see state-leads H25); a third pass makes three writes', async () => {
    const store = await cloudErasedElsewhere();
    const writes = scriptWrites(MemoryAdapter.prototype, n => {
      if (n === 1) store.addMeasurement('ldl', 3.1, '2026-09-03');
      if (n === 2) store.addMeasurement('hba1c', 5.4, '2026-09-04');
    });
    const p = probe(store);
    store.addMeasurement('waist', 90, '2026-09-02');
    await store.flush();
    expect(writes()).toBe(3);
    expect(p).toEqual(LATE);
  });

  it('two-pass fold: the erase arrives one pass late, never missed (by design, fix 4 D2; see state-leads H25); on this device, the page hiding mid-loop', async () => {
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    await anotherWriterErases(new LocalStorageAdapter());
    const before = store.eraseIdentity;
    const writes = scriptWrites(LocalStorageAdapter.prototype, n => {
      if (n === 1) store.addMeasurement('ldl', 3.1, '2026-09-03');
      if (n === 2) store.flushSync(); // writes synchronously, so the second write conflicts and goes round
    });
    const p = probe(store);
    store.addMeasurement('waist', 90, '2026-09-02');
    await store.flush().catch(() => {});
    await settle();
    expect(writes()).toBeGreaterThan(1);
    expect(store.eraseIdentity).not.toBe(before);
    expect(p).toEqual(LATE);
  });
});
