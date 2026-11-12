/**
 * US-11 AC6, AC7: this device's off-file data (drafts, kept answers, stored
 * originals) is cleared for every erase it has not cleared for, across
 * reloads. The host keeps one value per device, the erase last cleared for and
 * the record (store id) it was cleared on: `clearedErase()` answers it only
 * for the record the host's store is, and only while that store owns the
 * off-file data; `noteCleared` writes it only while it owns. At open, a record
 * with no erase kept for it adopts its own erase and clears nothing; one whose
 * erase is later than the kept one clears, then keeps it.
 *
 * The fake host below models the web host's rule (one owner: the store this
 * device has chosen, with no log-off since load); the real host is pinned in
 * widget-src/src/storage/web-record-host.cleared-erase.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { createMeasurement, type FileDocument } from './roadmap-file';

let clock = Date.parse('2026-10-21T10:00:00.000Z');
const later = () => { clock += 60_000; };

/** One device: the store it has chosen, its off-file stores, and the one kept value. */
interface Device {
  chosen: string;
  loggedOff: boolean;
  key: { lineage: string; erase: string } | null;
  drafts: Map<string, string>;
  kept: Set<string>;
  originals: Set<string>;
  /** Times a page not owning the stores dropped only the drafts on its screen. */
  screenDrops: number;
}

const newDevice = (chosen: string): Device => ({
  chosen, loggedOff: false, key: null, drafts: new Map(), kept: new Set(), originals: new Set(), screenDrops: 0,
});

/** A MemoryAdapter standing for the store `id` ('local' is the device record). */
function provider(cloud: MemoryCloud, id: string): MemoryAdapter {
  return Object.defineProperty(new MemoryAdapter(cloud), 'id', { value: id });
}

function fakeHost(store: MemoryAdapter, device: Device) {
  const clears = { calls: 0, failing: false, leavesDraft: false };
  const reports: Array<{ op: string; repeat: boolean }> = [];
  const mirrorCloud = new MemoryCloud();
  let pending = false;
  const owns = () => !device.loggedOff && device.chosen === store.id;
  const host = {
    tier: 'cloud',
    store,
    clearOffFileData: (keep: ReadonlySet<string>) => {
      if (!owns()) { device.screenDrops += 1; return; }
      clears.calls += 1;
      if (clears.failing) throw new Error('clear refused');
      device.kept.clear();
      for (const ref of [...device.originals]) if (!keep.has(ref)) device.originals.delete(ref);
      // A remove the storage refused leaves its key; the host's read-back finds it.
      if (clears.leavesDraft) throw new Error('off-file data still stored');
      device.drafts.clear();
    },
    ownsOffFileData: owns,
    clearedErase: () => (owns() && device.key?.lineage === store.id ? device.key.erase : null),
    noteCleared: (identity: string) => { if (owns()) device.key = { lineage: store.id, erase: identity }; },
    deviceId: () => 'phone',
    clock: { now: () => clock },
    timers: { set: () => ({}), clear: () => {} },
    remoteChanged: () => {},
    failureCause: () => 'other',
    report: (_error: unknown, at: { op: string; repeat: boolean }) => void reports.push({ op: at.op, repeat: at.repeat }),
    mirror: {
      adapter: new MemoryAdapter(mirrorCloud),
      pending: { get: () => pending, set: () => { pending = true; }, clear: () => { pending = false; } },
      writesStopped: () => false,
      wipe: async () => mirrorCloud.files.clear(),
      opened: () => {},
    },
  } as unknown as RecordHost;
  return { host, device, clears, reports };
}

const weight = (id: string, day: string) =>
  createMeasurement({ id, metricType: 'weight', value: 80, recordedAt: day, createdAt: new Date(clock).toISOString() });
const doc = (id: string, fileRef: string): FileDocument => ({
  id, title: id, type: 'pathology_report', date: '2026-10-20', fileRef, contentHash: 'sha256-x', mimeType: 'application/pdf',
  extractedText: '', addedAt: new Date(clock).toISOString(), metadata: {}, sourceFileName: `${id}.pdf`,
});
const epoch = (identity: string) => (JSON.parse(identity) as [number, string | null])[0];

/** Another device on the cloud `id`: it owns its own stores, and erases there. */
async function otherDevice(cloud: MemoryCloud, id: string) {
  return RecordSession.open(fakeHost(provider(cloud, id), newDevice(id)).host);
}

/** The cloud `id` with one saved row, erased `times` times by another device;
 *  this device then opens it (its first load: it adopts, so the key is that erase). */
async function cloudAtEpoch(times: number, id = 'cloud-a', device = newDevice(id)) {
  const cloud = new MemoryCloud();
  const other = await otherDevice(cloud, id);
  other.edit((file) => void file.measurements.push(weight('a', '2026-10-01')));
  await other.flush();
  for (let i = 0; i < times; i += 1) {
    later();
    expect((await other.erase()).success).toBe(true);
  }
  later();
  const fake = fakeHost(provider(cloud, id), device);
  const session = await RecordSession.open(fake.host);
  fake.clears.calls = 0;
  return { cloud, other, fake, session, id };
}

/** Off-file data as a page leaves it: a draft, a kept answer, a stored original. */
function offFileData(device: Device, draft = 'typed') {
  device.drafts.set('vitals', draft);
  device.kept.add('lpa-answer');
  device.originals.add('Lab results/before.pdf');
}

function cleared(device: Device) {
  expect([...device.drafts]).toEqual([]);
  expect([...device.kept]).toEqual([]);
  expect([...device.originals]).toEqual([]);
}

function untouched(device: Device, draft = 'typed') {
  expect([...device.drafts]).toEqual([['vitals', draft]]);
  expect([...device.kept]).toEqual(['lpa-answer']);
  expect([...device.originals]).toEqual(['Lab results/before.pdf']);
}

describe('US-11 AC6: a page closed through an erase made elsewhere', () => {
  it('reloaded as owner: the off-file data is cleared, then the key holds the new erase', async () => {
    const { other, fake, id } = await cloudAtEpoch(0);
    offFileData(fake.device);
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    const reopened = await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.key).toEqual({ lineage: id, erase: reopened.eraseIdentity });
    expect(reopened.eraseIdentity).toBe(other.eraseIdentity);
  });

  it('two erases in a row elsewhere: the reload clears once, and the key holds the later one', async () => {
    const { other, fake, id } = await cloudAtEpoch(1);
    offFileData(fake.device);
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    const reopened = await RecordSession.open(fake.host);
    expect(epoch(reopened.eraseIdentity)).toBe(3);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.key).toEqual({ lineage: id, erase: reopened.eraseIdentity });
  });

  it('an older erase arriving later (a lagging copy of the same record) never moves the key back and clears nothing', async () => {
    const { cloud, other, fake, id } = await cloudAtEpoch(1);
    later();
    expect((await other.erase()).success).toBe(true);
    const lagging = new MemoryCloud();
    lagging.files = new Map(cloud.files); // a copy that stops at epoch 2
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    const current = await RecordSession.open(fake.host);
    const e3 = current.eraseIdentity;
    expect(fake.device.key).toEqual({ lineage: id, erase: e3 });
    fake.clears.calls = 0;

    offFileData(fake.device, 'typed-after-e3');
    const stale = await RecordSession.open(fakeHost(provider(lagging, id), fake.device).host);
    expect(epoch(stale.eraseIdentity)).toBe(2);
    later();
    await stale.refreshFromRemote();
    stale.edit((file) => void file.measurements.push(weight('b', '2026-10-02')), stale.eraseIdentity);
    await stale.flush();
    untouched(fake.device, 'typed-after-e3');
    expect(fake.device.key).toEqual({ lineage: id, erase: e3 });
  });

  it('a reload with no erase since the last clear clears nothing', async () => {
    const { fake } = await cloudAtEpoch(1);
    offFileData(fake.device);
    const second = await RecordSession.open(fake.host);
    second.edit((file) => void file.measurements.push(weight('b', '2026-10-02')), second.eraseIdentity);
    await second.flush();
    expect(fake.clears.calls).toBe(0);
    untouched(fake.device);
  });

  it('the same epoch with a later erasedAt clears, and the key moves to it', async () => {
    const { cloud, fake, session, id } = await cloudAtEpoch(1);
    const [n, erasedAt] = JSON.parse(session.eraseIdentity) as [number, string];
    const entry = cloud.files.get(ROADMAP_FILE_NAME)!;
    const body = JSON.parse(entry.json);
    body.meta.erasedAt = new Date(Date.parse(erasedAt) + 60_000).toISOString();
    cloud.files.set(ROADMAP_FILE_NAME, { ...entry, json: JSON.stringify(body), version: entry.version + 1 });
    offFileData(fake.device);
    later();
    await session.refreshFromRemote();
    expect(JSON.parse(session.eraseIdentity)).toEqual([n, body.meta.erasedAt]);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.key).toEqual({ lineage: id, erase: session.eraseIdentity });
  });
});

/** The cloud `id` erased three times elsewhere, the device keeping E3, and a copy that stops at E2. */
async function keptAtE3WithLaggingE2() {
  const { cloud, other, fake, id } = await cloudAtEpoch(1);
  later();
  expect((await other.erase()).success).toBe(true);
  const lagging = new MemoryCloud();
  lagging.files = new Map(cloud.files);
  later();
  expect((await other.erase()).success).toBe(true);
  later();
  const current = await RecordSession.open(fake.host);
  const e3 = current.eraseIdentity;
  expect(epoch(e3)).toBe(3);
  expect(fake.device.key).toEqual({ lineage: id, erase: e3 });
  fake.clears.calls = 0;
  return { cloud, other, fake, id, lagging, current, e3 };
}

describe('US-11 AC6: "cleared up to" is an order, at open and in session', () => {
  it('an owner opens a lagging copy at E2 over a key at E3: nothing cleared at open or after; E3 arriving clears nothing; E4 clears once', async () => {
    const { cloud, other, fake, id, lagging, e3 } = await keptAtE3WithLaggingE2();
    offFileData(fake.device, 'typed-after-e3');
    const stale = await RecordSession.open(fakeHost(provider(lagging, id), fake.device).host);
    expect(epoch(stale.eraseIdentity)).toBe(2);
    expect(fake.clears.calls).toBe(0);
    later();
    await stale.refreshFromRemote();
    stale.edit((file) => void file.measurements.push(weight('b', '2026-10-02')), stale.eraseIdentity);
    await stale.flush();
    expect(fake.clears.calls).toBe(0);
    untouched(fake.device, 'typed-after-e3');
    expect(fake.device.key).toEqual({ lineage: id, erase: e3 });

    // The up-to-date copy at E3 arrives: already cleared for it.
    lagging.files = new Map(cloud.files);
    later();
    expect(await stale.refreshFromRemote()).toBe(true);
    expect(stale.eraseIdentity).toBe(e3);
    expect(fake.clears.calls).toBe(0);
    untouched(fake.device, 'typed-after-e3');
    expect(fake.device.key).toEqual({ lineage: id, erase: e3 });

    // A real E4 arrives: one clear, and the key moves to it.
    later();
    expect((await other.erase()).success).toBe(true);
    lagging.files = new Map(cloud.files);
    later();
    expect(await stale.refreshFromRemote()).toBe(true);
    expect(epoch(stale.eraseIdentity)).toBe(4);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.key).toEqual({ lineage: id, erase: stale.eraseIdentity });
    later();
    await stale.refreshFromRemote();
    expect(fake.clears.calls).toBe(1);
  });

  it('an owner open at E3 whose store goes back to an E2 copy clears nothing; E4 then clears once', async () => {
    const { cloud, other, fake, id, lagging, current, e3 } = await keptAtE3WithLaggingE2();
    offFileData(fake.device, 'typed-after-e3');
    const upToDate = new Map(cloud.files);
    cloud.files = new Map(lagging.files); // a store that serves the older copy again
    later();
    await current.refreshFromRemote();
    expect(current.eraseIdentity).toBe(e3);
    expect(fake.clears.calls).toBe(0);
    untouched(fake.device, 'typed-after-e3');
    expect(fake.device.key).toEqual({ lineage: id, erase: e3 });

    cloud.files = upToDate;
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    expect(await current.refreshFromRemote()).toBe(true);
    expect(epoch(current.eraseIdentity)).toBe(4);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.key).toEqual({ lineage: id, erase: current.eraseIdentity });
  });

  it('a non-owner drops its on-screen draft on a later erase and on nothing else; the key is unchanged throughout', async () => {
    const { cloud, other, fake, id, lagging, e3 } = await keptAtE3WithLaggingE2();
    fake.device.chosen = 'cloud-b'; // another tab moved this browser to another cloud
    offFileData(fake.device);
    // Opened on the older copy: it adopts that erase, and drops nothing.
    const onLagging = await RecordSession.open(fakeHost(provider(lagging, id), fake.device).host);
    expect(epoch(onLagging.eraseIdentity)).toBe(2);
    expect(fake.device.screenDrops).toBe(0);
    // The same erase again: nothing.
    later();
    await onLagging.refreshFromRemote();
    expect(fake.device.screenDrops).toBe(0);
    // A later erase (E3) arrives: one drop.
    const e2Copy = new Map(lagging.files);
    lagging.files = new Map(cloud.files);
    later();
    expect(await onLagging.refreshFromRemote()).toBe(true);
    expect(onLagging.eraseIdentity).toBe(e3);
    expect(fake.device.screenDrops).toBe(1);
    // The older copy served again: nothing.
    lagging.files = new Map(e2Copy);
    later();
    await onLagging.refreshFromRemote();
    expect(onLagging.eraseIdentity).toBe(e3);
    expect(fake.device.screenDrops).toBe(1);
    // E4: one more drop, never a clear.
    later();
    expect((await other.erase()).success).toBe(true);
    lagging.files = new Map(cloud.files);
    later();
    expect(await onLagging.refreshFromRemote()).toBe(true);
    expect(epoch(onLagging.eraseIdentity)).toBe(4);
    expect(fake.device.screenDrops).toBe(2);
    expect(fake.clears.calls).toBe(0);
    untouched(fake.device);
    expect(fake.device.key).toEqual({ lineage: id, erase: e3 });
  });
});

describe('US-11 AC6: an on-device fallback page while a cloud is chosen', () => {
  it('opens over an earlier key: no clear, and the key is unchanged', async () => {
    const { fake, id } = await cloudAtEpoch(3);
    const kept = fake.device.key;
    offFileData(fake.device);
    const fallback = await RecordSession.open(fakeHost(provider(new MemoryCloud(), 'local'), fake.device).host);
    expect(fallback.eraseIdentity).toBe('[0,null]');
    fallback.edit((file) => void file.measurements.push(weight('b', '2026-10-02')), fallback.eraseIdentity);
    await fallback.flush();
    expect(fake.clears.calls).toBe(0);
    untouched(fake.device);
    expect(fake.device.key).toEqual(kept);
    expect(fake.device.key?.lineage).toBe(id);
  });

  it('outage round trip: the cloud erased elsewhere meanwhile, the next good cloud load clears', async () => {
    const { other, fake, id } = await cloudAtEpoch(3);
    const fallback = await RecordSession.open(fakeHost(provider(new MemoryCloud(), 'local'), fake.device).host);
    offFileData(fake.device, 'typed-in-fallback');
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    await fallback.refreshFromRemote();
    expect(fake.clears.calls).toBe(0);

    const back = await RecordSession.open(fake.host);
    expect(epoch(back.eraseIdentity)).toBe(4);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.key).toEqual({ lineage: id, erase: back.eraseIdentity });
  });

  // Limit 3, today's behaviour: the device cannot tell a draft typed for the
  // erased record from one typed during the outage, so the clear takes both.
  it('drafts typed on a fallback page during an outage, after the cloud was erased elsewhere, are cleared at the next good cloud load', async () => {
    const { other, fake, id } = await cloudAtEpoch(1);
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    await RecordSession.open(fakeHost(provider(new MemoryCloud(), 'local'), fake.device).host, { cloudUnreachable: true });
    offFileData(fake.device, 'typed-during-the-outage');
    const back = await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(1);
    cleared(fake.device);
    expect(fake.device.key).toEqual({ lineage: id, erase: back.eraseIdentity });
  });
});

describe('US-11 AC6: a record with no erase kept for it adopts its own erase', () => {
  it('a guest signing in to an account erased before adopts, clears nothing, and the key is that cloud\'s erase', async () => {
    const guest = newDevice('local');
    const local = new MemoryCloud();
    await RecordSession.open(fakeHost(provider(local, 'local'), guest).host);
    expect(guest.key).toEqual({ lineage: 'local', erase: '[0,null]' });
    offFileData(guest, 'typed-as-guest');

    const account = new MemoryCloud();
    const other = await otherDevice(account, 'cloud-c');
    other.edit((file) => void file.measurements.push(weight('a', '2026-10-01')));
    await other.flush();
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    guest.chosen = 'cloud-c'; // the sign-in
    const fake = fakeHost(provider(account, 'cloud-c'), guest);
    const signedIn = await RecordSession.open(fake.host);
    expect(epoch(signedIn.eraseIdentity)).toBe(1);
    expect(fake.clears.calls).toBe(0);
    untouched(guest, 'typed-as-guest');
    expect(guest.key).toEqual({ lineage: 'cloud-c', erase: signedIn.eraseIdentity });
  });

  // Rollout: a browser that has used the tool before this key existed.
  it('an existing browser with no key, on a record never erased, adopts and clears nothing', async () => {
    const device = newDevice('cloud-a');
    const cloud = new MemoryCloud();
    const other = await otherDevice(cloud, 'cloud-a');
    other.edit((file) => void file.measurements.push(weight('a', '2026-10-01')));
    await other.flush();
    offFileData(device);
    const fake = fakeHost(provider(cloud, 'cloud-a'), device);
    const session = await RecordSession.open(fake.host);
    expect(session.eraseIdentity).toBe('[0,null]');
    expect(fake.clears.calls).toBe(0);
    untouched(device);
    expect(device.key).toEqual({ lineage: 'cloud-a', erase: '[0,null]' });
  });

  it('an existing browser with no key, on a record already erased, adopts and clears nothing', async () => {
    const device = newDevice('cloud-a');
    offFileData(device);
    const { fake, session } = await cloudAtEpoch(2, 'cloud-a', device);
    expect(epoch(session.eraseIdentity)).toBe(2);
    expect(fake.clears.calls).toBe(0);
    untouched(device);
    await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(0);
    untouched(device);
  });

  // Limit 5, today's behaviour: each change of record adopts, so an erase
  // made on the first record while this device was on the second is skipped.
  it('switch away and back: an erase made on the first record meanwhile is adopted, and nothing is cleared', async () => {
    const x = await cloudAtEpoch(3, 'cloud-x');
    const device = x.fake.device;
    offFileData(device, 'typed-on-x');
    device.chosen = 'cloud-y'; // the switch
    const y = new MemoryCloud();
    const onY = await RecordSession.open(fakeHost(provider(y, 'cloud-y'), device).host);
    expect(device.key).toEqual({ lineage: 'cloud-y', erase: onY.eraseIdentity });
    later();
    expect((await x.other.erase()).success).toBe(true);
    later();
    device.chosen = 'cloud-x'; // the switch back
    const back = await RecordSession.open(x.fake.host);
    expect(epoch(back.eraseIdentity)).toBe(4);
    expect(x.fake.clears.calls).toBe(0);
    untouched(device, 'typed-on-x');
    expect(device.key).toEqual({ lineage: 'cloud-x', erase: back.eraseIdentity });
  });
});

describe('US-11 AC6: two tabs of one device on one record', () => {
  it('both own the stores: one clears and moves the key; the other taking the same erase in leaves the key there', async () => {
    const { other, fake, cloud, id } = await cloudAtEpoch(1);
    const tabA = await RecordSession.open(fake.host);
    const b = fakeHost(provider(cloud, id), fake.device);
    const tabB = await RecordSession.open(b.host);
    offFileData(fake.device);
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    expect(await tabB.refreshFromRemote()).toBe(true);
    expect(b.clears.calls).toBe(1);
    cleared(fake.device);
    const e2 = tabB.eraseIdentity;
    expect(fake.device.key).toEqual({ lineage: id, erase: e2 });

    expect(await tabA.refreshFromRemote()).toBe(true);
    expect(tabA.eraseIdentity).toBe(e2);
    expect(fake.device.key).toEqual({ lineage: id, erase: e2 });
    await RecordSession.open(fake.host);
    expect(fake.device.key).toEqual({ lineage: id, erase: e2 });
  });
});

describe('US-11 AC6: a page not owning the stores takes an erase in', () => {
  it('drops only the draft on its screen; the stored data and the key are unchanged', async () => {
    const { other, fake } = await cloudAtEpoch(1);
    const kept = fake.device.key;
    const session = await RecordSession.open(fake.host);
    offFileData(fake.device);
    fake.device.chosen = 'cloud-b'; // another tab moved this browser to another cloud
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    expect(await session.refreshFromRemote()).toBe(true);
    expect(fake.device.screenDrops).toBe(1);
    expect(fake.clears.calls).toBe(0);
    untouched(fake.device);
    expect(fake.device.key).toEqual(kept);
  });

  it('a guest tab that loses the stores to a sign-in, takes that account\'s erase in, then owns them again, clears nothing', async () => {
    const device = newDevice('local');
    const local = new MemoryCloud();
    const g = fakeHost(provider(local, 'local'), device);
    const guestTab = await RecordSession.open(g.host);
    guestTab.edit((file) => void file.measurements.push(weight('a', '2026-10-01')));
    await guestTab.flush();
    const kept = device.key;
    expect(kept).toEqual({ lineage: 'local', erase: '[0,null]' });

    device.chosen = 'cloud-c'; // another tab signs in: this guest tab no longer owns the stores
    const signedIn = await RecordSession.open(fakeHost(provider(local, 'local'), newDevice('local')).host);
    later();
    expect((await signedIn.erase()).success).toBe(true); // the erase reaches the device copy
    later();
    offFileData(device, 'typed-after-the-sign-in');
    expect(await guestTab.refreshFromRemote()).toBe(true);
    expect(device.screenDrops).toBe(1);
    expect(device.key).toEqual(kept);

    device.chosen = 'local'; // "use this browser only": this tab owns the stores again
    later();
    await guestTab.refreshFromRemote();
    guestTab.edit((file) => void file.measurements.push(weight('b', '2026-10-02')), guestTab.eraseIdentity);
    await guestTab.flush();
    expect(g.clears.calls).toBe(0);
    untouched(device, 'typed-after-the-sign-in');
    expect(device.key).toEqual(kept);
  });
});

describe('US-11 AC6: a clear that did not work is tried again at the next load', () => {
  it('an erase made in this tab whose read-back fails leaves the key at the old erase; the next load as owner clears, then moves it', async () => {
    const { fake, session, id } = await cloudAtEpoch(1);
    const before = fake.device.key;
    offFileData(fake.device);
    fake.clears.leavesDraft = true;
    later();
    expect((await session.erase()).success).toBe(true);
    expect([...fake.device.drafts]).toEqual([['vitals', 'typed']]);
    expect(fake.device.key).toEqual(before);

    fake.clears.leavesDraft = false;
    const reopened = await RecordSession.open(fake.host);
    expect(reopened.eraseIdentity).toBe(session.eraseIdentity);
    cleared(fake.device);
    expect(fake.device.key).toEqual({ lineage: id, erase: session.eraseIdentity });
  });

  it('an erase made in this tab whose clear works moves the key, and the next load clears nothing', async () => {
    const { fake, session, id } = await cloudAtEpoch(1);
    offFileData(fake.device);
    later();
    expect((await session.erase()).success).toBe(true);
    cleared(fake.device);
    expect(fake.device.key).toEqual({ lineage: id, erase: session.eraseIdentity });
    await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(1);
  });

  it('a clear that throws in one session is tried at the next load; once it works the stores are empty and the key moves', async () => {
    const { other, fake, session, id } = await cloudAtEpoch(1);
    offFileData(fake.device);
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    fake.clears.failing = true;
    expect(await session.refreshFromRemote()).toBe(true);
    later();
    await session.refreshFromRemote();
    expect(fake.clears.calls).toBe(2);
    expect(fake.device.key?.erase).not.toBe(other.eraseIdentity);

    const second = await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(3);
    expect(fake.reports.at(-1)).toEqual({ op: 'clear-off-file', repeat: false });
    expect(fake.device.key?.erase).not.toBe(other.eraseIdentity);

    fake.clears.failing = false;
    second.edit((file) => void file.measurements.push(weight('b', '2026-10-02')), second.eraseIdentity);
    await second.flush();
    expect(fake.clears.calls).toBe(4);
    cleared(fake.device);
    expect(fake.device.key).toEqual({ lineage: id, erase: other.eraseIdentity });

    later();
    await second.refreshFromRemote();
    await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(4);
  });

  it('reports a clear that keeps failing once per session, then as a repeat', async () => {
    const { other, fake, session } = await cloudAtEpoch(1);
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    fake.clears.failing = true;
    await session.refreshFromRemote();
    later();
    await session.refreshFromRemote();
    expect(fake.reports).toEqual([{ op: 'clear-off-file', repeat: false }, { op: 'clear-off-file', repeat: true }]);

    const second = await RecordSession.open(fake.host);
    later();
    await second.refreshFromRemote();
    expect(fake.reports.slice(2)).toEqual([{ op: 'clear-off-file', repeat: false }, { op: 'clear-off-file', repeat: true }]);
  });

  it('a stored original the erase kept survives the open-time clear', async () => {
    const { cloud, other, fake, id } = await cloudAtEpoch(0);
    offFileData(fake.device);
    later();
    expect((await other.erase()).success).toBe(true);
    later();
    // Saved after the erase on another device: its original outlives it.
    const after = await otherDevice(cloud, id);
    after.edit((file) => void file.documents.push(doc('after', 'Lab results/after.pdf')), after.eraseIdentity);
    await after.flush();
    fake.device.originals.add('Lab results/after.pdf');
    await RecordSession.open(fake.host);
    expect(fake.clears.calls).toBe(1);
    expect([...fake.device.drafts]).toEqual([]);
    expect([...fake.device.originals]).toEqual(['Lab results/after.pdf']);
  });
});
