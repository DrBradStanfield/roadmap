// @vitest-environment jsdom
/**
 * US-14 AC10 through the real save path: off-cloud, a lab report leaves a
 * metadata-only archive row with its file's hash, listing the lab rows its
 * values wrote. The values save before the documents, and a partial failure
 * leaves what it left before: values saved, the review open with the same
 * message, and a retry (whose values skip as saved) still lists the first
 * attempt's rows. The store is mocked. Synthetic values, plain fake hashes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { bulkSaveMeasurements, bulkSaveDocuments, bulkSaveLabValues } from '../lib/roadmap-data';
import type { UploadHistory } from '../lib/api-types';
import { findReviewValue } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'local'), bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
// Hashing stands in for sha256Blob: each result gets its bytes and a plain fake hash.
vi.mock('../lib/archive-payloads', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/archive-payloads')>(),
  attachOriginals: vi.fn(async (results: Array<{ fileName: string }>) => results.map(r => ({ ...r, file: new Blob(['x']), contentHash: `hash-${r.fileName}` }))),
}));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const read = { result: {
  classification: 'lab_report', document: null, reportDate: '2025-09-02', values: [],
  additionalValues: [{ name: 'Ferritin', value: 90, unit: 'µg/L', referenceLow: 30, referenceHigh: 300 }],
} } as unknown as Import;
const history: UploadHistory = { measurements: [], labValues: [], documents: [] };
type Docs = Awaited<ReturnType<typeof bulkSaveDocuments>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(read);
  vi.mocked(bulkSaveMeasurements).mockResolvedValue({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] });
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async (f: File) => ({ pages: [{ type: 'text', content: f.name }], truncated: false })),
    isPdf: (f: File) => f.name.endsWith('.pdf'), isZip: () => false, isImage: () => false, resizeImage: vi.fn(async () => 'base64'), docxToText: vi.fn(),
  } });
});
afterEach(cleanup);

async function openReview() {
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" metricUnitOverrides={{}}
    grading={{}} history={history} onComplete={() => {}} onScreeningUpdate={() => {}} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'labs.pdf', { type: 'application/pdf' })] } });
  await findReviewValue('90');
}
const archiveCall = (call: number) => vi.mocked(bulkSaveDocuments).mock.calls[call][0].find(d => d.metadata.labArchive === true);

describe('US-14 AC10 — off-cloud archive rows keep the hash and list their rows', () => {
  it('the values save first; the archive row carries the hash, no bytes, and the rows the values wrote', async () => {
    vi.mocked(bulkSaveLabValues).mockResolvedValue({ saved: [{}], skippedDuplicates: 0, errorCount: 0, refused: [], labRows: ['row-1'] } as unknown as Awaited<ReturnType<typeof bulkSaveLabValues>>);
    vi.mocked(bulkSaveDocuments).mockResolvedValue({ saved: [], errorCount: 0 } as unknown as Docs);
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(vi.mocked(bulkSaveLabValues).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(bulkSaveDocuments).mock.invocationCallOrder[0]);
    expect(archiveCall(0)).toMatchObject({ file: undefined, contentHash: 'hash-labs.pdf', sourceFileName: 'labs.pdf', metadata: { labArchive: true, rows: ['row-1'] } });
  });

  it('values saved, the documents save fails: the review stays open with the same words; the retry lists the first attempt\'s rows', async () => {
    vi.mocked(bulkSaveLabValues)
      .mockResolvedValueOnce({ saved: [{}], skippedDuplicates: 0, errorCount: 0, refused: [], labRows: ['row-1'] } as unknown as Awaited<ReturnType<typeof bulkSaveLabValues>>)
      .mockResolvedValueOnce({ saved: [], skippedDuplicates: 1, errorCount: 0, refused: [], labRows: [null] });
    vi.mocked(bulkSaveDocuments)
      .mockRejectedValueOnce(new Error('synthetic store failure'))
      .mockResolvedValueOnce({ saved: [], errorCount: 0 } as unknown as Docs);
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    expect(await screen.findByText('Some items could not be saved. Please try again.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(bulkSaveLabValues).toHaveBeenCalledTimes(2);
    expect(archiveCall(1)).toMatchObject({ contentHash: 'hash-labs.pdf', metadata: { labArchive: true, rows: ['row-1'] } });
  });
});
