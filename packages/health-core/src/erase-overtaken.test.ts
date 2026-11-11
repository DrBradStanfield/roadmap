/**
 * Untangle fix 4, what the page's erase machine relies on at the end of its
 * own erase (widget-src lib/erase-machine.ts, own-end; adversary F2): when
 * another writer's erase is taken in during this erase's flush, the session
 * announces it (REMOTE_CHANGED's `erase`) before erase() resolves, and once
 * it resolves the session reports that same identity. So an own-end at the
 * identity last heard as `arrived` is another writer's erase, and its rows
 * are read. Synthetic records only.
 */
import { describe, it, expect } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import type { RecordHost, RemoteChange } from './record-host';
import { RecordSession, eraseIdentityOf } from './record-session';
import { createMeasurement, type RoadmapFile } from './roadmap-file';

let clock = Date.parse('2026-11-11T10:00:00.000Z');

function host(cloud: MemoryCloud, heard: Array<RemoteChange | 'resolved'>): RecordHost {
  return {
    tier: 'cloud',
    store: new MemoryAdapter(cloud),
    clearOffFileData: () => {},
    deviceId: () => 'phone',
    clock: { now: () => clock },
    timers: { set: () => null, clear: () => {} },
    remoteChanged: (change) => { heard.push(change); },
    failureCause: () => 'other',
    report: () => {},
    mirror: {
      adapter: new MemoryAdapter(new MemoryCloud()),
      pending: { get: () => false, set: () => {}, clear: () => {} },
      writesStopped: () => false,
      wipe: async () => {},
      opened: () => {},
    },
  };
}
const stored = (cloud: MemoryCloud): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);

describe('RecordSession.erase: another writer\'s erase taken in during the flush (fix 4, adversary F2)', () => {
  it('is announced before erase() resolves, and the session then reports that same identity', async () => {
    const cloud = new MemoryCloud();
    const heard: Array<RemoteChange | 'resolved'> = [];
    const session = await RecordSession.open(host(cloud, heard));
    session.edit((file) => void file.measurements.push(createMeasurement({
      id: 'a', metricType: 'weight', value: 80, recordedAt: '2026-11-01', createdAt: new Date(clock).toISOString(),
    })));
    await session.flush();
    heard.length = 0;
    const other = await RecordSession.open(host(cloud, []));
    // This erase has read the record (epoch 0) when the other writer erases
    // twice: its own erase, at epoch 1, meets the other's at epoch 2 in the flush.
    const result = await session.erase(async () => {
      clock += 1_000;
      expect((await other.erase()).success).toBe(true);
      clock += 1_000;
      expect((await other.erase()).success).toBe(true);
      clock += 1_000;
    });
    heard.push('resolved');
    expect(result.success).toBe(true);
    const theirs = eraseIdentityOf(stored(cloud));
    expect(JSON.parse(theirs)[0]).toBe(2);
    expect(session.eraseIdentity).toBe(theirs);
    expect(heard).toEqual([{ erase: theirs }, 'resolved']);
  });

  it('an erase nobody overtakes is announced to nobody, and the session reports its own identity', async () => {
    const cloud = new MemoryCloud();
    const heard: Array<RemoteChange | 'resolved'> = [];
    const session = await RecordSession.open(host(cloud, heard));
    clock += 1_000;
    const result = await session.erase();
    heard.push('resolved');
    expect(result.success).toBe(true);
    expect(session.eraseIdentity).toBe(eraseIdentityOf(stored(cloud)));
    expect(JSON.parse(session.eraseIdentity)[0]).toBe(1);
    expect(heard).toEqual(['resolved']);
  });
});
