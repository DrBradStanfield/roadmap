/**
 * US-17 AC19: an old device and a new device open on one record do not
 * rewrite it on every sync. The new merge writes `tokens`; an old merge keeps
 * the identical object without them (pinned in reminder-rows.test.ts). A
 * re-read never writes (record-session.ts refreshFromRemote), so the file
 * changes only when a person edits. The old side runs today's rule: the
 * opt-in is `pickNewerOptional` over the two objects; everything else in the
 * session is the same code. Synthetic data, in memory.
 */
import { describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import type { RecordHost } from './record-host';
import { createEmptyFile, type FileReminderOptIn, type RoadmapFile } from './roadmap-file';

const OLD = 'old-device';
vi.mock('./merge', async (importOriginal) => {
  const real = await importOriginal<typeof import('./merge')>();
  return {
    ...real,
    // The old device's merge: the newer opt-in object whole, as main did before the rows.
    mergeFiles: (a: RoadmapFile, b: RoadmapFile, opts: { deviceId: string; now: string }) => {
      const merged = real.mergeFiles(a, b, opts);
      return opts.deviceId === OLD && (a.meta.eraseEpoch ?? 0) === (b.meta.eraseEpoch ?? 0)
        ? { ...merged, reminderOptIn: real.pickNewerOptional(a.reminderOptIn, b.reminderOptIn) }
        : merged;
    },
  };
});
const { RecordSession } = await import('./record-session');

const NOW = '2026-10-21T12:00:00.000Z';
let tick = Date.parse(NOW);

function host(cloud: MemoryCloud, deviceId: string, writes: string[]): RecordHost {
  const store = new MemoryAdapter(cloud);
  const write = store.write.bind(store);
  store.write = (...args: Parameters<MemoryAdapter['write']>) => { writes.push(deviceId); return write(...args); };
  return {
    store,
    clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {},
    deviceId: () => deviceId,
    clock: { now: () => (tick += 60_000) },
    timers: { set: () => 0, clear: () => {} },
    remoteChanged: () => {},
    failureCause: () => 'x',
    report: () => {},
    tier: 'cloud',
    mirror: {
      adapter: new MemoryAdapter(new MemoryCloud()),
      pending: { get: () => false, set: () => {}, clear: () => {} },
      writesStopped: () => false,
      wipe: async () => {},
      opened: () => {},
    },
  } as unknown as RecordHost;
}

const row = (token: string, status: 'active' | 'cancelled', updatedAt: string): FileReminderOptIn =>
  ({ status, token, email: `${token}@example.test`, provider: 'dropbox', updatedAt, lamport: 1 });

const stored = (cloud: MemoryCloud): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);

describe('US-17 AC19: an old and a new device on one record settle', () => {
  it('re-reads on both sides write nothing, whichever copy the cloud holds', async () => {
    const cloud = new MemoryCloud();
    const writes: string[] = [];
    // The old device opened the record when it held cancelled A alone.
    const start = createEmptyFile({ deviceId: 'seed', now: NOW });
    start.reminderOptIn = row('token-a', 'cancelled', '2026-10-21T11:00:00.000Z');
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(start), version: 1 });
    const old = await RecordSession.open(host(cloud, OLD, writes));
    // Then a new merge wrote active B nested under the same object, and the new device opened it.
    const listed = { ...start, schemaVersion: 2, reminderOptIn: { ...start.reminderOptIn, tokens: [row('token-b', 'active', '2026-10-21T10:00:00.000Z')] } };
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(listed), version: 2 });
    const fresh = await RecordSession.open(host(cloud, 'new-device', writes));
    expect(fresh.file.reminderOptIn?.tokens).toHaveLength(1);

    // The old device saves an edit: its merge keeps the object without the list, and the write drops it.
    old.edit((file) => { file.profile = { ...file.profile, heightCm: 170 }; }, old.shownErase);
    await old.flush();
    expect(stored(cloud).reminderOptIn?.tokens).toBeUndefined();
    expect(writes).toEqual([OLD]);

    // Twenty rounds of polling on both sides: the new copy takes the list back in, nobody writes.
    for (let round = 0; round < 20; round++) {
      await fresh.refreshFromRemote('pressed');
      await old.refreshFromRemote('pressed');
    }
    expect(writes).toEqual([OLD]);
    expect(fresh.file.reminderOptIn?.tokens).toHaveLength(1);
    expect(old.file.reminderOptIn?.tokens).toBeUndefined();

    // The new device saves an edit: the list is written back, once.
    fresh.edit((file) => { file.profile = { ...file.profile, heightCm: 171 }; }, fresh.shownErase);
    await fresh.flush();
    expect(stored(cloud).reminderOptIn?.tokens).toHaveLength(1);
    for (let round = 0; round < 20; round++) {
      await old.refreshFromRemote('pressed');
      await fresh.refreshFromRemote('pressed');
    }
    expect(writes).toEqual([OLD, 'new-device']);
    // The stored object is the same on both sides throughout: today's rule.
    expect(fresh.file.reminderOptIn?.token).toBe('token-a');
    expect(old.file.reminderOptIn?.token).toBe('token-a');
  });
});
