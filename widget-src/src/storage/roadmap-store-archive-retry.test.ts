import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from './index';
import { sha256Blob } from '../lib/archive-payloads';
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());
const payload = () => ({
  documentType: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-01-01',
  contentMd: 'Synthetic note', metadata: {}, sourceFileName: 'synthetic.pdf',
  file: new Blob(['synthetic file bytes'], { type: 'application/pdf' }),
});
const read = (cloud: MemoryCloud) => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
describe('US-35 AC6b: a failed original retains its dedup identity', () => {
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
