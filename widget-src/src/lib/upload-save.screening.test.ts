/**
 * US-13 AC6: the web's own Save (kept until the upload list mounts) writes a letter's screening date only for a key in
 * the screening table, whatever the review hands it, as the shared Save does (health-core upload-screening.ts).
 * Synthetic values only; the store is mocked.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReviewDecisions } from './upload-pipeline';

vi.mock('./roadmap-data', () => ({
  bulkSaveMeasurements: vi.fn(async () => ({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] })),
  bulkSaveLabValues: vi.fn(async () => ({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] })),
  bulkSaveDocuments: vi.fn(async () => ({ saved: [{ id: 'd', contentHash: 'h' }], errorCount: 0 })),
  getEraseIdentity: () => '',
  getShownErase: () => '',
}));
const { saveReview } = await import('./upload-save');

const letter = (key: string): ReviewDecisions['documents'][number] => ({
  documentType: 'scan_result', title: 'Synthetic scan', documentDate: '2026-10-20', contentMd: 'Synthetic', metadata: {},
  sourceFileName: 'scan.pdf', contentHash: 'h', screeningUpdate: { key, date: '2026-10-20' },
});
const decisions = (keys: string[]): ReviewDecisions => ({ values: [], labValues: [], reviewed: [], documents: keys.map(letter) });

describe('US-13 AC6: a screening box only for a type in the screening table (the web\'s own Save)', () => {
  it('writes a key in the table and nothing else', async () => {
    const screening = vi.fn();
    await saveReview(decisions(['knee_last_date', 'colorectal_method', 'colorectal_last_date']), { earlierRows: new Map(), complete: () => {}, screening, existing: [] });
    expect(screening.mock.calls).toEqual([['colorectal_last_date', '2026-10-20', '']]);
  });
});
