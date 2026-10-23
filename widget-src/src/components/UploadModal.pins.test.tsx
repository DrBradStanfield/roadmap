// @vitest-environment jsdom
/**
 * US-12 / US-13 characterisation pins (plan docs/reviews/2026-10-23-mcp-dedup-plan.md,
 * step 1): the store inputs UploadModal reshapes the review's rows into, byte
 * for byte — the two store calls (measurements, labs) with an edited value,
 * an undated previous column on the picked day, and a ticked Replace. A later
 * de-dup must leave them alone. Same harness shape as UploadModal.outcome.test.tsx.
 * Synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { bulkSaveMeasurements, bulkSaveDocuments, bulkSaveLabValues } from '../lib/roadmap-data';
import type { UploadHistory } from '../lib/api-types';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'cloud'), bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), attachOriginals: vi.fn(async results => results), synthesizeLabArchiveEntries: vi.fn(() => []) }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const v = (metric: string, valueSI: number, recordedAt?: string) =>
  ({ metric, valueSI, displayValue: valueSI, displayUnit: 'mmol/L', confidence: 'high', ...(recordedAt ? { recordedAt } : {}) });
const read: Import = { result: {
  classification: 'lab_report', document: null, reportDate: '2025-09-02',
  values: [v('ldl', 2.8), v('hdl', 1.4), v('ldl', 3.4, 'undated')],
  additionalValues: [{ name: 'Ferritin', value: 90, unit: 'µg/L', referenceLow: 30, referenceHigh: 300 }, { name: 'sodium', value: 139, unit: 'mmol/L', recordedAt: 'undated' }],
} } as unknown as Import;
const history: UploadHistory = {
  measurements: [{ id: 'H', metricType: 'hdl', value: 1.2, recordedAt: '2025-09-02T00:00:00.000Z', createdAt: '2025-09-02T00:00:00.000Z' }],
  labValues: [{ id: 'F', metricName: 'ferritin', value: 70, unit: 'µg/L', referenceLow: null, referenceHigh: null, recordedAt: '2025-09-02T00:00:00.000Z', source: 'lab_import', createdAt: '2025-09-02T00:00:00.000Z' }],
  documents: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(read);
  vi.mocked(bulkSaveMeasurements).mockResolvedValue({ saved: [{}], skippedDuplicates: 0, errorCount: 0, refused: [] } as unknown as Awaited<ReturnType<typeof bulkSaveMeasurements>>);
  vi.mocked(bulkSaveDocuments).mockResolvedValue({ saved: [], errorCount: 0 } as unknown as Awaited<ReturnType<typeof bulkSaveDocuments>>);
  vi.mocked(bulkSaveLabValues).mockResolvedValue({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] });
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async (f: File) => ({ pages: [{ type: 'text', content: f.name }], truncated: false })),
    isPdf: (f: File) => f.name.endsWith('.pdf'),
    isZip: () => false,
    isImage: () => false,
    resizeImage: vi.fn(async () => 'base64'),
    docxToText: vi.fn(),
  } });
});
afterEach(cleanup);

describe('US-12 / US-13 pins — UploadModal hands the store the same inputs as today', () => {
  it('two store calls: an edited value, an undated column on its picked day, and ticked Replaces', async () => {
    render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={history} onComplete={() => {}} />);
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'labs.pdf', { type: 'application/pdf' })] } });
    fireEvent.change(await screen.findByDisplayValue('2.8'), { target: { value: '2.9' } });
    fireEvent.change(screen.getByLabelText('Choose the date of the previous results'), { target: { value: '2025-03-01' } });
    for (const box of screen.queryAllByRole('checkbox', { name: /Replace the saved/ })) fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(JSON.stringify({
      measurements: vi.mocked(bulkSaveMeasurements).mock.calls,
      labValues: vi.mocked(bulkSaveLabValues).mock.calls,
    })).toMatchSnapshot();
  });
});
