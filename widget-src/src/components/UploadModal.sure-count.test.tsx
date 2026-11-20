// @vitest-environment jsdom
/**
 * PR 1906 real-browser run, item B (US-13 AC13): "{n} values will be saved" counts from the same view as
 * Save's own label, so a file read later never leaves the line behind the button. Synthetic only.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { resetUploadStore } from '../testing/upload-store';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import type { UploadHistory } from '../lib/api-types';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', async () => ({ ...(await import('../testing/upload-store')).uploadStoreMock(), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => ''), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false) }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '/apps/synthetic', parseJsonResponse: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: async (b: Blob) => `sha256-${await b.text()}` }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const lab = (day: string, metric: string, valueSI: number, displayValue = valueSI, displayUnit = 'mmol/L'): Import =>
  ({ result: { classification: 'lab_report', document: null, reportDate: day, values: [{ metric, valueSI, displayValue, displayUnit, confidence: 'high' }], additionalValues: [] } }) as unknown as Import;
const history: UploadHistory = { measurements: [], labValues: [], documents: [] };
const pdf = (name: string) => new File([name], name, { type: 'application/pdf' });

beforeEach(() => {
  vi.clearAllMocks();
  resetUploadStore();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async (f: File) => ({ pages: [{ type: 'text', content: await f.text() }], truncated: false })),
    isPdf: () => true, isZip: () => false, isImage: () => false,
  } });
});
afterEach(cleanup);

it('a third report read late, after an edit: the line and Save both say 3', async () => {
  let third!: (r: Import) => void;
  vi.mocked(labImport).mockImplementation(async p => {
    const name = p[0].content as string;
    if (name === 'c.pdf') return new Promise<Import>(resolve => { third = resolve; });
    // An HbA1c printed in %, shown in mmol/mol: a value the review keeps in sight.
    return name === 'a.pdf' ? lab('2026-03-10', 'ldl', 3.1) : lab('2026-03-11', 'hba1c', 36, 5.4, '%');
  });
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={history} onComplete={() => {}} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')] } });
  await waitFor(() => expect(third).toBeDefined());
  // As the real-browser run did: Show all, and an edit to the first report's LDL, which keeps its row in sight.
  fireEvent.click(await screen.findByRole('button', { name: /^Show all/ }));
  fireEvent.change(await screen.findByDisplayValue('3.1'), { target: { value: '3.7' } });
  await act(async () => third(lab('2026-03-12', 'hdl', 1.4)));
  await screen.findByRole('button', { name: 'Save 3 values' });
  expect(document.querySelector('.review-overview-line')?.textContent).toMatch(/^3 values will be saved/);
});
