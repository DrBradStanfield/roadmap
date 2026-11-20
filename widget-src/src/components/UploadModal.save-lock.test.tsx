// @vitest-environment jsdom
/**
 * PR 1906 Codex re-check, owner rulings 2026-11-20 (US-12 AC6, AC28, US-13 AC13):
 * 1. While the shared state is `saving`, every review control is disabled, so nothing typed then is lost
 *    (the state refuses a choice while it saves); a failed Save opens them again, and the retry writes
 *    what the screen shows.
 * 2. While a file is still read, the window offers only Stop, which keeps what was read; the Cancel that
 *    discards the upload shows only once nothing is in flight.
 * The record is in memory (testing/upload-store.ts); Save runs health-core's real uploadSave. Synthetic only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { lastSaved, resetUploadStore, uploadStore } from '../testing/upload-store';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import type { UploadHistory } from '../lib/api-types';
import { findReviewValue, showAllValues } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', async () => ({ ...(await import('../testing/upload-store')).uploadStoreMock(), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => ''), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false) }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '/apps/synthetic', parseJsonResponse: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: async (b: Blob) => `sha256-${await b.text()}` }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const lab = (metric: string, v: number, day = '2024-06-01'): Import =>
  ({ result: { classification: 'lab_report', document: null, reportDate: day, values: [{ metric, valueSI: v, displayValue: v, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } }) as unknown as Import;
const history: UploadHistory = { measurements: [], labValues: [], documents: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const pdf = (name: string) => new File([name], name, { type: 'application/pdf' });
const pick = (...files: File[]) => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files } });
const saveButton = () => screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement;
const cells = () => Array.from(document.querySelectorAll<HTMLInputElement>('.bt-cell-input input'));
/** Every control the review offers: cells, ticks, dates, Replace, document fields, screening ticks, Try again. */
const controls = () => Array.from(document.querySelectorAll<HTMLElement>('.review-table input, .review-table button, .review-table select'))
  .filter(el => !el.classList.contains('review-save-btn') && !el.classList.contains('review-cancel-btn'));

beforeEach(() => {
  vi.clearAllMocks();
  resetUploadStore();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async (f: File) => ({ pages: [{ type: 'text', content: await f.text() }], truncated: false })),
    isPdf: (f: File) => f.name.endsWith('.pdf'), isZip: () => false, isImage: () => false, resizeImage: vi.fn(), docxToText: vi.fn(),
  } });
});
afterEach(cleanup);
const render_ = () => render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={history} onComplete={() => {}} sex="male" />);

describe('ruling 1: the review is locked while Save runs', () => {
  it('every control is disabled while saving; a failed Save opens them, and the retry writes what the screen shows', async () => {
    vi.mocked(labImport).mockResolvedValue(lab('ldl', 3.9));
    render_(); pick(pdf('a.pdf'));
    await findReviewValue('3.9');
    const saving = deferred<void>();
    uploadStore.hold = saving.promise;
    uploadStore.fail = new Error('synthetic save failure');
    fireEvent.click(saveButton());
    expect(controls().length).toBeGreaterThan(0);
    expect(controls().filter(el => !el.matches(':disabled'))).toEqual([]);
    expect(cells()[0].value).toBe('3.9');
    await act(async () => saving.resolve());
    expect(await screen.findByText('Failed to save. Please try again.')).toBeTruthy();
    expect(controls().filter(el => el.matches(':disabled') && el.closest('.bt-cell-input'))).toEqual([]);
    fireEvent.change(cells()[0], { target: { value: '4.1' } });
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().values.map(v => v.value)).toEqual([4.1]);
  });
});

describe('ruling 2: while a file is read, only Stop', () => {
  it('two reports, the first edited while the second reads: no Cancel; Stop keeps the first and its edit, aborts the second, ignores its late answer', async () => {
    const late = deferred<Import>();
    let signal: AbortSignal | undefined;
    vi.mocked(labImport).mockImplementation(async (p, _u, o) => {
      if (p[0].content === 'b.pdf') { signal = o?.signal; return late.promise; }
      return lab('ldl', 3.9);
    });
    render_(); pick(pdf('a.pdf'), pdf('b.pdf'));
    await findReviewValue('3.9');
    await waitFor(() => expect(signal).toBeDefined());
    fireEvent.change(cells()[0], { target: { value: '4.2' } });
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(signal!.aborted).toBe(true);
    await act(async () => late.resolve(lab('hdl', 1.4)));
    showAllValues();
    expect(cells().map(c => c.value)).toEqual(['4.2']);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().values.map(v => [v.metricName, v.value])).toEqual([['ldl', 4.2]]);
  });
});
