/**
 * @vitest-environment jsdom
 *
 * US-11 AC1a: a document upload whose erase has moved before its file is
 * written writes no copy on the device. The store checks the save's erase
 * before each file write. A write already in progress when the erase lands
 * may leave a device-only copy, which the next erase removes: the stated limit.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoadmapStore } from './roadmap-store';
import { LocalStorageAdapter } from './local-storage-adapter';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

/** Holds every hash until released, so an erase can land before any write starts. */
const hashGate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
vi.mock('../lib/archive-payloads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/archive-payloads')>();
  return { ...actual, sha256Blob: async (b: Blob) => { await hashGate.wait; return actual.sha256Blob(b); } };
});

const DOC_PREFIX = 'health_roadmap_doc_v2:';
const blobKeys = () => Object.keys(localStorage).filter((k) => k.startsWith(DOC_PREFIX));
const pdf = (text: string) => new Blob([`%PDF-1.4 ${text}`], { type: 'application/pdf' });
const doc = (name: string) => ({
  documentType: 'pathology_report', title: name, documentDate: '2026-11-01', contentMd: 'Synthetic fixture',
  metadata: {}, sourceFileName: `${name}.pdf`, file: pdf(name),
});

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
    const gate = this.gate;
    this.gate = null; // only the first write is held
    if (gate) { this.entered(); await gate; }
    return super.writeDocument(ref, bytes);
  }
}

beforeEach(() => {
  localStorage.clear();
  hashGate.wait = null;
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

/** The other tab erases and this tab takes the erase in. */
async function eraseLands(other: RoadmapStore, page: RoadmapStore) {
  vi.setSystemTime(new Date('2026-11-10T10:01:00.000Z'));
  expect((await other.deleteAllData()).success).toBe(true);
  expect(await page.refreshFromRemote()).toBe(true);
}

it('a document save whose erase has already moved writes no copy on the device (US-11 AC1a)', async () => {
  const { other, page } = await twoTabs();
  let release!: () => void;
  hashGate.wait = new Promise<void>((r) => { release = r; });
  const pending = page.bulkSaveDocuments([doc('Lipids')]);
  await eraseLands(other, page);
  release();
  expect(await pending).toEqual({ saved: [], errorCount: 1 });
  expect(blobKeys()).toEqual([]);
});

it('an accepted document save keeps its original (US-11 AC1a)', async () => {
  const { page } = await twoTabs();
  const { saved } = await page.bulkSaveDocuments([doc('Lipids')]);
  expect(saved).toHaveLength(1);
  await page.flush();
  expect(blobKeys()).toEqual([DOC_PREFIX + saved[0].fileRef]);
});

it('stated limit: a file write already in progress when the erase lands may leave a device copy; the writes after it never happen (US-11 AC1a)', async () => {
  const { other, adapter, page } = await twoTabs();
  const held = adapter.hold();
  const pending = page.bulkSaveDocuments([doc('Lipids'), doc('Thyroid')]); // one folder: the first write runs alone
  await held.reached;
  await eraseLands(other, page);
  held.release();
  expect(await pending).toEqual({ saved: [], errorCount: 2 });
  expect(blobKeys()).toEqual([`${DOC_PREFIX}Lab results/2026-11-01 Lipids.pdf`]);
});
