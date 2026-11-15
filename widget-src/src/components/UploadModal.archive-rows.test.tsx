// @vitest-environment jsdom
/**
 * US-14 AC10 through the upload's one Save (health-core uploadSave, design 12c): off-cloud, a lab
 * report leaves a metadata-only archive row with its file's hash, listing the lab rows its values
 * wrote. One Save is one edit: a refused Save writes nothing, and the retry writes it all once (the
 * old two-branch partial save is gone). The record is in memory (testing/upload-store.ts).
 * Synthetic values, plain fake hashes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { lastSaved, resetUploadStore, uploadStore } from '../testing/upload-store';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { getDocumentArchiveMode } from '../lib/roadmap-data';
import type { UploadHistory } from '../lib/api-types';
import { findReviewValue } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', async () => ({ ...(await import('../testing/upload-store')).uploadStoreMock(), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'no-prompt'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
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

beforeEach(() => {
  vi.clearAllMocks();
  resetUploadStore();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockImplementation(async (pages: unknown) => reads[(pages as Array<{ content: string }>)[0].content]);
  vi.mocked(getDocumentArchiveMode).mockReturnValue('no-prompt');
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async (f: File) => ({ pages: [{ type: 'text', content: await f.text() }], truncated: false })),
    isPdf: (f: File) => f.name.endsWith('.pdf'), isZip: () => false, isImage: () => false, resizeImage: vi.fn(async () => 'base64'), docxToText: vi.fn(),
  } });
});
afterEach(cleanup);

async function openReview(files: Array<[content: string, name: string]> = [['labs', 'labs.pdf']]) {
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" metricUnitOverrides={{}}
    grading={{}} history={history} onComplete={() => {}} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: files.map(([content, name]) => new File([content], name, { type: 'application/pdf' })) } });
  await findReviewValue('90');
}
/** The archive rows the last Save wrote, each with its hash, original and the rows it lists, by their test and day. */
function archives() {
  const { values, labValues, documents } = lastSaved();
  const name = new Map([...values, ...labValues].map(r => [r.id as string, `${r.metricName}@${String(r.recordedAt).slice(0, 10)}`]));
  return documents.filter(d => d.metadata.labArchive === true)
    .map(d => ({ name: d.sourceFileName, hash: d.contentHash, stored: d.fileRef !== '', rows: ((d.metadata.rows as string[]) ?? []).map(id => name.get(id) ?? id).sort() }));
}

describe('US-14 AC10 — off-cloud archive rows keep the hash and list their rows', () => {
  it('the archive row carries the hash, no original, and the rows the values wrote', async () => {
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(archives()).toEqual([{ name: 'labs.pdf', hash: 'hash-labs', stored: false, rows: ['Ferritin@2025-09-02'] }]);
  });

  it('a refused Save writes nothing and keeps the review; the retry writes it all once', async () => {
    uploadStore.refuse = '';
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    expect(await screen.findByText('Failed to save. Please try again.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(uploadStore.record.labValues).toEqual([]);
    uploadStore.refuse = null;
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(archives()).toEqual([{ name: 'labs.pdf', hash: 'hash-labs', stored: false, rows: ['Ferritin@2025-09-02'] }]);
  });

  it('Codex R1: two different files both called Results.pdf: each archive row lists only the rows its own values wrote', async () => {
    await openReview([['first', 'Results.pdf'], ['second', 'Results.pdf']]);
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(archives()).toEqual([
      { name: 'Results.pdf', hash: 'hash-first', stored: false, rows: ['Ferritin@2025-09-02'] },
      { name: 'Results.pdf', hash: 'hash-second', stored: false, rows: ['Ferritin@2025-10-02'] },
    ]);
  });

  it('Codex R2: a report with a core value and another lab: its archive row lists both', async () => {
    await openReview([['core', 'labs.pdf']]);
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(archives()).toEqual([{ name: 'labs.pdf', hash: 'hash-core', stored: false, rows: ['Ferritin@2025-09-02', 'ldl@2025-09-02'] }]);
  });

  for (const mode of ['no-prompt', 'cloud'] as const) {
    it(`Codex re-check 2 (${mode}): a letter and a lab report both called Results.pdf: both are saved, the lab report with its fingerprint and rows`, async () => {
      vi.mocked(getDocumentArchiveMode).mockReturnValue(mode);
      await openReview([['letter', 'Results.pdf'], ['labs', 'Results.pdf']]);
      fireEvent.click(screen.getByRole('button', { name: /^Save / }));
      await screen.findByRole('button', { name: 'Done' });
      const { documents } = lastSaved();
      expect(documents.map(d => [d.sourceFileName, d.metadata.labArchive === true, d.contentHash, d.fileRef !== ''])).toEqual([
        ['Results.pdf', false, 'hash-letter', mode === 'cloud'],
        ['Results.pdf', true, 'hash-labs', mode === 'cloud'],
      ]);
      expect(archives()[0].rows).toEqual(['Ferritin@2025-09-02']);
      expect(uploadStore.written.size).toBe(mode === 'cloud' ? 2 : 0);
    });
  }
});
