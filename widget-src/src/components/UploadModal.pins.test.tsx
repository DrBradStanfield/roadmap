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
import { lastSaved, resetUploadStore } from '../testing/upload-store';
import { recordOf } from '../testing/review-harness';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import type { UploadHistory } from '../lib/api-types';
import { findReviewValue } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', async () => ({ ...(await import('../testing/upload-store')).uploadStoreMock(), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async () => ''), synthesizeLabArchiveEntries: vi.fn(() => []) }));
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
  resetUploadStore(recordOf(history));
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(read);
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

describe('US-12 / US-13 pins — UploadModal saves the same rows as before (design 12c)', () => {
  it('two store calls: an edited value, an undated column on its picked day, and ticked Replaces', async () => {
    render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={history} onComplete={() => {}} />);
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'labs.pdf', { type: 'application/pdf' })] } });
    fireEvent.change(await findReviewValue('2.8'), { target: { value: '2.9' } });
    fireEvent.change(screen.getByLabelText('Choose the date of the previous results'), { target: { value: '2025-03-01' } });
    for (const box of screen.queryAllByRole('checkbox', { name: /Replace the saved/ })) fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    // What Save wrote (health-core uploadSave, design 12c), as the old store calls carried it.
    const { values, labValues } = lastSaved();
    const tuple = (r: Record<string, unknown>) => [r.metricName, r.value, String(r.recordedAt).slice(0, 10), r.source, r.correctsId ?? null];
    expect(values.map(tuple).sort()).toEqual([
      ['hdl', 1.4, '2025-09-02', 'lab_import', 'H'],
      ['ldl', 2.9, '2025-09-02', 'lab_import_edited', null],
      ['ldl', 3.4, '2025-03-01', 'lab_import', null],
    ]);
    expect(labValues.map(tuple).sort()).toEqual([
      ['Ferritin', 90, '2025-09-02', 'lab_import', 'F'],
      ['sodium', 139, '2025-03-01', 'lab_import', null],
    ]);
  });
});
