/**
 * Untangle fix 4, the transport: a save loop's passes told to the page as one
 * change (record-host.ts laterChange, announce; US-16 AC2a, US-34 AC1).
 */
import { describe, it, expect, vi } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { announce, laterChange, type RecordHost, type RemoteChange } from './record-host';
import { RecordSession, eraseIdentityOf } from './record-session';
import type { RoadmapFile } from './roadmap-file';

describe('laterChange: two changes taken in before the page hears, as one', () => {
  it.each([
    [null, null, null],
    [null, { erase: null }, { erase: null }],
    [null, { erase: 'a' }, { erase: 'a' }],
    [{ erase: 'a' }, null, { erase: 'a' }],
    [{ erase: 'a' }, { erase: null }, { erase: 'a' }], // a later pass with no erase keeps the earlier one's
    [{ erase: 'a' }, { erase: 'b' }, { erase: 'b' }],
    [{ erase: null }, { erase: 'b' }, { erase: 'b' }],
  ])('laterChange(%o, %o) is %o', (prior, next, joined) => {
    expect(laterChange(prior, next)).toEqual(joined);
  });
});

describe('announce: the page hears a change, and nothing for none', () => {
  it('calls remoteChanged with the change, once, and never for null', () => {
    const remoteChanged = vi.fn();
    const host = { remoteChanged } as unknown as RecordHost;
    announce(host, null);
    expect(remoteChanged).not.toHaveBeenCalled();
    announce(host, { erase: 'a' });
    expect(remoteChanged.mock.calls).toEqual([[{ erase: 'a' }]]);
  });
});

// A cloud host for RecordSession, as erase-overtaken.test.ts builds it. Synthetic records only.
let clock = Date.parse('2026-11-11T10:00:00.000Z');
function cloudHost(cloud: MemoryCloud, heard: RemoteChange[]): RecordHost {
  return {
    tier: 'cloud',
    store: new MemoryAdapter(cloud),
    clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {},
    deviceId: () => 'laptop',
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

describe('H26: an erase of an empty record is a change the page hears (fix 4 PR 2b-1)', () => {
  it('H26: another writer\'s erase of an empty record is announced with its identity', async () => {
    const cloud = new MemoryCloud();
    const heard: RemoteChange[] = [];
    const page = await RecordSession.open(cloudHost(cloud, heard));
    const other = await RecordSession.open(cloudHost(cloud, []));
    clock += 1_000;
    expect((await other.erase()).success).toBe(true);
    const erased = eraseIdentityOf(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile);
    expect(erased).not.toBe(page.eraseIdentity);
    clock += 10_000; // past the re-read throttle
    expect(await page.refreshFromRemote()).toBe(true);
    expect(heard).toEqual([{ erase: erased }]);
    expect(page.eraseIdentity).toBe(erased);
  });
});
