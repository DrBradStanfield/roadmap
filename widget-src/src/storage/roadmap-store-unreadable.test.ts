/**
 * US-65 AC2: the web's document commit pushes into the working copy in place.
 * While a hidden document is in the record, a new upload must still show at
 * once: the readers' view is made again when an array grows. Synthetic only.
 */
import { describe, it, expect } from 'vitest';
import { RoadmapStore } from './roadmap-store';
import { createEmptyFile } from '@roadmap/health-core/roadmap-file';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';

const DAY = '2026-09-01T00:00:00.000Z';

describe('RoadmapStore — US-65 readers view', () => {
  it('an upload shows at once while a hidden document is in the record', async () => {
    const cloud = new MemoryCloud();
    const hidden = { id: 'd1', title: 'Synthetic', type: 7, date: null, fileRef: '', contentHash: '', mimeType: '', extractedText: '', addedAt: DAY };
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify({ ...createEmptyFile({ deviceId: 'w', now: DAY }), documents: [hidden] }), version: 1 });
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(store.loadLatestMeasurements().documents).toEqual([]);
    expect(store.unreadableCount).toBe(1);

    await store.bulkSaveDocuments([{
      documentType: 'clinic_letter', title: 'Heart clinic', documentDate: null,
      contentMd: '# Letter', metadata: {}, sourceFileName: 'letter.pdf',
      file: new Blob(['letter'], { type: 'application/pdf' }),
    }]);
    expect(store.loadLatestMeasurements().documents.map((d) => d.title)).toEqual(['Heart clinic']);
  });
});
