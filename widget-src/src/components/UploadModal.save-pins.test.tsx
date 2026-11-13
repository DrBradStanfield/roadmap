// @vitest-environment jsdom
/**
 * US-12 / US-13 pins (untangle W2-6): the store inputs one representative
 * upload saves through the real save path — two files (a lab report and a
 * letter), a held day in conflict left unticked, a cleared (skipped) row, a
 * value typed in the other unit, ticked Replaces (a measurement and a lab
 * value) and printed limits ("<5", core and additional). The store is mocked,
 * so its dedup is not under test. Moving the review's payload shape must
 * leave every pin alone. Same harness as
 * UploadModal.pins.test.tsx. Synthetic values.
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
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), attachOriginals: vi.fn(async results => results) }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const v = (metric: string, valueSI: number) =>
  ({ metric, valueSI, displayValue: valueSI, displayUnit: 'mmol/L', confidence: 'high' });
const reads: Record<string, Import> = {
  'labs.pdf': { result: {
    classification: 'lab_report', document: null, reportDate: '2025-09-02',
    values: [v('ldl', 2.8), v('hdl', 1.4), v('triglycerides', 1.1),
      { metric: 'lpa', valueSI: 5, displayValue: 5, displayUnit: 'nmol/L', confidence: 'high', comparator: '<' }],
    additionalValues: [{ name: 'Ferritin', value: 90, unit: 'µg/L', referenceLow: 30, referenceHigh: 300 }, { name: 'Sodium', value: 139, unit: 'mmol/L' },
      { name: 'CRP', value: 5, unit: 'mg/L', comparator: '<' }],
  } } as unknown as Import,
  'letter.pdf': { result: {
    classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [],
    document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2025-08-01', contentMarkdown: 'letter text', metadata: { clinic: 'synthetic' } },
  } } as unknown as Import,
};
// HDL, triglycerides and ferritin are held on the report's day: three conflicts.
const history: UploadHistory = {
  measurements: [
    { id: 'H', metricType: 'hdl', value: 1.2, recordedAt: '2025-09-02T00:00:00.000Z', createdAt: '2025-09-02T00:00:00.000Z' },
    { id: 'T', metricType: 'triglycerides', value: 0.9, recordedAt: '2025-09-02T00:00:00.000Z', createdAt: '2025-09-02T00:00:00.000Z' },
  ],
  labValues: [{ id: 'F', metricName: 'ferritin', value: 70, unit: 'µg/L', referenceLow: null, referenceHigh: null, recordedAt: '2025-09-02T00:00:00.000Z', source: 'lab_import', createdAt: '2025-09-02T00:00:00.000Z' }],
  documents: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockImplementation(async (pages: unknown) => reads[(pages as Array<{ content: string }>)[0].content]);
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

describe('US-12 / US-13 pins (W2-6) — one upload saves the same store inputs', () => {
  it('two files, an unticked conflict, a skipped row, a unit change and a ticked Replace', async () => {
    const onScreeningUpdate = vi.fn();
    render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" metricUnitOverrides={{ ldl: 'conventional' }}
      grading={{}} history={history} onComplete={() => {}} onScreeningUpdate={onScreeningUpdate} />);
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [
      new File(['x'], 'labs.pdf', { type: 'application/pdf' }), new File(['y'], 'letter.pdf', { type: 'application/pdf' }),
    ] } });
    await screen.findByDisplayValue('139');
    const cell = (value: string) => Array.from(document.querySelectorAll<HTMLInputElement>('.bt-cell-input input')).find(i => i.value === value)!;
    // LDL shows in mg/dL; a new number typed there saves in SI.
    const ldl = Array.from(document.querySelectorAll<HTMLInputElement>('.bt-cell-input input'))[0];
    fireEvent.change(ldl, { target: { value: '120' } });
    // Sodium cleared: skipped.
    fireEvent.change(cell('139'), { target: { value: '' } });
    // Triglycerides' and ferritin's Replace ticked; HDL's conflict left unticked.
    const replaces = screen.queryAllByRole('checkbox', { name: /Replace the saved/ });
    const tick = (name: RegExp) => fireEvent.click(replaces.find(b => name.test(b.getAttribute('aria-label') ?? ''))!);
    tick(/Triglycerides/i);
    tick(/Ferritin/i);
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    // Explicit, as JSON drops an undefined: a lost correctsId or comparator fails here.
    const measured = vi.mocked(bulkSaveMeasurements).mock.calls[0][0];
    const labs = vi.mocked(bulkSaveLabValues).mock.calls[0][0];
    expect(measured.find(m => m.metricType === 'triglycerides')).toHaveProperty('correctsId', 'T');
    expect(measured.find(m => m.metricType === 'hdl')).toBeUndefined();
    expect(measured.find(m => m.metricType === 'lpa')).toHaveProperty('comparator', '<');
    expect(labs.find(l => l.metricName === 'Ferritin')).toHaveProperty('correctsId', 'F');
    expect(labs.find(l => l.metricName === 'CRP')).toHaveProperty('comparator', '<');
    expect(labs.find(l => l.metricName === 'Sodium')).toBeUndefined();
    expect(JSON.stringify({
      ldlShown: ldl.value,
      replaceBoxes: replaces.map(b => b.getAttribute('aria-label')),
      measurements: vi.mocked(bulkSaveMeasurements).mock.calls,
      labValues: vi.mocked(bulkSaveLabValues).mock.calls,
      documents: vi.mocked(bulkSaveDocuments).mock.calls,
      screening: onScreeningUpdate.mock.calls,
    }, null, 1)).toMatchSnapshot();
  });
});
