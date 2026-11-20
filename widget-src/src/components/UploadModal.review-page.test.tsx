// @vitest-environment jsdom
/**
 * Design PR 10 and 12c: the web's upload window drawn from health-core's view and saved through
 * health-core's uploadSave. US-12 AC26 (results as each file is read, Save waits with its reason,
 * Try again for one file), AC27 (a file the record holds is only counted), AC28 (Stop keeps what was
 * read), US-13 AC13 (every choice is the shared state's), US-12 AC10 (counts only). The record is in
 * memory (testing/upload-store.ts) and Save runs health-core's real uploadSave on it. Synthetic only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { UploadModal } from './UploadModal';
import { lastSaved, resetUploadStore, uploadStore } from '../testing/upload-store';
import { recordOf } from '../testing/review-harness';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { trackProductEvent } from '../lib/server-api';
import { uploadKnownIndex } from '../lib/roadmap-data';
import type { UploadHistory } from '../lib/api-types';
import { showAllValues } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', async () => ({ ...(await import('../testing/upload-store')).uploadStoreMock(), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => ''), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false) }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '/apps/synthetic', parseJsonResponse: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: async (b: Blob) => `sha256-${await b.text()}` }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const lab = (metric: string, v: number, day = '2024-06-01', more: Record<string, unknown> = {}): Import =>
  ({ result: { classification: 'lab_report', document: null, reportDate: day, values: [{ metric, valueSI: v, displayValue: v, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [], ...more } }) as unknown as Import;
const scan: Import = { result: { classification: 'scan_result', reportDate: null, values: [], additionalValues: [],
  document: { classification: 'scan_result', title: 'Synthetic scan', documentDate: '2024-05-01', contentMarkdown: 'scan', metadata: { screeningType: 'colorectal' } } } } as unknown as Import;
const busy: Import = { result: null, error: 'Not read', errorCode: 'busy' } as unknown as Import;
const history: UploadHistory = { measurements: [], labValues: [], documents: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
/** Each file's answer by the text its pages carry (its name). */
function answers(by: Record<string, Import | Promise<Import>>) {
  vi.mocked(labImport).mockImplementation(async p => by[p[0].content as string]);
}
const pdf = (name: string) => new File([name], name, { type: 'application/pdf' });
const pick = (...files: File[]) => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files } });
const saveButton = () => screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement;
const inputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('.bt-cell-input input')).map(i => i.value).sort();
const sentFor = (id: string) => vi.mocked(labImport).mock.calls.filter(c => c[0][0].content === id).length;
/** The state the last Save was asked with. */
const savedState = (): UploadState => uploadStore.saves.at(-1)!.state;
const choicesOf = (name: string) => {
  const s = savedState();
  const f = 'files' in s ? s.files.find(x => x.name === name) : undefined;
  return f?.status.s === 'read' ? f.status.choices : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  resetUploadStore();
  vi.mocked(uploadKnownIndex).mockReturnValue(new Map());
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async (f: File) => ({ pages: [{ type: 'text', content: await f.text() }], truncated: false })),
    isPdf: (f: File) => f.name.endsWith('.pdf'), isZip: () => false, isImage: () => false, resizeImage: vi.fn(), docxToText: vi.fn(),
  } });
});
afterEach(cleanup);
const render_ = (more: { age?: number } = {}) => render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={history} onComplete={() => {}} sex="male" {...more} />);

describe('US-12 AC26: results show as each file is read', () => {
  it('three files, one slow: the first two are in the review while the third reads, and Save waits, saying why', async () => {
    const slow = deferred<Import>();
    answers({ 'a.pdf': lab('ldl', 3.9), 'b.pdf': lab('hdl', 1.4, '2024-07-01'), 'c.pdf': slow.promise });
    render_(); pick(pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'));
    await waitFor(() => { showAllValues(); expect(inputs()).toEqual(['1.4', '3.9']); });
    expect(screen.getByText('Reading 2 of 3 files')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('Wait for 1 file to finish')).toBeTruthy();
    await act(async () => slow.resolve(lab('triglycerides', 1.1, '2024-08-01')));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.queryByText('Wait for 1 file to finish')).toBeNull();
    expect(screen.queryByText(/^Reading \d+ of/)).toBeNull();
  });

  it('a failed file shows its reason and Try again; Try again sends that file alone and keeps the other\'s edit', async () => {
    let first = true;
    vi.mocked(labImport).mockImplementation(async p => {
      if (p[0].content === 'b.pdf' && first) { first = false; return busy; }
      return p[0].content === 'a.pdf' ? lab('ldl', 3.9) : lab('hdl', 1.4, '2024-07-01');
    });
    render_(); pick(pdf('a.pdf'), pdf('b.pdf'));
    const failed = await screen.findByText('1 file not read');
    expect(failed.closest('.review-failed-files')!.textContent).toContain('Not read. Our server was busy. Please try again later.');
    expect(saveButton().disabled).toBe(false); // a failed file never blocks Save
    showAllValues();
    fireEvent.change(screen.getByDisplayValue('3.9'), { target: { value: '4.4' } });
    const sentA = sentFor('a.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('1 file not read')).toBeNull());
    expect(sentFor('a.pdf')).toBe(sentA);
    expect(sentFor('b.pdf')).toBe(2);
    showAllValues();
    expect(inputs()).toEqual(['1.4', '4.4']);
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().values.map(v => [v.metricName, v.value]).sort()).toEqual([['hdl', 1.4], ['ldl', 4.4]]);
  });

  it('US-12 AC28: Stop keeps what was read; the stopped file is named, and Save writes the rest', async () => {
    answers({ 'a.pdf': lab('ldl', 3.9), 'b.pdf': new Promise<Import>(() => {}) });
    render_(); pick(pdf('a.pdf'), pdf('b.pdf'));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    showAllValues();
    expect(inputs()).toEqual(['3.9']);
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().values.map(v => v.value)).toEqual([3.9]);
  });
});

// PR 1906 fix round, item 1: a typed cell belongs to its file and value, not to its place in the review.
describe('US-12 AC26: an earlier file that is read late never moves a typed value onto another file', () => {
  /** What the cells show, by test, and what Save wrote, by test. */
  const shown = () => Object.fromEntries([...document.querySelectorAll<HTMLInputElement>('.bt-cell-input input')].map(i => [i.getAttribute('aria-label')?.split(' value')[0], i.value]));

  it('a slow earlier file finishing after an edit to a later one', async () => {
    const slow = deferred<Import>();
    answers({ 'a.pdf': slow.promise, 'b.pdf': lab('hdl', 1.4, '2024-07-01') });
    render_(); pick(pdf('a.pdf'), pdf('b.pdf'));
    await waitFor(() => { showAllValues(); expect(inputs()).toEqual(['1.4']); });
    fireEvent.change(screen.getByDisplayValue('1.4'), { target: { value: '1.6' } });
    await act(async () => slow.resolve(lab('ldl', 3.9)));
    await waitFor(() => { showAllValues(); expect(inputs()).toEqual(['1.6', '3.9']); });
    expect(shown()).toMatchObject({ 'HDL Cholesterol': '1.6', 'LDL Cholesterol': '3.9' });
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(Object.fromEntries(lastSaved().values.map(v => [v.metricName, v.value]))).toEqual({ hdl: 1.6, ldl: 3.9 });
  });

  it('Try again on an earlier failed file after an edit to a later one', async () => {
    let first = true;
    vi.mocked(labImport).mockImplementation(async p => {
      if (p[0].content === 'a.pdf' && first) { first = false; return busy; }
      return p[0].content === 'a.pdf' ? lab('ldl', 3.9) : lab('hdl', 1.4, '2024-07-01');
    });
    render_(); pick(pdf('a.pdf'), pdf('b.pdf'));
    await screen.findByText('1 file not read');
    showAllValues();
    fireEvent.change(screen.getByDisplayValue('1.4'), { target: { value: '1.6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => { showAllValues(); expect(inputs()).toEqual(['1.6', '3.9']); });
    expect(shown()).toMatchObject({ 'HDL Cholesterol': '1.6', 'LDL Cholesterol': '3.9' });
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(Object.fromEntries(lastSaved().values.map(v => [v.metricName, v.value]))).toEqual({ hdl: 1.6, ldl: 3.9 });
  });
});

// PR 1906 fix round, item 2: a choice made after a failed Save is what the retry writes.
describe('US-12 AC6: edits after a failed Save are what the retry writes', () => {
  it('an edit and a clear after the failed Save, then the retry: the rows are what the screen shows', async () => {
    answers({ 'a.pdf': lab('ldl', 3.9, '2024-06-01', { values: [
      { metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' },
      { metric: 'hdl', valueSI: 1.4, displayValue: 1.4, displayUnit: 'mmol/L', confidence: 'high' },
    ] }) });
    uploadStore.fail = new Error('synthetic save failure'); // a Save that throws: "Failed to save"
    render_(); pick(pdf('a.pdf'));
    await waitFor(() => { showAllValues(); expect(inputs()).toEqual(['1.4', '3.9']); });
    fireEvent.click(saveButton());
    await screen.findByText('Failed to save. Please try again.');
    fireEvent.change(screen.getByDisplayValue('3.9'), { target: { value: '4.4' } });
    fireEvent.change(screen.getByDisplayValue('1.4'), { target: { value: '' } });
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().values.map(v => [v.metricName, v.value])).toEqual([['ldl', 4.4]]);
  });
});

// PR 1906 fix round, item 5 (US-06 AC5, owner ruling (a)): the screening update is as visible as before:
// shown outside the collapsed documents row, ticked by default, so no date is written from a letter the
// person never saw offered.
describe('US-06 AC5: a letter\'s screening update shows with the documents row closed', () => {
  it('is visible and ticked with the list closed; unticked, no date is written', async () => {
    answers({ 'scan.pdf': scan });
    render_({ age: 60 }); pick(pdf('scan.pdf'));
    const row = await screen.findByText((_, el) => el?.classList.contains('review-screening-update') ?? false);
    expect(screen.getByRole('button', { name: '1 letter or document will be saved' }).getAttribute('aria-expanded')).toBe('false');
    expect(row.textContent).toBe('Update colorectal screening date to 2024-05-01');
    const box = row.querySelector('input')!;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(uploadStore.record.screenings.colorectalLastDate).toBeUndefined();
  });
});

describe('US-12 AC27: a file the record holds is counted, never offered again', () => {
  it('the summary and the files list count it; Save writes nothing for it', async () => {
    vi.mocked(uploadKnownIndex).mockReturnValue(new Map([['sha256-old.pdf', { as: 'document', archiveOnly: false }]]));
    answers({ 'new.pdf': lab('ldl', 3.9) });
    render_(); pick(pdf('old.pdf'), pdf('new.pdf'));
    expect((await screen.findByText(/^2 files: 1 already in your record/)).textContent).toBe('2 files: 1 already in your record, 1 lab report');
    fireEvent.click(screen.getByRole('button', { name: 'Files (2)' }));
    expect(document.querySelector('.review-files')!.textContent).toContain('old.pdf Already in your record');
    expect(sentFor('old.pdf')).toBe(0);
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().documents.map(d => d.sourceFileName)).toEqual(['new.pdf']);
  });
});

describe('US-13 AC13, design 12c: every choice is the shared state\'s, and Save writes from it', () => {
  it('a cleared value, an edit, the test\'s day, a Replace, a letter\'s title, date and screening tick', async () => {
    resetUploadStore(recordOf({ ...history, measurements: [{ id: 'H', metricType: 'hdl', value: 1.2, recordedAt: '2024-06-02T00:00:00.000Z', createdAt: '2024-06-02T00:00:00.000Z' }] }));
    answers({ 'labs.pdf': lab('ldl', 3.9, '2024-06-01', { values: [
      { metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' },
      { metric: 'hdl', valueSI: 1.4, displayValue: 1.4, displayUnit: 'mmol/L', confidence: 'high' },
      { metric: 'triglycerides', valueSI: 1.1, displayValue: 1.1, displayUnit: 'mmol/L', confidence: 'high' },
    ] }), 'scan.pdf': scan });
    render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} sex="male" age={60}
      history={{ ...history, measurements: [{ id: 'H', metricType: 'hdl', value: 1.2, recordedAt: '2024-06-02T00:00:00.000Z', createdAt: '2024-06-02T00:00:00.000Z' }] }} onComplete={() => {}} />);
    pick(pdf('labs.pdf'), pdf('scan.pdf'));
    await screen.findByText(/^2 files/);
    showAllValues();
    fireEvent.change(screen.getByLabelText('Choose column date'), { target: { value: '2024-06-02' } });
    fireEvent.change(screen.getByDisplayValue('3.9'), { target: { value: '4.4' } });
    fireEvent.change(screen.getByDisplayValue('1.1'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Replace the saved HDL Cholesterol value/ }));
    fireEvent.change(screen.getByDisplayValue('Synthetic scan'), { target: { value: 'Reviewed scan' } });
    fireEvent.change(screen.getByLabelText('Document date'), { target: { value: '2024-05-03' } });
    const screening = document.querySelector<HTMLInputElement>('.review-screening-update input')!;
    expect(screening.checked).toBe(true);
    fireEvent.click(screening);
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(choicesOf('labs.pdf')).toMatchObject({ testDay: '2024-06-02', ticks: { v2: false }, edits: { v0: 4.4 }, replace: { v1: 'H' } });
    expect(choicesOf('scan.pdf')).toMatchObject({ document: { title: 'Reviewed scan', date: expect.stringMatching(/^2024-05-03/) }, screening: false });
    const { values, documents } = lastSaved();
    expect(values.map(v => [v.metricName, v.value, v.correctsId ?? null]).sort()).toEqual([['hdl', 1.4, 'H'], ['ldl', 4.4, null]]);
    expect(documents.find(d => d.sourceFileName === 'scan.pdf')).toMatchObject({ title: 'Reviewed scan', date: expect.stringMatching(/^2024-05-03/) });
    expect(uploadStore.record.screenings.colorectalLastDate).toBeUndefined(); // the person unticked it
  });
});

describe('US-12 AC10: the upload\'s events carry counts only', () => {
  it('no file name, hash, value or unit reaches an event', async () => {
    answers({ 'Secret-Name.pdf': lab('ldl', 3.9), 'scan.pdf': scan });
    render_({ age: 60 }); pick(pdf('Secret-Name.pdf'), pdf('scan.pdf'));
    await screen.findByText(/^2 files/);
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    const events = vi.mocked(trackProductEvent).mock.calls;
    expect(events.map(([name]) => name)).toEqual(expect.arrayContaining(['upload_started', 'upload_outcome', 'upload_review', 'upload_saved']));
    const text = JSON.stringify(events);
    for (const secret of ['Secret', 'sha256', '3.9', 'mmol', 'Synthetic scan', 'colorectal', '2024']) expect(text).not.toContain(secret);
    for (const [, meta] of events) for (const v of Object.values(meta ?? {})) expect(typeof v === 'number' || Array.isArray(v)).toBe(true);
  });
});
