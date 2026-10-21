// US-14 AC4. Based on Austin Bell's PR #164 (robertaustinbell). Synthetic bytes only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAB_ARCHIVE_TITLE, ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from './index';
import { LAB_ARCHIVE_FLAG, sha256Blob, unarchivedOriginals } from '../lib/archive-payloads';
import type { FileResult } from '../components/ReviewTable';
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
    const result = await store.bulkSaveDocuments([doc, doc]);
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
    const original = (await first.bulkSaveDocuments([doc])).saved[0];
    await first.flush();
    const retry = await RoadmapStore.create(new MemoryAdapter(cloud));
    const result = await retry.bulkSaveDocuments([doc]);
    await retry.flush();
    const file = read(cloud);
    expect(result.saved).toHaveLength(1);
    expect(file.documents.find(d => d.id === original.id)?.deleted).toBe(true);
    expect(file.documents.filter(d => !d.deleted)).toHaveLength(1);
    expect(file.documents.find(d => !d.deleted)?.fileRef).toBeTruthy();
    expect((await retry.bulkSaveDocuments([doc])).saved).toHaveLength(0);
  });
  it('a retry that fails again leaves the first metadata row intact and reports the failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const store = await RoadmapStore.create(adapter);
    const doc = payload();
    const original = (await store.bulkSaveDocuments([doc])).saved[0];
    await store.flush();
    const result = await store.bulkSaveDocuments([doc]);
    await store.flush();
    expect(result).toEqual({ saved: [], errorCount: 1 });
    expect(read(cloud).documents.filter(d => !d.deleted).map(d => d.id)).toEqual([original.id]);
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
  const original = (await store.bulkSaveDocuments([first])).saved[0];
  await store.flush();
  const retry = await RoadmapStore.create(new MemoryAdapter(cloud));
  const saved = (await retry.bulkSaveDocuments([second])).saved;
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
  it('the review offers its bytes again, as it does a connector row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new MemoryAdapter(new MemoryCloud());
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const store = await RoadmapStore.create(adapter);
    const doc = payload();
    const row = (await store.bulkSaveDocuments([doc])).saved[0];
    const letter: FileResult = { fileName: doc.sourceFileName, reportDate: null, values: [], additionalValues: [], file: doc.file,
      contentHash: await sha256Blob(doc.file),
      document: { classification: 'clinic_letter', title: doc.title, documentDate: doc.documentDate, contentMarkdown: doc.contentMd, metadata: {} } };
    expect(unarchivedOriginals([letter], [row], new Set())).toEqual([letter]);
  });

  it('bytes held only by a failed lab-archive row never file a deselected letter', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new MemoryAdapter(new MemoryCloud());
    adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
    const store = await RoadmapStore.create(adapter);
    const lab = labPayload();
    const row = (await store.bulkSaveDocuments([lab])).saved[0];
    const letter: FileResult = { fileName: lab.sourceFileName, reportDate: null, values: [], additionalValues: [], file: lab.file,
      contentHash: await sha256Blob(lab.file),
      document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: null, contentMarkdown: 'Synthetic note', metadata: {} } };
    expect(unarchivedOriginals([letter], [row], new Set())).toEqual([]);
  });
});
