// @vitest-environment jsdom
/**
 * US-12 AC1, AC4, AC5, AC9, AC26-AC28: what the upload shows, and what reaches the review, for
 * each kind of pick. Pinned on the web's own flow before it read through the shared upload state
 * (health-core upload-flow.ts, design docs/drafts/upload-shared-engine.md PR 9), and kept green
 * after. Same harness as UploadModal.outcome.test.tsx. Synthetic names and values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_ENGINE } from '../testing/upload-engine';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { saveUpload } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import { findAllReviewValues, findReviewValue, reasonFor } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ recordFileSync: vi.fn(() => null), saveUpload: vi.fn(), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => ''), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false) }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '/apps/synthetic', parseJsonResponse: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// A hash that names the bytes, settled in the order asked: the platform's real digest runs off the main
// thread, so two files can finish hashing in either order, and a pick's order would then be luck.
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: async (b: Blob) => `sha256-${await b.text()}` }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const valueOf = (v: number, day = '2024-06-01'): Import => ({ result: { classification: 'lab_report', document: null, reportDate: day, values: [{ metric: 'ldl', valueSI: v, displayValue: v, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } }) as unknown as Import;
const letter: Import = { result: { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2024-06-01', contentMarkdown: 'letter', metadata: {} } } } as unknown as Import;
const failure = (errorCode: NonNullable<Import['errorCode']>): Import => ({ result: null, error: 'Not read', errorCode });
const extractFromPdf = vi.fn();

const pdf = (name: string, bytes = 1) => {
  const f = new File([name], name, { type: 'application/pdf' });
  Object.defineProperty(f, 'size', { value: bytes });
  return f;
};
const zip = (name: string) => new File(['x'], name, { type: 'application/zip' });
/** A ZIP bundle whose members are `paths`, each member's bytes its own path. */
function zipOf(paths: string[] | Error) {
  Object.assign((window as unknown as { HealthUpload: object }).HealthUpload, {
    isZip: (f: File) => f.name.endsWith('.zip'),
    getZipEntries: async () => {
      if (paths instanceof Error) throw paths;
      return paths.map(name => ({ name, entry: { async: async () => new Blob([name]) } }));
    },
  });
}
function pick(...files: File[]) {
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files } });
}
/** The shared Save's answer when its commit landed (its rows are the store's tests', roadmap-store-upload-save.test.ts). */
const LANDED: Awaited<ReturnType<typeof saveUpload>> = { ok: true, outcome: { values: 1, documents: 0, archived: 0, unstored: 0 }, added: [] };
/** Each file's own answer, by the text its pages carry (the file's name, or a member's path). */
function answers(by: Record<string, Import | Promise<Import>>, otherwise: Import = valueOf(3.9)) {
  vi.mocked(labImport).mockImplementation(async p => by[p[0].content as string] ?? otherwise);
}
const dropzone = () => screen.queryByText('Drop health records here, or click to browse');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  answers({});
  vi.mocked(saveUpload).mockResolvedValue(LANDED);
  extractFromPdf.mockImplementation(async (f: File) => ({ pages: [{ type: 'text', content: await f.text() }], truncated: false }));
  Object.assign(window, { HealthUpload: { ...UPLOAD_ENGINE, extractFromPdf, isPdf: (f: File) => f.name.endsWith('.pdf'), isZip: () => false, isImage: () => false, resizeImage: vi.fn(), docxToText: vi.fn() } });
});
afterEach(cleanup);

const render_ = () => render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" onComplete={() => {}} />);

describe('US-12 read pins: what the modal shows and what reaches the review', () => {
  it('a single PDF: its value reaches the review and the save, and the done screen counts it', async () => {
    render_(); pick(pdf('a.pdf'));
    await findReviewValue('3.9');
    expect(reasonFor('a.pdf')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    // The Save is handed the state the person reviewed: its one read file, with the value read (the rows are the engine's).
    const s = vi.mocked(saveUpload).mock.calls[0][1];
    expect(s.phase === 'saving' && s.files.map(f => f.status.s === 'read' && f.status.extraction.values[0].valueSI)).toEqual([3.9]);
    expect(screen.getByText('Saved 1 value.')).toBeTruthy();
  });

  it('a mixed pick: the values reach the review; a letter, a locked file and a large one are each named', async () => {
    extractFromPdf.mockImplementation(async (f: File) => {
      if (f.name === 'locked.pdf') throw new Error('PasswordException');
      return { pages: [{ type: 'text', content: await f.text() }], truncated: false };
    });
    answers({ 'letter.pdf': letter });
    render_(); pick(pdf('good.pdf'), pdf('letter.pdf'), pdf('locked.pdf'), pdf('huge.pdf', 11 * 1024 * 1024));
    await findReviewValue('3.9');
    expect(reasonFor('good.pdf')).toBeNull();
    // The letter is under the list's letters, with no notice of its own (mount 3b); the large file by the list's status word.
    expect(reasonFor('letter.pdf')).toBeNull();
    expect(screen.getByDisplayValue('Synthetic letter')).toBeTruthy();
    expect(reasonFor('locked.pdf')).toMatch(/^Could not open it/);
    expect(reasonFor('huge.pdf')).toBe('Too large to read');
  });

  it('a ZIP: each member is read and its value reaches the review', async () => {
    zipOf(['a.pdf', 'b.pdf']);
    answers({ 'a.pdf': valueOf(3.9), 'b.pdf': valueOf(4.2, '2024-07-01') });
    render_(); pick(zip('labs.zip'));
    await findReviewValue('3.9');
    expect(screen.getAllByDisplayValue('4.2')).toHaveLength(1);
    expect([reasonFor('labs.zip/a.pdf'), reasonFor('labs.zip/b.pdf')]).toEqual([null, null]);
  });

  it('an empty ZIP: the error screen names it', async () => {
    zipOf([]);
    render_(); pick(zip('scans.zip'));
    await screen.findByText(/No readable files found/);
    expect(reasonFor('scans.zip')).toBe('No files we can read inside this ZIP.');
    expect(labImport).not.toHaveBeenCalled();
  });

  it('a ZIP that will not open beside a good file: the good file is reviewed, the ZIP named', async () => {
    zipOf(new Error('corrupt'));
    render_(); pick(pdf('good.pdf'), zip('broken.zip'));
    await findReviewValue('3.9');
    expect(reasonFor('broken.zip')).toMatch(/^Could not open it/);
  });

  it('a file too large: named, never read; alone, it starts no read', async () => {
    render_(); pick(pdf('huge.pdf', 11 * 1024 * 1024));
    expect(reasonFor('huge.pdf')).toBe('Too large to read. The limit is 10 MB per file.');
    await new Promise(r => setTimeout(r, 0));
    expect(checkLabImportQuota).not.toHaveBeenCalled();
    expect(extractFromPdf).not.toHaveBeenCalled();
    expect(dropzone()).toBeTruthy();
  });

  it('the daily limit mid-run: what was read reaches the review, the limited file is named', async () => {
    answers({ 'late.pdf': failure('rate_limit') });
    render_(); pick(pdf('good.pdf'), pdf('late.pdf'));
    await findReviewValue('3.9');
    expect(reasonFor('late.pdf')).toBe('Not read. The daily upload limit was reached.');
    expect(reasonFor('good.pdf')).toBeNull();
  });

  it.each([
    ['busy', 'Not read. Our server was busy. Please try again later.'],
    ['refused', 'Not read. Claude declined to read this file, so trying again will not help.'],
    ['too_long', 'Not read. The file is too long to read in one go.'],
    ['server_error', 'Our server could not read it. Please try again.'],
  ] as const)('a file the server answers %s: named with its words beside the files read', async (code, words) => {
    answers({ 'bad.pdf': failure(code) });
    render_(); pick(pdf('good.pdf'), pdf('bad.pdf'));
    await findReviewValue('3.9');
    expect(reasonFor('bad.pdf')).toBe(words);
  });

  it('every file failing at the server still opens the review, each file named', async () => {
    answers({}, failure('server_error'));
    render_(); pick(pdf('a.pdf'), pdf('b.pdf'));
    await waitFor(() => expect(reasonFor('a.pdf')).toBe('Our server could not read it. Please try again.'));
    expect(reasonFor('b.pdf')).toBe('Our server could not read it. Please try again.');
    expect(screen.queryByText(/No readable files found/)).toBeNull();
  });

  it('Cancel mid-read: back to the dropzone, and the late answer changes nothing', async () => {
    let finish!: (r: Import) => void;
    vi.mocked(labImport).mockImplementation(() => new Promise<Import>(resolve => { finish = resolve; }));
    render_(); pick(pdf('a.pdf'));
    await waitFor(() => expect(labImport).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dropzone()).toBeTruthy();
    finish(valueOf(3.9));
    await new Promise(r => setTimeout(r, 0));
    expect(dropzone()).toBeTruthy();
    expect(screen.queryByDisplayValue('3.9')).toBeNull();
  });

  it('a second pick after Cancel: only the new file reaches the review, whatever the first answers late', async () => {
    const pending: Array<(r: Import) => void> = [];
    vi.mocked(labImport).mockImplementation(p => (p[0].content === 'first.pdf'
      ? new Promise<Import>(resolve => { pending.push(resolve); }) : Promise.resolve(valueOf(4.2))));
    render_(); pick(pdf('first.pdf'));
    await waitFor(() => expect(labImport).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    pick(pdf('second.pdf'));
    await findReviewValue('4.2');
    for (const finish of pending) finish(valueOf(3.9));
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByDisplayValue('3.9')).toBeNull();
    expect(await findAllReviewValues('4.2')).toHaveLength(1);
  });

  // US-12 AC6: an erase remounts the page while a Save runs; the save that ends after it is not counted.
  it('a Save that ends after the modal is gone sends no upload_saved', async () => {
    let finish!: (r: Awaited<ReturnType<typeof saveUpload>>) => void;
    vi.mocked(saveUpload).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { unmount } = render_(); pick(pdf('a.pdf'));
    await findReviewValue('3.9');
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await waitFor(() => expect(saveUpload).toHaveBeenCalled());
    unmount();
    finish(LANDED);
    await new Promise(r => setTimeout(r, 0));
    expect(vi.mocked(trackProductEvent).mock.calls.filter(([n]) => n === 'upload_saved')).toEqual([]);
  });

  it('control: a Save that ends on screen sends one upload_saved', async () => {
    render_(); pick(pdf('a.pdf'));
    await findReviewValue('3.9');
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(vi.mocked(trackProductEvent).mock.calls.filter(([n]) => n === 'upload_saved')).toEqual([['upload_saved', { count: 1 }]]);
  });
});
