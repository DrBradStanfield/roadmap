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
import { bulkSaveMeasurements, bulkSaveDocuments, bulkSaveLabValues, getDocumentArchiveMode } from '../lib/roadmap-data';
import type { UploadHistory } from '../lib/api-types';
import { findReviewValue } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'no-prompt'), bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
// A plain fake hash stands in for sha256Blob: it names a file's bytes, not its name.
vi.mock('../lib/archive-payloads', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/archive-payloads')>(),
  sha256Blob: vi.fn(async (blob: Blob) => `hash-${await blob.text()}`),
}));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const labRead = (reportDate: string, ferritin: number, values: unknown[] = []) => ({ result: {
  classification: 'lab_report', document: null, reportDate, values,
  additionalValues: [{ name: 'Ferritin', value: ferritin, unit: 'µg/L', referenceLow: 30, referenceHigh: 300 }],
} } as unknown as Import);
const reads: Record<string, Import> = {
  labs: labRead('2025-09-02', 90),
  first: labRead('2025-09-02', 90),
  second: labRead('2025-10-02', 70),
  core: labRead('2025-09-02', 90, [{ metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: 'mmol/L', confidence: 'high' }]),
  letter: { result: {
    classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [],
    document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2025-08-01', contentMarkdown: 'letter text', metadata: {} },
  } } as unknown as Import,
};
const history: UploadHistory = { measurements: [], labValues: [], documents: [] };
type Docs = Awaited<ReturnType<typeof bulkSaveDocuments>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockImplementation(async (pages: unknown) => reads[(pages as Array<{ content: string }>)[0].content]);
  vi.mocked(bulkSaveMeasurements).mockResolvedValue({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] });
  vi.mocked(getDocumentArchiveMode).mockReturnValue('no-prompt');
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async (f: File) => ({ pages: [{ type: 'text', content: await f.text() }], truncated: false })),
    isPdf: (f: File) => f.name.endsWith('.pdf'), isZip: () => false, isImage: () => false, resizeImage: vi.fn(async () => 'base64'), docxToText: vi.fn(),
  } });
});
afterEach(cleanup);

async function openReview(files: Array<[content: string, name: string]> = [['labs', 'labs.pdf']]) {
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" metricUnitOverrides={{}}
    grading={{}} history={history} onComplete={() => {}} onScreeningUpdate={() => {}} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: files.map(([content, name]) => new File([content], name, { type: 'application/pdf' })) } });
  await findReviewValue('90');
}
const archiveCall = (call: number) => vi.mocked(bulkSaveDocuments).mock.calls[call][0].find(d => d.metadata.labArchive === true);
const archives = (call: number) => vi.mocked(bulkSaveDocuments).mock.calls[call][0].filter(d => d.metadata.labArchive === true);
type Labs = Awaited<ReturnType<typeof bulkSaveLabValues>>;

describe('US-14 AC10 — off-cloud archive rows keep the hash and list their rows', () => {
  it('the values save first; the archive row carries the hash, no bytes, and the rows the values wrote', async () => {
    vi.mocked(bulkSaveLabValues).mockResolvedValue({ saved: [{}], skippedDuplicates: 0, errorCount: 0, refused: [], labRows: ['row-1'] } as unknown as Awaited<ReturnType<typeof bulkSaveLabValues>>);
    vi.mocked(bulkSaveDocuments).mockResolvedValue({ saved: [], errorCount: 0 } as unknown as Docs);
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(vi.mocked(bulkSaveLabValues).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(bulkSaveDocuments).mock.invocationCallOrder[0]);
    expect(archiveCall(0)).toMatchObject({ file: undefined, contentHash: 'hash-labs', sourceFileName: 'labs.pdf', metadata: { labArchive: true, rows: ['row-1'] } });
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
    expect(archiveCall(1)).toMatchObject({ contentHash: 'hash-labs', metadata: { labArchive: true, rows: ['row-1'] } });
  });

  it('Codex R1: two different files both called Results.pdf: each archive row lists only the rows its own values wrote', async () => {
    // One written row per value, named by its day: the two reports are on different days.
    vi.mocked(bulkSaveLabValues).mockImplementation(async (values) => ({ saved: values.map(() => ({})), skippedDuplicates: 0, errorCount: 0, refused: [], labRows: values.map(v => `row-${v.recordedAt.slice(0, 10)}`) }) as unknown as Labs);
    vi.mocked(bulkSaveDocuments).mockResolvedValue({ saved: [], errorCount: 0 } as unknown as Docs);
    await openReview([['first', 'Results.pdf'], ['second', 'Results.pdf']]);
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(archives(0).map(d => [d.sourceFileName, d.contentHash, d.metadata.rows])).toEqual([
      ['Results.pdf', 'hash-first', ['row-2025-09-02']],
      ['Results.pdf', 'hash-second', ['row-2025-10-02']],
    ]);
  });

  it('Codex R2: the core values save, the other branch fails; the retry saves the rest and the archive row lists both', async () => {
    vi.mocked(bulkSaveMeasurements)
      .mockResolvedValueOnce({ saved: [{}], skippedDuplicates: 0, errorCount: 0, refused: [], labRows: ['core-1'] } as unknown as Awaited<ReturnType<typeof bulkSaveMeasurements>>)
      .mockResolvedValueOnce({ saved: [], skippedDuplicates: 1, errorCount: 0, refused: [], labRows: [null] });
    vi.mocked(bulkSaveLabValues)
      .mockRejectedValueOnce(new Error('synthetic store failure'))
      .mockResolvedValueOnce({ saved: [{}], skippedDuplicates: 0, errorCount: 0, refused: [], labRows: ['add-1'] } as unknown as Labs);
    vi.mocked(bulkSaveDocuments).mockResolvedValue({ saved: [], errorCount: 0 } as unknown as Docs);
    await openReview([['core', 'labs.pdf']]);
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    expect(await screen.findByText('Some items could not be saved. Please try again.')).toBeTruthy();
    expect(archiveCall(0)).toMatchObject({ contentHash: 'hash-core', metadata: { rows: ['core-1'] } });
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(archiveCall(1)).toMatchObject({ contentHash: 'hash-core', metadata: { rows: ['core-1', 'add-1'] } });
  });

  for (const mode of ['no-prompt', 'cloud'] as const) {
    it(`Codex re-check 2 (${mode}): a letter and a lab report both called Results.pdf: both are saved, the lab report with its fingerprint and rows`, async () => {
      vi.mocked(getDocumentArchiveMode).mockReturnValue(mode);
      vi.mocked(bulkSaveLabValues).mockResolvedValue({ saved: [{}], skippedDuplicates: 0, errorCount: 0, refused: [], labRows: ['row-1'] } as unknown as Labs);
      vi.mocked(bulkSaveDocuments).mockResolvedValue({ saved: [], errorCount: 0 } as unknown as Docs);
      await openReview([['letter', 'Results.pdf'], ['labs', 'Results.pdf']]);
      fireEvent.click(screen.getByRole('button', { name: /^Save / }));
      await screen.findByRole('button', { name: 'Done' });
      const saved = vi.mocked(bulkSaveDocuments).mock.calls[0][0];
      expect(saved.map(d => [d.sourceFileName, d.metadata.labArchive === true, mode === 'cloud' ? !!d.file : d.contentHash])).toEqual([
        ['Results.pdf', false, mode === 'cloud' ? true : 'hash-letter'],
        ['Results.pdf', true, mode === 'cloud' ? true : 'hash-labs'],
      ]);
      expect(archiveCall(0)).toMatchObject({ contentHash: 'hash-labs', metadata: { rows: ['row-1'] } });
    });
  }
});
