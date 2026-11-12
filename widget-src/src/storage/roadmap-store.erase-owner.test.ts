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
import { MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ERASE_STALE_TAB } from '@roadmap/health-core/record-session';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { DOC_KEY_PREFIX, LPA_CHECK_KEPT_KEY, VITALS_DRAFT_KEY, clearLocalStorage, clearOffFileHealthData } from '../lib/storage';
import { LocalStorageAdapter, NAMED_FILE_PREFIX } from './local-storage-adapter';
import { BACKEND_KEY, PENDING_MIRROR_KEY } from './web-record-host';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const ORIGINAL = `${DOC_KEY_PREFIX}synthetic.pdf`;
const CHAT = `${NAMED_FILE_PREFIX}chat-history.json`;
const DRAFT = '{"draft":{"date":"2026-11-12","values":{"weight":"84"}}}';
const snapshot = () => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]));
const cloudBody = (cloud: MemoryCloud) => cloud.files.get(ROADMAP_FILE_NAME)?.json;

/** A page: a fresh module graph, so it has its own health-writes state and notes the device's log-off id as it
 *  is now, as each tab does in a real browser. Its stores and adapters come from that graph. */
async function loadPage() {
  vi.resetModules();
  const { RoadmapStore } = await import('./roadmap-store');
  const { stopLocalHealthWrites } = await import('../lib/storage');
  const { LocalStorageAdapter: PageDevice } = await import('./local-storage-adapter');
  const { MemoryAdapter } = await import('@roadmap/health-core/memory-adapter');
  return {
    RoadmapStore, stopLocalHealthWrites, PageDevice,
    device: () => new PageDevice(),
    cloud: (cloud: MemoryCloud) => new MemoryAdapter(cloud),
  };
}
type Page = Awaited<ReturnType<typeof loadPage>>;

/** A store with one weight saved, opened on `page`. */
async function withWeight(page: Page, adapter: ReturnType<Page['device'] | Page['cloud']>) {
  const store = await page.RoadmapStore.create(adapter);
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
  const guest = await loadPage();
  await withWeight(guest, guest.device());
  offFileData();
  localStorage.setItem(LPA_CHECK_KEPT_KEY, '{"synthetic":"kept"}');
  if (!optIn) return;
  const device = guest.device(); // the guest page's own: it loaded after the log-off, so it may write
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
    const stalePage = await loadPage();
    const stale = await withWeight(stalePage, stalePage.cloud(cloud));
    // Another tab chooses "This device" and saves there.
    localStorage.removeItem(BACKEND_KEY);
    const other = await loadPage();
    await withWeight(other, other.device());
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
    const guestPage = await loadPage();
    const guest = await withWeight(guestPage, guestPage.device());
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
    const page = await loadPage();
    const tab = await withWeight(page, page.cloud(cloud));
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
    const frozenPage = await loadPage();
    const frozen = await withWeight(frozenPage, frozenPage.cloud(new MemoryCloud()));
    await anotherTabLogsOff();
    await guestUsesDevice();
    localStorage.setItem(PENDING_MIRROR_KEY, '1');
    const device = snapshot();
    const read = vi.spyOn(frozenPage.PageDevice.prototype, 'read');
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
    const frozenPage = await loadPage();
    const frozen = await withWeight(frozenPage, frozenPage.cloud(new MemoryCloud()));
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
    const frozenPage = await loadPage();
    const frozen = await withWeight(frozenPage, frozenPage.cloud(cloud));
    await anotherTabLogsOff();
    localStorage.setItem(BACKEND_KEY, 'memory'); // signed in again, to the same provider
    const again = await loadPage();
    await withWeight(again, again.cloud(new MemoryCloud()));
    offFileData();
    const device = snapshot();
    const remote = cloudBody(cloud);
    const run = steps();

    expect(await frozen.deleteAllData(run)).toEqual({ success: false, error: ERASE_STALE_TAB, chatErased: false });

    expect(run.teardown).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(device);
    expect(cloudBody(cloud)).toBe(remote);
  });

  it('a device page, after a log-off elsewhere: refused first, nothing moves', async () => {
    localStorage.setItem('health_roadmap_log_off_id', 'synthetic-log-off-before');
    const guestPage = await loadPage(); // a fresh page: nothing from an earlier test or page carries in
    const guest = await withWeight(guestPage, guestPage.device());
    localStorage.setItem('health_roadmap_log_off_id', 'synthetic-log-off-after');
    offFileData();
    const device = snapshot();
    const run = steps();

    expect(await guest.deleteAllData(run)).toEqual({ success: false, error: ERASE_STALE_TAB, chatErased: false });

    expect(run.teardown).not.toHaveBeenCalled();
    expect(run.chat).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(device);
  });

  it('a guest page open while someone signed in, logged off and a guest then used this browser: refused first; the guest\'s record, drafts, original, kept answer and opt-in stay', async () => {
    const stalePage = await loadPage();
    const stale = await withWeight(stalePage, stalePage.device());
    localStorage.setItem(BACKEND_KEY, 'memory'); // another tab signs in
    const signedIn = await loadPage();
    await withWeight(signedIn, signedIn.cloud(new MemoryCloud()));
    await anotherTabLogsOff();
    await guestUsesDevice(true);
    const device = snapshot();
    const run = steps();

    expect(await stale.deleteAllData(run)).toEqual({ success: false, error: ERASE_STALE_TAB, chatErased: false });

    expect(run.teardown).not.toHaveBeenCalled(); // the guest's reminder row on the server is not cancelled
    expect(run.chat).not.toHaveBeenCalled();
    expect(stale.getReminderOptIn()).toBeUndefined();
    expect(snapshot()).toEqual(device);
  });

  it('control: a device page with no log-off since it loaded erases its own record', async () => {
    localStorage.setItem('health_roadmap_log_off_id', 'synthetic-log-off-before');
    const guestPage = await loadPage();
    const guest = await withWeight(guestPage, guestPage.device());
    offFileData();

    expect((await guest.deleteAllData(steps())).success).toBe(true);
    expect((new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body as RoadmapFile).measurements).toEqual([]);
    expect(localStorage.getItem(ORIGINAL)).toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
  });

  it('the refused tab, reloaded, is on the chosen record and erases', async () => {
    const cloud = new MemoryCloud();
    const guestPage = await loadPage();
    const guest = await withWeight(guestPage, guestPage.device());
    localStorage.setItem(BACKEND_KEY, 'memory'); // another tab signs in
    const other = await loadPage();
    await withWeight(other, other.cloud(cloud));
    expect((await guest.deleteAllData(steps())).error).toBe(ERASE_STALE_TAB);

    const reload = await loadPage(); // the reload opens the chosen cloud
    const reloaded = await reload.RoadmapStore.create(reload.cloud(cloud));
    expect((await reloaded.deleteAllData(steps())).success).toBe(true);
    expect((JSON.parse(cloudBody(cloud)!) as RoadmapFile).measurements).toEqual([]);
  });

  it('control: a cloud tab that heard another tab\'s log-off (latched): refused first, nothing moves', async () => {
    const cloud = new MemoryCloud();
    localStorage.setItem(BACKEND_KEY, 'memory');
    const page = await loadPage();
    const tab = await withWeight(page, page.cloud(cloud));
    offFileData();
    page.stopLocalHealthWrites(); // the latch another tab's log-off sets on this page
    const device = snapshot();
    const remote = cloudBody(cloud);

    expect(await tab.deleteAllData(steps())).toEqual({ success: false, error: ERASE_STALE_TAB, chatErased: false });
    expect(snapshot()).toEqual(device);
    expect(cloudBody(cloud)).toBe(remote);
  });
});
