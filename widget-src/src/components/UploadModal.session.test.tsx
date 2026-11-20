// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { lastSaved, resetUploadStore, uploadStore } from '../testing/upload-store';
import { sha256Blob } from '../lib/archive-payloads';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { getDocumentArchiveMode } from '../lib/roadmap-data';
import { Sentry } from '../lib/sentry';
import { WritesStoppedError } from '../lib/error-diagnostics';
import { trackProductEvent } from '../lib/server-api';
import type { UploadHistory } from '../lib/api-types';
import { findReviewValue } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', async () => ({ ...(await import('../testing/upload-store')).uploadStoreMock(), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async () => '') }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const extraction = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } };
const emptyHistory: UploadHistory = { measurements: [], labValues: [], documents: [] };
const letter = { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2024-06-01', contentMarkdown: 'letter', metadata: {} };
const archivedLetter = { id: 'd1', documentType: 'clinic_letter', title: letter.title, documentDate: letter.documentDate, contentMd: 'letter', metadata: {}, sourceFileName: 'test.pdf', createdAt: '2024-06-02T00:00:00Z' };
const onComplete = vi.fn();
const extractFromPdf = vi.fn();
/** `archived`: what a completed save leaves in the reloaded history. */
/** `refresh`: the page's re-read after a save; the history changes only once it ends. */
/** `rereadThrows`: the page's re-read throws at once, before it returns a promise. */
function Harness({ onStart, archived, completedHistory, initialHistory = emptyHistory, refresh, rereadThrows }: { onStart?: () => Promise<void>; archived?: typeof archivedLetter; completedHistory?: UploadHistory; initialHistory?: UploadHistory; refresh?: Promise<void>; rereadThrows?: boolean }) {
  const [open, setOpen] = useState(true);
  const [history, setHistory] = useState(initialHistory);
  return <><button onClick={() => setOpen(true)}>Upload records</button><UploadModal
    open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}
    unitSystem="si" grading={{}} history={history} onStart={onStart}
    onComplete={() => {
      onComplete();
      if (rereadThrows) throw new Error('synthetic re-read throw');
      if (refresh) return refresh.then(() => { if (completedHistory) setHistory(completedHistory); });
      if (completedHistory) setHistory(completedHistory); if (archived) setHistory({ ...emptyHistory, documents: [archived] });
    }}
  /></>;
}
function selectFile() {
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], 'test.pdf', { type: 'application/pdf' })] } });
}
async function ready() {
  selectFile();
  return findReviewValue('3.9');
}
beforeEach(() => {
  vi.clearAllMocks();
  resetUploadStore();
  vi.mocked(getDocumentArchiveMode).mockReturnValue('cloud');
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(extraction as Awaited<ReturnType<typeof labImport>>);
  vi.mocked(sha256Blob).mockReset().mockResolvedValue('');
  extractFromPdf.mockResolvedValue({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false });
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
    extractFromPdf.mockResolvedValue({ pages: [{ type: 'text', content: 'retry' }], truncated: false });
    await ready();
  });
  it('claims the session before quota resolves, so rapid selections launch once', async () => {
    const quota = deferred<Awaited<ReturnType<typeof checkLabImportQuota>>>();
    vi.mocked(checkLabImportQuota).mockReturnValue(quota.promise);
    render(<Harness />);
    const picker = document.querySelector('input[type=file]')!;
    const event = { target: { files: [new File(['x'], 'test.pdf')] } };
    act(() => { fireEvent.change(picker, event); fireEvent.change(picker, event); });
    expect(checkLabImportQuota).toHaveBeenCalledOnce();
    await act(async () => quota.resolve({ allowed: true, remaining: 60 }));
    await findReviewValue('3.9');
    expect(labImport).toHaveBeenCalledOnce();
  });
  it('does not launch after unmount during quota', async () => {
    const quota = deferred<Awaited<ReturnType<typeof checkLabImportQuota>>>();
    vi.mocked(checkLabImportQuota).mockReturnValue(quota.promise);
    const view = render(<Harness />); selectFile(); view.unmount();
    await act(async () => quota.resolve({ allowed: true, remaining: 60 }));
    expect(labImport).not.toHaveBeenCalled();
  });
  it('does not let a cancelled extraction replace a newer review', async () => {
    const oldRead = deferred<{ pages: Array<{ type: string; content: string }>; truncated: boolean }>();
    extractFromPdf.mockReturnValueOnce(oldRead.promise);
    render(<Harness />); selectFile();
    await waitFor(() => expect(extractFromPdf).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const value = await ready();
    fireEvent.change(value, { target: { value: '4.2' } });
    await act(async () => oldRead.resolve({ pages: [{ type: 'text', content: 'cancelled result' }], truncated: false }));
    expect(screen.getByDisplayValue('4.2')).toBeTruthy();
    expect(labImport).toHaveBeenCalledOnce();
  });


  it('US-13 AC13, US-12 AC4: Escape and × only hide the review; reopened and saved, it sends one upload_review, saved 1', async () => {
    const reviews = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'upload_review').map(([, meta]) => meta);
    render(<Harness />); await ready();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /Ready for review|Click to open/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(reviews()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /Ready for review|Click to open/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(reviews()).toEqual([expect.objectContaining({ saved: 1 })]);
  });
  it('US-13 AC13: Cancel ends the review and sends one upload_review, saved 0', async () => {
    const reviews = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'upload_review').map(([, meta]) => meta);
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(reviews()).toEqual([expect.objectContaining({ saved: 0 })]);
  });
  it('keeps a dismissed connect-first panel dismissed when processing is cancelled (US-12 AC4)', async () => {
    vi.mocked(getDocumentArchiveMode).mockReturnValue('device-only');
    extractFromPdf.mockReturnValue(deferred<never>().promise);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Continue without keeping my files/ }));
    selectFile();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(document.querySelector('input[type=file]')).toBeTruthy();
    expect(screen.queryByText('Keep your original documents')).toBeNull();
  });

  // US-21 phase 3 · a lab value the record refused for its unit is never a
  // silent drop: the summary names the test and the spelling it would not take.

  // US-21 AC15 · a unit the test does not take is named, never sent. A differential in % was
  // this example until US-21 AC28 stored it as its own test, so mg/L stands in.
  it('US-21 AC15 — a differential in a unit it does not take is named and never sent', async () => {
    vi.mocked(labImport).mockResolvedValue({
      result: { ...extraction.result, additionalValues: [{ name: 'Lymphocytes', value: 30, unit: 'mg/L', referenceLow: null, referenceHigh: null }] },
    } as Awaited<ReturnType<typeof labImport>>);
    render(<Harness />); await ready();
    // US-13 AC13: named before Save under "Not saved", in the review's words, and never sent.
    fireEvent.click(screen.getByRole('button', { name: '1 value not saved' }));
    expect(screen.getByRole('list', { name: 'Values not saved' }).textContent).toBe('Lymphocytes: this unit is not one we know for this test');
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().labValues).toEqual([]);
  });

  // US-21 AC15 · a count per µL refused for its NUMBER (a decimal, or a
  // hundredfold off its own range) is not an unknown unit, so the summary
  // does not say so: it says the number was not saved, and why.
  // US-13 AC13 (owner, 2026-11-15): a lab the write refuses for its number is
  // named before Save under "Not saved", in the review's words, and never sent.
  // Before, the done screen named it with the US-21 AC15/AC26 line after Save refused it.
  it.each([
    ['US-21 AC15 — a count per µL that is not whole', { name: 'Neutrophils', value: 2.4, unit: 'cells/uL', referenceLow: null, referenceHigh: null }, 'Neutrophils: the number and its range are on different scales'],
    ['US-21 AC15 — a count per µL on a different scale from its printed range', { name: 'Platelets', value: 250000, unit: 'cells/µL', referenceLow: 150, referenceHigh: 400 }, 'Platelets: the number and its range are on different scales'],
    ['US-21 AC26 — a value past its plausible range', { name: 'Glucose', value: 3000, unit: 'mg/dL', referenceLow: null, referenceHigh: null }, 'Glucose: the number looks misread. Check the report'],
  ])('%s is named before Save, never sent, and its number never shown', async (_name, value, line) => {
    vi.mocked(labImport).mockResolvedValue({ result: { ...extraction.result, additionalValues: [value] } } as Awaited<ReturnType<typeof labImport>>);
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole('button', { name: '1 value not saved' }));
    expect(screen.getByRole('list', { name: 'Values not saved' }).textContent).toBe(line);
    expect(document.body.textContent).not.toContain(String(value.value));
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().labValues).toEqual([]);
  });
});

// Design PR 10, 12c: one Save is one edit (health-core uploadSave). A Save that fails writes nothing
// and keeps the review, its drafts and its words, for a retry that writes it all once; the partial
// saves and their retry counts (US-12 AC6c) are gone with the two-branch save.
describe('US-12 AC6: one Save, all or nothing', () => {
  const reviews = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'upload_review').map(([, meta]) => meta);

  it('a failed Save keeps the drafts for a retry; one upload_review, saved 1, when the retry lands (US-13 AC13)', async () => {
    uploadStore.fail = new Error('synthetic save failure'); // a Save that throws: "Failed to save"
    render(<Harness />); const value = await ready();
    fireEvent.change(value, { target: { value: '4.2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByText('Failed to save. Please try again.');
    expect(reviews()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /Upload needs attention/ }));
    expect(screen.getByDisplayValue('4.2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().values).toEqual([expect.objectContaining({ metricName: 'ldl', value: 4.2, source: 'lab_import_edited' })]);
    expect(reviews()).toEqual([expect.objectContaining({ saved: 1 })]);
  });

  it.each([
    { name: 'a log-off refusal', error: () => new WritesStoppedError(), reports: 0 },
    { name: 'any other throw', error: () => new Error('synthetic save failure'), reports: 1 },
  ])('US-09 AC2c, lead A19: a Save that throws $name reports $reports time(s), tag only, and keeps the review for a retry', async ({ error, reports }) => {
    uploadStore.fail = error();
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    expect(await screen.findByText('Failed to save. Please try again.')).toBeTruthy();
    expect(screen.getByDisplayValue('3.9')).toBeTruthy();
    expect(Sentry.captureException).toHaveBeenCalledTimes(reports);
    if (reports) expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { area: 'upload-save', branch: 'save' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
  });

  it.each([
    { name: 'a log-off refusal', error: () => new WritesStoppedError(), reports: 0 },
    { name: 'any other throw', error: () => new Error('synthetic re-read failure'), reports: 1 },
  ])('US-09 AC2c, lead A19: a re-read after a finished save that fails with $name reports $reports time(s) and the save stays done', async ({ error, reports }) => {
    const failedReread = Promise.reject(error());
    failedReread.catch(() => {});
    render(<Harness refresh={failedReread} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(screen.getByText(/^Saved 1 value/)).toBeTruthy();
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    await act(async () => { await failedReread.catch(() => {}); });
    expect(Sentry.captureException).toHaveBeenCalledTimes(reports);
  });

  it('a re-read that throws at once after a finished save is reported, tag only, and the save stays done', async () => {
    render(<Harness rereadThrows />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(screen.queryByText(/try again/)).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { area: 'upload-save', branch: 'reread' } });
  });

  it('preserves a pending save, prevents discard, and resets after completion closes', async () => {
    let finish!: () => void;
    uploadStore.hold = new Promise<void>(resolve => { finish = resolve; });
    render(<Harness />); await ready();
    const save = screen.getByRole('button', { name: /^Save / });
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /Saving health records/ }));
    expect(screen.getByDisplayValue('3.9')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => finish());
    expect(uploadStore.saves).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Health records saved/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload records' }));
    expect(screen.queryByDisplayValue('3.9')).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeTruthy();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  // US-14 AC4, design 12c: every original the cloud would not store is counted, and the done screen says so.
  it('US-14 AC4: the done screen says when an original could not be stored', async () => {
    uploadStore.writeFails = true;
    vi.mocked(sha256Blob).mockResolvedValue('sha256-test');
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    expect(await screen.findByText("The original file couldn't be stored; its details are saved.")).toBeTruthy();
  });

  it('a corrected column date reaches the lab-archive row', async () => {
    render(<Harness />); await ready();
    fireEvent.change(screen.getByLabelText('Choose column date'), { target: { value: '2024-06-15' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().documents).toEqual([expect.objectContaining({ title: 'Blood test results', date: '2024-06-15', sourceFileName: 'test.pdf' })]);
  });
});
