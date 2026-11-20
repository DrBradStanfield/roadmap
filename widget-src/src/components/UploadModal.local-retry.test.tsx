// @vitest-environment jsdom
/**
 * PR 1906 final Codex pass, item 2 (US-12 AC9, AC26): a file that fails on this device for a reason a
 * retry can mend (its pages took too long to read, its bytes could not be read to hash them) always gets
 * its Try again, even when it is the only file and nothing reached the server. Try again runs that step
 * again. The record is in memory (testing/upload-store.ts). Synthetic only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { resetUploadStore } from '../testing/upload-store';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { sha256Blob } from '../lib/archive-payloads';
import type { UploadHistory } from '../lib/api-types';
import { findReviewValue } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', async () => ({ ...(await import('../testing/upload-store')).uploadStoreMock(), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => ''), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false) }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '/apps/synthetic', parseJsonResponse: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn() }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const lab: Import = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } } as unknown as Import;
const history: UploadHistory = { measurements: [], labValues: [], documents: [] };
const extractFromPdf = vi.fn();
const pick = () => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['a'], 'a.pdf', { type: 'application/pdf' })] } });

beforeEach(() => {
  vi.clearAllMocks();
  resetUploadStore();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(lab);
  vi.mocked(sha256Blob).mockResolvedValue('sha256-synthetic');
  extractFromPdf.mockReset().mockResolvedValue({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false });
  Object.assign(window, { HealthUpload: { extractFromPdf, isPdf: () => true, isZip: () => false, isImage: () => false } });
});
afterEach(cleanup);
const render_ = () => render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={history} onComplete={() => {}} />);

describe('a lone file that fails on this device for a mendable reason (item 2)', () => {
  it('its pages took too long: Try again shows, and reads it again', async () => {
    extractFromPdf.mockRejectedValueOnce(new Error('timeout'));
    render_(); pick();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await findReviewValue('3.9');
    expect(extractFromPdf).toHaveBeenCalledTimes(2);
  });

  it('its bytes could not be read to hash them: Try again shows, and hashes it again', async () => {
    vi.mocked(sha256Blob).mockRejectedValueOnce(new Error('synthetic read failure'));
    render_(); pick();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await findReviewValue('3.9');
    await waitFor(() => expect(sha256Blob).toHaveBeenCalledTimes(2));
  });
});
