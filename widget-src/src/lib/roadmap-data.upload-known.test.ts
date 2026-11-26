// @vitest-environment jsdom
// US-12 AC27: the upload reads the record's files by content as the record is now. A delete or a
// save edits the working copy in place, so an index kept by the copy's identity went stale: a
// deleted document's bytes were still skipped on the next upload. Synthetic rows only. The save is
// the upload's one Save (roadmap-data.ts saveUpload), the path a person's upload takes.
import { beforeEach, describe, expect, it } from 'vitest';
import { knownAs } from '@roadmap/health-core/upload-known';
import { deleteDocument, initRoadmapStore, recordFileSync, uploadKnownIndex, getShownErase } from './roadmap-data';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { uploadOpen } from '../testing/upload-save-kit';

const HASH = 'sha256-synthetic-letter';
const letter = { documentType: 'clinic_letter', title: 'Synthetic letter', documentDate: '2024-06-01', contentMd: 'letter', metadata: {}, sourceFileName: 'letter.pdf', contentHash: HASH };
const saved = () => recordFileSync()!.documents.filter((d) => !d.deleted);

beforeEach(async () => {
  localStorage.clear();
  await initRoadmapStore(new LocalStorageAdapter());
});

describe('US-12 AC27: the known index follows the record', () => {
  it('a document-only save, then the same file again: it is known', async () => {
    expect(knownAs(uploadKnownIndex(), HASH)).toBeNull();
    expect(await uploadOpen([letter])).toMatchObject({ ok: true, outcome: { documents: 1 } });
    expect(saved()).toHaveLength(1);
    expect(knownAs(uploadKnownIndex(), HASH)).toEqual({ as: 'document', archiveOnly: true });
  });

  it('a delete, then the same file again before the write lands: it is read', async () => {
    expect(await uploadOpen([letter])).toMatchObject({ ok: true });
    expect(knownAs(uploadKnownIndex(), HASH)).not.toBeNull();
    expect(await deleteDocument(saved()[0].id, getShownErase())).toBe(true);
    expect(knownAs(uploadKnownIndex(), HASH)).toBeNull();
  });
});
