// @vitest-environment jsdom
/**
 * PR 1906 final Codex pass, item 3 (US-12 AC10): a run's one `upload_outcome` is sent when the run is
 * final (saved, stopped, discarded or closed, the page gone), so a file a Try again mends is counted as
 * read, never as a final failure; a run left with a failure counts it; never twice. Synthetic only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { resetUploadStore } from '../testing/upload-store';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { trackProductEvent } from '../lib/server-api';
import type { UploadHistory } from '../lib/api-types';
import { findReviewValue } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', async () => ({ ...(await import('../testing/upload-store')).uploadStoreMock(), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => ''), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false) }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '/apps/synthetic', parseJsonResponse: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: async (b: Blob) => `sha256-${await b.text()}` }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const lab = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } } as unknown as Import;
const busy = { result: null, error: 'Not read', errorCode: 'busy' } as unknown as Import;
const history: UploadHistory = { measurements: [], labValues: [], documents: [] };
const extractFromPdf = vi.fn();
const pick = () => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['a'], 'a.pdf', { type: 'application/pdf' })] } });
const sent = () => vi.mocked(trackProductEvent).mock.calls.filter(([n]) => n === 'upload_outcome').map(([, meta]) => meta);

beforeEach(() => {
  vi.clearAllMocks();
  resetUploadStore();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  extractFromPdf.mockReset().mockResolvedValue({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false });
  Object.assign(window, { HealthUpload: { extractFromPdf, isPdf: () => true, isZip: () => false, isImage: () => false } });
});
afterEach(cleanup);
const render_ = () => render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={history} onComplete={() => {}} />);

describe('the run is counted once, when it is final (item 3)', () => {
  it('fails busy, is read on Try again and saved: one outcome, the file counted as read, no final failure', async () => {
    vi.mocked(labImport).mockResolvedValueOnce(busy).mockResolvedValue(lab);
    render_(); pick();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await findReviewValue('3.9');
    expect(sent()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    expect(sent()).toEqual([{ picked: 1, withValues: 1, firstReadSeconds: 0 }]);
  });

  it('fails busy and the review is left: one outcome with the final failure', async () => {
    vi.mocked(labImport).mockResolvedValue(busy);
    render_(); pick();
    await screen.findByRole('button', { name: 'Try again' });
    expect(sent()).toEqual([]);
    // Nothing to save: the review's own button reads Close, and discards the upload.
    fireEvent.click(document.querySelector<HTMLButtonElement>('.review-cancel-btn')!);
    expect(sent()).toEqual([expect.objectContaining({ picked: 1, failedFinal: 1 })]);
  });

  it('fails on this device and is closed: one outcome with the final failure; closing again sends nothing', async () => {
    extractFromPdf.mockRejectedValue(new Error('timeout'));
    render_(); pick();
    await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(sent()).toEqual([expect.objectContaining({ picked: 1, failedFinal: 1 })]);
  });
});
