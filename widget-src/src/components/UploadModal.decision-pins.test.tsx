// @vitest-environment jsdom
/**
 * Shared upload PR 1 (US-12, US-13): golden pins of the decisions the upload modal makes
 * today (the pick, a plain file's name, the review's defaults, what blocks Save), read
 * from the table the phone runs too (packages/health-core/src/__fixtures__/upload-decisions.json).
 * The pure rows are in lib/upload-decisions.pins.test.tsx. No behaviour change: a later
 * move keeps every row green, unedited. Same harness as UploadModal.outcome.test.tsx.
 * Synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_ENGINE } from '../testing/upload-engine';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import table from '../../../packages/health-core/src/__fixtures__/upload-decisions.json';
import { createEmptyFile, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { uploadFileName } from '@roadmap/health-core/upload-flow';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { getDocumentArchiveMode, recordFileSync, saveUpload } from '../lib/roadmap-data';
import { isPdf } from '../lib/pdf-extract';
import { isImage } from '../lib/image-resize';
import { isZip } from '../lib/file-kinds';
import { findReviewValue } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ recordFileSync: vi.fn(() => null), saveUpload: vi.fn(), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '/apps/synthetic', parseJsonResponse: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async () => 'sha256-synthetic') }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
type Piece = string | { repeat: string; times: number };
const text = (spec: Piece | Piece[]): string =>
  (Array.isArray(spec) ? spec : [spec]).map(p => (typeof p === 'string' ? p : p.repeat.repeat(p.times))).join('');
const row = <T extends { case: string }>(rows: T[], name: string) => rows.find(r => r.case === name)!;

const value = (metric: string, valueSI: number, more: Record<string, unknown> = {}) =>
  ({ metric, valueSI, displayValue: valueSI, displayUnit: 'mmol/L', confidence: 'high', ...more });
const letter = { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2024-06-01', contentMarkdown: 'letter', metadata: {} };
const extraction = (more: Record<string, unknown>): Import =>
  ({ result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [], additionalValues: [], ...more } }) as unknown as Import;

const readers = {
  extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'x' }], truncated: false })),
  resizeImage: vi.fn(async () => 'base64'),
  docxToText: vi.fn(async () => ({ text: 'x', truncated: false, picturesOnly: false })),
  getZipEntries: vi.fn(async () => []),
};

/** The modal over `record`, the record as the store holds it (the list reads it, mount 3b). */
function open(record: RoadmapFile | null = null) {
  vi.mocked(recordFileSync).mockReturnValue(record);
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" onComplete={() => {}} />);
}
/** Types `text` into a review input and leaves it: the list commits a draft on blur. */
function retype(input: HTMLElement, text: string) {
  act(() => input.focus());
  fireEvent.change(input, { target: { value: text } });
  act(() => input.blur());
}
function pick(name: string, bytes = 1, type = '') {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: bytes });
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file] } });
  return file;
}
// An empty selection names nothing after Save, so its name is "Save" alone.
const saveButton = () => screen.findByRole('button', { name: /^Save\b/ }) as Promise<HTMLButtonElement>;
const filesToCheck = () => screen.queryByRole('list', { name: 'Files to check' })?.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDocumentArchiveMode).mockReturnValue('cloud');
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(extraction({ reportDate: null }));
  vi.mocked(saveUpload).mockResolvedValue({ ok: true, outcome: { values: 0, documents: 1, archived: 0, unstored: 0 }, added: [] });
  // The upload bundle's real type checks, with readers that only say they ran.
  Object.assign(window, { HealthUpload: { ...UPLOAD_ENGINE, isPdf, isImage, isZip, ...readers } });
});
afterEach(cleanup);

/** Which reader opened the picked file, or the notice that stopped it. */
async function verdict(): Promise<string> {
  let found = '';
  await waitFor(() => {
    found = readers.extractFromPdf.mock.calls.length ? 'pdf'
      : readers.resizeImage.mock.calls.length ? 'image'
        : readers.docxToText.mock.calls.length ? 'docx'
          : readers.getZipEntries.mock.calls.length ? 'zip'
            : filesToCheck().includes('Word .doc files cannot be read') ? 'legacyDoc'
              : filesToCheck().includes('Too large to read') ? 'tooLarge'
                : filesToCheck().includes('Could not open it') ? 'refused' : '';
    expect(found).not.toBe('');
  });
  return found;
}

describe('upload decisions: a picked file kept or refused by its name (D15)', () => {
  it.each(table.fileKinds.rows)('$name → $web', async ({ name, web }) => {
    open();
    pick(name);
    expect(await verdict()).toBe(web);
  });
});

describe('upload decisions: a picked file kept or refused by its size (D8)', () => {
  it.each(table.fileSizes.rows)('$name of $bytes bytes → $web', async ({ name, bytes, web }) => {
    open();
    pick(name, bytes);
    const found = await verdict();
    expect(found === 'tooLarge' ? 'tooLarge' : 'read').toBe(web);
  });
});

describe('upload decisions: a picked photo is sent at its long side (D10)', () => {
  it('resizes to the table\'s web px', async () => {
    open();
    const file = pick('scan.jpg');
    await waitFor(() => expect(readers.resizeImage).toHaveBeenCalled());
    expect(readers.resizeImage.mock.calls[0]).toEqual([file, table.photoResize.web]);
  });
});

// The web's Save is the shared engine's (mount 3b): a plain file is named by the shared rule (control characters to
// spaces, 255 at most), the table's web column.
describe('upload decisions: a plain file\'s sourceFileName (D13)', () => {
  it.each(table.naming.rows.filter(r => r.kind === 'plain'))('$name → $web', async ({ name, web }) => {
    vi.mocked(labImport).mockResolvedValue(extraction({ classification: 'clinic_letter', reportDate: null, document: letter }));
    open();
    pick(text(name!), 1, 'application/pdf');
    fireEvent.click(await saveButton());
    await waitFor(() => expect(saveUpload).toHaveBeenCalled());
    // The shared Save files the letter under its file's name as the state holds it (upload-plan.ts `sourceFileName`).
    const s = vi.mocked(saveUpload).mock.calls[0][1];
    expect(s.phase === 'saving' ? s.files.map(uploadFileName) : []).toEqual([text(web)]);
  });
});

describe('upload decisions: what the review starts with (D1, D3)', () => {
  const rows = table.reviewDefaults.rows;

  it('a plain value starts ticked', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ values: [value('ldl', 2.8)] }));
    open();
    pick('labs.pdf');
    expect((await saveButton()).textContent).toMatch(/1 value\b/);
    expect(row(rows, 'plain value').web.ticked).toBe(true);
  });

  it('a value with an extractor question starts ticked (D1)', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ values: [value('hdl', 1.4, { confidence: 'medium', question: 'Was this a blood test?' })] }));
    open();
    pick('labs.pdf');
    expect((await saveButton()).textContent).toMatch(/1 value\b/);
    expect(row(rows, 'value with an extractor question').web.ticked).toBe(true);
  });

  const keeps = async (record: RoadmapFile | null) => {
    vi.mocked(labImport).mockResolvedValue(extraction({ classification: 'clinic_letter', reportDate: null, document: letter }));
    open(record);
    pick('letter.pdf');
    return /\d+ document/.test((await saveButton()).textContent ?? '');
  };
  it('document, sourceFileName not held → its keep tick', async () => {
    expect(await keeps(null)).toBe(row(rows, 'document, sourceFileName not held').web.keepDocument);
  });
  // Every read letter saves (US-13 AC14): a letter named like one the record holds is kept.
  it('document, sourceFileName held → its keep tick', async () => {
    const held = createEmptyFile({ deviceId: 'web', now: '2024-06-02T00:00:00.000Z' });
    held.documents.push({ id: 'D', type: 'clinic_letter', title: 'Earlier', date: null, sourceFileName: 'letter.pdf', extractedText: '', metadata: {}, createdAt: '2024-06-02T00:00:00.000Z' } as unknown as RoadmapFile['documents'][number]);
    expect(await keeps(held)).toBe(row(rows, 'document, sourceFileName held').web.keepDocument);
  });

  // D3, decided by Brad 2026-11-21: the letter is filed alone, its values not saved.
  it('a letter with values: the letter alone (D3)', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ classification: 'clinic_letter', values: [value('ldl', 2.8)], document: letter }));
    open();
    pick('letter.pdf');
    const label = (await saveButton()).textContent ?? '';
    const web = row(rows, 'letter with values').web;
    expect([/1 value\b/.test(label), /1 document/.test(label)]).toEqual([web.values, web.document]);
  });
});

describe('upload decisions: what blocks Save (D2, D6)', () => {
  const rows = table.saveBlocks.rows;
  // The list never disables Save: it refuses it (aria-disabled) and says why beside it (US-13 AC26).
  const blocked = (b: HTMLButtonElement) => (b.getAttribute('aria-disabled') === 'true' ? 'blocked' : b.textContent);

  it('nothing ticked, no cloud: Save is blocked', async () => {
    vi.mocked(getDocumentArchiveMode).mockReturnValue('device-only');
    vi.mocked(labImport).mockResolvedValue(extraction({ values: [value('ldl', 2.8)] }));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Continue without keeping the files ›' }));
    pick('labs.pdf');
    retype(await findReviewValue('2.8'), '');
    expect(blocked(await saveButton())).toBe(row(rows, 'nothing ticked').web);
  });

  it('nothing ticked, cloud connected: Save files the original alone (D6)', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ values: [value('ldl', 2.8)] }));
    open();
    pick('labs.pdf');
    retype(await findReviewValue('2.8'), '');
    const label = blocked(await saveButton());
    expect(row(rows, 'nothing ticked, cloud connected').web).toBe('original only');
    expect(label).toBe('Save 1 original');
  });

  it('an undated report with no day given: Save is blocked', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ reportDate: null, values: [value('ldl', 2.8)] }));
    open();
    pick('labs.pdf');
    await findReviewValue('2.8');
    expect(blocked(await saveButton())).toBe(row(rows, 'undated report, no day given').web);
  });

  it('one value typed invalid blocks the whole Save (D2)', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ values: [value('ldl', 2.8), value('hdl', 1.4)] }));
    open();
    pick('labs.pdf');
    retype(await findReviewValue('2.8'), '1.2.3');
    expect(blocked(await saveButton())).toBe(row(rows, 'one value typed invalid').web);
  });
});
