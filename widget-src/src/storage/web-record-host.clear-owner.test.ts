/**
 * @vitest-environment jsdom
 *
 * US-11 AC6 — which tab clears this browser's off-file data (drafts, kept
 * answers, stored originals) when an erase comes in. Only a tab on the record
 * this browser has chosen clears it: the device record when no cloud is
 * chosen, else the chosen cloud. Another tab (a guest tab after a sign-in
 * elsewhere, a cloud tab after another tab switched backend) takes the erase
 * into its own copy without clearing, and owes no clear later when the
 * browser comes back to its record. Sessions over one jsdom localStorage, through
 * the web host itself, stand in for the tabs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RecordSession } from '@roadmap/health-core/record-session';
import { createMeasurement } from '@roadmap/health-core/roadmap-file';
import { LocalStorageAdapter } from './local-storage-adapter';
import { RoadmapStore } from './roadmap-store';
import { BACKEND_KEY, webRecordHost } from './web-record-host';
import { BT_TIMELINE_DRAFT_KEY, LPA_CHECK_KEPT_KEY, MIRROR_KEY, VITALS_DRAFT_KEY } from '../lib/storage';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const GUEST_DRAFT = '{"draft":{"date":"2026-11-12","values":{"weight":"84"}}}';
const CLOUD_DRAFT = '{"draft":{"date":"2026-11-12","values":{"ldl":"3.2"}}}';
const drafts = () => [localStorage.getItem(VITALS_DRAFT_KEY), localStorage.getItem(BT_TIMELINE_DRAFT_KEY)];
const typeDrafts = () => {
  localStorage.setItem(VITALS_DRAFT_KEY, GUEST_DRAFT);
  localStorage.setItem(BT_TIMELINE_DRAFT_KEY, CLOUD_DRAFT);
};
const add = (session: RecordSession, id: string) =>
  session.edit((file) => void file.measurements.push(createMeasurement({
    id, metricType: 'weight', value: 80, recordedAt: '2026-11-12', createdAt: '2026-11-12T10:00:00.000Z',
  })));
/** Past the re-read's throttle. */
const later = () => vi.setSystemTime(Date.now() + 60_000);

/** A cloud record erased earlier, from a tab on that cloud, before the test's tabs open. */
async function erasedCloud(): Promise<MemoryCloud> {
  const cloud = new MemoryCloud();
  localStorage.setItem(BACKEND_KEY, 'memory'); // MemoryAdapter's id
  const earlier = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
  add(earlier, 'old');
  await earlier.flush();
  expect((await earlier.erase()).success).toBe(true);
  localStorage.clear();
  return cloud;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T10:00:00.000Z'));
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('US-11 AC6 — only the tab on the chosen record clears off-file data', () => {
  it('a guest tab takes in a cloud tab\'s erase through the device copy and clears nothing', async () => {
    const cloud = await erasedCloud();
    const guest = await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    // Another tab signs in to the erased cloud.
    localStorage.setItem(BACKEND_KEY, 'memory');
    const signedIn = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    typeDrafts();
    add(signedIn, 'new');
    signedIn.flushSync(); // it hides: its copy, erase included, goes to the device copy

    later();
    await guest.refreshFromRemote();

    expect(guest.eraseIdentity).toBe(signedIn.eraseIdentity); // the erase is taken in
    expect(drafts()).toEqual([GUEST_DRAFT, CLOUD_DRAFT]);
  });

  it('after "use this browser only", the guest tab is on the chosen record again and owes no clear', async () => {
    const cloud = await erasedCloud();
    const guest = await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    localStorage.setItem(BACKEND_KEY, 'memory');
    const signedIn = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    typeDrafts();
    add(signedIn, 'new');
    signedIn.flushSync();
    later();
    await guest.refreshFromRemote();

    // The signed-in tab chooses "use this browser only" and reloads.
    localStorage.removeItem(BACKEND_KEY);
    await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    later();
    await guest.refreshFromRemote(); // nothing new: a clear owed would run here

    expect(drafts()).toEqual([GUEST_DRAFT, CLOUD_DRAFT]);
  });

  it('a cloud tab left on its cloud after another tab chose another backend takes in an erase there and clears nothing', async () => {
    const cloud = new MemoryCloud();
    localStorage.setItem(BACKEND_KEY, 'memory');
    const stale = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    const eraser = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    expect((await eraser.erase()).success).toBe(true);
    // Another tab moves this browser to another cloud and types there.
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    typeDrafts();

    later();
    await stale.refreshFromRemote();

    expect(stale.eraseIdentity).toBe(eraser.eraseIdentity);
    expect(drafts()).toEqual([GUEST_DRAFT, CLOUD_DRAFT]);
  });

  it('a guest tab\'s own erase, after another tab signed in, is refused, and the page\'s clear clears nothing of this browser\'s', async () => {
    const guest = await RoadmapStore.create(new LocalStorageAdapter());
    localStorage.setItem(BACKEND_KEY, 'memory'); // another tab signs in
    typeDrafts();

    expect((await guest.deleteAllData()).success).toBe(false); // roadmap-store.erase-owner.test.ts
    guest.clearOffFileData(); // the page's clear, kept as defence

    expect(drafts()).toEqual([GUEST_DRAFT, CLOUD_DRAFT]);
  });

  it('a cloud tab\'s own erase, after another tab chose another backend, is refused, and the page\'s clear clears nothing of this browser\'s', async () => {
    localStorage.setItem(BACKEND_KEY, 'memory');
    const stale = await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    typeDrafts();

    expect((await stale.deleteAllData()).success).toBe(false);
    stale.clearOffFileData();

    expect(drafts()).toEqual([GUEST_DRAFT, CLOUD_DRAFT]);
  });

  it.each([
    ['a guest uses this browser', null],
    ['someone signs in again to the same provider', 'memory'],
  ])('a cloud tab that heard no log-off takes in an erase made elsewhere after another tab logged off and %s: drafts and kept answers stay', async (_, backend) => {
    const cloud = new MemoryCloud();
    localStorage.setItem(BACKEND_KEY, 'memory');
    const frozen = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    add(frozen, 'old');
    await frozen.flush();
    const before = frozen.eraseIdentity;
    const elsewhere = new MemoryAdapter(cloud); // another device erases the cloud record: only its cloud file is shared
    const { body, version } = await elsewhere.read(ROADMAP_FILE_NAME);
    const erased = body as { meta: { eraseEpoch?: number }; measurements: unknown[] };
    await elsewhere.write(ROADMAP_FILE_NAME, { ...erased, measurements: [], meta: { ...erased.meta, eraseEpoch: (erased.meta.eraseEpoch ?? 0) + 1 } }, version);
    // Another tab logs off (a new log-off id; the device copy, off-file data and backend gone; no event here).
    localStorage.setItem('health_roadmap_log_off_id', 'synthetic-log-off-after');
    await new LocalStorageAdapter().disconnect();
    localStorage.removeItem(BACKEND_KEY);
    if (backend) localStorage.setItem(BACKEND_KEY, backend);
    typeDrafts();
    localStorage.setItem(LPA_CHECK_KEPT_KEY, '{"synthetic":"kept"}');
    localStorage.setItem(MIRROR_KEY, '{"synthetic":"mirror"}');

    later();
    await frozen.refreshFromRemote();

    expect(frozen.eraseIdentity).not.toBe(before); // taken in
    expect(drafts()).toEqual([GUEST_DRAFT, CLOUD_DRAFT]);
    expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).toBe('{"synthetic":"kept"}');
    expect(localStorage.getItem(MIRROR_KEY)).toBe('{"synthetic":"mirror"}');
  });

  it('the tab on the chosen record still clears an erase it takes in', async () => {
    const cloud = new MemoryCloud();
    localStorage.setItem(BACKEND_KEY, 'memory');
    const tab = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    const eraser = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    expect((await eraser.erase()).success).toBe(true);
    typeDrafts();

    later();
    await tab.refreshFromRemote();

    expect(drafts()).toEqual([null, null]);
  });
});

describe('US-11 AC6 — the page\'s clear after its erase', () => {
  it('a clear that throws is reported as upkeep and never stops the page', async () => {
    const { Sentry } = await import('../lib/sentry');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    vi.spyOn(RecordSession.prototype, 'clearOffFileData').mockImplementation(() => { throw new Error('storage gone'); });

    expect(() => store.clearOffFileData()).not.toThrow();

    expect(warn).toHaveBeenCalledWith('Record upkeep failed');
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { area: 'cloud-sync', op: 'clear-off-file' } });
    vi.restoreAllMocks();
  });
});
