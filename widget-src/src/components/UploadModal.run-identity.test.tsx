// @vitest-environment jsdom
// US-12 AC4: a cancelled read never reaches into a newer one, and a Cancel
// wins over a read that finishes in the same render.
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { trackProductEvent } from '../lib/server-api';
import type { UploadHistory } from '../lib/api-types';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'cloud'), bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), attachOriginals: vi.fn(async results => results), synthesizeLabArchiveEntries: vi.fn(() => []) }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

type Pages = { pages: Array<{ type: string; content: string }>; truncated: boolean };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const extraction = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } };
const emptyHistory: UploadHistory = { measurements: [], labValues: [], documents: [] };
const pages: Pages = { pages: [{ type: 'text', content: 'synthetic' }], truncated: false };
const extractFromPdf = vi.fn();
function Harness() {
  const [open, setOpen] = useState(true);
  return <UploadModal open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}
    unitSystem="si" grading={{}} history={emptyHistory} onComplete={() => {}} />;
}
const pick = (name: string) => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], name, { type: 'application/pdf' })] } });
const cancel = () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
const DROPZONE = 'Drop health records here, or click to browse';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(extraction as Awaited<ReturnType<typeof labImport>>);
  extractFromPdf.mockReset();
  Object.assign(window, { HealthUpload: { extractFromPdf, isPdf: () => true, isZip: () => false, isImage: () => false } });
});
afterEach(cleanup);

describe('US-12 AC4: read runs', () => {
  it('US-12 AC4: a cancelled read that ends late leaves the newer read its claim: Cancel still stops it', async () => {
    const readA = deferred<Pages>();
    const readB = deferred<Pages>();
    extractFromPdf.mockReturnValueOnce(readA.promise).mockReturnValueOnce(readB.promise);
    render(<Harness />);
    pick('a.pdf');
    await waitFor(() => expect(extractFromPdf).toHaveBeenCalledTimes(1));
    cancel();
    pick('b.pdf');
    await waitFor(() => expect(extractFromPdf).toHaveBeenCalledTimes(2));
    // A ends late; its run and its claim are gone.
    await act(async () => readA.resolve(pages));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(labImport).not.toHaveBeenCalled();
    // B still holds the claim, so this Cancel aborts B: it never reaches the reader.
    cancel();
    await act(async () => readB.resolve(pages));
    expect(screen.getByText(DROPZONE)).toBeTruthy();
    expect(labImport).not.toHaveBeenCalled();
  });

  it('US-12 AC4: Cancel in the same render as the read finishing ends on the dropzone', async () => {
    const readA = deferred<Pages>();
    extractFromPdf.mockReturnValueOnce(readA.promise);
    render(<Harness />);
    pick('a.pdf');
    await waitFor(() => expect(extractFromPdf).toHaveBeenCalledTimes(1));
    const button = screen.getByRole('button', { name: 'Cancel' });
    await act(async () => {
      readA.resolve(pages);
      // Wait until the read has handed over its result (its outcome is counted
      // just before), while the reading screen is still the one rendered.
      for (let i = 0; i < 50 && !vi.mocked(trackProductEvent).mock.calls.some(([n]) => n === 'upload_outcome'); i++) await new Promise(r => setTimeout(r, 0));
      expect(vi.mocked(trackProductEvent).mock.calls.some(([n]) => n === 'upload_outcome')).toBe(true);
      expect(button.isConnected).toBe(true);
      fireEvent.click(button);
    });
    expect(screen.getByText(DROPZONE)).toBeTruthy();
    expect(screen.queryByDisplayValue('3.9')).toBeNull();
  });
});
