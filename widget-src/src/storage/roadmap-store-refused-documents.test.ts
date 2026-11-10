/**
 * @vitest-environment jsdom
 *
 * US-11 AC1a: a document upload whose save is refused leaves no copy on the
 * device. The store writes each original before its gated commit; when that
 * commit is refused (here, the store took in another tab's erase while the
 * upload ran), the device-tier originals this save wrote go too. An original
 * a live row still names stays.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoadmapStore } from './roadmap-store';
import { LocalStorageAdapter } from './local-storage-adapter';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const DOC_PREFIX = 'health_roadmap_doc_v2:';
const blobKeys = () => Object.keys(localStorage).filter((k) => k.startsWith(DOC_PREFIX));
const pdf = () => new Blob(['%PDF-1.4 synthetic'], { type: 'application/pdf' });
const upload = (name: string) => [{
  documentType: 'pathology_report', title: name, documentDate: '2026-11-01', contentMd: 'Synthetic fixture',
  metadata: {}, sourceFileName: `${name}.pdf`, file: pdf(),
}];

/** The device tier, its blob writes held at the door until released. */
class HeldBlobs extends LocalStorageAdapter {
  private gate: Promise<void> | null = null;
  private entered: () => void = () => {};
  hold() {
    let release!: () => void;
    this.gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { this.entered = r; });
    return { reached, release };
  }
  async writeDocument(ref: string, bytes: Blob) {
    if (this.gate) { this.entered(); await this.gate; }
    return super.writeDocument(ref, bytes);
  }
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

/** Two tabs on the device tier with a record; `page` uploads through a held adapter. */
async function twoTabs() {
  const other = await RoadmapStore.create(new LocalStorageAdapter());
  other.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
  await other.flush();
  const adapter = new HeldBlobs();
  const page = await RoadmapStore.create(adapter);
  return { other, adapter, page };
}

it('a refused document save leaves no copy on the device (US-11 AC1a)', async () => {
  const { other, adapter, page } = await twoTabs();
  const held = adapter.hold();
  const pending = page.bulkSaveDocuments(upload('Lipids'));
  await held.reached;
  vi.setSystemTime(new Date('2026-11-10T10:01:00.000Z'));
  expect((await other.deleteAllData()).success).toBe(true);
  expect(await page.refreshFromRemote()).toBe(true); // takes the erase in, wipes the blobs
  held.release(); // the blob lands after the wipe
  expect(await pending).toEqual({ saved: [], errorCount: 1 });
  expect(blobKeys()).toEqual([]);
});

it('an accepted document save keeps its original (US-11 AC1a)', async () => {
  const { page } = await twoTabs();
  const { saved } = await page.bulkSaveDocuments(upload('Lipids'));
  expect(saved).toHaveLength(1);
  await page.flush();
  expect(blobKeys()).toEqual([DOC_PREFIX + saved[0].fileRef]);
});

it('a refused document save keeps an original a live row still names (US-11 AC1a)', async () => {
  const { other, adapter, page } = await twoTabs();
  const held = adapter.hold();
  const pending = page.bulkSaveDocuments(upload('Lipids'));
  await held.reached;
  vi.setSystemTime(new Date('2026-11-10T10:01:00.000Z'));
  expect((await other.deleteAllData()).success).toBe(true);
  // After the erase the other tab uploads the same letter: same name, same ref.
  vi.setSystemTime(new Date('2026-11-10T10:02:00.000Z'));
  const { saved } = await other.bulkSaveDocuments(upload('Lipids'));
  await other.flush();
  const ref = saved[0].fileRef!;
  expect(await page.refreshFromRemote()).toBe(true);
  held.release();
  expect(await pending).toEqual({ saved: [], errorCount: 1 });
  expect(blobKeys()).toEqual([DOC_PREFIX + ref]);
  const reread = await RoadmapStore.create(new LocalStorageAdapter());
  expect((await reread.readDocumentFile(ref)).size).toBe(pdf().size);
});
