// @vitest-environment jsdom
/**
 * US-11 AC6 — "Delete all my data" in a tab that is not on the record this
 * browser has chosen (a guest tab after a sign-in elsewhere, a cloud tab after
 * another tab chose "This device", a tab after a log-off elsewhere) is refused
 * before anything moves: no teardown, no chat erase, no write, nothing off the
 * device. It answers ERASE_STALE_TAB, and the person reloads, which puts the
 * tab on the chosen record. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ERASE_STALE_TAB } from '@roadmap/health-core/record-session';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { DOC_KEY_PREFIX, LPA_CHECK_KEPT_KEY, VITALS_DRAFT_KEY, clearLocalStorage, clearOffFileHealthData, stopLocalHealthWrites } from '../lib/storage';
import { LocalStorageAdapter, NAMED_FILE_PREFIX } from './local-storage-adapter';
import { RoadmapStore } from './roadmap-store';
import { BACKEND_KEY, PENDING_MIRROR_KEY } from './web-record-host';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const ORIGINAL = `${DOC_KEY_PREFIX}synthetic.pdf`;
const CHAT = `${NAMED_FILE_PREFIX}chat-history.json`;
const DRAFT = '{"draft":{"date":"2026-11-12","values":{"weight":"84"}}}';
const snapshot = () => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]));
const cloudBody = (cloud: MemoryCloud) => cloud.files.get(ROADMAP_FILE_NAME)?.json;

/** A store with one weight saved. */
async function withWeight(adapter: LocalStorageAdapter | MemoryAdapter): Promise<RoadmapStore> {
  const store = await RoadmapStore.create(adapter);
  store.addMeasurement('weight', 82, '2026-11-01');
  await store.flush();
  return store;
}
/** This browser's off-file data: a stored original, a draft and a device chat history. */
function offFileData() {
  localStorage.setItem(ORIGINAL, 'synthetic bytes');
  localStorage.setItem(VITALS_DRAFT_KEY, DRAFT);
  localStorage.setItem(CHAT, '{"synthetic":"chat"}');
}
/** What another tab's log-off leaves in this browser's storage (connect.ts logOff): a new log-off id, the
 *  device copy and off-file data gone, no backend remembered. This tab hears no event (frozen). */
async function anotherTabLogsOff() {
  localStorage.setItem('health_roadmap_log_off_id', `synthetic-log-off-${Math.random()}`);
  await new LocalStorageAdapter().disconnect();
  clearLocalStorage();
  clearOffFileHealthData();
  localStorage.removeItem(BACKEND_KEY);
}
/** Then someone else uses this browser as a guest: a record, an original, a chat history, a draft and a kept answer. */
async function guestUsesDevice(optIn = false) {
  await withWeight(new LocalStorageAdapter());
  offFileData();
  localStorage.setItem(LPA_CHECK_KEPT_KEY, '{"synthetic":"kept"}');
  if (!optIn) return;
  const device = new LocalStorageAdapter();
  const { body, version } = device.readSync(ROADMAP_FILE_NAME);
  const reminderOptIn = { status: 'active', token: 'test-token-guest', email: 'guest@example.test', provider: 'dropbox', updatedAt: '2026-11-12T10:00:00.000Z' };
  device.writeSync(ROADMAP_FILE_NAME, { ...(body as object), reminderOptIn }, version);
}
/** The erase's two steps, as the page passes them. */
const steps = () => ({ teardown: vi.fn(async () => {}), chat: vi.fn(async () => ({ eraseAll: vi.fn(async () => {}) })) });

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('US-11 AC6 — an out-of-date tab cannot delete data; it is told to reload', () => {
  it('a cloud tab, after another tab chose "This device": refused first; the device record, originals and named files stay', async () => {
    const cloud = new MemoryCloud();
    localStorage.setItem(BACKEND_KEY, 'memory');
    const stale = await withWeight(new MemoryAdapter(cloud));
    // Another tab chooses "This device" and saves there.
    localStorage.removeItem(BACKEND_KEY);
    await withWeight(new LocalStorageAdapter());
    offFileData();
    const device = snapshot();
    const remote = cloudBody(cloud);
    const run = steps();

    expect(await stale.deleteAllData(run)).toEqual({ success: false, error: ERASE_STALE_TAB, chatErased: false });

    expect(run.teardown).not.toHaveBeenCalled();
    expect(run.chat).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(device);
    expect(cloudBody(cloud)).toBe(remote);
  });

  it('a guest tab, after another tab signed in: refused first; nothing is written to the device file and chat history stays', async () => {
    const guest = await withWeight(new LocalStorageAdapter());
    offFileData();
    localStorage.setItem(BACKEND_KEY, 'memory'); // another tab signs in
    const device = snapshot();
    const run = steps();

    expect(await guest.deleteAllData(run)).toEqual({ success: false, error: ERASE_STALE_TAB, chatErased: false });

    expect(run.teardown).not.toHaveBeenCalled();
    expect(run.chat).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(device);
    // Defence: the page's clear in a tab off the chosen record still clears nothing.
    guest.clearOffFileData();
    expect(snapshot()).toEqual(device);
  });

  it('control: the tab on the chosen record erases fully', async () => {
    const cloud = new MemoryCloud();
    localStorage.setItem(BACKEND_KEY, 'memory');
    const tab = await withWeight(new MemoryAdapter(cloud));
    offFileData();
    localStorage.setItem(PENDING_MIRROR_KEY, '1');
    const run = steps();

    expect((await tab.deleteAllData(run)).success).toBe(true);

    expect(run.teardown).toHaveBeenCalledTimes(1);
    expect(run.chat).toHaveBeenCalledTimes(1);
    const erased = JSON.parse(cloudBody(cloud)!) as RoadmapFile;
    expect(erased.meta.eraseEpoch).toBeGreaterThan(0);
    expect(erased.measurements).toEqual([]);
    expect(localStorage.getItem(ORIGINAL)).toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).toBeNull();
    expect(localStorage.getItem(CHAT)).toBeNull();
  });

  it('a cloud tab that heard no log-off, after another tab logged off and a guest used this browser: refused first; the guest\'s data stays', async () => {
    localStorage.setItem(BACKEND_KEY, 'memory');
    const frozen = await withWeight(new MemoryAdapter(new MemoryCloud()));
    await anotherTabLogsOff();
    await guestUsesDevice();
    localStorage.setItem(PENDING_MIRROR_KEY, '1');
    const device = snapshot();
    const read = vi.spyOn(LocalStorageAdapter.prototype, 'read');
    const run = steps();

    expect(await frozen.deleteAllData(run)).toEqual({ success: false, error: ERASE_STALE_TAB, chatErased: false });

    expect(read).not.toHaveBeenCalled(); // the device copy is not read
    read.mockRestore();
    expect(run.teardown).not.toHaveBeenCalled();
    expect(run.chat).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(device);
  });

  it('the same, with the guest opted in to reminders: the erase\'s server step is never reached and the opt-in stays the guest\'s', async () => {
    localStorage.setItem(BACKEND_KEY, 'memory');
    const frozen = await withWeight(new MemoryAdapter(new MemoryCloud()));
    await anotherTabLogsOff();
    await guestUsesDevice(true);
    const device = snapshot();
    const run = steps();

    expect((await frozen.deleteAllData(run)).error).toBe(ERASE_STALE_TAB);

    expect(run.teardown).not.toHaveBeenCalled();
    expect(frozen.getReminderOptIn()).toBeUndefined();
    expect(snapshot()).toEqual(device);
  });

  it('the same, with someone signed in again to the same provider: refused first; their data stays', async () => {
    const cloud = new MemoryCloud();
    localStorage.setItem(BACKEND_KEY, 'memory');
    const frozen = await withWeight(new MemoryAdapter(cloud));
    await anotherTabLogsOff();
    localStorage.setItem(BACKEND_KEY, 'memory'); // signed in again, to the same provider
    await withWeight(new MemoryAdapter(new MemoryCloud()));
    offFileData();
    const device = snapshot();
    const remote = cloudBody(cloud);
    const run = steps();

    expect(await frozen.deleteAllData(run)).toEqual({ success: false, error: ERASE_STALE_TAB, chatErased: false });

    expect(run.teardown).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(device);
    expect(cloudBody(cloud)).toBe(remote);
  });

  it('control: a device page, after a log-off elsewhere, still erases its own record', async () => {
    localStorage.setItem('health_roadmap_log_off_id', 'synthetic-log-off-before');
    const guest = await withWeight(new LocalStorageAdapter());
    localStorage.setItem('health_roadmap_log_off_id', 'synthetic-log-off-after');
    offFileData();

    expect((await guest.deleteAllData(steps())).success).toBe(true);
    expect((new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body as RoadmapFile).measurements).toEqual([]);
    expect(localStorage.getItem(ORIGINAL)).toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
  });

  it('the refused tab, reloaded, is on the chosen record and erases', async () => {
    const cloud = new MemoryCloud();
    const guest = await withWeight(new LocalStorageAdapter());
    localStorage.setItem(BACKEND_KEY, 'memory'); // another tab signs in
    await withWeight(new MemoryAdapter(cloud));
    expect((await guest.deleteAllData(steps())).error).toBe(ERASE_STALE_TAB);

    const reloaded = await RoadmapStore.create(new MemoryAdapter(cloud)); // the reload opens the chosen cloud
    expect((await reloaded.deleteAllData(steps())).success).toBe(true);
    expect((JSON.parse(cloudBody(cloud)!) as RoadmapFile).measurements).toEqual([]);
  });

  it('control: a cloud tab that heard another tab\'s log-off (latched): refused first, nothing moves', async () => {
    const cloud = new MemoryCloud();
    localStorage.setItem(BACKEND_KEY, 'memory');
    const tab = await withWeight(new MemoryAdapter(cloud));
    offFileData();
    stopLocalHealthWrites(); // the latch another tab's log-off sets here; last in this file: it lasts for the module's life
    const device = snapshot();
    const remote = cloudBody(cloud);

    expect(await tab.deleteAllData(steps())).toEqual({ success: false, error: ERASE_STALE_TAB, chatErased: false });
    expect(snapshot()).toEqual(device);
    expect(cloudBody(cloud)).toBe(remote);
  });
});
