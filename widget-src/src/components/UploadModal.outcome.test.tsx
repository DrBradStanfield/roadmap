// @vitest-environment jsdom
/**
 * US-12 AC9–10: every file the upload did not fully read is named with a
 * plain reason, and each run sends one count-only `upload_outcome` event.
 * Same harness shape as UploadModal.session.test.tsx.
 */
import { zipMemberName } from '@roadmap/health-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport, labImportBatch, pollBatchStatus } from '../lib/upload-api';
import { attachOriginals } from '../lib/archive-payloads';
import { bulkSaveMeasurements, bulkSaveDocuments, bulkSaveLabValues } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import type { UploadHistory } from '../lib/api-types';
import type { FileResult } from './ReviewTable';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'cloud'), bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn() }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), attachOriginals: vi.fn(async results => results), synthesizeLabArchiveEntries: vi.fn(() => []) }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// The build decides the wording (US-12 AC9): the Shopify page reads through
// our server, the Pages build through the user's own Anthropic key.
const build = vi.hoisted(() => ({ shopify: true }));
vi.mock('../lib/build-flags', () => ({ get SHOPIFY_SURFACE() { return build.shopify; }, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const withValues: Import = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } } as unknown as Import;
const letterOnly: Import = { result: { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2024-06-01', contentMarkdown: 'letter', metadata: {} } } } as unknown as Import;
const nothing: Import = { result: { classification: 'lab_report', document: null, reportDate: null, values: [], additionalValues: [] } } as unknown as Import;
const history: UploadHistory = { measurements: [], labValues: [], documents: [] };
const extractFromPdf = vi.fn();
const docxToText = vi.fn();
const pages = (content: string) => ({ pages: [{ type: 'text', content }], truncated: false });

function pick(...files: File[]) {
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files } });
}
const pdf = (name: string, bytes = 1) => {
  const f = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(f, 'size', { value: bytes });
  return f;
};
/** The reason the list gives for one file, or null when the file is not listed. */
function reasonFor(name: string): string | null {
  const list = screen.queryByRole('list', { name: 'Files to check' });
  if (!list) return null;
  const items = within(list).queryAllByText(name);
  return items.length ? items.map(i => i.closest('li')!.textContent!.slice(name.length).trim()).join(' | ') : null;
}
function outcomes() {
  return vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'upload_outcome').map(([, m]) => m);
}

beforeEach(() => {
  vi.clearAllMocks();
  build.shopify = true;
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(withValues);
  vi.mocked(bulkSaveMeasurements).mockResolvedValue({ saved: [{}], skippedDuplicates: 0, errorCount: 0 } as Awaited<ReturnType<typeof bulkSaveMeasurements>>);
  vi.mocked(bulkSaveDocuments).mockResolvedValue({ saved: [{}], errorCount: 0 } as Awaited<ReturnType<typeof bulkSaveDocuments>>);
  vi.mocked(bulkSaveLabValues).mockResolvedValue({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] });
  extractFromPdf.mockImplementation(async (f: File) => pages(f.name));
  Object.assign(window, { HealthUpload: {
    extractFromPdf,
    isPdf: (f: File) => f.name.endsWith('.pdf'),
    isZip: () => false,
    isImage: (f: File) => f.name.endsWith('.jpg'),
    resizeImage: vi.fn(async () => 'base64'),
    docxToText,
  } });
});
afterEach(cleanup);

function render_() {
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={history} onComplete={() => {}} />);
}

describe('US-12 AC9: every file not fully read is named with a reason', () => {
  it('names a PDF that will not open, on the review and done screens, and leaves the read file unlisted', async () => {
    extractFromPdf.mockImplementation(async (f: File) => {
      if (f.name === 'locked.pdf') throw new Error('PasswordException');
      return pages(f.name);
    });
    render_(); pick(pdf('good.pdf'), pdf('locked.pdf'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('locked.pdf')).toBe('Could not open it. It may be password-protected, damaged, or not a PDF, photo or .docx file.');
    expect(reasonFor('good.pdf')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(reasonFor('locked.pdf')).toMatch(/^Could not open it/);
  });

  it('names a file with no readable pages (not a PDF or photo)', async () => {
    render_(); pick(pdf('good.pdf'), new File(['x'], 'notes.txt'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('notes.txt')).toMatch(/^Could not open it/);
  });

  it('lists an oversize file beside the files that were read, instead of wiping it when the run starts', async () => {
    render_(); pick(pdf('good.pdf'), pdf('huge.pdf', 11 * 1024 * 1024));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('huge.pdf')).toBe('Too large to read. The limit is 10 MB per file.');
    expect(extractFromPdf).toHaveBeenCalledOnce();
  });

  it('lists oversize files when nothing else was picked, and starts no run', async () => {
    render_(); pick(pdf('huge.pdf', 11 * 1024 * 1024), pdf('huger.pdf', 12 * 1024 * 1024));
    expect(reasonFor('huge.pdf')).toMatch(/^Too large/);
    expect(reasonFor('huger.pdf')).toMatch(/^Too large/);
    expect(checkLabImportQuota).not.toHaveBeenCalled();
  });

  it('says only the first 20 pages of a long PDF were read', async () => {
    extractFromPdf.mockImplementation(async (f: File) => ({ ...pages(f.name), truncated: true }));
    render_(); pick(pdf('long.pdf'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('long.pdf')).toBe('Only the first 20 pages were read.');
  });

  it('says a file filed as a document gave no blood test values', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (pages[0].content === 'letter.pdf' ? letterOnly : withValues));
    render_(); pick(pdf('good.pdf'), pdf('letter.pdf'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('letter.pdf')).toBe('Filed as a document. No blood test values found.');
  });

  it('says when a read file gave no values and no document', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (pages[0].content === 'blank.pdf' ? nothing : withValues));
    render_(); pick(pdf('good.pdf'), pdf('blank.pdf'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('blank.pdf')).toBe('No blood test values found.');
  });

  it('tells a server error from the daily limit', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (
      pages[0].content === 'broken.pdf' ? { result: null, error: 'Extraction failed', errorCode: 'server_error' }
        : pages[0].content === 'late.pdf' ? { result: null, error: 'Daily upload limit reached. You can upload more tomorrow.', errorCode: 'rate_limit' }
          : withValues));
    render_(); pick(pdf('good.pdf'), pdf('broken.pdf'), pdf('late.pdf'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('broken.pdf')).toBe('Our server could not read it. Please try again.');
    expect(reasonFor('late.pdf')).toBe('Not read. The daily upload limit was reached.');
  });

  // US-15 AC34: Haiku 5.5 can decline a file or stop at its token cap, and the
  // same request stops the same way again: neither says "try again".
  it.each([true, false])('says a declined file and a too-long one will not read on a retry (Shopify build: %s)', async shopify => {
    build.shopify = shopify;
    vi.mocked(labImport).mockImplementation(async pages => (
      pages[0].content === 'declined.pdf' ? { result: null, error: 'Not read', errorCode: 'refused' }
        : pages[0].content === 'long.pdf' ? { result: null, error: 'Not read', errorCode: 'too_long' }
          : withValues));
    render_(); pick(pdf('good.pdf'), pdf('declined.pdf'), pdf('long.pdf'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('declined.pdf')).toBe('Not read. Claude declined to read this file, so trying again will not help.');
    expect(reasonFor('long.pdf')).toBe('Not read. The file is too long to read in one go.');
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 3, withValues: 1, refused: 1, tooLong: 1, serverError: 0 }));
  });

  it('names the files on the error screen when none could be read', async () => {
    extractFromPdf.mockRejectedValue(new Error('PasswordException'));
    render_(); pick(pdf('a.pdf'), pdf('b.pdf'));
    await screen.findByText(/No readable files found/);
    expect(reasonFor('a.pdf')).toMatch(/^Could not open it/);
    expect(reasonFor('b.pdf')).toMatch(/^Could not open it/);
  });

  it('keeps the list inside the Clarity-masked modal', async () => {
    render_(); pick(pdf('huge.pdf', 11 * 1024 * 1024));
    expect(screen.getByRole('list', { name: 'Files to check' }).closest('[data-clarity-mask="true"]')).toBeTruthy();
  });
});

describe('US-12 AC10: one count-only upload_outcome per run', () => {
  it('counts every file of a mixed run once, with integers only', async () => {
    extractFromPdf.mockImplementation(async (f: File) => {
      if (f.name === 'locked.pdf') throw new Error('PasswordException');
      return { ...pages(f.name), truncated: f.name === 'letter.pdf' };
    });
    vi.mocked(labImport).mockImplementation(async pages => (
      pages[0].content === 'letter.pdf' ? letterOnly
        : pages[0].content === 'blank.pdf' ? nothing
          : pages[0].content === 'broken.pdf' ? { result: null, error: 'Extraction failed', errorCode: 'server_error' }
            : withValues));
    render_();
    pick(pdf('good.pdf'), pdf('letter.pdf'), pdf('blank.pdf'), pdf('broken.pdf'), pdf('locked.pdf'), pdf('huge.pdf', 11 * 1024 * 1024));
    await screen.findByDisplayValue('3.9');
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual({
      picked: 6, withValues: 1, documentOnly: 1, noValues: 1, openFailed: 1,
      tooLarge: 1, truncated: 1, serverError: 1, limitError: 0, refused: 0, tooLong: 0, valuesDropped: 0, docx: 0,
    });
    expect(Object.values(outcomes()[0]!).every(Number.isInteger)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(outcomes()).toHaveLength(1);
  });

  it('fires for a run where no file could be read', async () => {
    extractFromPdf.mockRejectedValue(new Error('PasswordException'));
    render_(); pick(pdf('a.pdf'));
    await screen.findByText(/No readable files found/);
    expect(outcomes()).toEqual([expect.objectContaining({ picked: 1, openFailed: 1, withValues: 0 })]);
  });

  it('fires for a pick of only oversize files', () => {
    render_(); pick(pdf('huge.pdf', 11 * 1024 * 1024));
    expect(outcomes()).toEqual([expect.objectContaining({ picked: 1, tooLarge: 1 })]);
  });
});

const zip = (name: string) => new File(['x'], name, { type: 'application/zip' });
function zipBundle(getZipEntries: (f: File) => Promise<unknown[]>) {
  Object.assign((window as unknown as { HealthUpload: object }).HealthUpload, { isZip: (f: File) => f.name.endsWith('.zip'), getZipEntries });
}

describe('US-12 AC9: a ZIP that gives no files is named too', () => {
  it('names an empty ZIP, or one of unsupported files, on the error screen and counts it', async () => {
    zipBundle(async () => []);
    render_(); pick(zip('scans.zip'));
    await screen.findByText(/No readable files found/);
    expect(reasonFor('scans.zip')).toBe('No files we can read inside this ZIP.');
    expect(outcomes()).toEqual([expect.objectContaining({ picked: 1, openFailed: 1, withValues: 0 })]);
  });

  it('names a ZIP that will not open and still reads the other files', async () => {
    zipBundle(async () => { throw new Error('corrupt'); });
    render_(); pick(pdf('good.pdf'), zip('broken.zip'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('broken.zip')).toMatch(/^Could not open it/);
    expect(outcomes()).toEqual([expect.objectContaining({ picked: 2, openFailed: 1, withValues: 1 })]);
  });
});

describe('US-12 AC9: values a file printed but the parse refused are not silent', () => {
  it('says how many values of a file could not be read, and counts them', async () => {
    vi.mocked(labImport).mockImplementation(async pages => {
      const dropped = pages[0].content === 'partial.pdf' ? 2 : pages[0].content === 'one.pdf' ? 1 : 0;
      return { result: { ...withValues.result!, droppedValueCount: dropped } } as Import;
    });
    render_(); pick(pdf('good.pdf'), pdf('partial.pdf'), pdf('one.pdf'));
    await screen.findAllByDisplayValue('3.9');
    expect(reasonFor('partial.pdf')).toBe('2 values could not be read.');
    expect(reasonFor('one.pdf')).toBe('1 value could not be read.');
    expect(reasonFor('good.pdf')).toBeNull();
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 3, withValues: 3, valuesDropped: 3 }));
  });
});

describe('US-12 AC9: the batch path (20+ files) names each file by its own result', () => {
  type Poll = Awaited<ReturnType<typeof pollBatchStatus>>;
  const twenty = () => Array.from({ length: 20 }, (_, i) => pdf(`r${i}.pdf`));
  const result = (i: number, r: Import) => ({ ...r.result!, index: i });
  /** Picks twenty files and lets the one 5-second poll fire. */
  async function runBatch() {
    vi.useFakeTimers();
    try {
      render_(); pick(...twenty());
      await vi.waitFor(() => expect(labImportBatch).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5000);
    } finally { vi.useRealTimers(); }
  }
  beforeEach(() => { vi.mocked(labImportBatch).mockResolvedValue({ batchId: 'batch_abc' }); });

  it('maps results by index, so a lost or failed result names its own file', async () => {
    // Index 3 is missing (a malformed line), index 5 failed at the provider.
    const results = Array.from({ length: 20 }, (_, i) => i).filter(i => i !== 3)
      .map(i => (i === 0 ? result(i, withValues) : i === 5 ? { ...result(i, nothing), errorCode: 'server_error' as const } : result(i, nothing)));
    vi.mocked(pollBatchStatus).mockResolvedValue({ status: 'ended', completed: 20, total: 20, results: results.reverse() } as Poll);
    await runBatch();
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('r0.pdf')).toBeNull();
    expect(reasonFor('r1.pdf')).toBe('No blood test values found.');
    expect(reasonFor('r3.pdf')).toBe('Our server could not read it. Please try again.');
    expect(reasonFor('r5.pdf')).toBe('Our server could not read it. Please try again.');
    expect(screen.queryByText(/Unknown file/)).toBeNull();
    // The originals and each document's sourceFileName key on the real name.
    expect(vi.mocked(attachOriginals).mock.calls[0]![0].map(r => r.fileName)).toEqual(Array.from({ length: 20 }, (_, i) => `r${i}.pdf`));
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 20, withValues: 1, noValues: 17, serverError: 2 }));
  });

  // During a deploy the old server can answer a batch the new widget started:
  // its results carry no index, only their order (sorted by request position).
  it('falls back to position when no result carries an index (old server, deploy window)', async () => {
    const results = Array.from({ length: 20 }, (_, i) => ({ ...(i === 0 ? withValues : nothing).result!, fileName: `r${i}.pdf` }));
    vi.mocked(pollBatchStatus).mockResolvedValue({ status: 'ended', completed: 20, total: 20, results } as unknown as Poll);
    await runBatch();
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('r0.pdf')).toBeNull();
    expect(reasonFor('r1.pdf')).toBe('No blood test values found.');
    expect(reasonFor('r19.pdf')).toBe('No blood test values found.');
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 20, withValues: 1, noValues: 19, serverError: 0 }));
  });

  // US-12 AC9/AC10: an old server's results carry only their order, so a
  // list that is short or long cannot be matched to the files at all.
  it('marks every file a server error when an old server returns the wrong number of unindexed results', async () => {
    const results = Array.from({ length: 19 }, (_, i) => ({ ...(i === 0 ? withValues : nothing).result!, fileName: `r${i}.pdf` }));
    vi.mocked(pollBatchStatus).mockResolvedValue({ status: 'ended', completed: 20, total: 20, results } as unknown as Poll);
    await runBatch();
    await screen.findByRole('list', { name: 'Files to check' });
    expect(reasonFor('r0.pdf')).toBe('Our server could not read it. Please try again.');
    expect(reasonFor('r19.pdf')).toBe('Our server could not read it. Please try again.');
    expect(screen.queryByDisplayValue('3.9')).toBeNull();
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 20, withValues: 0, noValues: 0, serverError: 20 }));
  });

  // US-12 AC9/AC10: two files may share a short name in different folders. A
  // run that fails as a whole still gives each its own verdict.
  it('gives two files with one short name their own notices when the batch hits the daily limit', async () => {
    const names = ['a/results.pdf', 'b/results.pdf', ...Array.from({ length: 18 }, (_, i) => `r${i}.pdf`)];
    zipBundle(async () => names.map(name => ({ name, entry: { async: async () => new Blob([name]) } })));
    extractFromPdf.mockImplementation(async (f: File) => {
      if (await f.text() === 'a/results.pdf') throw new Error('PasswordException');
      return pages(f.name);
    });
    vi.mocked(labImportBatch).mockResolvedValue({ batchId: null, error: 'Daily upload limit reached. You can upload more tomorrow.', errorCode: 'rate_limit' });
    render_(); pick(zip('labs.zip'));
    await screen.findByText(/Daily upload limit reached/);
    expect(reasonFor('labs.zip/a/results.pdf')).toMatch(/^Could not open it/);
    expect(reasonFor('labs.zip/b/results.pdf')).toBe('Not read. The daily upload limit was reached.');
    expect(reasonFor('r0.pdf')).toBe('Not read. The daily upload limit was reached.');
    expect(outcomes()).toEqual([expect.objectContaining({ picked: 20, openFailed: 1, limitError: 19 })]);
  });

  it('names every file with the daily limit when the batch is refused', async () => {
    vi.mocked(labImportBatch).mockResolvedValue({ batchId: null, error: 'Daily upload limit reached. You can upload more tomorrow.', errorCode: 'rate_limit' });
    render_(); pick(...twenty());
    await screen.findByText(/Daily upload limit reached/);
    expect(reasonFor('r0.pdf')).toBe('Not read. The daily upload limit was reached.');
    expect(reasonFor('r19.pdf')).toBe('Not read. The daily upload limit was reached.');
    expect(outcomes()).toEqual([expect.objectContaining({ picked: 20, limitError: 20, serverError: 0 })]);
  });

  it('names every unread file with a server error when the poll fails, and a file that would not open only once', async () => {
    extractFromPdf.mockImplementation(async (f: File) => {
      if (f.name === 'r1.pdf') throw new Error('PasswordException');
      return pages(f.name);
    });
    vi.mocked(pollBatchStatus).mockResolvedValue({ status: 'ended', completed: 0, total: 0, error: 'Batch not found.', errorCode: 'server_restart' });
    await runBatch();
    await screen.findByText(/server restarted/);
    expect(reasonFor('r0.pdf')).toBe('Our server could not read it. Please try again.');
    expect(reasonFor('r1.pdf')).toMatch(/^Could not open it/);
    expect(outcomes()).toEqual([expect.objectContaining({ picked: 20, openFailed: 1, serverError: 19 })]);
  });
});

// US-12 AC9 (Codex R1): two ZIPs can hold one member path. Each member is its
// own file end to end: its own name (the ZIP's, then the path: the stable
// `sourceFileName`), its own extracted values and its own original bytes.
describe('US-12 AC9: members of two ZIPs on one path stay apart', () => {
  type Poll = Awaited<ReturnType<typeof pollBatchStatus>>;
  /** Each ZIP holds `paths`; a member's bytes are its ZIP's name, then its path. */
  const twoZips = (paths: string[]) => zipBundle(async (z: File) => paths.map(name => ({
    name, entry: { async: async () => new Blob([`${z.name}/${name}`]) },
  })));
  /** The results with their originals attached, once the run attaches them.
   *  The run then stops short of the review, which this check does not need. */
  let attached: Promise<FileResult[]>;
  beforeEach(async () => {
    const { attachOriginals: real } = await vi.importActual<typeof import('../lib/archive-payloads')>('../lib/archive-payloads');
    attached = new Promise(resolve => vi.mocked(attachOriginals).mockImplementationOnce(async (...args: Parameters<typeof attachOriginals>) => {
      resolve(await real(...args));
      return new Promise<never>(() => {});
    }));
  });
  /** Each result's name, the date its own pages gave, and its original's bytes. */
  const identities = (results: FileResult[]) => Promise.all(results.map(async r => [r.fileName, r.reportDate, await r.file?.text()]));
  beforeEach(() => {
    extractFromPdf.mockImplementation(async (f: File) => pages(await f.text()));
    // Each file's pages name it, and so does the date its result gives back.
    vi.mocked(labImport).mockImplementation(async p => ({ result: { ...withValues.result!, reportDate: p[0].content } }) as Import);
  });

  // The website half of "one name on both surfaces": a member path past the
  // 255-character limit is named by the shared zipMemberName, as the connector names it.
  it('names a member path past 255 characters exactly as zipMemberName does (US-35 AC5)', async () => {
    const long = 'Pathology/' + 'p'.repeat(300) + '/results.pdf';
    twoZips([long]);
    render_(); pick(zip('labs-a.zip'));
    const results = await attached;
    expect(results.map(r => r.fileName)).toEqual([zipMemberName('labs-a.zip', long)]);
    expect(results[0].fileName.length).toBeLessThanOrEqual(255);
  });

  it('the pipeline (under 20 files) names each by its ZIP and pairs its values with its own original', async () => {
    twoZips(['results.pdf']);
    render_(); pick(zip('labs-a.zip'), zip('labs-b.zip'));
    const results = await attached;
    expect((await identities(results)).sort()).toEqual([
      ['labs-a.zip/results.pdf', 'labs-a.zip/results.pdf', 'labs-a.zip/results.pdf'],
      ['labs-b.zip/results.pdf', 'labs-b.zip/results.pdf', 'labs-b.zip/results.pdf'],
    ]);
    expect(new Set(results.map(r => r.contentHash)).size).toBe(2);
  });

  it('the batch (20+ files) names each by its ZIP and pairs its values with its own original', async () => {
    const paths = ['results.pdf', ...Array.from({ length: 9 }, (_, i) => `r${i}.pdf`)];
    twoZips(paths);
    vi.mocked(labImportBatch).mockResolvedValue({ batchId: 'batch_abc' });
    vi.mocked(pollBatchStatus).mockImplementation(async () => ({
      status: 'ended', completed: 20, total: 20,
      results: vi.mocked(labImportBatch).mock.calls[0]![0].map((f, index) => ({ ...withValues.result!, reportDate: f.pages[0].content, index })),
    }) as Poll);
    vi.useFakeTimers();
    try {
      render_(); pick(zip('labs-a.zip'), zip('labs-b.zip'));
      await vi.waitFor(() => expect(labImportBatch).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5000);
    } finally { vi.useRealTimers(); }
    const results = await attached;
    const expected = ['labs-a.zip', 'labs-b.zip'].flatMap(z => paths.map(p => `${z}/${p}`));
    expect((await identities(results)).sort()).toEqual(expected.sort().map(name => [name, name, name]));
    expect(new Set(results.map(r => r.contentHash)).size).toBe(20);
  });
});

// US-12 AC9: the 10 MB limit was checked on picked files only, so a ZIP of
// 1 MB could hold a member that inflates past it and went to pdf.js anyway.
describe('US-12 AC9: a ZIP member over the per-file limit is named and never read', () => {
  type Poll = Awaited<ReturnType<typeof pollBatchStatus>>;
  const big = () => new Blob([new Uint8Array(11 * 1024 * 1024)]);
  /** One ZIP whose `huge.pdf` member is over the limit; every other member is small. */
  const withHugeMember = (paths: string[]) => zipBundle(async () => paths.map(name => ({
    name, entry: { async: async () => (name === 'huge.pdf' ? big() : new Blob([name])) },
  })));

  it('the pipeline (under 20 files) skips it before pdf.js and reads the rest', async () => {
    withHugeMember(['huge.pdf', 'good.pdf']);
    render_(); pick(zip('labs.zip'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('huge.pdf')).toBe('Too large to read. The limit is 10 MB per file.');
    expect(extractFromPdf.mock.calls.map(([f]) => (f as File).name)).toEqual(['good.pdf']);
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 2, tooLarge: 1, withValues: 1, openFailed: 0 }));
  });

  it('the batch (20+ files) skips it before pdf.js and sends only the rest', async () => {
    const paths = ['huge.pdf', ...Array.from({ length: 20 }, (_, i) => `r${i}.pdf`)];
    withHugeMember(paths);
    vi.mocked(labImportBatch).mockResolvedValue({ batchId: 'batch_abc' });
    vi.mocked(pollBatchStatus).mockImplementation(async () => ({
      status: 'ended', completed: 20, total: 20,
      results: vi.mocked(labImportBatch).mock.calls[0]![0].map((_f, index) => ({ ...withValues.result!, index })),
    }) as Poll);
    vi.useFakeTimers();
    try {
      render_(); pick(zip('labs.zip'));
      await vi.waitFor(() => expect(labImportBatch).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5000);
    } finally { vi.useRealTimers(); }
    await screen.findAllByDisplayValue('3.9');
    expect(reasonFor('huge.pdf')).toBe('Too large to read. The limit is 10 MB per file.');
    expect(extractFromPdf.mock.calls.map(([f]) => (f as File).name)).not.toContain('huge.pdf');
    expect(vi.mocked(labImportBatch).mock.calls[0]![0]).toHaveLength(20);
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 21, tooLarge: 1, withValues: 20, openFailed: 0 }));
  });
});

// US-12 AC9: the GitHub Pages build has no server of ours and no daily limit.
// It reads with the user's own Anthropic key, so a 429 is that key's
// per-minute rate limit, and a failure is Anthropic's, never "our server".
describe('US-12 AC9: the Pages build names its own transport', () => {
  beforeEach(() => { build.shopify = false; });

  it('says a file was not read because the user\'s key hit its rate limit, or Anthropic could not read it', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (
      pages[0].content === 'broken.pdf' ? { result: null, error: 'Network error reaching Anthropic. Check your connection.', errorCode: 'network' }
        : pages[0].content === 'late.pdf' ? { result: null, error: 'Your Anthropic account is rate-limited right now. Wait a minute and try again.', errorCode: 'rate_limit' }
          : withValues));
    render_(); pick(pdf('good.pdf'), pdf('broken.pdf'), pdf('late.pdf'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('broken.pdf')).toBe('Not read. Anthropic could not be reached or could not read it. Please try again.');
    expect(reasonFor('late.pdf')).toBe('Not read. Your Anthropic key hit its rate limit. Wait a minute and try again.');
    // The usage signal keeps its keys: a rate limit is still limitError.
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ serverError: 1, limitError: 1 }));
  });

  it('says the key was refused, or its account has no credit, rather than "try again", and counts both as serverError', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (
      pages[0].content === 'refused.pdf' ? { result: null, error: 'x', errorCode: 'key_refused' }
        : pages[0].content === 'broke.pdf' ? { result: null, error: 'x', errorCode: 'no_credit' }
          : withValues));
    render_(); pick(pdf('good.pdf'), pdf('refused.pdf'), pdf('broke.pdf'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('refused.pdf')).toBe('Not read. Anthropic refused your API key. Check the key in the "Ask about your plan" panel.');
    expect(reasonFor('broke.pdf')).toBe('Not read. Your Anthropic account has no credit. Check its billing, then try again.');
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ serverError: 2, limitError: 0 }));
  });

  it.each([
    ['rate_limit', 'Your Anthropic key hit its rate limit. Wait a minute and try again.'],
    ['server_error', 'Anthropic could not read these files. Please try again.'],
    ['network', 'Could not reach Anthropic. Check your connection and try again.'],
  ] as const)('a whole run that fails with %s says so on the error screen', async (errorCode, text) => {
    vi.mocked(labImportBatch).mockResolvedValue({ batchId: null, error: 'x', errorCode });
    render_(); pick(...Array.from({ length: 20 }, (_, i) => pdf(`r${i}.pdf`)));
    await screen.findByText(text);
    expect(screen.queryByText(/server|daily/i)).toBeNull();
  });
});

describe('US-12 AC9: the Shopify build keeps its server wording', () => {
  it.each([
    ['rate_limit', 'Daily upload limit reached. You can upload more tomorrow.'],
    ['server_error', 'Something went wrong on the server. Please try again.'],
    ['network', 'Network error. Please check your connection and try again.'],
  ] as const)('a whole run that fails with %s says so on the error screen', async (errorCode, text) => {
    vi.mocked(labImportBatch).mockResolvedValue({ batchId: null, error: 'x', errorCode });
    render_(); pick(...Array.from({ length: 20 }, (_, i) => pdf(`r${i}.pdf`)));
    await screen.findByText(text);
  });
});

describe('US-12 AC12: a .docx is read in the browser and sent as text', () => {
  const word = (name: string) => new File(['x'], name);

  it('sends the document text as one text page and counts the file as docx', async () => {
    docxToText.mockResolvedValue('Ferritin | 85 | 60 | ug/L | 30-400');
    render_(); pick(word('baseline.docx'));
    await screen.findByDisplayValue('3.9');
    expect(labImport).toHaveBeenCalledWith([{ type: 'text', content: 'Ferritin | 85 | 60 | ug/L | 30-400' }], 'si');
    expect(docxToText.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer);
    expect(reasonFor('baseline.docx')).toBeNull();
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 1, withValues: 1, docx: 1 }));
  });

  it('names a .docx with no text, or one that will not open, as could not open', async () => {
    docxToText.mockImplementation(async (b: ArrayBuffer) => { if (b.byteLength === 1) return ''; throw new Error('docx too large'); });
    render_(); pick(pdf('good.pdf'), word('empty.docx'), new File(['xx'], 'bomb.docx'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('empty.docx')).toBe('Could not open it. It may be password-protected, damaged, or not a PDF, photo or .docx file.');
    expect(reasonFor('bomb.docx')).toMatch(/^Could not open it/);
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 3, withValues: 1, openFailed: 2, docx: 2 }));
  });

  it('refuses a legacy .doc with a notice to save it as PDF or .docx, and never reads it', async () => {
    render_(); pick(pdf('good.pdf'), word('old.doc'));
    await screen.findByDisplayValue('3.9');
    expect(reasonFor('old.doc')).toBe('Word .doc files cannot be read. Save it as a PDF or .docx, then upload that.');
    expect(docxToText).not.toHaveBeenCalled();
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 2, openFailed: 1, docx: 0 }));
  });

  it('reads and counts a .docx by the one rule, its mime type when the name has no extension', async () => {
    docxToText.mockResolvedValue('Ferritin | 85');
    const typed = new File(['x'], 'baseline', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    render_(); pick(typed);
    await screen.findByDisplayValue('3.9');
    expect(docxToText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 1, withValues: 1, docx: 1 }));
  });

  it('counts an oversize .docx as docx and too large', () => {
    const huge = word('huge.docx');
    Object.defineProperty(huge, 'size', { value: 11 * 1024 * 1024 });
    render_(); pick(huge);
    expect(reasonFor('huge.docx')).toMatch(/^Too large/);
    expect(outcomes()).toEqual([expect.objectContaining({ picked: 1, tooLarge: 1, docx: 1 })]);
  });

  it('offers .docx and .doc in the file picker', () => {
    render_();
    expect(document.querySelector('input[type=file]')!.getAttribute('accept')!.split(',')).toEqual(expect.arrayContaining(['.docx', '.doc']));
  });
});
