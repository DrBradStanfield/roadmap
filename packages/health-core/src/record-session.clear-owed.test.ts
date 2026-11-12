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

describe('US-11 AC6: the first load with no erase kept on the device adopts the record\'s erase', () => {
  it('a record that was erased clears nothing, and keeps its erase', async () => {
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
    expect(fake.clears.calls).toBe(0);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed']]);
    expect(fake.device.clearedFor).toBe(other.eraseIdentity);
    await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(0);
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
    // record switched to keeps its own at its first load, clearing nothing.
    fake.device.clearedFor = null;
    fake.device.drafts.set('vitals', 'typed-on-the-old-record');
    const switched = await RecordSession.open(onStore(fake, new MemoryAdapter(lower.cloud)));
    expect(fake.clears.calls).toBe(0);
    expect(fake.device.clearedFor).toBe(switched.eraseIdentity);

    fake.device.drafts.set('vitals', 'typed-after-the-switch');
    clock += 60_000;
    expect((await lower.other.erase()).success).toBe(true);
    clock += 60_000;
    expect(await switched.refreshFromRemote()).toBe(true);
    expect(JSON.parse(switched.eraseIdentity)[0]).toBe(2);
    expect(fake.clears.calls).toBe(1);
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

  it('a kept erase that cannot be read is no key: an erased record adopts its erase and clears nothing', async () => {
    const { cloud } = await cloudAtEpoch(1);
    const fake = fakeHost(new MemoryAdapter(cloud));
    fake.device.clearedFor = 'garbage';
    fake.device.drafts.set('vitals', 'typed');
    const session = await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(0);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed']]);
    expect(fake.device.clearedFor).toBe(session.eraseIdentity);
  });
});

/** What a connect (a sign-in, a switch) leaves: no erase kept, so the next record opened keeps its own, clearing nothing. */
const REMOVED = null;

describe('US-11 AC6: a connect removes the key, and the next record adopts its erase', () => {
  it('case 1: a page closed through another device\'s erase, with no connect in between, still clears', async () => {
    const { other, fake } = await cloudAtEpoch(3);
    fake.device.drafts.set('vitals', 'typed-before-erase');
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;
    const reopened = await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(reopened.eraseIdentity);
    expect(JSON.parse(reopened.eraseIdentity)[0]).toBe(4);
  });

  it('case 2: a switch made after such an erase: the load before it cleared, the record switched to adopts', async () => {
    const { other, fake } = await cloudAtEpoch(3);
    fake.device.drafts.set('vitals', 'typed-before-erase');
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;
    await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);

    fake.device.drafts.set('vitals', 'typed-after-the-clear');
    fake.device.clearedFor = REMOVED; // the switch
    const target = await cloudAtEpoch(1);
    const switched = await RecordSession.open(onStore(fake, new MemoryAdapter(target.cloud)));
    expect(fake.clears.calls).toBe(1);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed-after-the-clear']]);
    expect(fake.device.clearedFor).toBe(switched.eraseIdentity);
  });

  it('case 3: log-off, then sign-in: no key after log-off, the guest load keeps [0,null], the sign-in adopts', async () => {
    const { cloud } = await cloudAtEpoch(2);
    const fake = fakeHost(new MemoryAdapter(new MemoryCloud()));
    expect(fake.device.clearedFor).toBeNull(); // log-off removed it, and cleared the drafts
    await RecordSession.open(fake.host);
    expect(fake.device.clearedFor).toBe('[0,null]');
    fake.device.drafts.set('vitals', 'typed-as-guest');
    fake.device.clearedFor = REMOVED; // the sign-in
    const signedIn = await RecordSession.open(onStore(fake, new MemoryAdapter(cloud)));
    expect(fake.clears.calls).toBe(0);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed-as-guest']]);
    expect(fake.device.clearedFor).toBe(signedIn.eraseIdentity);
  });

  it('case 4: a guest\'s draft survives a sign-in to an account erased before; a later erase there still clears', async () => {
    const { cloud, other } = await cloudAtEpoch(2);
    const fake = fakeHost(new MemoryAdapter(cloud));
    fake.device.drafts.set('vitals', 'typed-as-guest');
    fake.device.clearedFor = REMOVED;
    const signedIn = await RecordSession.open(fake.host);
    expect(JSON.parse(signedIn.eraseIdentity)[0]).toBe(2);
    expect(fake.clears.calls).toBe(0);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed-as-guest']]);
    expect(fake.device.clearedFor).toBe(signedIn.eraseIdentity);

    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;
    expect(await signedIn.refreshFromRemote()).toBe(true);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
  });

  // Case 5, the A13 Limit: X kept at [3] with a draft typed there; a switch
  // to Y, then back to X after another device erased X to [4]. The switch
  // back removes the key, so X's open adopts [4] and the draft stays.
  it('case 5: back to X after its erase: X adopts it, and the draft typed there before stays', async () => {
    const x = await cloudAtEpoch(3);
    const { fake } = x;
    fake.device.drafts.set('vitals', 'typed-on-x-before-its-erase');
    fake.device.clearedFor = REMOVED; // the switch to Y
    const y = await cloudAtEpoch(1);
    await RecordSession.open(onStore(fake, new MemoryAdapter(y.cloud)));
    expect(fake.clears.calls).toBe(0);
    clock += 60_000;
    expect((await x.other.erase()).success).toBe(true);
    clock += 60_000;
    fake.device.clearedFor = REMOVED; // the switch back to X
    const back = await RecordSession.open(fake.host);
    expect(JSON.parse(back.eraseIdentity)[0]).toBe(4);
    expect(fake.clears.calls).toBe(0);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed-on-x-before-its-erase']]);
    expect(fake.device.clearedFor).toBe(back.eraseIdentity);
  });

  it('a fallback first load right after a connect writes no key; the cloud open adopts the cloud\'s erase', async () => {
    const { cloud } = await cloudAtEpoch(2);
    const fake = fakeHost(new MemoryAdapter(cloud));
    fake.device.drafts.set('vitals', 'typed-as-guest');
    fake.device.clearedFor = REMOVED; // the connect
    const fallback = await RecordSession.open(onStore(fake, new MemoryAdapter(new MemoryCloud())), { cloudUnreachable: true });
    expect(fallback.eraseIdentity).toBe('[0,null]');
    expect(fake.device.clearedFor).toBeNull();
    fake.device.drafts.set('vitals', 'typed-in-fallback');
    fallback.edit((file) => void file.measurements.push(weight('b', '2026-10-02')), fallback.eraseIdentity);
    await fallback.flush();
    expect(fake.device.clearedFor).toBeNull();

    const back = await RecordSession.open(fake.host);
    expect(JSON.parse(back.eraseIdentity)[0]).toBe(2);
    expect(fake.clears.calls).toBe(0);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed-in-fallback']]);
    expect(fake.device.clearedFor).toBe(back.eraseIdentity);
  });

  it('a session whose key was removed after it opened (a connect or log-off elsewhere) owes nothing and writes nothing', async () => {
    const { other, fake, session } = await cloudAtEpoch(1);
    fake.device.drafts.set('vitals', 'typed');
    fake.device.clearedFor = REMOVED;
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;
    expect(await session.refreshFromRemote()).toBe(true);
    expect(fake.clears.calls).toBe(0);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed']]);
    expect(fake.device.clearedFor).toBeNull();
  });
});

describe('US-11 AC6: two tabs of one device share the kept erase', () => {
  // A tab that takes an erase in still clears for it, whatever another tab
  // kept: a draft its stale screen wrote after that tab's clear belongs to the
  // old record (US-34 AC6, roadmap-store-two-tabs.test.ts). It never moves
  // the kept erase back.
  it('tab B keeps E3; tab A then taking in E2 clears and leaves the key at E3', async () => {
    const { cloud, other, fake } = await cloudAtEpoch(1);
    const lagging = new MemoryCloud();
    lagging.files = new Map(cloud.files);
    const tabA = await RecordSession.open(onStore(fake, new MemoryAdapter(lagging)));
    const b = fakeHost(new MemoryAdapter(cloud), fake.device);
    const tabB = await RecordSession.open(b.host);
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    lagging.files = new Map(cloud.files); // tab A's copy reaches E2 only
    clock += 60_000;
    expect((await other.erase()).success).toBe(true);
    clock += 60_000;
    expect(await tabB.refreshFromRemote()).toBe(true);
    expect(b.clears.calls).toBe(1);
    const e3 = tabB.eraseIdentity;
    expect(fake.device.clearedFor).toBe(e3);

    fake.device.drafts.set('vitals', 'typed-on-a-before-e2');
    expect(await tabA.refreshFromRemote()).toBe(true);
    expect(JSON.parse(tabA.eraseIdentity)[0]).toBe(2);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.clearedFor).toBe(e3);
  });
});
