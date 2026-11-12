// US-09 AC30 (lead A1 step e): RecordSession.retry() starts one save of a
// failed pass's changes, only when `retryOwed`: never while a pass runs (it
// is single-flight, so nothing doubles), never while erasing, never after a
// refused grant, and never on a page whose writes have stopped.
import { describe, expect, it } from 'vitest';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { ConflictError, ROADMAP_FILE_NAME, StorageError, type ReadResult, type WriteResult } from './adapter';
import { createMeasurement, type RoadmapFile } from './roadmap-file';

/** A cloud whose writes can fail with a chosen error, or be held. */
class TestCloud extends MemoryAdapter {
  fail: Error | null = null;
  held: Promise<void> | null = null;
  writes = 0;
  async write(fileName: string, body: object, expected: string | null) {
    this.writes += 1;
    if (this.held) await this.held;
    if (this.fail) throw this.fail;
    return super.write(fileName, body, expected);
  }
}

const OFFLINE = () => new StorageError('Dropbox did not answer', undefined, new TypeError('Failed to fetch'));
const REVOKED = () => new StorageError('Dropbox call failed (401).', undefined, undefined, 401);
const clock = Date.parse('2026-11-13T10:00:00.000Z');

function cloudHost(store: TestCloud, stopped = { value: false }): RecordHost {
  return {
    tier: 'cloud',
    store,
    mirror: {
      adapter: new MemoryAdapter(new MemoryCloud()),
      pending: { get: () => false, set: () => {}, clear: () => {} },
      writesStopped: () => stopped.value,
      wipe: async () => {},
      opened: () => {},
    },
    clearOffFileData: () => {},
    clearedErase: () => null,
    noteCleared: () => {},
    deviceId: () => 'web-1',
    clock: { now: () => clock },
    timers: { set: () => ({}), clear: () => {} }, // the debounce never fires: each test saves by flush or retry
    remoteChanged: () => {},
    failureCause: () => 'other',
    report: () => {},
  };
}

/** A device store with the synchronous face a device tier needs, as localStorage has. */
class DeviceStore extends TestCloud {
  readSync(fileName: string): ReadResult {
    const entry = this.cloud.files.get(fileName);
    return entry ? { body: JSON.parse(entry.json), version: String(entry.version) } : { body: null, version: null };
  }
  writeSync(fileName: string, body: object, expected: string | null): WriteResult {
    this.writes += 1;
    const entry = this.cloud.files.get(fileName);
    if ((entry ? String(entry.version) : null) !== expected) throw new ConflictError('moved');
    const version = (entry?.version ?? 0) + 1;
    this.cloud.files.set(fileName, { json: JSON.stringify(body), version });
    return { version: String(version) };
  }
  revision(fileName: string): string | null {
    const entry = this.cloud.files.get(fileName);
    return entry ? String(entry.version) : null;
  }
}

function deviceHost(store: DeviceStore, open: { value: boolean }): RecordHost {
  const { mirror: _mirror, tier: _tier, ...base } = cloudHost(store) as Extract<RecordHost, { tier: 'cloud' }>;
  return { ...base, tier: 'device', sync: store, clearNamedFiles: () => {}, eraseFence: () => null, deviceFilesOpen: () => open.value };
}

const add = (session: RecordSession, id: string) =>
  session.edit((file) => void file.measurements.push(createMeasurement({ id, metricType: 'weight', value: 80, recordedAt: '2026-11-01', createdAt: new Date(clock).toISOString() })));
const stored = (store: TestCloud): RoadmapFile => JSON.parse(store.cloud.files.get(ROADMAP_FILE_NAME)!.json);

/** A session whose one save has failed with `error`. */
async function failedSession(error: Error, stopped?: { value: boolean }) {
  const store = new TestCloud(new MemoryCloud());
  const session = await RecordSession.open(cloudHost(store, stopped));
  store.fail = error;
  add(session, 'a');
  await expect(session.flush()).rejects.toThrow();
  expect(store.writes).toBe(1);
  return { store, session };
}

describe('RecordSession.retry (US-09 AC30, lead A1 step e)', () => {
  it('after a failed save (offline), starts one save of its changes, which lands', async () => {
    const { store, session } = await failedSession(OFFLINE());
    store.fail = null;
    const run = session.retry();
    expect(run).not.toBeNull();
    expect(await run).toBe(true);
    expect(store.writes).toBe(2);
    expect(stored(store).measurements.map((m) => m.id)).toEqual(['a']);
    expect(session.saveStatus).toBe('saved');
  });

  it('a retry that fails again answers false, and leaves a retry owed', async () => {
    const { store, session } = await failedSession(OFFLINE());
    expect(await session.retry()).toBe(false);
    expect(store.writes).toBe(2);
    expect(session.saveStatus).toBe('not-saved');
    store.fail = null;
    expect(await session.retry()).toBe(true);
    expect(store.writes).toBe(3);
  });

  it('is single-flight: a second retry while the first pass runs starts nothing (one write)', async () => {
    const { store, session } = await failedSession(OFFLINE());
    store.fail = null;
    let release!: () => void;
    store.held = new Promise<void>((resolve) => { release = resolve; });
    const first = session.retry();
    expect(first).not.toBeNull();
    expect(session.retry()).toBeNull(); // saving: not owed
    release();
    expect(await first).toBe(true);
    expect(store.writes).toBe(2);
  });

  it('while an edit\'s own save runs, a retry starts nothing (one write)', async () => {
    const store = new TestCloud(new MemoryCloud());
    const session = await RecordSession.open(cloudHost(store));
    let release!: () => void;
    store.held = new Promise<void>((resolve) => { release = resolve; });
    add(session, 'a');
    const flushing = session.flush();
    expect(session.retry()).toBeNull();
    release();
    await flushing;
    expect(store.writes).toBe(1);
  });

  it('on a clean session answers null and starts nothing', async () => {
    const store = new TestCloud(new MemoryCloud());
    const session = await RecordSession.open(cloudHost(store));
    expect(session.retry()).toBeNull();
    expect(store.writes).toBe(0);
  });

  it('after a refused grant (401) answers null and starts nothing', async () => {
    const { store, session } = await failedSession(REVOKED());
    store.fail = null;
    expect(session.retry()).toBeNull();
    expect(store.writes).toBe(1);
  });

  it('after a 403 answers null and starts nothing', async () => {
    const { store, session } = await failedSession(new StorageError('Forbidden', undefined, undefined, 403));
    store.fail = null;
    expect(session.retry()).toBeNull();
    expect(store.writes).toBe(1);
  });

  it('while an erase runs over a failed save, answers null and starts nothing', async () => {
    const { store, session } = await failedSession(OFFLINE());
    store.fail = null;
    let inside: Promise<boolean> | null | undefined;
    // The caller's step runs inside the erase's reading phase (lead A6).
    const erasing = session.erase(async () => { inside = session.retry(); });
    await erasing;
    expect(inside).toBeNull();
    // The erase's own write is the only write after the failed one.
    expect(store.writes).toBe(2);
  });

  // H: a page whose writes have stopped (this device logged off in another
  // tab, US-09 AC2c) never starts a save from a retry. On main the cloud save
  // itself is not refused by writesStopped (only the device mirror is), so
  // the retry must refuse it. PR 1449 (deviceFilesOpen gate) meets this once merged.
  it('on a page whose writes have stopped, answers null and starts nothing', async () => {
    const stopped = { value: false };
    const { store, session } = await failedSession(OFFLINE(), stopped);
    store.fail = null;
    stopped.value = true;
    expect(session.retry()).toBeNull();
    expect(store.writes).toBe(1);
  });

  // PR 1449: a device page closed to this device's files fails every pass
  // before its read (deviceClosed). Its failed save is never retried either.
  it('on a device page closed to this device\'s files, answers null and starts nothing', async () => {
    const store = new DeviceStore(new MemoryCloud());
    const open = { value: true };
    const session = await RecordSession.open(deviceHost(store, open));
    open.value = false;
    add(session, 'a');
    await expect(session.flush()).rejects.toThrow();
    expect(session.saveStatus).toBe('not-saved');
    const writes = store.writes;
    expect(session.retry()).toBeNull();
    expect(store.writes).toBe(writes);
  });
});

describe('the session tells the host when a retry becomes owed or stops being owed (US-09 AC30)', () => {
  async function told(error: Error) {
    const store = new TestCloud(new MemoryCloud());
    const calls: unknown[][] = [];
    const session = await RecordSession.open({ ...cloudHost(store), saveStatusChanged: (...args: unknown[]) => void calls.push(args) });
    store.fail = error;
    add(session, 'a');
    await expect(session.flush()).rejects.toThrow();
    return { calls, session, store };
  }

  it('a failed save (offline) tells its status with a retry owed, and the session says so', async () => {
    const { calls, session } = await told(OFFLINE());
    expect(calls.at(-1)).toEqual(['not-saved-on-device', true]);
    expect(session.retryDue).toBe(true);
  });

  it('a refused grant tells its status with no retry owed', async () => {
    const { calls, session } = await told(REVOKED());
    expect(calls.at(-1)).toEqual(['not-saved-on-device', false]);
    expect(session.retryDue).toBe(false);
  });

  it('an erase over a failed save tells the same status with no retry owed while it runs', async () => {
    const { calls, session, store } = await told(OFFLINE());
    store.fail = null;
    let during: unknown[] | undefined;
    await session.erase(async () => { during = calls.at(-1); });
    expect(during).toEqual(['not-saved-on-device', false]);
    expect(calls.at(-1)).toEqual(['saved', false]);
  });
});
