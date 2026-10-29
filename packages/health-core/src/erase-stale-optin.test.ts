/**
 * US-11 AC4 (C2): an erase from a copy read before another device opted in to
 * reminders must still leave reminders off, and must hand that opt-in to the
 * teardown that cancels its server row. buildErasedFile looked only at the
 * eraser's own copy, so the erased file read "never decided" and the next load
 * enrolled the user again; the teardown read the same stale copy, so the row
 * the other device made was never cancelled. Synthetic data, in memory.
 */
import { describe, expect, it } from 'vitest';
import { buildErasedFile } from './erase';
import { mergeFiles } from './merge';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { ROADMAP_FILE_NAME } from './adapter';
import { createEmptyFile, type FileReminderOptIn, type RoadmapFile } from './roadmap-file';

const NOW = '2026-10-21T12:00:00.000Z';
const ctx = { deviceId: 'eraser', now: NOW };
const record = (): RoadmapFile => createEmptyFile({ deviceId: 'd', now: '2026-10-01T00:00:00.000Z' });
const active = (lamport: number, provider = 'dropbox'): FileReminderOptIn =>
  ({ status: 'active', token: 'tok', email: 'a@example.test', provider, updatedAt: NOW, lamport } as FileReminderOptIn);

describe('buildErasedFile: an opt-in only another copy holds (US-11 AC4)', () => {
  it('turns reminders off when the stored record, not this copy, has the opt-in', () => {
    const stored = record();
    stored.reminderOptIn = active(3);
    const erased = buildErasedFile({ stored, own: record(), device: null, ctx });
    expect(erased.reminderOptIn).toMatchObject({ status: 'cancelled', token: '', email: '', provider: 'dropbox' });
    // The erase wins the epoch gate, and what the cloud keeps still says off.
    expect(mergeFiles(erased, stored, ctx).reminderOptIn?.status).toBe('cancelled');
  });

  it('turns reminders off when only the device copy has the opt-in', () => {
    const device = record();
    device.reminderOptIn = { ...active(2, 'google-drive'), status: 'cancelled', token: '', email: '' };
    const erased = buildErasedFile({ stored: record(), own: record(), device, ctx });
    expect(erased.reminderOptIn).toMatchObject({ status: 'cancelled', provider: 'google-drive' });
  });

  it('names the provider of the newest opt-in, whichever copy holds it', () => {
    const older = active(1, 'dropbox');
    const newer = active(5, 'github');
    const [a, b] = [record(), record()];
    a.reminderOptIn = older;
    b.reminderOptIn = newer;
    expect(buildErasedFile({ stored: b, own: a, device: null, ctx }).reminderOptIn?.provider).toBe('github');
    expect(buildErasedFile({ stored: a, own: b, device: null, ctx }).reminderOptIn?.provider).toBe('github');
  });

  it('control: an opt-in in this copy is turned off, and none anywhere stays undecided', () => {
    const own = record();
    own.reminderOptIn = active(3);
    expect(buildErasedFile({ stored: record(), own, device: null, ctx }).reminderOptIn)
      .toMatchObject({ status: 'cancelled', token: '', email: '' });
    expect(buildErasedFile({ stored: record(), own: record(), device: record(), ctx }).reminderOptIn).toBeUndefined();
  });
});

describe('RecordSession.deleteAllData: the teardown sees the stored opt-in (US-11 AC4)', () => {
  const host = (cloud: MemoryCloud, mirror = new MemoryCloud()): RecordHost => ({
    store: new MemoryAdapter(cloud),
    clearOffFileData: () => {},
    deviceId: () => 'tab',
    clock: { now: () => Date.parse(NOW) },
    timers: { set: () => 0, clear: () => {} },
    remoteChanged: () => {},
    failureCause: () => 'x',
    report: () => {},
    tier: 'cloud',
    mirror: {
      adapter: new MemoryAdapter(mirror),
      pending: { get: () => false, set: () => {}, clear: () => {} },
      writesStopped: () => false,
      wipe: async () => {},
      opened: () => {},
    },
  } as unknown as RecordHost);

  it('a tab opened before another device enrolled cancels that enrolment', async () => {
    const cloud = new MemoryCloud();
    const session = await RecordSession.open(host(cloud));
    expect(session.file.reminderOptIn).toBeUndefined();
    // Another device enrols after this tab read the record.
    const other = record();
    other.reminderOptIn = active(4);
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(other), version: 99 });

    let seen: FileReminderOptIn | undefined;
    const result = await session.deleteAllData({ teardown: async () => { seen = session.file.reminderOptIn; } });

    expect(result.success).toBe(true);
    expect(seen).toMatchObject({ status: 'active', token: 'tok' });
    const saved: RoadmapFile = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
    expect(saved.reminderOptIn).toMatchObject({ status: 'cancelled', token: '', email: '' });
  });

  it('an opt-in only the device copy holds (another tab whose save failed) reaches the teardown', async () => {
    const cloud = new MemoryCloud();
    const mirror = new MemoryCloud();
    const session = await RecordSession.open(host(cloud, mirror));
    const tab = record();
    tab.reminderOptIn = active(4, 'google-drive');
    mirror.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(tab), version: 1 });

    let seen: FileReminderOptIn | undefined;
    await session.deleteAllData({ teardown: async () => { seen = session.file.reminderOptIn; } });
    expect(seen).toMatchObject({ status: 'active', provider: 'google-drive' });
  });

  it('the stored record\'s epoch outranks a later stamp in a copy that missed its erase', async () => {
    const cloud = new MemoryCloud();
    const session = await RecordSession.open(host(cloud));
    // This tab opted in before another device erased; its stamp runs ahead.
    session.edit((file) => { file.reminderOptIn = { ...active(9, 'dropbox'), token: 'stale' }; });
    const other = record();
    other.meta.eraseEpoch = 1;
    other.reminderOptIn = { ...active(2, 'github'), token: 'fresh' };
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(other), version: 99 });

    let seen: FileReminderOptIn | undefined;
    await session.deleteAllData({ teardown: async () => { seen = session.file.reminderOptIn; } });
    expect(seen).toMatchObject({ token: 'fresh', provider: 'github' });
  });

  for (const [label, theirs] of [
    ['no opt-in', undefined],
    ['a cancelled opt-in', { ...active(3, 'github'), status: 'cancelled', token: '', email: '' }],
  ] as const) {
    it(`an erase this copy missed, holding ${label}, never takes this copy's active opt-in away`, async () => {
      const cloud = new MemoryCloud();
      const session = await RecordSession.open(host(cloud));
      session.edit((file) => { file.reminderOptIn = { ...active(1, 'dropbox'), token: 'mine' }; });
      const other = record();
      other.meta.eraseEpoch = 1;
      if (theirs) other.reminderOptIn = theirs as FileReminderOptIn;
      cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(other), version: 99 });

      let seen: FileReminderOptIn | undefined;
      await session.deleteAllData({ teardown: async () => { seen = session.file.reminderOptIn; } });
      expect(seen).toMatchObject({ status: 'active', token: 'mine' });
      const saved: RoadmapFile = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
      expect(saved.reminderOptIn).toMatchObject({ status: 'cancelled', token: '', email: '' });
    });
  }

  it('control: an older stored opt-in does not replace this copy\'s newer one', async () => {
    const cloud = new MemoryCloud();
    const old = record();
    old.reminderOptIn = { ...active(1), status: 'cancelled', token: '', email: '' };
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(old), version: 1 });
    const session = await RecordSession.open(host(cloud));
    session.edit((file) => { file.reminderOptIn = active(7, 'github'); });

    let seen: FileReminderOptIn | undefined;
    await session.deleteAllData({ teardown: async () => { seen = session.file.reminderOptIn; } });
    expect(seen).toMatchObject({ status: 'active', provider: 'github' });
  });
});
