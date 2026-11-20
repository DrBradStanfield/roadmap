// US-14 AC4. Based on Austin Bell's PR #164 (robertaustinbell). Synthetic bytes only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAB_ARCHIVE_FLAG } from '@roadmap/health-core/document-rows';
import { LAB_ARCHIVE_TITLE } from '@roadmap/health-core/document-path';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from './index';
import { knownAs, knownIndex } from '@roadmap/health-core/upload-known';
import { sha256Blob } from '../lib/archive-payloads';
import { seedStoreDocuments } from '../testing/record-seed';
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());
const payload = () => ({
  documentType: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-01-01',
  contentMd: 'Synthetic note', metadata: {}, sourceFileName: 'synthetic.pdf',
  file: new Blob(['synthetic file bytes'], { type: 'application/pdf' }),
});
const read = (cloud: MemoryCloud) => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
describe('US-14 AC4: a failed original retains its dedup identity', () => {
  it('keeps the computed hash on one metadata-only row for duplicate inputs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = vi.fn(async () => { throw new Error('synthetic quota refusal'); });
    const store = await RoadmapStore.create(adapter);
    const doc = payload();
    const hash = await sha256Blob(doc.file);
    const result = await seedStoreDocuments(store, [doc, doc]);
    await store.flush();
    expect(adapter.writeDocument).toHaveBeenCalledTimes(1);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0]).toMatchObject({ fileRef: null, contentHash: hash });
    expect(read(cloud).documents).toHaveLength(1);
  });
  it('a later successful retry tombstones the metadata-only row, including after reload', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const first = await RoadmapStore.create(adapter);
    const doc = payload();
    const original = (await seedStoreDocuments(first, [doc])).saved[0];
    await first.flush();
    const retry = await RoadmapStore.create(new MemoryAdapter(cloud));
    const result = await seedStoreDocuments(retry, [doc]);
    await retry.flush();
    const file = read(cloud);
    expect(result.saved).toHaveLength(1);
    expect(file.documents.find(d => d.id === original.id)?.deleted).toBe(true);
    expect(file.documents.filter(d => !d.deleted)).toHaveLength(1);
    expect(file.documents.find(d => !d.deleted)?.fileRef).toBeTruthy();
    expect((await seedStoreDocuments(retry, [doc])).saved).toHaveLength(0);
  });
  // An original that can never be stored (a size cap) must not trap the user
  // in "Failed to save": a repeat failure is settled, no error, and `unstored`
  // tells the done screen to say so.
  it('a retry that fails again, details unchanged, leaves the first row intact: settled, counted unstored', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const store = await RoadmapStore.create(adapter);
    const doc = payload();
    const original = (await seedStoreDocuments(store, [doc])).saved[0];
    await store.flush();
    const result = await seedStoreDocuments(store, [doc]);
    await store.flush();
    expect(result).toEqual({ saved: [], errorCount: 0, unstored: 1 });
    expect(read(cloud).documents.filter(d => !d.deleted).map(d => d.id)).toEqual([original.id]);
  });

  it('a retry that fails again with a reviewed title or date files a new row with them and replaces the held one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const store = await RoadmapStore.create(adapter);
    const original = (await seedStoreDocuments(store, [payload()])).saved[0];
    await store.flush();
    for (const change of [{ title: 'Reviewed title' }, { documentDate: '2025-02-03' }]) {
      const result = await seedStoreDocuments(store, [{ ...payload(), ...change }]);
      await store.flush();
      expect(result).toMatchObject({ errorCount: 0, unstored: 1, saved: [expect.objectContaining({ fileRef: null, contentHash: original.contentHash })] });
    }
    const live = read(cloud).documents.filter(d => !d.deleted);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ title: 'Synthetic letter', date: '2025-02-03', contentHash: original.contentHash, fileRef: '' });
  });

  it('a repeat failure behind a connector row settles the same way, whatever its metadata says', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const store = await RoadmapStore.create(adapter);
    const doc = { ...payload(), metadata: { importedVia: 'connector' } };
    await seedStoreDocuments(store, [doc]);
    await store.flush();
    expect(await seedStoreDocuments(store, [payload()])).toEqual({ saved: [], errorCount: 0, unstored: 1 });
  });

  it('a row of the same bytes merged in during the upload is replaced too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const failing = new MemoryAdapter(cloud);
    failing.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const first = await RoadmapStore.create(failing);
    const original = (await seedStoreDocuments(first, [payload()])).saved[0];
    await first.flush();
    const adapter = new MemoryAdapter(cloud);
    const retry = await RoadmapStore.create(adapter);
    const write = adapter.writeDocument.bind(adapter);
    adapter.writeDocument = async (ref, file) => {
      // Another device's same-hash row, folded in while the blob uploads.
      retry['session'].edit(f => { f.documents.push({ ...f.documents.find(d => d.id === original.id)!, id: 'merged-in' }); });
      return write(ref, file);
    };
    expect((await seedStoreDocuments(retry, [payload()])).saved).toHaveLength(1);
    await retry.flush();
    const after = read(cloud).documents;
    expect(after.filter(d => d.deleted).map(d => d.id).sort()).toEqual([original.id, 'merged-in'].sort());
  });

  it('a stored blob supersedes every metadata-only row of its kind for those bytes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const failing = new MemoryAdapter(cloud);
    failing.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const first = await RoadmapStore.create(failing);
    const original = (await seedStoreDocuments(first, [payload()])).saved[0];
    await first.flush();
    // A second such row, as another device's failed save would leave.
    const stored = cloud.files.get(ROADMAP_FILE_NAME)!;
    const file = JSON.parse(stored.json) as RoadmapFile;
    file.documents.push({ ...file.documents[0], id: 'other-device', addedAt: '2020-01-01T00:00:00.000Z' });
    cloud.files.set(ROADMAP_FILE_NAME, { ...stored, json: JSON.stringify(file) });
    const retry = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect((await seedStoreDocuments(retry, [payload()])).saved).toHaveLength(1);
    await retry.flush();
    const after = read(cloud).documents;
    expect(after.filter(d => d.deleted).map(d => d.id).sort()).toEqual([original.id, 'other-device'].sort());
    expect(after.filter(d => !d.deleted)).toHaveLength(1);
  });
});

// US-14 AC4 (Brad, 2026-10-19): a re-upload supersedes a failed row only of
// its own kind. `deleted` is OR-ed on merge, so a wrong tombstone is permanent.
const labPayload = () => ({ ...payload(), documentType: 'pathology_report', title: LAB_ARCHIVE_TITLE, contentMd: '', metadata: { [LAB_ARCHIVE_FLAG]: true } });
async function failedThenRetried(first: ReturnType<typeof payload>, second: ReturnType<typeof payload>) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const cloud = new MemoryCloud();
  const failing = new MemoryAdapter(cloud);
  failing.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
  const store = await RoadmapStore.create(failing);
  const original = (await seedStoreDocuments(store, [first])).saved[0];
  await store.flush();
  const retry = await RoadmapStore.create(new MemoryAdapter(cloud));
  const saved = (await seedStoreDocuments(retry, [second])).saved;
  await retry.flush();
  return { original, saved, documents: read(cloud).documents };
}
describe('US-14 AC4: a re-upload replaces a failed row only of its own kind', () => {
  it('a letter whose blob failed stays when the same bytes come back read as a lab report', async () => {
    const { original, saved, documents } = await failedThenRetried(payload(), labPayload());
    expect(saved).toHaveLength(1);
    expect(documents.find(d => d.id === original.id)?.deleted).toBeFalsy();
    expect(documents.find(d => d.id === saved[0].id)?.fileRef).toBeTruthy();
  });
  it('a lab report whose blob failed stays when the same bytes come back read as a letter', async () => {
    const { original, saved, documents } = await failedThenRetried(labPayload(), payload());
    expect(saved).toHaveLength(1);
    expect(documents.find(d => d.id === original.id)?.deleted).toBeFalsy();
  });
  it('a lab report replaces a lab report, and a letter re-read under another type replaces the letter', async () => {
    const labs = await failedThenRetried(labPayload(), labPayload());
    expect(labs.documents.find(d => d.id === labs.original.id)?.deleted).toBe(true);
    const letters = await failedThenRetried(payload(), { ...payload(), documentType: 'discharge_summary' });
    expect(letters.documents.find(d => d.id === letters.original.id)?.deleted).toBe(true);
  });
});

describe('US-14 AC4: a failed website row is a pending original', () => {
  // Design PR 10: the upload knows these bytes before reading them, and its Save files the original unread behind the row.
  it('a new upload of its bytes is known as a document still waiting for its original', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new MemoryAdapter(new MemoryCloud());
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const store = await RoadmapStore.create(adapter);
    const doc = payload();
    await seedStoreDocuments(store, [doc]);
    expect(knownAs(knownIndex(store.file), await sha256Blob(doc.file))).toEqual({ as: 'document', archiveOnly: true });
  });

  // Ruling Q6: a lab report is known only while one of the rows it wrote is active; this one wrote none, so its bytes are read again.
  it('bytes held only by a failed lab-archive row that lists no live value are not known: the upload reads them again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new MemoryAdapter(new MemoryCloud());
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const store = await RoadmapStore.create(adapter);
    const lab = labPayload();
    await seedStoreDocuments(store, [lab]);
    expect(knownAs(knownIndex(store.file), await sha256Blob(lab.file))).toBeNull();
  });
});
