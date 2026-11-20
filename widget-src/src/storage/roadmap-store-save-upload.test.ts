// @vitest-environment jsdom
/**
 * PR 1906 fix round, items 8 and 9 (US-52 AC8c, US-13 AC1, US-11 AC1a): the upload's Save plans and
 * dedups on the record as it is when Save runs, not as it was reviewed; a usage count that throws after
 * the rows landed never turns a landed Save into "Failed to save"; an erase refusal says so in the
 * page's words for a refused write. Synthetic names, values and hashes only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { RoadmapStore } from './roadmap-store';

vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

const NOW = '2026-11-02T00:00:00.000Z';
const letter: UnifiedExtractionResult = {
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-10-20', contentMarkdown: 'x', metadata: {} },
};
const saving = (extraction: UnifiedExtractionResult): UploadState => ({
  phase: 'saving', platform: 'web', run: 1, started: NOW, firstRead: NOW, attempt: 1,
  files: [{ id: 'f', name: 'letter.pdf', bytes: 1, hash: 'h-letter', pages: null, status: { s: 'read', extraction, choices: NO_CHOICES } }],
});

describe('Save plans on the record as it is when Save runs (item 8)', () => {
  it('a letter another device filed, with its original, between review and Save gets no second row and no second blob', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    const writes: string[] = [];
    const write = adapter.writeDocument.bind(adapter);
    adapter.writeDocument = async (ref, blob) => { writes.push(ref); return write(ref, blob); };
    const store = await RoadmapStore.create(adapter);
    store.showErase(store.eraseIdentity);
    const reviewed = store.file;
    // Another device's copy arrives: the same bytes, filed with their original.
    // A merge hands the session a new file object, as a re-read does.
    (store as unknown as { session: { edit(f: (file: typeof reviewed) => typeof reviewed): void } }).session.edit((file) => ({ ...file, documents: [...file.documents, {
      id: 'other', title: 'Synthetic letter', type: 'clinic_letter', date: '2026-10-20', fileRef: 'Clinic letters/x.pdf', contentHash: 'h-letter',
      mimeType: 'application/pdf', extractedText: 'x', addedAt: NOW, metadata: {}, sourceFileName: 'letter.pdf',
    }] }));
    expect(store.file).not.toBe(reviewed);
    const answer = await store.saveUpload(saving(letter), NOW, true, { holds: () => true, original: () => new Blob(['b']), mimeType: () => 'application/pdf' });
    expect(answer.ok).toBe(true);
    expect(store.file.documents.filter((d) => d.contentHash === 'h-letter' && !d.deleted)).toHaveLength(1);
    expect(writes).toEqual([]);
  });
});
