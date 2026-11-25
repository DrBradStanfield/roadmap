/**
 * @vitest-environment jsdom
 *
 * US-11 AC1a: a document upload whose erase has moved before its file is
 * written writes no copy on the device. The upload's Save (the shipped path,
 * storage/upload-save-store.ts) checks the save's erase before each file write. A write already in progress when the erase lands
 * may leave a device-only copy, which a later erase, once the record holds
 * data again, removes: the stated limit.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoadmapStore } from './roadmap-store';
import { LocalStorageAdapter } from './local-storage-adapter';
import { Sentry } from '../lib/sentry';
import { WritesStoppedError } from '../lib/error-diagnostics';
import { StorageError } from '@roadmap/health-core/adapter';
import { ENGINE, pickOf, stamped, uploadThrough } from '../testing/upload-save-kit';
import { WRITES_STOPPED_CASES } from '../testing/writes-stopped-cases';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

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
  vi.clearAllMocks();
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
  other.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z', other.shownErase);
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
  // The Save begins before the erase, which lands once it runs, before its first file write: the check before
  // each write refuses it.
  let reached!: () => void;
  const began = new Promise<void>((r) => { reached = r; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const engine: typeof ENGINE = { ...ENGINE, uploadSave: async (...args) => { reached(); await gate; return ENGINE.uploadSave(...args); } };
  const now = new Date().toISOString();
  const { s, io } = await pickOf(page.file, [doc('Lipids')], { now });
  const pending = page.saveUpload(engine, stamped(s, page.shownErase), now, true, io);
  await began;
  await eraseLands(other, page);
  release();
  expect(await pending).toMatchObject({ ok: false, reason: 'erased' });
  expect(blobKeys()).toEqual([]);
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

it('an accepted document save keeps its original (US-11 AC1a)', async () => {
  const { page } = await twoTabs();
  expect(await uploadThrough(page, [doc('Lipids')])).toMatchObject({ ok: true, outcome: { documents: 1, unstored: 0 } });
  await page.flush();
  const saved = page.file.documents.filter((d) => !d.deleted);
  expect(saved).toHaveLength(1);
  expect(blobKeys()).toEqual([DOC_PREFIX + saved[0].fileRef]);
});

it('stated limit: a file write already in progress when the erase lands may leave a device copy; the writes after it never happen (US-11 AC1a)', async () => {
  const { other, adapter, page } = await twoTabs();
  const held = adapter.hold();
  const pending = uploadThrough(page, [doc('Lipids'), doc('Thyroid')]); // one folder: the first write runs alone
  await held.reached;
  await eraseLands(other, page);
  held.release();
  expect(await pending).toMatchObject({ ok: false, reason: 'erased' });
  expect(page.file.documents).toEqual([]);
  expect(blobKeys()).toEqual([`${DOC_PREFIX}Lab results/2026-11-01 Lipids.pdf`]);
  expect(Sentry.captureException).not.toHaveBeenCalled();
  // A later erase, once the record holds data again, removes that copy.
  vi.setSystemTime(new Date('2026-11-10T10:02:00.000Z'));
  page.addMeasurement('weight', 81, '2026-11-10T00:00:00.000Z', page.eraseIdentity);
  await page.flush();
  expect((await page.deleteAllData()).success).toBe(true);
  expect(blobKeys()).toEqual([]);
});

/** The device tier, its blob writes refused with one given error. */
class RefusingBlobs extends LocalStorageAdapter {
  constructor(private readonly refusal: Error) { super(); }
  async writeDocument(): Promise<void> { throw this.refusal; }
}

it('A15: a document write the device refuses after log-off is not reported', async () => {
  const page = await RoadmapStore.create(new RefusingBlobs(new WritesStoppedError()));
  expect(await uploadThrough(page, [doc('Lipids')])).toMatchObject({ ok: true, outcome: { documents: 1, unstored: 1 } });
  const saved = page.file.documents.filter((d) => !d.deleted);
  expect(saved).toHaveLength(1);
  expect(saved[0].fileRef).toBe(''); // metadata kept, file not stored
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

it.each(WRITES_STOPPED_CASES)('US-09 AC59: a document write refused with $name reports $reports time(s)', async ({ error, reports }) => {
  const page = await RoadmapStore.create(new RefusingBlobs(error()));
  expect(await uploadThrough(page, [doc('Lipids')])).toMatchObject({ ok: true, outcome: { documents: 1, unstored: 1 } });
  expect(Sentry.captureException).toHaveBeenCalledTimes(reports);
});

it('A15: a real document write failure (storage full) is still reported once', async () => {
  const page = await RoadmapStore.create(new RefusingBlobs(new StorageError('Synthetic storage full', undefined, undefined, undefined, undefined, 'refused')));
  await uploadThrough(page, [doc('Lipids')]);
  expect(Sentry.captureException).toHaveBeenCalledOnce();
  expect(vi.mocked(Sentry.captureException).mock.calls[0][0]).toMatchObject({ message: 'Document file not stored' });
});
