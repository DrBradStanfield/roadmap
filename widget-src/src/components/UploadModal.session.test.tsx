// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { synthesizeLabArchiveEntries } from '../lib/archive-payloads';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { bulkSaveMeasurements, bulkSaveDocuments } from '../lib/roadmap-data';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: () => 'cloud', bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn() }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', () => ({ attachOriginals: async (results: unknown) => results, synthesizeLabArchiveEntries: vi.fn(() => []), connectorDocumentEntries: () => [], connectorOriginals: () => [] }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const extraction = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } };
const history = { bloodTests: [], labValues: [], documents: [] };
const onComplete = vi.fn();
const extractFromPdf = vi.fn();
function Harness({ onStart }: { onStart?: () => Promise<void> }) {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Upload records</button><UploadModal
    open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}
    unitSystem="si" history={history} onStart={onStart} onComplete={onComplete}
  /></>;
}
function selectFile() {
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], 'test.pdf', { type: 'application/pdf' })] } });
}
async function ready() {
  selectFile();
  return screen.findByDisplayValue('3.9');
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(extraction as Awaited<ReturnType<typeof labImport>>);
  vi.mocked(bulkSaveMeasurements).mockResolvedValue({ saved: [{}], skippedDuplicates: 0, errorCount: 0 } as Awaited<ReturnType<typeof bulkSaveMeasurements>>);
  vi.mocked(bulkSaveDocuments).mockResolvedValue({ saved: [], errorCount: 0 });
  extractFromPdf.mockResolvedValue([{ type: 'text', content: 'synthetic' }]);
  Object.assign(window, { HealthUpload: { extractFromPdf, isPdf: () => true, isZip: () => false, isImage: () => false } });
});
afterEach(cleanup);

describe('US-12 AC4–6 upload session ownership', () => {
  it('keeps review drafts when hidden and reopened', async () => {
    render(<Harness />);
    const value = await ready();
    fireEvent.change(value, { target: { value: '4.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /Ready for review/ }));
    expect(screen.getByDisplayValue('4.2')).toBeTruthy();
  });
  it('keeps a hidden extraction failure available to retry', async () => {
    const reading = deferred<never>();
    extractFromPdf.mockReturnValue(reading.promise);
    render(<Harness />); selectFile();
    await waitFor(() => expect(extractFromPdf).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => reading.reject(new Error('synthetic unreadable file')));
    fireEvent.click(await screen.findByRole('button', { name: /Upload needs attention/ }));
    expect(screen.getByText(/No readable files found/)).toBeTruthy();
    extractFromPdf.mockResolvedValue([{ type: 'text', content: 'retry' }]);
    await ready();
  });
  it('claims the session before quota resolves, so rapid selections launch once', async () => {
    const quota = deferred<{ allowed: boolean; remaining: number }>();
    vi.mocked(checkLabImportQuota).mockReturnValue(quota.promise);
    render(<Harness />);
    const picker = document.querySelector('input[type=file]')!;
    const event = { target: { files: [new File(['x'], 'test.pdf')] } };
    act(() => { fireEvent.change(picker, event); fireEvent.change(picker, event); });
    expect(checkLabImportQuota).toHaveBeenCalledOnce();
    await act(async () => quota.resolve({ allowed: true, remaining: 60 }));
    await screen.findByDisplayValue('3.9');
    expect(labImport).toHaveBeenCalledOnce();
  });
  it.each(['quota', 'draft flush'])('cancels while awaiting %s without later launching', async phase => {
    const pending = deferred<{ allowed: boolean; remaining: number }>();
    const flushing = deferred<void>();
    const onStart = vi.fn(() => flushing.promise);
    if (phase === 'quota') vi.mocked(checkLabImportQuota).mockReturnValue(pending.promise);
    render(<Harness onStart={phase === 'draft flush' ? onStart : undefined} />); selectFile();
    if (phase === 'draft flush') await waitFor(() => expect(onStart).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await act(async () => { pending.resolve({ allowed: true, remaining: 60 }); flushing.resolve(); });
    expect(labImport).not.toHaveBeenCalled();
    await ready();
    expect(labImport).toHaveBeenCalledOnce();
  });
  it('does not launch after unmount during quota', async () => {
    const quota = deferred<{ allowed: boolean; remaining: number }>();
    vi.mocked(checkLabImportQuota).mockReturnValue(quota.promise);
    const view = render(<Harness />); selectFile(); view.unmount();
    await act(async () => quota.resolve({ allowed: true, remaining: 60 }));
    expect(labImport).not.toHaveBeenCalled();
  });
  it('does not let a cancelled extraction replace a newer review', async () => {
    const oldRead = deferred<Array<{ type: string; content: string }>>();
    extractFromPdf.mockReturnValueOnce(oldRead.promise);
    render(<Harness />); selectFile();
    await waitFor(() => expect(extractFromPdf).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const value = await ready();
    fireEvent.change(value, { target: { value: '4.2' } });
    await act(async () => oldRead.resolve([{ type: 'text', content: 'cancelled result' }]));
    expect(screen.getByDisplayValue('4.2')).toBeTruthy();
    expect(labImport).toHaveBeenCalledOnce();
  });
  it('keeps failed save drafts for retry', async () => {
    vi.mocked(bulkSaveMeasurements).mockRejectedValueOnce(new Error('synthetic failure'));
    render(<Harness />); const value = await ready();
    fireEvent.change(value, { target: { value: '4.2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByText('Failed to save. Please try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /Upload needs attention/ }));
    expect(screen.getByDisplayValue('4.2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(bulkSaveMeasurements).toHaveBeenCalledTimes(2);
  });
  it('waits for all launched save branches before allowing retry or discard', async () => {
    const archive = deferred<Awaited<ReturnType<typeof bulkSaveDocuments>>>();
    vi.mocked(synthesizeLabArchiveEntries).mockReturnValueOnce([{
      documentType: 'pathology_report', title: 'Synthetic report', documentDate: '2024-06-01',
      contentMd: '', metadata: {}, sourceFileName: 'test.pdf',
    }]);
    vi.mocked(bulkSaveMeasurements).mockRejectedValueOnce(new Error('synthetic measurement failure'));
    vi.mocked(bulkSaveDocuments).mockReturnValueOnce(archive.promise);
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await waitFor(() => expect(bulkSaveDocuments).toHaveBeenCalledOnce());
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: /Saving health records/ })).toBeTruthy();
    await act(async () => archive.resolve({ saved: [{}], errorCount: 0 } as Awaited<ReturnType<typeof bulkSaveDocuments>>));
    fireEvent.click(screen.getByRole('button', { name: /Upload needs attention/ }));
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.getByText('1 item could not be saved. Please try again.')).toBeTruthy();
  });
  it('preserves a pending save, prevents discard, and resets after completion closes', async () => {
    const saving = deferred<Awaited<ReturnType<typeof bulkSaveMeasurements>>>();
    vi.mocked(bulkSaveMeasurements).mockReturnValue(saving.promise);
    render(<Harness />); await ready();
    const save = screen.getByRole('button', { name: /^Save / });
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    expect(bulkSaveMeasurements).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /Saving health records/ }));
    expect(screen.getByDisplayValue('3.9')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => saving.resolve({ saved: [{}], skippedDuplicates: 0, errorCount: 0 } as Awaited<ReturnType<typeof bulkSaveMeasurements>>));
    fireEvent.click(screen.getByRole('button', { name: /Health records saved/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload records' }));
    expect(screen.queryByDisplayValue('3.9')).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeTruthy();
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
