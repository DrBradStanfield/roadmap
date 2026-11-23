// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_ENGINE } from '../testing/upload-engine';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { sha256Blob } from '../lib/archive-payloads';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { getDocumentArchiveMode, saveUpload } from '../lib/roadmap-data';
import { Sentry } from '../lib/sentry';
import { WritesStoppedError } from '../lib/error-diagnostics';
import { trackProductEvent } from '../lib/server-api';
import { findReviewValue, notSaved } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ recordFileSync: vi.fn(() => null), saveUpload: vi.fn(), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
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
const onComplete = vi.fn();
const extractFromPdf = vi.fn();
/** The shared Save's answers: its commit landed, or it refused (an erase moved; the page's words). */
const LANDED: Awaited<ReturnType<typeof saveUpload>> = { ok: true, outcome: { values: 1, documents: 0, archived: 0, unstored: 0 }, added: [] };
const REFUSED: Awaited<ReturnType<typeof saveUpload>> = { ok: false, reason: 'erased', message: 'Failed to save. Please try again.' };
/** `refresh`: the page's re-read after a save. `rereadThrows`: the re-read throws at once, before it returns a promise. */
function Harness({ onStart, refresh, rereadThrows }: { onStart?: () => Promise<void>; refresh?: Promise<void>; rereadThrows?: boolean }) {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Upload records</button><UploadModal
    open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}
    unitSystem="si" onStart={onStart}
    onComplete={() => {
      onComplete();
      if (rereadThrows) throw new Error('synthetic re-read throw');
      if (refresh) return refresh;
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
  vi.mocked(getDocumentArchiveMode).mockReturnValue('cloud');
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(extraction as Awaited<ReturnType<typeof labImport>>);
  // Reset, not cleared: a test that fails early must not leave its queued answers to the next.
  vi.mocked(saveUpload).mockReset().mockResolvedValue(LANDED);
  vi.mocked(sha256Blob).mockReset().mockResolvedValue('');
  extractFromPdf.mockResolvedValue({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false });
  Object.assign(window, { HealthUpload: { ...UPLOAD_ENGINE, extractFromPdf, isPdf: () => true, isZip: () => false, isImage: () => false } });
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
  it.each(['quota', 'draft flush'])('cancels while awaiting %s without later launching', async phase => {
    const pending = deferred<Awaited<ReturnType<typeof checkLabImportQuota>>>();
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
  // Mount 3b: one Save, one commit or none (health-core uploadSave). A failed Save keeps the review and its drafts, and
  // the person saves again from it (upload-flow `saveFailed` → `saveStarted`).
  it('keeps failed save drafts for retry', async () => {
    vi.mocked(saveUpload).mockRejectedValueOnce(new Error('synthetic failure'));
    render(<Harness />); const value = await ready();
    act(() => value.focus());
    fireEvent.change(value, { target: { value: '4.2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByText('Failed to save. Please try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /Upload needs attention/ }));
    expect(screen.getByDisplayValue('4.2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(saveUpload).toHaveBeenCalledTimes(2);
    // The correction typed before the first Save, never blurred, is in what each Save was handed (owner ruling 1).
    const edits = (call: number) => {
      const s = vi.mocked(saveUpload).mock.calls[call][1];
      return s.phase === 'saving' && s.files[0].status.s === 'read' && s.files[0].status.choices.edits;
    };
    expect([edits(0), edits(1)]).toEqual([{ v0: 4.2 }, { v0: 4.2 }]);
  });
  it('US-13 AC13: one upload_review per review: none for the failed Save, one, saved 1, when the retry finishes', async () => {
    vi.mocked(saveUpload).mockResolvedValueOnce(REFUSED);
    const reviews = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'upload_review').map(([, meta]) => meta);
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByText('Failed to save. Please try again.');
    expect(reviews()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    // `showAll` 1: the review was opened to reach the value. `notSavedOpened` is no longer sent (the list has no disclosure).
    expect(reviews()).toEqual([{ sure: 1, showAll: 1, saved: 1 }]);
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
  it('US-13 AC13: Cancel ends the review and sends one upload_review, saved 0, with what the person changed', async () => {
    const reviews = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'upload_review').map(([, meta]) => meta);
    render(<Harness />); const value = await ready();
    act(() => value.focus());
    fireEvent.change(value, { target: { value: '' } });
    act(() => value.blur());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(reviews()).toEqual([expect.objectContaining({ showAll: 1, changedSure: 1, saved: 0 })]);
  });
  it.each([
    { name: 'a log-off refusal', error: () => new WritesStoppedError(), reports: 0 },
    { name: 'any other throw', error: () => new Error('synthetic save failure'), reports: 1 },
  ])('US-09 AC2c, lead A19: a Save that throws $name reports $reports time(s) and keeps the review for a retry', async ({ error, reports }) => {
    vi.mocked(saveUpload).mockRejectedValueOnce(error());
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    expect(await screen.findByText('Failed to save. Please try again.')).toBeTruthy();
    expect(screen.getByDisplayValue('3.9')).toBeTruthy();
    expect(Sentry.captureException).toHaveBeenCalledTimes(reports);
    expect(onComplete).not.toHaveBeenCalled();
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
    expect(screen.getByText('Saved 1 value.')).toBeTruthy();
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    await act(async () => { await failedReread.catch(() => {}); });
    expect(Sentry.captureException).toHaveBeenCalledTimes(reports);
  });
  it('a re-read that throws at once after a finished save is reported, tag only, and the save stays done', async () => {
    render(<Harness rereadThrows />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(vi.mocked(Sentry.captureException).mock.calls.map(([, context]) => context)).toEqual([{ tags: { area: 'upload-save', branch: 'reread' } }]);
  });
  it('keeps a dismissed connect-first panel dismissed when processing is cancelled (US-12 AC4)', async () => {
    vi.mocked(getDocumentArchiveMode).mockReturnValue('device-only');
    extractFromPdf.mockReturnValue(deferred<never>().promise);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Continue without keeping the files/ }));
    selectFile();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(document.querySelector('input[type=file]')).toBeTruthy();
    expect(screen.queryByText('Keep the original files too?')).toBeNull();
  });
  it('preserves a pending save, prevents discard, and resets after completion closes', async () => {
    const saving = deferred<Awaited<ReturnType<typeof saveUpload>>>();
    vi.mocked(saveUpload).mockReturnValue(saving.promise);
    render(<Harness />); await ready();
    const save = screen.getByRole('button', { name: /^Save / });
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    await waitFor(() => expect(saveUpload).toHaveBeenCalledOnce());
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /Saving health records/ }));
    expect(screen.getByDisplayValue('3.9')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => saving.resolve(LANDED));
    fireEvent.click(screen.getByRole('button', { name: /Health records saved/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload records' }));
    expect(screen.queryByDisplayValue('3.9')).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeTruthy();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(saveUpload).toHaveBeenCalledOnce();
  });
});

// US-13 AC13, US-21 AC15, AC26: a lab value the write would refuse, for its unit or its number, is named under the
// list's "Not saved" before Save, in the review's words, its number never shown. The Save's plan never sends it
// (health-core import-review.save-agreement.test.ts); the refused spelling's count is roadmap-data.save-upload.test.ts's.
describe('US-21 AC15, AC26: a refused lab value is named before Save', () => {
  it.each([
    ['a unit the test does not take', { name: 'Ferritin', value: 80, unit: 'mg/dL', referenceLow: null, referenceHigh: null }, 'Ferritin: this unit is not one we know for this test'],
    ['a differential in a unit it does not take', { name: 'Lymphocytes', value: 30, unit: 'mg/L', referenceLow: null, referenceHigh: null }, 'Lymphocytes: this unit is not one we know for this test'],
    ['a count per µL that is not whole', { name: 'Neutrophils', value: 2.4, unit: 'cells/uL', referenceLow: null, referenceHigh: null }, 'Neutrophils: the number and its range are on different scales'],
    ['a count per µL on a different scale from its printed range', { name: 'Platelets', value: 250000, unit: 'cells/µL', referenceLow: 150, referenceHigh: 400 }, 'Platelets: the number and its range are on different scales'],
    ['a value past its plausible range', { name: 'Glucose', value: 3000, unit: 'mg/dL', referenceLow: null, referenceHigh: null }, 'Glucose: the number looks misread. Check the report'],
  ])('%s', async (_name, value, line) => {
    vi.mocked(labImport).mockResolvedValue({ result: { ...extraction.result, additionalValues: [value] } } as Awaited<ReturnType<typeof labImport>>);
    render(<Harness />); await ready();
    expect(notSaved()).toEqual({ title: '1 value not saved', lines: [line] });
    expect(document.body.textContent).not.toContain(String(value.value));
  });
});

// US-14 AC4, AC12, layout pin (Brad 2026-11-21: the same layout elements as the save confirmation): the not-stored
// line sits in the confirmation's own line element, once, whatever the count: no new element, no new words. The count
// itself is the shared Save's (health-core upload-save.keep-original.test.ts, storage/roadmap-store-upload-save.test.ts).
it.each([0, 1, 3])('US-14 AC12 layout pin: the done screen with %i unstored originals', async (unstored) => {
  vi.mocked(saveUpload).mockResolvedValue({ ok: true, outcome: { values: 1, documents: 0, archived: 0, unstored }, added: [] });
  render(<Harness />); await ready();
  fireEvent.click(screen.getByRole('button', { name: /^Save / }));
  await screen.findByRole('button', { name: 'Done' });
  const done = document.querySelector('.upload-done')!;
  const lines = [...done.children].map((el) => `${el.tagName.toLowerCase()}.${el.className}: ${el.textContent}`);
  const unstoredLine = "p.upload-done-skipped: The original file couldn't be stored; its details are saved.";
  expect(lines).toEqual([
    'div.upload-done-icon: ✓',
    'p.upload-done-text: Saved 1 value.',
    ...(unstored ? [unstoredLine] : []),
    'button.btn-primary upload-done-btn: Done',
  ]);
});
