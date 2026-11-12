/**
 * US-09 AC30 (lead A1 step d): the session tells its host each time the save
 * status changes, and only then, so a status line follows the save without
 * polling: an edit makes it saving, a landed save saved, a failed one
 * not-saved. Over MemoryAdapter and a fake cloud host.
 */
import { describe, expect, it } from 'vitest';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { StorageError } from './adapter';
import { createMeasurement } from './roadmap-file';
import type { SaveStatus } from './save-state';

class FailingStore extends MemoryAdapter {
  failWrites = false;
  async write(...args: Parameters<MemoryAdapter['write']>) {
    if (this.failWrites) throw new StorageError('unreachable');
    return super.write(...args);
  }
}

function cloudHost(store: FailingStore, told: SaveStatus[]): { host: RecordHost; fire: () => void } {
  let timer: (() => void) | null = null;
  const host: RecordHost = {
    store,
    tier: 'cloud',
    clearOffFileData: () => {},
    deviceId: () => 'phone',
    clock: { now: () => Date.parse('2026-11-12T10:00:00.000Z') },
    timers: { set: (run) => { timer = run; return 1; }, clear: () => { timer = null; } },
    remoteChanged: () => {},
    failureCause: () => 'other',
    report: () => {},
    saveStatusChanged: (status) => told.push(status),
    mirror: {
      adapter: new MemoryAdapter(new MemoryCloud()),
      pending: { get: () => false, set: () => {}, clear: () => {} },
      writesStopped: () => false,
      wipe: async () => {},
      opened: () => {},
    },
  };
  return { host, fire: () => timer?.() };
}

const add = (session: RecordSession, id: string) => session.edit((file) => void file.measurements.push(
  createMeasurement({ id, metricType: 'weight', value: 80, recordedAt: '2026-11-01', createdAt: '2026-11-12T10:00:00.000Z' }),
));

describe('RecordSession tells the host its save status (US-09 AC30)', () => {
  it('edit: saving; land: saved; fail: not-saved; never the same status twice in a row', async () => {
    const store = new FailingStore();
    const told: SaveStatus[] = [];
    const { host, fire } = cloudHost(store, told);
    const session = await RecordSession.open(host);
    expect(told).toEqual([]); // opened clean: nothing to tell

    add(session, 'a');
    add(session, 'b'); // a burst: still saving
    expect(told).toEqual(['saving']);
    fire(); // the debounce starts the pass: still saving
    await session.flush();
    expect(told).toEqual(['saving', 'saved']);

    store.failWrites = true;
    add(session, 'c');
    await expect(session.flush()).rejects.toThrow();
    expect(told).toEqual(['saving', 'saved', 'saving', 'not-saved']);
    expect(session.saveStatus).toBe('not-saved');

    store.failWrites = false;
    add(session, 'd');
    await session.flush();
    expect(told).toEqual(['saving', 'saved', 'saving', 'not-saved', 'saving', 'saved']);
    expect(session.saveStatus).toBe('saved');
  });

  it('the session already answers the status it tells, so a listener that reads it back sees the new one', async () => {
    const store = new FailingStore();
    const readBack: SaveStatus[] = [];
    const { host } = cloudHost(store, []);
    let session!: RecordSession;
    session = await RecordSession.open({ ...host, saveStatusChanged: () => readBack.push(session.saveStatus) });
    add(session, 'a');
    await session.flush();
    expect(readBack).toEqual(['saving', 'saved']);
  });

  it('a callback that throws never throws out of the session, and the status stays untold, so the next change tries again', async () => {
    const store = new FailingStore();
    const tried: SaveStatus[] = [];
    const { host } = cloudHost(store, []);
    const session = await RecordSession.open({
      ...host,
      saveStatusChanged: (status) => { tried.push(status); if (tried.length === 1) throw new Error('listener failed'); },
    });
    expect(() => add(session, 'a')).not.toThrow();
    expect(session.saveStatus).toBe('saving');
    add(session, 'b'); // still saving, but never told: told again
    await session.flush();
    expect(tried).toEqual(['saving', 'saving', 'saved']);
    expect(store.cloud.files.size).toBe(1); // the save itself went on
  });

  it('a host without the callback saves as before', async () => {
    const store = new FailingStore();
    const { host } = cloudHost(store, []);
    const { saveStatusChanged: _ignored, ...bare } = host;
    const session = await RecordSession.open(bare as RecordHost);
    add(session, 'a');
    await session.flush();
    expect(session.saveStatus).toBe('saved');
  });
});
