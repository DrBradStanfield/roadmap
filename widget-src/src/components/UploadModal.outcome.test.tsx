// @vitest-environment jsdom
/**
 * US-12 AC9–10: every file the upload did not fully read is named with a
 * plain reason, and each run sends one count-only `upload_outcome` event.
 * Same harness shape as UploadModal.session.test.tsx.
 */
import { zipMemberName } from '@roadmap/health-core/lab-extraction';
import { UPLOAD_OUTCOME_KEYS } from '@roadmap/health-core/product-events';
import { KEY_TEXT } from '@roadmap/health-core/upload-text';
import { uploadFileName } from '@roadmap/health-core/upload-flow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_ENGINE } from '../testing/upload-engine';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { sha256Blob } from '../lib/archive-payloads';
import { saveUpload } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import { findAllReviewValues, findReviewValue, notSaved, reasonFor } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ recordFileSync: vi.fn(() => null), saveUpload: vi.fn(), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '/apps/synthetic', parseJsonResponse: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async () => '') }));
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
const extractFromPdf = vi.fn();
const docxToText = vi.fn();
const pages = (content: string) => ({ pages: [{ type: 'text', content }], truncated: false });
const docxText = (text: string, more: { truncated?: boolean; picturesOnly?: boolean } = {}) => ({ text, truncated: false, picturesOnly: false, ...more });

function pick(...files: File[]) {
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files } });
}
const pdf = (name: string, bytes = 1) => {
  const f = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(f, 'size', { value: bytes });
  return f;
};
/** The raw `upload_outcome` metadata sent, each run's. */
function sent() {
  return vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'upload_outcome').map(([, m]) => m as Record<string, number>);
}
/** Each run's counts as the product-health read takes them: a key not sent is 0. */
function outcomes() {
  return sent().map(m => Object.fromEntries(UPLOAD_OUTCOME_KEYS.map(k => [k, m[k] ?? 0])));
}

beforeEach(() => {
  // Reset, not clear: Vitest 4's clearAllMocks keeps a mock's implementation, so a describe's
  // content-named sha256Blob gave every later file of the same bytes one hash, and a pick of two
  // such files read as one.
  vi.resetAllMocks();
  build.shopify = true;
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(withValues);
  // The shared Save's own counts are its tests' (storage/roadmap-store-upload-save.test.ts): here it lands.
  vi.mocked(saveUpload).mockResolvedValue({ ok: true, outcome: { values: 1, documents: 0, archived: 0, unstored: 0 }, added: [] });
  extractFromPdf.mockImplementation(async (f: File) => pages(f.name));
  Object.assign(window, { HealthUpload: { ...UPLOAD_ENGINE,
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
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" onComplete={() => {}} />);
}

describe('US-12 AC9: every file not fully read is named with a reason', () => {
  it('names a PDF that will not open, on the review and done screens, and leaves the read file unlisted', async () => {
    extractFromPdf.mockImplementation(async (f: File) => {
      if (f.name === 'locked.pdf') throw new Error('PasswordException');
      return pages(f.name);
    });
    render_(); pick(pdf('good.pdf'), pdf('locked.pdf'));
    await findReviewValue('3.9');
    expect(reasonFor('locked.pdf')).toBe('Could not open it. It may be password-protected, damaged, or not a PDF, photo or .docx file.');
    expect(reasonFor('good.pdf')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(reasonFor('locked.pdf')).toMatch(/^Could not open it/);
  });

  it('names a file with no readable pages (not a PDF or photo)', async () => {
    render_(); pick(pdf('good.pdf'), new File(['x'], 'notes.txt'));
    await findReviewValue('3.9');
    expect(reasonFor('notes.txt')).toMatch(/^Could not open it/);
  });

  it('lists an oversize file beside the files that were read, instead of wiping it when the run starts', async () => {
    render_(); pick(pdf('good.pdf'), pdf('huge.pdf', 11 * 1024 * 1024));
    await findReviewValue('3.9');
    // The list's file status, the shared engine's word (mount 3b); the pick screen keeps the limit sentence.
    expect(reasonFor('huge.pdf')).toBe('Too large to read');
    expect(extractFromPdf).toHaveBeenCalledOnce();
  });

  // US-12 AC9 (engine PR 1974, one placement rule): the done screen names the file not read, with its reason, once.
  it('after Save, the done screen names an oversize file with its reason exactly once', async () => {
    render_(); pick(pdf('good.pdf'), pdf('huge.pdf', 11 * 1024 * 1024));
    await findReviewValue('3.9');
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(reasonFor('huge.pdf')).toBe('Too large to read');
    expect([...document.querySelectorAll('li')].filter(li => li.textContent!.startsWith('huge.pdf'))).toHaveLength(1);
    expect(reasonFor('good.pdf')).toBeNull();
  });

  // "Already in your record" is a status, not a reason (PR 1974): the done screen leaves a known file out.
  it('after Save, a file the record already holds is not named on the done screen', async () => {
    const { uploadKnownIndex } = await import('../lib/roadmap-data');
    vi.mocked(sha256Blob).mockImplementation(async (b: Blob) => `sha256-${await b.text()}`);
    vi.mocked(uploadKnownIndex).mockReturnValue(new Map([['sha256-held', { as: 'document', archiveOnly: false }]]) as never);
    try {
      render_(); pick(pdf('good.pdf'), new File(['held'], 'held.pdf', { type: 'application/pdf' }));
      await findReviewValue('3.9');
      // The review's Files row shows the status; it is the file the record holds (the control for the done check).
      expect(reasonFor('held.pdf')).toMatch(/already in your record/i);
      fireEvent.click(screen.getByRole('button', { name: /^Save / }));
      await screen.findByRole('button', { name: 'Done' });
      expect(reasonFor('held.pdf')).toBeNull();
    } finally {
      vi.mocked(uploadKnownIndex).mockReturnValue(new Map());
      vi.mocked(sha256Blob).mockImplementation(async () => '');
    }
  });

  it('lists oversize files when nothing else was picked, and starts no run', async () => {
    render_(); pick(pdf('huge.pdf', 11 * 1024 * 1024), pdf('huger.pdf', 12 * 1024 * 1024));
    expect(reasonFor('huge.pdf')).toMatch(/^Too large/);
    expect(reasonFor('huger.pdf')).toMatch(/^Too large/);
    expect(checkLabImportQuota).not.toHaveBeenCalled();
  });

  it('says only the first part of a long PDF was read (US-12 AC9, AC13)', async () => {
    extractFromPdf.mockImplementation(async (f: File) => ({ ...pages(f.name), truncated: true }));
    render_(); pick(pdf('long.pdf'));
    await findReviewValue('3.9');
    expect(reasonFor('long.pdf')).toBe('This file is long, so only its first part was read.');
  });

  it('says a file filed as a document gave no blood test values', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (pages[0].content === 'letter.pdf' ? letterOnly : withValues));
    render_(); pick(pdf('good.pdf'), pdf('letter.pdf'));
    await findReviewValue('3.9');
    // The list files the letter under its letters, by name, with no notice of its own (US-14 AC11-13, mount 3b).
    expect(reasonFor('letter.pdf')).toBeNull();
    expect(screen.getByDisplayValue('Synthetic letter')).toBeTruthy();
  });

  it('says when a read file gave no values and no document', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (pages[0].content === 'blank.pdf' ? nothing : withValues));
    render_(); pick(pdf('good.pdf'), pdf('blank.pdf'));
    await findReviewValue('3.9');
    // Once, in its Files row (the engine's one placement rule, PR 1974).
    expect(reasonFor('blank.pdf')).toBe('No blood test values found.');
  });

  it('tells a server error from the daily limit', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (
      pages[0].content === 'broken.pdf' ? { result: null, error: 'Extraction failed', errorCode: 'server_error' } : withValues));
    render_(); pick(pdf('good.pdf'), pdf('broken.pdf'));
    await findReviewValue('3.9');
    expect(reasonFor('broken.pdf')).toBe('Our server could not read it. Please try again.');
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ serverError: 1, limitError: 0 }));
  });

  // US-12 AC26: the state is the one source of a file's reason. A file that failed in a way a retry
  // would send again, in a run the daily limit then stops, fails on the limit: its words and its count say so.
  it('a file that failed before the daily limit stopped the run is named and counted by the limit, as the state holds it', async () => {
    let limit!: (r: Import) => void;
    vi.mocked(labImport).mockImplementation(pages => (
      pages[0].content === 'broken.pdf' ? Promise.resolve({ result: null, error: 'Network error', errorCode: 'network' } as Import)
        : pages[0].content === 'late.pdf' ? new Promise<Import>(resolve => { limit = resolve; })
          : Promise.resolve(withValues)));
    render_(); pick(pdf('good.pdf'), pdf('broken.pdf'), pdf('late.pdf'));
    await waitFor(() => expect(labImport).toHaveBeenCalledTimes(3));
    await new Promise(r => setTimeout(r, 0));
    limit({ result: null, error: 'Daily upload limit reached. You can upload more tomorrow.', errorCode: 'rate_limit' });
    await findReviewValue('3.9');
    expect(reasonFor('broken.pdf')).toBe('Not read. The daily upload limit was reached.');
    expect(reasonFor('late.pdf')).toBe('Not read. The daily upload limit was reached.');
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ serverError: 0, limitError: 2 }));
  });

  // US-12 AC9 H65: a single file the server calls busy says the busy words.
  it('US-12 AC9 H65: a single file the server calls busy gets the busy notice, counted as a server error', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (
      pages[0].content === 'busy.pdf' ? { result: null, error: 'Server busy. Please try again later.', errorCode: 'busy' } : withValues));
    render_(); pick(pdf('good.pdf'), pdf('busy.pdf'));
    await findReviewValue('3.9');
    expect(reasonFor('busy.pdf')).toBe('Not read. Our server was busy. Please try again later.');
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ serverError: 1, limitError: 0 }));
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
    await findReviewValue('3.9');
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
    await findReviewValue('3.9');
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual({
      picked: 6, withValues: 1, documentOnly: 1, noValues: 1, openFailed: 1,
      tooLarge: 1, truncated: 1, serverError: 1, limitError: 0, refused: 0, tooLong: 0, valuesDropped: 0, docx: 0, picturesOnly: 0, undatedPrevious: 0, unitsGuessed: 0, unitsRefused: 0, valuesLimit: 0, valuesLimitUngraded: 0, cancelled: 0, known: 0, failedFinal: 2, firstReadSeconds: 0,
    });
    expect(Object.values(outcomes()[0]!).every(Number.isInteger)).toBe(true);
    // A zero is never sent, so a server a deploy behind never meets a new key it would refuse; a first read
    // under a second is a real time, so `firstReadSeconds: 0` is (US-12 AC30).
    expect(sent()[0]).toEqual({ picked: 6, withValues: 1, documentOnly: 1, noValues: 1, openFailed: 1, tooLarge: 1, truncated: 1, serverError: 1, failedFinal: 2, firstReadSeconds: 0 });
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(outcomes()).toHaveLength(1);
  });

  // US-12 AC14: how many values came from an undated previous column, a count only.
  it('counts the values read from an undated previous column, core and lab rows alike', async () => {
    const undated = { result: { ...withValues.result!, values: [
      ...withValues.result!.values,
      { metric: 'hdl', valueSI: 1.2, displayValue: 1.2, displayUnit: 'mmol/L', confidence: 'high', recordedAt: 'undated' },
      { metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', confidence: 'high', recordedAt: '2024-01-10' },
    ], additionalValues: [{ name: 'sodium', value: 139, unit: 'mmol/L', recordedAt: 'undated' }] } } as Import;
    vi.mocked(labImport).mockResolvedValue(undated);
    render_(); pick(pdf('baseline.pdf'));
    await findReviewValue('3.9');
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ picked: 1, withValues: 1, undatedPrevious: 2, firstReadSeconds: 0 });
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
    await findReviewValue('3.9');
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
    await findReviewValue('3.9');
    // US-13 AC13: one "Not saved" section across the files, not a notice per file.
    for (const name of ['partial.pdf', 'one.pdf', 'good.pdf']) expect(reasonFor(name)).toBeNull();
    expect(notSaved()).toEqual({ title: '3 values not saved', lines: ['3 values could not be read'] });
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 3, withValues: 3, valuesDropped: 3 }));
  });
});

// A lab photo with HDL printed "> 60" and Lp(a) "<5" said only "2 values could
// not be read" (break-it pass, 2026-11-01): the person could not tell which.
describe('US-12 AC19: each value not saved is named, with why', () => {
  it('names the tests not read, counts the rest, and sends only counts', async () => {
    vi.mocked(labImport).mockResolvedValue({ result: { ...withValues.result!, droppedValueCount: 3, unreadValues: [
      { name: 'vitamin_d', reason: 'unreadable' }, { name: 'hdl', reason: 'unreadable' },
    ] } } as Import);
    render_(); pick(pdf('photo.pdf'));
    await findReviewValue('3.9');
    // US-13 AC13: named under the review's "Not saved" by label, never a key; no file notice.
    expect(reasonFor('photo.pdf')).toBeNull();
    const { title, lines: items } = notSaved()!;
    expect(title).toBe('3 values not saved');
    expect(items).toEqual(['Vitamin D (25-OH), HDL Cholesterol: could not be read', '1 other value could not be read']);
    expect(items.join(' ')).not.toMatch(/vitamin_d|\bhdl\b/);
    await waitFor(() => expect(sent()).toHaveLength(1));
    // A count and its reason word only: never a test's name or a value.
    expect(sent()[0]).toEqual({ picked: 1, withValues: 1, valuesDropped: 3, firstReadSeconds: 0 });
  });
});

// US-12 AC20 (Brad 2026-11-01, 2026-11-02): a limit is saved, so it is no longer
// a dropped value; the run counts how many there were, how many the rule could
// not grade, and which tests those were, from a closed list of keys.
describe('US-12 AC20: the upload counts limits, and names the ungraded tests by key only', () => {
  it('counts each limit, the undecided ones, and their keys, never a value, unit or printed name', async () => {
    vi.mocked(labImport).mockResolvedValue({ result: { ...withValues.result!,
      values: [
        ...withValues.result!.values,
        { metric: 'lpa', valueSI: 10, displayValue: 10, displayUnit: 'nmol/L', confidence: 'high', comparator: '<' },
        { metric: 'ldl', valueSI: 1.5, displayValue: 1.5, displayUnit: 'mmol/L', confidence: 'high', comparator: '<' },
      ],
      additionalValues: [
        { name: 'eGFR', value: 30, unit: 'mL/min/1.73m²', comparator: '>' },
        { name: 'Folate (serum)', value: 45, unit: 'nmol/L', referenceLow: 7, referenceHigh: 45, comparator: '>' },
        { name: 'Made-up marker 7', value: 3, unit: 'U/L', referenceLow: 1, referenceHigh: 5, comparator: '<' },
      ],
    } } as Import);
    render_(); pick(pdf('limits.pdf'));
    await findReviewValue('3.9');
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ picked: 1, withValues: 1, valuesLimit: 5, valuesLimitUngraded: 3, firstReadSeconds: 0, limitUngradedTests: ['egfr', 'ldl', 'other'] });
    expect(JSON.stringify(sent()[0])).not.toMatch(/Made-up|Folate|nmol|1\.5|"30"|[<>]/);
  });
});

describe('US-12 AC9: members of two ZIPs on one path stay apart', () => {
  /** Each ZIP holds `paths`; a member's bytes are its ZIP's name, then its path. */
  const twoZips = (paths: string[]) => zipBundle(async (z: File) => paths.map(name => ({
    name, entry: { async: async () => new Blob([`${z.name}/${name}`]) },
  })));
  /** The read files the shared Save is handed, each with its name, the value its own pages gave, its hash and its
   *  original's bytes as the page hands them (lib/upload-save-io.ts). */
  async function savedResults() {
    // Read while the Save runs: a landed Save drops the held bytes (upload-flow `saved` forgets them).
    let identities: unknown[] = [];
    vi.mocked(saveUpload).mockImplementationOnce(async (_engine, s, _now, io) => {
      const read = (s.phase === 'saving' ? s.files : []).filter(f => f.status.s === 'read');
      identities = await Promise.all(read.map(async f => [uploadFileName(f), (f.status as { extraction: { values: Array<{ valueSI: number }> } }).extraction.values[0]?.valueSI, await (await io.original(f.id)!()).text()]));
      return { ok: true, outcome: { values: read.length, documents: 0, archived: 0, unstored: 0 }, added: [] };
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await waitFor(() => expect(saveUpload).toHaveBeenCalled());
    const s = vi.mocked(saveUpload).mock.calls[0]![1];
    const results = (s.phase === 'saving' ? s.files : []).filter(f => f.status.s === 'read').map(f => ({ fileName: uploadFileName(f), contentHash: f.hash }));
    await waitFor(() => expect(identities).toHaveLength(results.length));
    return { results, identities };
  }
  beforeEach(() => {
    // A fake hash that names the bytes it was given.
    vi.mocked(sha256Blob).mockImplementation(async (b: Blob) => `sha256-${await b.text()}`);
    extractFromPdf.mockImplementation(async (f: File) => pages(await f.text()));
    // Each file's pages name it; its one value says which ZIP it came from.
    vi.mocked(labImport).mockImplementation(async p => ({ result: { ...withValues.result!, values: [{ ...withValues.result!.values[0], valueSI: p[0].content.startsWith('labs-a') ? 3.9 : 4.2, displayValue: p[0].content.startsWith('labs-a') ? 3.9 : 4.2 }] } }) as Import);
  });

  // The website half of "one name on both surfaces": a member path past the
  // 255-character limit is named by the shared zipMemberName, as the connector names it.
  it('names a member path past 255 characters exactly as zipMemberName does (US-35 AC5)', async () => {
    const long = 'Pathology/' + 'p'.repeat(300) + '/results.pdf';
    twoZips([long]);
    render_(); pick(zip('labs-a.zip'));
    await findReviewValue('3.9');
    const { results } = await savedResults();
    expect(results.map(r => r.fileName)).toEqual([zipMemberName('labs-a.zip', long)]);
    expect(results[0].fileName.length).toBeLessThanOrEqual(255);
  });

  it('names each by its ZIP and pairs its values with its own original', async () => {
    twoZips(['results.pdf']);
    render_(); pick(zip('labs-a.zip'), zip('labs-b.zip'));
    await findReviewValue('3.9');
    const { results, identities } = await savedResults();
    expect(identities).toEqual([
      ['labs-a.zip/results.pdf', 3.9, 'labs-a.zip/results.pdf'],
      ['labs-b.zip/results.pdf', 4.2, 'labs-b.zip/results.pdf'],
    ]);
    expect(new Set(results.map(r => r.contentHash)).size).toBe(2);
  });
});

// US-12 AC9: the 10 MB limit was checked on picked files only, so a ZIP of
// 1 MB could hold a member that inflates past it and went to pdf.js anyway.
describe('US-12 AC9: a ZIP member over the per-file limit is named and never read', () => {
  const big = () => new Blob([new Uint8Array(11 * 1024 * 1024)]);
  /** One ZIP whose `huge.pdf` member is over the limit; every other member is small. */
  const withHugeMember = (paths: string[]) => zipBundle(async () => paths.map(name => ({
    name, entry: { async: async () => (name === 'huge.pdf' ? big() : new Blob([name])) },
  })));

  it('skips it before pdf.js and reads the rest', async () => {
    withHugeMember(['huge.pdf', 'good.pdf']);
    render_(); pick(zip('labs.zip'));
    await findReviewValue('3.9');
    expect(reasonFor('huge.pdf')).toBe('Too large to read. The limit is 10 MB per file.');
    expect(extractFromPdf.mock.calls.map(([f]) => (f as File).name)).toEqual(['good.pdf']);
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 2, tooLarge: 1, withValues: 1, openFailed: 0 }));
  });
});

// US-12 AC9: the GitHub Pages build has no server of ours and no daily limit.
// It reads with the user's own Anthropic key, so a 429 is that key's
// per-minute rate limit, and a failure is Anthropic's, never "our server".
describe('US-12 AC9: the Pages build names its own transport', () => {
  beforeEach(() => { build.shopify = false; });

  // The engine words the self-hosted build's failed read (it knows the reader, PR 1974), as the grid's notice did.
  it('a failed read on the Pages build names Anthropic, never "our server"', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (
      pages[0].content === 'broken.pdf' ? { result: null, error: 'Network error reaching Anthropic. Check your connection.', errorCode: 'network' } : withValues));
    render_(); pick(pdf('good.pdf'), pdf('broken.pdf'));
    await findReviewValue('3.9');
    expect(reasonFor('broken.pdf')).toBe('Not read. Anthropic could not be reached or could not read it. Please try again.');
  });

  it('says a file was not read because the user\'s key hit its rate limit, or Anthropic could not read it', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (
      pages[0].content === 'broken.pdf' ? { result: null, error: 'Network error reaching Anthropic. Check your connection.', errorCode: 'network' }
        : pages[0].content === 'late.pdf' ? { result: null, error: 'Your Anthropic account is rate-limited right now. Wait a minute and try again.', errorCode: 'key_rate_limit' }
          : withValues));
    render_(); pick(pdf('good.pdf'), pdf('broken.pdf'), pdf('late.pdf'));
    await findReviewValue('3.9');
    expect(reasonFor('late.pdf')).toBe('Not read. Your Anthropic key hit its rate limit. Wait a minute and try again.');
    // The usage signal keeps its keys: a rate limit is still limitError.
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ serverError: 1, limitError: 1 }));
  });

  // US-12 AC9 (adversary R1): the person's own key's minute limit is not our daily limit. It fails that file
  // only, in that key's words; every other file of the pick is still read, as before the shared state.
  it('a key rate limit on one file of 30 fails that file only; the other 29 are read', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (pages[0].content === 'r7.pdf'
      ? { result: null, error: 'Your Anthropic account is rate-limited right now. Wait a minute and try again.', errorCode: 'key_rate_limit' } : withValues));
    render_(); pick(...Array.from({ length: 30 }, (_, i) => pdf(`r${i}.pdf`)));
    await findAllReviewValues('3.9');
    expect(labImport).toHaveBeenCalledTimes(30);
    expect(reasonFor('r7.pdf')).toBe(KEY_TEXT.rateLimit);
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 30, withValues: 29, limitError: 1, serverError: 0 }));
  });

  it('says the key was refused, or its account has no credit, rather than "try again", and counts both as serverError', async () => {
    vi.mocked(labImport).mockImplementation(async pages => (
      pages[0].content === 'refused.pdf' ? { result: null, error: 'x', errorCode: 'key_refused' }
        : pages[0].content === 'broke.pdf' ? { result: null, error: 'x', errorCode: 'no_credit' }
          : withValues));
    render_(); pick(pdf('good.pdf'), pdf('refused.pdf'), pdf('broke.pdf'));
    await findReviewValue('3.9');
    expect(reasonFor('refused.pdf')).toBe('Not read. Anthropic refused your API key. Check the key in the "Ask about your plan" panel.');
    expect(reasonFor('broke.pdf')).toBe('Not read. Your Anthropic account has no credit. Check its billing, then try again.');
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ serverError: 2, limitError: 0 }));
  });

});

describe('US-12 AC13: a .docx is read in the browser and sent as text', () => {
  const word = (name: string) => new File(['x'], name);

  it('sends the document text as one text page and counts the file as docx', async () => {
    docxToText.mockResolvedValue(docxText('Ferritin | 85 | 60 | ug/L | 30-400'));
    render_(); pick(word('baseline.docx'));
    await findReviewValue('3.9');
    expect(labImport).toHaveBeenCalledWith([{ type: 'text', content: 'Ferritin | 85 | 60 | ug/L | 30-400' }], 'si', expect.anything());
    expect(docxToText.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer);
    expect(reasonFor('baseline.docx')).toBeNull();
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 1, withValues: 1, docx: 1 }));
  });

  it('names a .docx with no text, or one that will not open, as could not open', async () => {
    docxToText.mockImplementation(async (b: ArrayBuffer) => { if (b.byteLength === 1) return docxText(''); throw new Error('docx too large'); });
    render_(); pick(pdf('good.pdf'), word('empty.docx'), new File(['xx'], 'bomb.docx'));
    await findReviewValue('3.9');
    expect(reasonFor('empty.docx')).toBe('Could not open it. It may be password-protected, damaged, or not a PDF, photo or .docx file.');
    expect(reasonFor('bomb.docx')).toMatch(/^Could not open it/);
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 3, withValues: 1, openFailed: 2, docx: 2 }));
  });

  // KNOWN (owner ruling Q3, 2026-11-22): the file is named twice, with two reasons: the web's own note beside the list
  // (heldNotices) and the engine's failed line in the list. Lead: engine words these statuses. No screen rule hides either.
  it('KNOWN: refuses a legacy .doc with a notice to save it as PDF or .docx, and never reads it', async () => {
    render_(); pick(pdf('good.pdf'), word('old.doc'));
    await findReviewValue('3.9');
    expect(reasonFor('old.doc')).toBe('Word .doc files cannot be read. Save it as a PDF or .docx, then upload that. | Could not open it. It may be password-protected, damaged, or not a PDF, photo or .docx file.');
    expect(docxToText).not.toHaveBeenCalled();
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 2, openFailed: 1, docx: 0 }));
  });

  it('reads and counts a .docx by the one rule, its mime type when the name has no extension', async () => {
    docxToText.mockResolvedValue(docxText('Ferritin | 85'));
    const typed = new File(['x'], 'baseline', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    render_(); pick(typed);
    await findReviewValue('3.9');
    expect(docxToText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 1, withValues: 1, docx: 1 }));
  });

  // KNOWN (owner ruling Q3): named twice, as the legacy .doc above. Lead: engine words these statuses.
  it('KNOWN: names a .docx of pictures and no text with its own notice, and counts it', async () => {
    docxToText.mockResolvedValue(docxText('', { picturesOnly: true }));
    render_(); pick(pdf('good.pdf'), word('scan.docx'));
    await findReviewValue('3.9');
    expect(reasonFor('scan.docx')).toBe('This Word file holds pictures, not text. Save it as a PDF, or upload a photo of the page. | Could not open it. It may be password-protected, damaged, or not a PDF, photo or .docx file.');
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 2, withValues: 1, picturesOnly: 1, openFailed: 0, docx: 1 }));
  });

  it('sends a long .docx cut short, with the notice a long PDF gets', async () => {
    docxToText.mockResolvedValue(docxText('Ferritin | 85', { truncated: true }));
    render_(); pick(word('long.docx'));
    await findReviewValue('3.9');
    expect(reasonFor('long.docx')).toBe('This file is long, so only its first part was read.');
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 1, withValues: 1, truncated: 1, docx: 1 }));
  });

  it('reads a .docx the browser calls a ZIP as a .docx, never unzips it', async () => {
    docxToText.mockResolvedValue(docxText('Ferritin | 85'));
    const getZipEntries = vi.fn(async () => []);
    Object.assign((window as unknown as { HealthUpload: object }).HealthUpload, { isZip: (f: File) => f.type === 'application/zip', getZipEntries });
    render_(); pick(new File(['x'], 'baseline.docx', { type: 'application/zip' }));
    await findReviewValue('3.9');
    expect(getZipEntries).not.toHaveBeenCalled();
    expect(docxToText).toHaveBeenCalledTimes(1);
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

// Issue #166: a creatinine the extractor would not read is listed under
// "Not saved", once, and counted; a guessed unit is counted (US-12 AC15, AC16).
describe('US-12 AC15, AC16: refused and guessed units are shown and counted', () => {
  it('lists a refused creatinine under "Not saved" on review and done, never as "could not be read", and counts it', async () => {
    vi.mocked(labImport).mockResolvedValue({ result: { ...withValues.result!,
      values: [...withValues.result!.values, { metric: 'hdl', valueSI: 1.2, displayValue: 1.2, displayUnit: '', confidence: 'medium', unitGuessed: true }],
      droppedValueCount: 0,
      refusedValues: [{ metric: 'creatinine', value: 2, unit: 'mg/mmol', reason: 'This unit is usually a urine result.' }],
    } } as Import);
    render_(); pick(pdf('acr.pdf'));
    await findReviewValue('3.9');
    // US-13 AC13: in the person's words from the unit, never the assistant's reason text.
    expect(notSaved()!.lines).toEqual(['Creatinine: this unit is usually a urine result']);
    expect(reasonFor('acr.pdf')).toBeNull();
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ picked: 1, withValues: 1, unitsGuessed: 1, unitsRefused: 1, firstReadSeconds: 0 });
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
  });

  it('a file whose only values were refused is not "No blood test values found." and not counted noValues', async () => {
    vi.mocked(labImport).mockResolvedValue({ result: { ...nothing.result!,
      refusedValues: [{ metric: 'creatinine', value: 2, unit: 'mg/mmol', reason: 'This unit is usually a urine result.' }],
    } } as Import);
    render_(); pick(pdf('acr.pdf'));
    await waitFor(() => expect(notSaved()?.title).toBe('1 value not saved'));
    expect(reasonFor('acr.pdf')).toBeNull();
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ picked: 1, unitsRefused: 1, firstReadSeconds: 0 });
  });
});

// US-13 AC6 (mount 3b): a letter's screening box is the engine's (upload-list-page.ts `screening`), drawn by the list,
// and the person's tick and the plan's age and sex reach the one Save. The date itself is written by the Save's commit
// (health-core upload-save.screening.test.ts), refused after an erase (storage/roadmap-store-upload-save.test.ts), and
// read back into the form (HealthTool.record-read-pins.test.tsx).
describe('US-13 AC6: a letter\'s screening box reaches the Save', () => {
  const screeningLetter: Import = { result: { ...letterOnly.result!, document: { ...letterOnly.result!.document!, classification: 'scan_result', metadata: { screeningType: 'colorectal' } } } } as unknown as Import;
  const box = () => screen.getByRole('checkbox', { name: /^Update colorectal screening date/ }) as HTMLInputElement;

  it('shows the box ticked for an eligible age, and the Save carries the plan\'s age and sex', async () => {
    vi.mocked(labImport).mockResolvedValue(screeningLetter);
    render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" onComplete={() => {}} age={60} sex="male" />);
    pick(pdf('scope.pdf'));
    await waitFor(() => expect(box().checked).toBe(true));
    expect(box().closest('label')!.textContent).toBe('Update colorectal screening date to 1 Jun 2024');
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(vi.mocked(saveUpload).mock.calls[0]![4]).toEqual({ age: 60, sex: 'male' });
  });

  it('an untick is the person\'s choice in the state the Save is handed', async () => {
    vi.mocked(labImport).mockResolvedValue(screeningLetter);
    render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" onComplete={() => {}} age={60} sex="male" />);
    pick(pdf('scope.pdf'));
    await waitFor(() => expect(box().checked).toBe(true));
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    const s = vi.mocked(saveUpload).mock.calls[0]![1];
    expect(s.phase === 'saving' && s.files[0].status.s === 'read' && s.files[0].status.choices.document.screening).toBe(false);
  });

  it('no age and sex from the plan: no box', async () => {
    vi.mocked(labImport).mockResolvedValue(screeningLetter);
    render_(); pick(pdf('scope.pdf'));
    await screen.findByDisplayValue('Synthetic letter');
    expect(screen.queryByRole('checkbox', { name: /screening date/ })).toBeNull();
  });
});

// US-12 AC28: Cancel aborts every read in flight; the late answer changes nothing.
describe('US-12 AC28: Cancel aborts the reads in flight', () => {
  it('hands each read a signal that Cancel aborts', async () => {
    vi.mocked(labImport).mockImplementation(() => new Promise<Import>(() => {}));
    render_(); pick(pdf('a.pdf'), pdf('b.pdf'));
    await waitFor(() => expect(labImport).toHaveBeenCalledTimes(2));
    const signals = vi.mocked(labImport).mock.calls.map(c => c[2]?.signal);
    expect(signals.map(sig => sig?.aborted)).toEqual([false, false]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(signals.map(sig => sig?.aborted)).toEqual([true, true]);
  });
});

// US-12 AC9, AC10 (Brad 2026-11-11, U6 U8 U9): the runs that ended without a
// count, and the files a pick past 200 left out without a word. Known gap: a
// page unmounted mid-read sends nothing.
describe('US-12 AC9, AC10: a quota refusal and a cancel count, and a pick past 200 says what it left out', () => {
  const LEFT_OUT = (n: number) => `Not read. One upload takes at most 200 files. Upload ${n === 1 ? 'it' : 'them'} separately.`;

  it('US-12 AC10 (U6): a refused quota fires one upload_outcome, each file counted under limitError', async () => {
    vi.mocked(checkLabImportQuota).mockResolvedValueOnce({ allowed: false, remaining: 0, reason: 'quota' });
    render_(); pick(pdf('a.pdf'), pdf('b.pdf'), pdf('huge.pdf', 11 * 1024 * 1024));
    await screen.findByText('Daily upload limit reached. You can upload more tomorrow.');
    expect(sent()).toEqual([{ picked: 3, tooLarge: 1, limitError: 2, failedFinal: 2 }]);
    expect(reasonFor('a.pdf')).toBe('Not read. The daily upload limit was reached.');
    expect(extractFromPdf).not.toHaveBeenCalled();
  });

  // Review R1 (adversary F1): only the server's daily limit is a quota refusal.
  it('US-12 AC10: a no-key refusal (Pages build) names no file and sends no upload_outcome', async () => {
    build.shopify = false;
    vi.mocked(checkLabImportQuota).mockResolvedValueOnce({ allowed: false, remaining: 0, reason: 'no-key', message: KEY_TEXT.missing });
    render_(); pick(pdf('a.pdf'), pdf('b.pdf'));
    await screen.findByText(KEY_TEXT.missing);
    expect(screen.queryByRole('list', { name: 'Files to check' })).toBeNull();
    expect(sent()).toEqual([]);
  });

  // Review R2 (adversary, Codex): a failed preflight passes, as a network error does; the POST enforces the limit.
  it('US-12 AC10: a 5xx quota check lets the upload proceed', async () => {
    const real = await vi.importActual<typeof import('../lib/upload-api')>('../lib/upload-api');
    vi.mocked(checkLabImportQuota).mockImplementationOnce(real.checkLabImportQuota);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    try {
      render_(); pick(pdf('a.pdf'));
      await findReviewValue('3.9');
    } finally { vi.unstubAllGlobals(); }
    expect(screen.queryByText('Daily upload limit reached. You can upload more tomorrow.')).toBeNull();
    expect(sent()).toEqual([{ picked: 1, withValues: 1, firstReadSeconds: 0 }]);
  });

  // Review R1 (Codex R1): an oversize file never stands in for a readable one of the same name.
  it('US-12 AC9 (U6): a quota refusal names a readable file that shares its name with an oversize one', async () => {
    vi.mocked(checkLabImportQuota).mockResolvedValueOnce({ allowed: false, remaining: 0, reason: 'quota' });
    render_(); pick(pdf('report.pdf', 11 * 1024 * 1024), pdf('report.pdf'));
    await screen.findByText('Daily upload limit reached. You can upload more tomorrow.');
    expect(reasonFor('report.pdf')).toMatch(/^Too large.* \| Not read\. The daily upload limit was reached\.$/);
    expect(sent()).toEqual([{ picked: 2, tooLarge: 1, limitError: 1, failedFinal: 1 }]);
  });

  it('US-12 AC10 (U9): Cancel during a read fires one upload_outcome with cancelled: 1, and the read finishing later adds none', async () => {
    const finishReads: Array<(r: Import) => void> = [];
    vi.mocked(labImport).mockImplementation(() => new Promise<Import>(resolve => { finishReads.push(resolve); }));
    docxToText.mockResolvedValue(docxText('synthetic'));
    render_(); pick(pdf('a.pdf'), new File(['x'], 'b.docx'), pdf('huge.pdf', 11 * 1024 * 1024));
    await waitFor(() => expect(labImport).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ picked: 3, docx: 1, tooLarge: 1, cancelled: 1 });
    for (const finish of finishReads) finish(withValues);
    await new Promise(r => setTimeout(r, 0));
    expect(sent()).toHaveLength(1);
  });

  // Review R1 (Codex R2, adversary F2): a cancelled run counts on the pick's basis.
  it('US-12 AC10 (U9): Cancel counts an oversize .docx as docx and too large', async () => {
    vi.mocked(labImport).mockImplementation(() => new Promise<Import>(() => {}));
    const huge = new File(['x'], 'huge.docx');
    Object.defineProperty(huge, 'size', { value: 11 * 1024 * 1024 });
    render_(); pick(pdf('a.pdf'), huge);
    await waitFor(() => expect(labImport).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ picked: 2, docx: 1, tooLarge: 1, cancelled: 1 });
  });

  it('US-12 AC10 (U9): Cancel after a ZIP is listed counts it by its members', async () => {
    vi.mocked(labImport).mockImplementation(() => new Promise<Import>(() => {}));
    zipBundle(async () => ['m1.pdf', 'm2.pdf', 'm3.pdf'].map(name => ({ name, entry: { async: async () => new Blob([name]) } })));
    render_(); pick(zip('scans.zip'));
    await waitFor(() => expect(labImport).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ picked: 3, cancelled: 1 });
  });

  // Review R2 (adversary, Codex): a ZIP counts by its members as soon as it is listed, not when every ZIP is.
  it('US-12 AC10 (U9): Cancel while a second ZIP is still opening counts the first by its members and the second as one', async () => {
    const getZipEntries = vi.fn((f: File) => f.name === 'first.zip'
      ? Promise.resolve(['m1.pdf', 'm2.pdf', 'm3.pdf'].map(name => ({ name, entry: { async: async () => new Blob([name]) } })))
      : new Promise<unknown[]>(() => {}));
    zipBundle(getZipEntries);
    render_(); pick(zip('first.zip'), zip('second.zip'));
    await waitFor(() => expect(getZipEntries).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ picked: 4, cancelled: 1, firstReadSeconds: 0 });
  });

  it('US-12 AC10 (U9): Cancel on the review sends nothing more: the read already counted', async () => {
    render_(); pick(pdf('a.pdf'));
    await findReviewValue('3.9');
    await waitFor(() => expect(sent()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sent()).toEqual([{ picked: 1, withValues: 1, firstReadSeconds: 0 }]);
  });

  it('US-12 AC9 (U8): a pick of 202 files reads 200 and says 2 were left out, on the review and done screens, counted under limitError', async () => {
    render_(); pick(...Array.from({ length: 202 }, (_, i) => pdf(`r${i}.pdf`)));
    await findAllReviewValues('3.9');
    expect(labImport).toHaveBeenCalledTimes(200);
    expect(reasonFor('2 more files')).toBe(LEFT_OUT(2));
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()[0]).toEqual(expect.objectContaining({ picked: 202, withValues: 200, limitError: 2 }));
    fireEvent.click(screen.getByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(reasonFor('2 more files')).toBe(LEFT_OUT(2));
  });

  it('US-12 AC9 (U8): the error screen says it too', async () => {
    vi.mocked(checkLabImportQuota).mockResolvedValueOnce({ allowed: false, remaining: 0, reason: 'quota' });
    render_(); pick(...Array.from({ length: 201 }, (_, i) => pdf(`r${i}.pdf`)));
    await screen.findByText('Daily upload limit reached. You can upload more tomorrow.');
    expect(reasonFor('1 more file')).toBe(LEFT_OUT(1));
    expect(sent()).toEqual([{ picked: 201, limitError: 201, failedFinal: 200 }]);
  });

  it('US-12 AC9 (U8): a pick of 201 oversize files names the extra one too, and starts no run', () => {
    render_(); pick(...Array.from({ length: 201 }, (_, i) => pdf(`big${i}.pdf`, 11 * 1024 * 1024)));
    expect(reasonFor('1 more file')).toBe(LEFT_OUT(1));
    expect(checkLabImportQuota).not.toHaveBeenCalled();
    expect(sent()).toEqual([{ picked: 201, tooLarge: 200, limitError: 1 }]);
  });
});
