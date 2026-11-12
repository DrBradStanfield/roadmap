/**
 * US-11 AC6, AC7: this device's off-file data (drafts, kept answers, stored
 * originals) is cleared for every erase it has not cleared for, across
 * reloads. The host keeps the erase identity last cleared for
 * (`clearedErase`), written only once a clear worked (`noteCleared`); a
 * session opens owing a clear while the record is at another erase.
 */
import { describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { createMeasurement, type FileDocument } from './roadmap-file';

let clock = Date.parse('2026-10-21T10:00:00.000Z');

/** One device: its off-file stores, as the web keeps them, and the erase it last cleared for. */
interface Device {
  drafts: Map<string, string>;
  kept: Set<string>;
  originals: Set<string>;
  clearedFor: string | null;
}

function fakeHost(store: MemoryAdapter, device: Device = { drafts: new Map(), kept: new Set(), originals: new Set(), clearedFor: null }) {
  const clears = { calls: 0, failing: false, leavesDraft: false };
  const reports: Array<{ op: string; repeat: boolean }> = [];
  const mirrorCloud = new MemoryCloud();
  let pending = false;
  const host: RecordHost = {
    tier: 'cloud',
    store,
    clearOffFileData: (keep) => {
      clears.calls += 1;
      if (clears.failing) throw new Error('clear refused');
      device.kept.clear();
      for (const ref of [...device.originals]) if (!keep.has(ref)) device.originals.delete(ref);
      // A remove the storage refused leaves its key; the host's read-back finds it.
      if (clears.leavesDraft) throw new Error('off-file data still stored');
      device.drafts.clear();
    },
    clearedErase: () => device.clearedFor,
    noteCleared: (identity) => { device.clearedFor = identity; },
    deviceId: () => 'phone',
    clock: { now: () => clock },
    timers: { set: () => ({}), clear: () => {} },
    remoteChanged: () => {},
    failureCause: () => 'other',
    report: (_error, at) => void reports.push({ op: at.op, repeat: at.repeat }),
    mirror: {
      adapter: new MemoryAdapter(mirrorCloud),
      pending: { get: () => pending, set: () => { pending = true; }, clear: () => { pending = false; } },
      writesStopped: () => false,
      wipe: async () => mirrorCloud.files.clear(),
      opened: () => {},
    },
  };
  return { host, device, clears, reports };
}

const weight = (id: string, day: string) =>
  createMeasurement({ id, metricType: 'weight', value: 80, recordedAt: day, createdAt: new Date(clock).toISOString() });
const doc = (id: string, fileRef: string): FileDocument => ({
  id, title: id, type: 'pathology_report', date: '2026-10-20', fileRef, contentHash: 'sha256-x', mimeType: 'application/pdf',
  extractedText: '', addedAt: new Date(clock).toISOString(), metadata: {}, sourceFileName: `${id}.pdf`,
});

/** A device with a saved row, a stored original, a draft and a kept answer; another device then erases. */
async function erasedElsewhere() {
  const cloud = new MemoryCloud();
  const fake = fakeHost(new MemoryAdapter(cloud));
  const first = await RecordSession.open(fake.host);
  first.edit((file) => {
    file.measurements.push(weight('a', '2026-10-01'));
    file.documents.push(doc('before', 'Lab results/before.pdf'));
  });
  await first.flush();
  fake.device.originals.add('Lab results/before.pdf');
  fake.device.drafts.set('vitals', 'typed-before-erase');
  fake.device.kept.add('lpa-answer');
  const other = await RecordSession.open(fakeHost(new MemoryAdapter(cloud)).host);
  clock += 60_000;
  expect((await other.erase()).success).toBe(true);
  clock += 60_000;
  return { cloud, fake, first, erased: other.eraseIdentity };
}

/** Every off-file store is empty. */
function cleared(device: Device) {
  expect([...device.drafts]).toEqual([]);
  expect([...device.kept]).toEqual([]);
  expect([...device.originals]).toEqual([]);
}

describe('US-11 AC6: a clear that did not work is tried again after a reload', () => {
  it('a clear that throws in one session is tried at the next load, and once it works the stores are empty and the erase is kept', async () => {
    const { fake, first, erased } = await erasedElsewhere();
    fake.clears.failing = true;
    expect(await first.refreshFromRemote()).toBe(true);
    clock += 60_000;
    expect(await first.refreshFromRemote()).toBe(false);
    expect(fake.clears.calls).toBe(2);
    expect(fake.device.clearedFor).not.toBe(erased);

    // Reload, still failing: the load tries, and reports afresh.
    const second = await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(3);
    expect(fake.reports.at(-1)).toEqual({ op: 'clear-off-file', repeat: false });
    expect(fake.device.clearedFor).not.toBe(erased);

    // Once the host can clear, the next save tries again and it works.
    fake.clears.failing = false;
    second.edit((file) => void file.measurements.push(weight('b', '2026-10-02')), second.eraseIdentity);
    await second.flush();
    expect(fake.clears.calls).toBe(4);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(erased);

    // Nothing is owed after that, in this session or the next.
    clock += 60_000;
    await second.refreshFromRemote();
    await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(4);
  });

  it('a clear whose read-back finds a key still stored stays owed, and the erase is not kept', async () => {
    const { fake, first, erased } = await erasedElsewhere();
    fake.clears.leavesDraft = true;
    expect(await first.refreshFromRemote()).toBe(true);
    expect(fake.reports).toEqual([{ op: 'clear-off-file', repeat: false }]);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed-before-erase']]);
    expect(fake.device.clearedFor).not.toBe(erased);

    // The next load tries again; this time every remove holds.
    fake.clears.leavesDraft = false;
    await RecordSession.open(fake.host);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(erased);
  });

  it('reports a clear that keeps failing once per session, then as a repeat', async () => {
    const { fake, first } = await erasedElsewhere();
    fake.clears.failing = true;
    await first.refreshFromRemote();
    clock += 60_000;
    await first.refreshFromRemote();
    expect(fake.reports).toEqual([{ op: 'clear-off-file', repeat: false }, { op: 'clear-off-file', repeat: true }]);

    const second = await RecordSession.open(fake.host);
    clock += 60_000;
    await second.refreshFromRemote();
    expect(fake.reports.slice(2)).toEqual([{ op: 'clear-off-file', repeat: false }, { op: 'clear-off-file', repeat: true }]);
  });
});

describe('US-11 AC6: a page closed through another device\'s erase', () => {
  it('clears the off-file data at its next load, before any re-read, and keeps the erase', async () => {
    const cloud = new MemoryCloud();
    const fake = fakeHost(new MemoryAdapter(cloud));
    const first = await RecordSession.open(fake.host);
    first.edit((file) => void file.measurements.push(weight('a', '2026-10-01')));
    await first.flush();
    fake.device.drafts.set('vitals', 'typed-before-erase');
    fake.device.kept.add('lpa-answer');
    expect(fake.device.clearedFor).toBe(first.eraseIdentity);

    const other = await RecordSession.open(fakeHost(new MemoryAdapter(cloud)).host);
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;

    const second = await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(other.eraseIdentity);
    expect(second.eraseIdentity).toBe(other.eraseIdentity);
  });

  it('a reload with no erase since the last clear clears nothing', async () => {
    const cloud = new MemoryCloud();
    const fake = fakeHost(new MemoryAdapter(cloud));
    const first = await RecordSession.open(fake.host);
    first.edit((file) => void file.measurements.push(weight('a', '2026-10-01')));
    await first.flush();
    fake.device.drafts.set('vitals', 'typed');
    const second = await RecordSession.open(fake.host);
    second.edit((file) => void file.measurements.push(weight('b', '2026-10-02')), second.eraseIdentity);
    await second.flush();
    expect(fake.clears.calls).toBe(0);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed']]);
  });
});

describe('US-11 AC6: the first load with no erase kept on the device', () => {
  it('a record that was erased clears once, then keeps the erase', async () => {
    const cloud = new MemoryCloud();
    const other = await RecordSession.open(fakeHost(new MemoryAdapter(cloud)).host);
    other.edit((file) => void file.measurements.push(weight('a', '2026-10-01')));
    await other.flush();
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;

    const fake = fakeHost(new MemoryAdapter(cloud));
    fake.device.drafts.set('vitals', 'typed');
    await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(other.eraseIdentity);
    await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(1);
  });

  it('a guest whose record was never erased keeps its live drafts, and the device keeps [0,null]', async () => {
    const fake = fakeHost(new MemoryAdapter(new MemoryCloud()));
    fake.device.drafts.set('vitals', 'typed');
    const session = await RecordSession.open(fake.host);
    expect(session.eraseIdentity).toBe('[0,null]');
    expect(fake.clears.calls).toBe(0);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed']]);
    expect(fake.device.clearedFor).toBe('[0,null]');
  });
});

describe('US-11 AC1: an erase made on this device', () => {
  it('keeps its erase once its own clear worked', async () => {
    const cloud = new MemoryCloud();
    const fake = fakeHost(new MemoryAdapter(cloud));
    const session = await RecordSession.open(fake.host);
    session.edit((file) => void file.measurements.push(weight('a', '2026-10-01')));
    await session.flush();
    fake.device.drafts.set('vitals', 'typed');
    clock += 60_000;
    expect((await session.erase()).success).toBe(true);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(session.eraseIdentity);
    await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(1);
  });

  it('whose clear throws keeps the earlier erase, so the next load clears', async () => {
    const cloud = new MemoryCloud();
    const fake = fakeHost(new MemoryAdapter(cloud));
    const session = await RecordSession.open(fake.host);
    session.edit((file) => void file.measurements.push(weight('a', '2026-10-01')));
    await session.flush();
    const before = session.eraseIdentity;
    fake.device.drafts.set('vitals', 'typed');
    fake.clears.failing = true;
    clock += 60_000;
    expect((await session.erase()).success).toBe(true);
    expect(fake.device.clearedFor).toBe(before);

    fake.clears.failing = false;
    await RecordSession.open(fake.host);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(session.eraseIdentity);
  });
});

/** A cloud record erased `times` times by another device, and a device that opened it once, so it keeps that erase. */
async function cloudAtEpoch(times: number) {
  const cloud = new MemoryCloud();
  const other = await RecordSession.open(fakeHost(new MemoryAdapter(cloud)).host);
  other.edit((file) => void file.measurements.push(weight('a', '2026-10-01')));
  await other.flush();
  for (let i = 0; i < times; i += 1) {
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
  }
  clock += 60_000;
  const fake = fakeHost(new MemoryAdapter(cloud));
  const session = await RecordSession.open(fake.host);
  expect(fake.device.clearedFor).toBe(session.eraseIdentity);
  fake.clears.calls = 0;
  return { cloud, other, fake, session };
}

/** The same device on another store: an on-device fallback, or a record it switched to. */
const onStore = (fake: ReturnType<typeof fakeHost>, store: MemoryAdapter): RecordHost => ({ ...fake.host, store });

describe('US-11 AC6: a clear is owed only for a later erase', () => {
  it('the on-device fallback round trip keeps the drafts typed in it, and the kept erase', async () => {
    const { fake, session } = await cloudAtEpoch(3);
    const kept = fake.device.clearedFor;
    expect(JSON.parse(kept!)[0]).toBe(3);

    // The cloud cannot be read: the page runs on the device record, never erased.
    const fallback = await RecordSession.open(onStore(fake, new MemoryAdapter(new MemoryCloud())));
    expect(fallback.eraseIdentity).toBe('[0,null]');
    fake.device.drafts.set('vitals', 'typed-in-fallback');
    fallback.edit((file) => void file.measurements.push(weight('b', '2026-10-02')), fallback.eraseIdentity);
    await fallback.flush();
    expect(fake.clears.calls).toBe(0);
    expect(fake.device.clearedFor).toBe(kept);

    // Reconnected: the cloud is at the erase the device kept.
    const back = await RecordSession.open(fake.host);
    expect(back.eraseIdentity).toBe(session.eraseIdentity);
    clock += 60_000;
    await back.refreshFromRemote();
    expect(fake.clears.calls).toBe(0);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed-in-fallback']]);
    expect(fake.device.clearedFor).toBe(kept);
  });

  it('an erase made in the fallback clears, and the kept erase does not move back', async () => {
    const { fake } = await cloudAtEpoch(3);
    const kept = fake.device.clearedFor;
    const fallback = await RecordSession.open(onStore(fake, new MemoryAdapter(new MemoryCloud())));
    fake.device.drafts.set('vitals', 'typed-in-fallback');
    clock += 60_000;
    expect((await fallback.erase()).success).toBe(true);
    expect(JSON.parse(fallback.eraseIdentity)[0]).toBe(1);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(kept);
  });

  it('a later erase by another device, after a fallback in between, still clears', async () => {
    const { other, fake } = await cloudAtEpoch(3);
    await RecordSession.open(onStore(fake, new MemoryAdapter(new MemoryCloud())));
    const back = await RecordSession.open(fake.host);
    fake.device.drafts.set('vitals', 'typed');
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;
    expect(await back.refreshFromRemote()).toBe(true);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(back.eraseIdentity);
    expect(JSON.parse(back.eraseIdentity)[0]).toBe(4);
  });

  it('a switch to a record at a lower epoch, then an erase there, clears', async () => {
    const { fake } = await cloudAtEpoch(3);
    const lower = await cloudAtEpoch(1);
    // The switch: the connect removes the kept erase (connect.ts), so the
    // record switched to keeps its own at its first load. Its erase came
    // before the switch: the drafts are the old record's, and go once.
    fake.device.clearedFor = null;
    fake.device.drafts.set('vitals', 'typed-on-the-old-record');
    const switched = await RecordSession.open(onStore(fake, new MemoryAdapter(lower.cloud)));
    expect(fake.clears.calls).toBe(1);
    expect(fake.device.clearedFor).toBe(switched.eraseIdentity);

    fake.device.drafts.set('vitals', 'typed-after-the-switch');
    clock += 60_000;
    expect((await lower.other.erase()).success).toBe(true);
    clock += 60_000;
    expect(await switched.refreshFromRemote()).toBe(true);
    expect(JSON.parse(switched.eraseIdentity)[0]).toBe(2);
    expect(fake.clears.calls).toBe(2);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(switched.eraseIdentity);
  });

  it('the same epoch with a later erasedAt clears', async () => {
    const { cloud, fake, session } = await cloudAtEpoch(1);
    const [epoch, erasedAt] = JSON.parse(session.eraseIdentity) as [number, string];
    // Another device's erase from the same epoch, a minute later, merged in.
    const entry = cloud.files.get(ROADMAP_FILE_NAME)!;
    const body = JSON.parse(entry.json);
    body.meta.erasedAt = new Date(Date.parse(erasedAt) + 60_000).toISOString();
    cloud.files.set(ROADMAP_FILE_NAME, { ...entry, json: JSON.stringify(body), version: entry.version + 1 });
    fake.device.drafts.set('vitals', 'typed');
    clock += 60_000;
    await session.refreshFromRemote();
    expect(JSON.parse(session.eraseIdentity)).toEqual([epoch, body.meta.erasedAt]);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(session.eraseIdentity);
  });

  it.each(['garbage', '', '{"epoch":3}'])('a kept erase that cannot be read (%j) is no key: a never-erased record keeps its drafts', async (bad) => {
    const fake = fakeHost(new MemoryAdapter(new MemoryCloud()));
    fake.device.clearedFor = bad;
    fake.device.drafts.set('vitals', 'typed');
    const session = await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(0);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed']]);
    expect(fake.device.clearedFor).toBe(session.eraseIdentity);
  });

  it('a kept erase that cannot be read is no key: an erased record clears once', async () => {
    const { cloud } = await cloudAtEpoch(1);
    const fake = fakeHost(new MemoryAdapter(cloud));
    fake.device.clearedFor = 'garbage';
    fake.device.drafts.set('vitals', 'typed');
    const session = await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(session.eraseIdentity);
  });
});
