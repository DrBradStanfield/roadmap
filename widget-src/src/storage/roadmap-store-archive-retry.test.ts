// US-14 AC4. Based on Austin Bell's PR #164 (robertaustinbell). Synthetic bytes only. Through the upload's one Save
// (storage/upload-save-store.ts), the path a person's upload takes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAB_ARCHIVE_FLAG } from '@roadmap/health-core/document-rows';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from './index';
import { sha256Blob } from '../lib/archive-payloads';
import { uploadThrough, type Picked } from '../testing/upload-save-kit';
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());
const payload = () => ({
  documentType: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-01-01',
  contentMd: 'Synthetic note', metadata: {}, sourceFileName: 'synthetic.pdf',
  file: new Blob(['synthetic file bytes'], { type: 'application/pdf' }),
});
const read = (cloud: MemoryCloud) => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
/** The record's live document rows. */
const live = (store: RoadmapStore) => store.file.documents.filter((d) => !d.deleted);
describe('US-14 AC4: a failed original retains its dedup identity', () => {
  it('keeps the computed hash on one metadata-only row for duplicate inputs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = vi.fn(async () => { throw new Error('synthetic quota refusal'); });
    const store = await RoadmapStore.create(adapter);
    const doc = payload();
    const hash = await sha256Blob(doc.file);
    const result = await uploadThrough(store, [doc, doc]);
    await store.flush();
    expect(adapter.writeDocument).toHaveBeenCalledTimes(1);
    expect(live(store)).toHaveLength(1);
    expect(live(store)[0]).toMatchObject({ fileRef: '', contentHash: hash });
    // US-14 AC12: a first failure, with no row held, is counted too, so the done screen says so.
    expect(result).toMatchObject({ ok: true, outcome: { unstored: 1 } });
    expect(read(cloud).documents).toHaveLength(1);
  });
  it('a later successful retry tombstones the metadata-only row, including after reload', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const first = await RoadmapStore.create(adapter);
    const doc = payload();
    await uploadThrough(first, [doc]);
    const original = live(first)[0];
    await first.flush();
    const retry = await RoadmapStore.create(new MemoryAdapter(cloud));
    const result = await uploadThrough(retry, [doc]);
    await retry.flush();
    const file = read(cloud);
    expect(result).toMatchObject({ ok: true, outcome: { documents: 1, unstored: 0 } });
    expect(file.documents.find(d => d.id === original.id)?.deleted).toBe(true);
    expect(file.documents.filter(d => !d.deleted)).toHaveLength(1);
    expect(file.documents.find(d => !d.deleted)?.fileRef).toBeTruthy();
    expect(await uploadThrough(retry, [doc])).toMatchObject({ ok: true, outcome: { documents: 0 } });
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
    await uploadThrough(store, [doc]);
    const original = live(store)[0];
    await store.flush();
    const result = await uploadThrough(store, [doc]);
    await store.flush();
    expect(result).toMatchObject({ ok: true, outcome: { documents: 0, unstored: 1 } });
    expect(read(cloud).documents.filter(d => !d.deleted).map(d => d.id)).toEqual([original.id]);
  });

  it('a retry that fails again with a reviewed title or date files a new row with them and replaces the held one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const store = await RoadmapStore.create(adapter);
    await uploadThrough(store, [payload()]);
    const original = live(store)[0];
    await store.flush();
    for (const change of [{ title: 'Reviewed title' }, { documentDate: '2025-02-03' }]) {
      const result = await uploadThrough(store, [{ ...payload(), ...change }]);
      await store.flush();
      expect(result).toMatchObject({ ok: true, outcome: { documents: 1, unstored: 1 } });
      expect(live(store)).toEqual([expect.objectContaining({ fileRef: '', contentHash: original.contentHash, ...('title' in change ? { title: change.title } : { date: change.documentDate }) })]);
    }
    const rows = read(cloud).documents.filter(d => !d.deleted);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Synthetic letter', date: '2025-02-03', contentHash: original.contentHash, fileRef: '' });
  });

  it('a repeat failure behind a connector row settles the same way, whatever its metadata says', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const store = await RoadmapStore.create(adapter);
    const doc = { ...payload(), metadata: { importedVia: 'connector' } };
    await uploadThrough(store, [doc]);
    await store.flush();
    expect(await uploadThrough(store, [payload()])).toMatchObject({ ok: true, outcome: { documents: 0, unstored: 1 } });
  });

  it('a row of the same bytes merged in during the upload is replaced too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const failing = new MemoryAdapter(cloud);
    failing.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const first = await RoadmapStore.create(failing);
    await uploadThrough(first, [payload()]);
    const original = live(first)[0];
    await first.flush();
    const adapter = new MemoryAdapter(cloud);
    const retry = await RoadmapStore.create(adapter);
    const write = adapter.writeDocument.bind(adapter);
    adapter.writeDocument = async (ref, file) => {
      // Another device's same-hash row, folded in while the blob uploads.
      retry['session'].edit(f => { f.documents.push({ ...f.documents.find(d => d.id === original.id)!, id: 'merged-in' }); }, retry['session'].shownErase);
      return write(ref, file);
    };
    expect(await uploadThrough(retry, [payload()])).toMatchObject({ ok: true, outcome: { documents: 1, unstored: 0 } });
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
    await uploadThrough(first, [payload()]);
    const original = live(first)[0];
    await first.flush();
    // A second such row, as another device's failed save would leave.
    const stored = cloud.files.get(ROADMAP_FILE_NAME)!;
    const file = JSON.parse(stored.json) as RoadmapFile;
    file.documents.push({ ...file.documents[0], id: 'other-device', addedAt: '2020-01-01T00:00:00.000Z' });
    cloud.files.set(ROADMAP_FILE_NAME, { ...stored, json: JSON.stringify(file) });
    const retry = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(await uploadThrough(retry, [payload()])).toMatchObject({ ok: true, outcome: { documents: 1, unstored: 0 } });
    await retry.flush();
    const after = read(cloud).documents;
    expect(after.filter(d => d.deleted).map(d => d.id).sort()).toEqual([original.id, 'other-device'].sort());
    expect(after.filter(d => !d.deleted)).toHaveLength(1);
  });
});

// US-14 AC4 (Brad, 2026-10-19): a re-upload supersedes a failed row only of
// its own kind. `deleted` is OR-ed on merge, so a wrong tombstone is permanent.
/** The same bytes read as a lab report: its value, and the report's hidden archive row with the original. */
const labPayload = (): Picked => ({ report: 'synthetic.pdf', reportDate: '2026-01-01', file: payload().file, values: [{ name: 'sodium', value: 140, unit: 'mmol/L' }] });
/** A row of the kind `picked` files: the report's archive row, or the letter. */
const isArchive = (d: RoadmapFile['documents'][number]) => d.metadata?.[LAB_ARCHIVE_FLAG] === true;
async function failedThenRetried(first: Picked, second: Picked) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const cloud = new MemoryCloud();
  const failing = new MemoryAdapter(cloud);
  failing.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
  const store = await RoadmapStore.create(failing);
  await uploadThrough(store, [first]);
  const original = live(store)[0];
  await store.flush();
  const retry = await RoadmapStore.create(new MemoryAdapter(cloud));
  const before = new Set(retry.file.documents.map((d) => d.id));
  await uploadThrough(retry, [second]);
  const saved = retry.file.documents.filter((d) => !before.has(d.id) && !d.deleted);
  await retry.flush();
  return { original, saved, documents: read(cloud).documents };
}
describe('US-14 AC4: a re-upload replaces a failed row only of its own kind', () => {
  it('a letter whose blob failed stays when the same bytes come back read as a lab report', async () => {
    const { original, saved, documents } = await failedThenRetried(payload(), labPayload());
    expect(saved).toHaveLength(1);
    expect(isArchive(saved[0])).toBe(true);
    expect(documents.find(d => d.id === original.id)?.deleted).toBeFalsy();
    expect(documents.find(d => d.id === saved[0].id)?.fileRef).toBeTruthy();
  });
  it('a lab report whose blob failed stays when the same bytes come back read as a letter', async () => {
    const { original, saved, documents } = await failedThenRetried(labPayload(), payload());
    expect(isArchive(original)).toBe(true);
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
