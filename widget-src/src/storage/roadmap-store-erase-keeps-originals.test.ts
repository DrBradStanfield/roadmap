/**
 * @vitest-environment jsdom
 *
 * US-11 AC6 with US-09 AC20/AC23: an erase taken in from elsewhere clears
 * this device's stored originals only where no live document still names
 * them. A document the erase never saw, or one added after it, keeps its
 * row, so its original must stay readable. One the erase listed goes, even
 * where a stale device copy still names it. Found by the step 5 reviews
 * (Codex + adversary, 2026-10-21) of the blanket clear O5 first brought in.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME } from '@roadmap/health-core';
import { RoadmapStore, saveRoadmapFileInto } from './roadmap-store';
import { LocalStorageAdapter } from './local-storage-adapter';
import { clearOffFileAfterErase, deleteUserData, initRoadmapStore, setPreEraseHook } from '../lib/roadmap-data';
import { setChatHistoryFactory } from '../lib/chat-history-access';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const DOC_PREFIX = 'health_roadmap_doc_v2:';
const blobKeys = () => Object.keys(localStorage).filter((k) => k.startsWith(DOC_PREFIX));
const pdf = () => new Blob(['%PDF-1.4 lipids'], { type: 'application/pdf' });

async function upload(store: RoadmapStore): Promise<string> {
  const result = await store.bulkSaveDocuments([{
    documentType: 'pathology_report', title: 'Lipids', documentDate: '2026-10-20', contentMd: 'x',
    metadata: {}, sourceFileName: 'lipids.pdf', file: pdf(),
  }]);
  expect(result.saved).toHaveLength(1);
  await store.flush();
  return result.saved[0].fileRef!;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

/** Another device erases the cloud record. jsdom has one localStorage for
 *  every device: the other device runs on an empty one, and this device's
 *  keys go back after. */
async function eraseElsewhere(cloud: MemoryCloud, at: string): Promise<void> {
  const mine = Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)!]));
  localStorage.clear();
  vi.setSystemTime(new Date(at));
  expect((await (await RoadmapStore.create(new MemoryAdapter(cloud))).deleteUserData()).success).toBe(true);
  localStorage.clear();
  for (const [k, v] of Object.entries(mine)) localStorage.setItem(k, v);
}

it('a stale guest tab that takes in the erase keeps an original uploaded after it (US-11 AC6, US-09 AC20)', async () => {
  const a = await RoadmapStore.create(new LocalStorageAdapter());
  a.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
  await a.flush();
  const b = await RoadmapStore.create(new LocalStorageAdapter()); // the stale tab

  vi.setSystemTime(new Date('2026-10-21T10:01:00.000Z'));
  expect((await a.deleteUserData()).success).toBe(true);
  vi.setSystemTime(new Date('2026-10-21T10:02:00.000Z'));
  const ref = await upload(a); // after the erase: its row survives everywhere

  vi.setSystemTime(new Date('2026-10-21T10:03:00.000Z'));
  expect(await b.refreshFromRemote()).toBe(true); // B takes the erase in
  expect(blobKeys()).toEqual([DOC_PREFIX + ref]);

  // ...and a save of B's own keeps it too.
  b.addMeasurement('weight', 81, '2026-10-21T00:00:00.000Z', b.eraseIdentity);
  await b.flush();
  const reread = await RoadmapStore.create(new LocalStorageAdapter());
  expect(reread.loadLatestMeasurements().documents.map((d) => d.fileRef)).toEqual([ref]);
  expect((await reread.readDocumentFile(ref)).size).toBe(pdf().size);
});

it("a cloud page that takes in another device's erase keeps the originals an on-device fallback tab holds (US-11 AC6, US-09 AC23)", async () => {
  const cloud = new MemoryCloud();
  const page = await RoadmapStore.create(new MemoryAdapter(cloud));
  page.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
  await page.flush();
  // A tab of this browser running on the device copy (the cloud could not be
  // read there): its document lives in the device record, which no erase listed.
  const fallback = await RoadmapStore.create(new LocalStorageAdapter());
  const ref = await upload(fallback);

  await eraseElsewhere(cloud, '2026-10-21T10:01:00.000Z');

  vi.setSystemTime(new Date('2026-10-21T10:02:00.000Z'));
  expect(await page.refreshFromRemote()).toBe(true);
  expect(blobKeys()).toEqual([DOC_PREFIX + ref]);
  expect((await fallback.readDocumentFile(ref)).size).toBe(pdf().size);
});

it('a stored original no live document names still goes (US-11 AC6)', async () => {
  const cloud = new MemoryCloud();
  const page = await RoadmapStore.create(new MemoryAdapter(cloud));
  page.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
  await page.flush();
  localStorage.setItem(`${DOC_PREFIX}orphan.pdf`, 'data:application/pdf;base64,AAAA');
  await eraseElsewhere(cloud, '2026-10-21T10:01:00.000Z');

  vi.setSystemTime(new Date('2026-10-21T10:02:00.000Z'));
  expect(await page.refreshFromRemote()).toBe(true);
  expect(blobKeys()).toEqual([]);
});

it('an original the erase listed goes, though a stale device copy still names it (US-11 AC6, US-09 AC23)', async () => {
  // A guest uploads, then connects: the lift carries the document up.
  const guest = await RoadmapStore.create(new LocalStorageAdapter());
  await upload(guest);
  const cloud = new MemoryCloud();
  await saveRoadmapFileInto(new MemoryAdapter(cloud), (await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body);
  const page = await RoadmapStore.create(new MemoryAdapter(cloud));
  expect(page.loadLatestMeasurements().documents).toHaveLength(1);

  await eraseElsewhere(cloud, '2026-10-21T10:01:00.000Z'); // lists the lifted document
  vi.setSystemTime(new Date('2026-10-21T10:02:00.000Z'));
  expect(await page.refreshFromRemote()).toBe(true);
  expect(page.loadLatestMeasurements().documents).toEqual([]);
  expect(blobKeys()).toEqual([]);
});

it('a device record that cannot be read names no original (US-11 AC6)', async () => {
  const cloud = new MemoryCloud();
  const page = await RoadmapStore.create(new MemoryAdapter(cloud));
  page.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
  await page.flush();
  localStorage.setItem(`${DOC_PREFIX}erased.pdf`, 'data:application/pdf;base64,AAAA');
  await eraseElsewhere(cloud, '2026-10-21T10:01:00.000Z');
  localStorage.setItem('health_roadmap_file_v2', '{broken');
  vi.setSystemTime(new Date('2026-10-21T10:02:00.000Z'));
  expect(await page.refreshFromRemote()).toBe(true);
  expect(blobKeys()).toEqual([]);
});

it("the page's erase keeps the original another tab saved while it ran, and removes the erased one (US-11 AC6, US-09 AC23)", async () => {
  // The erasing page, through the data layer HealthTool uses.
  const erasing = new LocalStorageAdapter();
  await initRoadmapStore(erasing);
  setChatHistoryFactory(null);
  const own = await RoadmapStore.create(new LocalStorageAdapter());
  const erasedRef = await upload(own); // before the erase: listed by it
  const otherTab = await RoadmapStore.create(new LocalStorageAdapter());
  let savedRef = '';
  // Saved by the other tab after the erase read the record: no erase lists it.
  setPreEraseHook(async () => {
    vi.setSystemTime(new Date('2026-10-21T10:01:00.000Z'));
    otherTab.addMeasurement('weight', 79, '2026-10-21T00:00:00.000Z');
    const result = await otherTab.bulkSaveDocuments([{
      documentType: 'pathology_report', title: 'Thyroid', documentDate: '2026-10-21', contentMd: 'y',
      metadata: {}, sourceFileName: 'thyroid.pdf', file: new Blob(['%PDF-1.4 thyroid'], { type: 'application/pdf' }),
    }]);
    await otherTab.flush();
    savedRef = result.saved[0].fileRef!;
  });
  vi.setSystemTime(new Date('2026-10-21T10:00:30.000Z'));
  expect((await deleteUserData()).success).toBe(true);
  clearOffFileAfterErase(); // what HealthTool runs next
  expect(savedRef).not.toBe('');
  expect(blobKeys()).toEqual([DOC_PREFIX + savedRef]);
  expect(blobKeys()).not.toContain(DOC_PREFIX + erasedRef);
  const reread = await RoadmapStore.create(new LocalStorageAdapter());
  expect(reread.loadLatestMeasurements().documents.map((d) => d.fileRef)).toEqual([savedRef]);
  expect((await reread.readDocumentFile(savedRef)).size).toBeGreaterThan(0);
  setPreEraseHook(async () => {});
});
