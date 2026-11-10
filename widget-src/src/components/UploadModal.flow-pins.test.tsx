// @vitest-environment jsdom
// Characterisation pins for the upload flow's modes (picking, reading, read
// failed, reviewing, saving, save failed, done) as UploadModal runs them today,
// before the mode moves into a hook. Modes the session, outcome and
// review-error tests already pin are not repeated here.
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { attachOriginals, synthesizeLabArchiveEntries } from '../lib/archive-payloads';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { bulkSaveMeasurements, bulkSaveDocuments, bulkSaveLabValues, getDocumentArchiveMode } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import type { UploadHistory } from '../lib/api-types';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'cloud'), bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), attachOriginals: vi.fn(async results => results), synthesizeLabArchiveEntries: vi.fn(() => []) }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Pages = { pages: Array<{ type: string; content: string }>; truncated: boolean };
const extraction = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } };
const emptyHistory: UploadHistory = { measurements: [], labValues: [], documents: [] };
const extractFromPdf = vi.fn();
const onClose = vi.fn();
function Harness() {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Upload records</button><UploadModal
    open={open} onOpen={() => setOpen(true)} onClose={() => { onClose(); setOpen(false); }}
    unitSystem="si" grading={{}} history={emptyHistory} onComplete={() => {}}
  /></>;
}
function pick(...files: File[]) {
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files } });
}
const pdf = (name = 'test.pdf', size?: number) => {
  const file = new File(['synthetic'], name, { type: 'application/pdf' });
  if (size) Object.defineProperty(file, 'size', { value: size });
  return file;
};
async function ready() {
  pick(pdf());
  return screen.findByDisplayValue('3.9');
}
const backdrop = () => document.querySelector<HTMLElement>('.upload-modal-backdrop')!;
const isOpen = () => backdrop().style.display !== 'none';
const indicator = () => document.querySelector<HTMLElement>('.floating-upload-indicator');
const close = () => fireEvent.click(screen.getByRole('button', { name: 'Close' }));
const reopen = () => fireEvent.click(screen.getByRole('button', { name: 'Upload records' }));
const escape = () => fireEvent.keyDown(document, { key: 'Escape' });
const events = (name: string) => vi.mocked(trackProductEvent).mock.calls.filter(([n]) => n === name);
const TOO_LARGE = 'Too large to read. The limit is 10 MB per file.';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(synthesizeLabArchiveEntries).mockReset().mockReturnValue([]);
  vi.mocked(getDocumentArchiveMode).mockReturnValue('cloud');
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(extraction as Awaited<ReturnType<typeof labImport>>);
  vi.mocked(bulkSaveMeasurements).mockReset().mockResolvedValue({ saved: [{}], skippedDuplicates: 0, errorCount: 0, refused: [] } as unknown as Awaited<ReturnType<typeof bulkSaveMeasurements>>);
  vi.mocked(bulkSaveDocuments).mockReset().mockResolvedValue({ saved: [], errorCount: 0 });
  vi.mocked(bulkSaveLabValues).mockReset().mockResolvedValue({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] });
  vi.mocked(attachOriginals).mockReset().mockImplementation(async results => results);
  extractFromPdf.mockReset().mockResolvedValue({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false });
  Object.assign(window, { HealthUpload: { extractFromPdf, isPdf: () => true, isZip: () => false, isImage: () => false } });
});
afterEach(cleanup);

describe('US-12 AC5: the floating indicator while the modal is hidden', () => {
  it('US-12 AC5: no indicator when the pick screen is hidden', () => {
    render(<Harness />);
    close();
    expect(isOpen()).toBe(false);
    expect(indicator()).toBeNull();
  });
  it('US-12 AC5: a hidden read says "Processing health records..." with a progress bar', async () => {
    extractFromPdf.mockReturnValue(deferred<never>().promise);
    render(<Harness />); pick(pdf());
    await waitFor(() => expect(extractFromPdf).toHaveBeenCalledOnce());
    close();
    expect(indicator()!.querySelector('.floating-upload-text')!.textContent).toBe('Processing health records...');
    expect(indicator()!.querySelector('.floating-upload-bar')).not.toBeNull();
  });
});

describe('US-12 AC4/AC5: Close per mode', () => {
  it('US-12 AC4: Close on the pick screen clears its too-large notices; reopening shows the empty dropzone', () => {
    render(<Harness />);
    pick(pdf('huge.pdf', 11 * 1024 * 1024));
    expect(screen.getByText(TOO_LARGE)).toBeTruthy();
    close();
    reopen();
    expect(isOpen()).toBe(true);
    expect(screen.getByText('Drop health records here, or click to browse')).toBeTruthy();
    expect(screen.queryByText(TOO_LARGE)).toBeNull();
    expect(screen.queryByText('huge.pdf')).toBeNull();
  });
  it('US-12 AC5: Close on a visible read failure resets it: no indicator, then the dropzone with no error and no file list', async () => {
    extractFromPdf.mockRejectedValue(new Error('synthetic unreadable file'));
    render(<Harness />); pick(pdf('bad.pdf'));
    expect(await screen.findByText(/No readable files found/)).toBeTruthy();
    expect(document.querySelector('.upload-file-list')).not.toBeNull();
    close();
    expect(indicator()).toBeNull();
    reopen();
    expect(screen.getByText('Drop health records here, or click to browse')).toBeTruthy();
    expect(screen.queryByText(/No readable files found/)).toBeNull();
    expect(document.querySelector('.upload-error')).toBeNull();
    expect(document.querySelector('.upload-file-list')).toBeNull();
  });
  it('US-12 AC5: Close during a read only hides it; the read still lands in review', async () => {
    const reading = deferred<Pages>();
    extractFromPdf.mockReturnValue(reading.promise);
    render(<Harness />); pick(pdf());
    await waitFor(() => expect(extractFromPdf).toHaveBeenCalledOnce());
    close();
    expect(isOpen()).toBe(false);
    await act(async () => reading.resolve({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ready for review. Click to open' }));
    expect(isOpen()).toBe(true);
    expect(screen.getByDisplayValue('3.9')).toBeTruthy();
  });
});

describe('US-12 AC4/AC5: Escape closes only while the modal is open', () => {
  it('US-12 AC4: Escape on the open pick screen closes and resets it, as Close does', () => {
    render(<Harness />);
    pick(pdf('huge.pdf', 11 * 1024 * 1024));
    escape();
    expect(isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    reopen();
    expect(screen.queryByText(TOO_LARGE)).toBeNull();
  });
  it('US-12 AC5: Escape on an open review hides it and keeps the drafts', async () => {
    render(<Harness />);
    fireEvent.change(await ready(), { target: { value: '4.2' } });
    escape();
    expect(isOpen()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ready for review. Click to open' }));
    expect(screen.getByDisplayValue('4.2')).toBeTruthy();
  });
  it('US-12 AC5: Escape while hidden does nothing: a save that finishes hidden stays recoverable as done', async () => {
    const saving = deferred<Awaited<ReturnType<typeof bulkSaveMeasurements>>>();
    vi.mocked(bulkSaveMeasurements).mockReturnValue(saving.promise);
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    close();
    await act(async () => saving.resolve({ saved: [{}], skippedDuplicates: 0, errorCount: 0, refused: [] } as unknown as Awaited<ReturnType<typeof bulkSaveMeasurements>>));
    expect(indicator()!.textContent).toBe('Health records saved. Click to open');
    onClose.mockClear();
    escape();
    expect(onClose).not.toHaveBeenCalled();
    expect(indicator()!.textContent).toBe('Health records saved. Click to open');
    fireEvent.click(indicator()!);
    expect(screen.getByText('Saved 1 blood test value')).toBeTruthy();
  });
  it('US-12 AC5: Escape while hidden does nothing: a read failure that lands hidden stays recoverable', async () => {
    const reading = deferred<never>();
    extractFromPdf.mockReturnValue(reading.promise);
    render(<Harness />); pick(pdf());
    await waitFor(() => expect(extractFromPdf).toHaveBeenCalledOnce());
    close();
    await act(async () => reading.reject(new Error('synthetic unreadable file')));
    onClose.mockClear();
    escape();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Upload needs attention. Click to open' }));
    expect(screen.getByText(/No readable files found/)).toBeTruthy();
  });
});

describe('US-12 AC4: a backdrop click closes as Close does', () => {
  it('US-12 AC4: a click inside the modal keeps it open; a click on the backdrop closes and resets the pick screen', () => {
    render(<Harness />);
    pick(pdf('huge.pdf', 11 * 1024 * 1024));
    fireEvent.click(document.querySelector('.upload-modal-header')!);
    fireEvent.click(document.querySelector('.upload-modal')!);
    expect(isOpen()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(backdrop());
    expect(isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    reopen();
    expect(screen.queryByText(TOO_LARGE)).toBeNull();
  });
  it('US-12 AC5: a backdrop click on a review only hides it', async () => {
    render(<Harness />); await ready();
    fireEvent.click(backdrop());
    expect(isOpen()).toBe(false);
    expect(indicator()!.textContent).toBe('Ready for review. Click to open');
  });
});

describe('US-12 AC10: a refused quota', () => {
  it.each([
    { message: 'Synthetic quota message.', shown: 'Synthetic quota message.' },
    { message: undefined, shown: 'Daily upload limit reached. You can upload more tomorrow.' },
  ])('US-12 AC10: allowed:false (message $message) shows "$shown", tracks no upload_started or upload_outcome, and releases the claim', async ({ message, shown }) => {
    vi.mocked(checkLabImportQuota).mockResolvedValueOnce({ allowed: false, remaining: 0, ...(message ? { message } : {}) });
    render(<Harness />); pick(pdf());
    expect(await screen.findByText(shown)).toBeTruthy();
    expect(screen.getByText('Drop health records here, or click to browse')).toBeTruthy();
    expect(extractFromPdf).not.toHaveBeenCalled();
    expect(events('upload_started')).toEqual([]);
    expect(events('upload_outcome')).toEqual([]);
    await ready();
    expect(checkLabImportQuota).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(shown)).toBeNull();
  });
});

describe('US-12 AC4: Cancel from review', () => {
  it('US-12 AC4: discards the review, closes, and brings back the connect-first panel in device-only mode', async () => {
    vi.mocked(getDocumentArchiveMode).mockReturnValue('device-only');
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Continue without keeping my files/ }));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(indicator()).toBeNull();
    reopen();
    expect(screen.getByText('Keep your original documents')).toBeTruthy();
    expect(screen.queryByDisplayValue('3.9')).toBeNull();
    expect(bulkSaveMeasurements).not.toHaveBeenCalled();
  });
});

describe('US-12 AC6: Save', () => {
  // US-12 AC6: upload_saved fires when the session reaches done, so a save into a record
  // erased before it finished (the erase remounts the window) does not count.
  it('US-12 AC6: a full save shows the done screen and tracks upload_saved with the count', async () => {
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(screen.getByText('Saved 1 blood test value')).toBeTruthy();
    expect(events('upload_saved')).toEqual([['upload_saved', { count: 1 }]]);
  });
  it('US-12 AC6: a branch errorCount stays in review with "Failed to save. Please try again." and the hidden indicator needs attention', async () => {
    vi.mocked(bulkSaveMeasurements).mockResolvedValueOnce({ saved: [], skippedDuplicates: 0, errorCount: 1, refused: [] });
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    expect(await screen.findByText('Failed to save. Please try again.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(events('upload_saved')).toEqual([]);
    close();
    expect(indicator()!.textContent).toBe('Upload needs attention. Click to open');
    fireEvent.click(indicator()!);
    expect(screen.getByDisplayValue('3.9')).toBeTruthy();
    expect(screen.getByText('Failed to save. Please try again.')).toBeTruthy();
  });
});
