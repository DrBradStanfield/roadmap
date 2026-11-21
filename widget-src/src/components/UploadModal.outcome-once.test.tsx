// @vitest-environment jsdom
/**
 * US-12 AC10: each upload run fires ONE `upload_outcome`, "when it reaches review or fails" (its first settlement). The
 * mounted list's "Try again" (US-12 AC26) sends the shared retry, which keeps the run's number: a retry, its settlement,
 * a Stop or a Cancel after it never count the run again. Found by Codex on PR 1972 (new with the mount: the grid offered
 * no retry). Synthetic files and values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UPLOAD_ENGINE } from '../testing/upload-engine';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { trackProductEvent } from '../lib/server-api';
import { findReviewValue } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ recordFileSync: vi.fn(() => null), saveUpload: vi.fn(), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async (original) => ({ ...await original<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async (b: Blob) => `sha256-${await b.text()}`) }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const withValues = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/mL', confidence: 'high' }], additionalValues: [] } } as unknown as Import;
const serverError = { result: null, error: 'Extraction failed', errorCode: 'server_error' } as Import;
const pdf = (name: string) => new File([name], name, { type: 'application/pdf' });
const outcomes = () => vi.mocked(trackProductEvent).mock.calls.filter(([n]) => n === 'upload_outcome');
/** Each answer `bad.pdf` gets, in order; `good.pdf` always reads. A pending one never answers. */
let badAnswers: Array<Import | 'pending'> = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockImplementation((pages) => {
    if ((pages[0] as { content: string }).content !== 'bad.pdf') return Promise.resolve(withValues);
    const next = badAnswers.shift() ?? serverError;
    return next === 'pending' ? new Promise<Import>(() => {}) : Promise.resolve(next);
  });
  Object.assign(window, { HealthUpload: { ...UPLOAD_ENGINE, extractFromPdf: vi.fn(async (f: File) => ({ pages: [{ type: 'text', content: await f.text() }], truncated: false })), isPdf: () => true, isZip: () => false, isImage: () => false } });
});
afterEach(cleanup);

async function firstSettled() {
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" onComplete={() => {}} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [pdf('good.pdf'), pdf('bad.pdf')] } });
  await findReviewValue('3.9');
  await waitFor(() => expect(outcomes()).toHaveLength(1));
  expect(outcomes()[0][1]).toEqual(expect.objectContaining({ picked: 2, withValues: 1, serverError: 1 }));
}
const tryAgain = () => fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('US-12 AC10: one upload_outcome per run, at its first settlement, whatever Try again does after', () => {
  it('a retry that reads the file sends no second event', async () => {
    badAnswers = [serverError, withValues];
    await firstSettled();
    tryAgain();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    await settle();
    expect(outcomes()).toHaveLength(1);
  });

  it('a retry that fails again sends no second event', async () => {
    badAnswers = [serverError, serverError];
    await firstSettled();
    tryAgain();
    await waitFor(() => expect(labImport).toHaveBeenCalledTimes(3));
    await settle();
    expect(outcomes()).toHaveLength(1);
  });

  it.each(['Stop', 'Cancel'])('%s during a retry sends no second event', async (button) => {
    badAnswers = [serverError, 'pending'];
    await firstSettled();
    tryAgain();
    await waitFor(() => expect(labImport).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: button }));
    await settle();
    expect(outcomes()).toHaveLength(1);
  });
});
