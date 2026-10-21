/**
 * @vitest-environment jsdom
 *
 * US-11 AC6 with US-09 AC20/AC23: an erase taken in from elsewhere clears
 * this device's stored originals only where no live document still names
 * them. A document the erase never saw, or one added after it, keeps its
 * row, so its original must stay readable. Found by the step 5 review
 * (Codex + adversary, 2026-10-21) of the blanket clear O5 first brought in.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';
import { LocalStorageAdapter } from './local-storage-adapter';

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

  // Another device erases the cloud record. jsdom has one localStorage for
  // every device: put this device's back after the other device's wipe.
  const mine = Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)!]));
  vi.setSystemTime(new Date('2026-10-21T10:01:00.000Z'));
  expect((await (await RoadmapStore.create(new MemoryAdapter(cloud))).deleteUserData()).success).toBe(true);
  localStorage.clear();
  for (const [k, v] of Object.entries(mine)) localStorage.setItem(k, v);

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
  const mine = Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)!]));
  vi.setSystemTime(new Date('2026-10-21T10:01:00.000Z'));
  expect((await (await RoadmapStore.create(new MemoryAdapter(cloud))).deleteUserData()).success).toBe(true);
  localStorage.clear();
  for (const [k, v] of Object.entries(mine)) localStorage.setItem(k, v);

  vi.setSystemTime(new Date('2026-10-21T10:02:00.000Z'));
  expect(await page.refreshFromRemote()).toBe(true);
  expect(blobKeys()).toEqual([]);
});
