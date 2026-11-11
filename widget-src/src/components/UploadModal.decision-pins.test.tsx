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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import table from '../../../packages/health-core/src/__fixtures__/upload-decisions.json';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { bulkSaveDocuments, bulkSaveLabValues, bulkSaveMeasurements, getDocumentArchiveMode } from '../lib/roadmap-data';
import { isPdf } from '../lib/pdf-extract';
import { isImage } from '../lib/image-resize';
import { isZip } from '../lib/zip-extract';
import type { UploadHistory } from '../lib/api-types';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'cloud'), bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '/apps/synthetic', parseJsonResponse: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), attachOriginals: vi.fn(async results => results) }));
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
const noHistory: UploadHistory = { measurements: [], labValues: [], documents: [] };

const readers = {
  extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'x' }], truncated: false })),
  resizeImage: vi.fn(async () => 'base64'),
  docxToText: vi.fn(async () => ({ text: 'x', truncated: false, picturesOnly: false })),
  getZipEntries: vi.fn(async () => []),
};

function open(history: UploadHistory = noHistory) {
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={history} onComplete={() => {}} />);
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
  vi.mocked(bulkSaveMeasurements).mockResolvedValue({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] });
  vi.mocked(bulkSaveDocuments).mockResolvedValue({ saved: [], errorCount: 0 } as unknown as Awaited<ReturnType<typeof bulkSaveDocuments>>);
  vi.mocked(bulkSaveLabValues).mockResolvedValue({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] });
  // The upload bundle's real type checks, with readers that only say they ran.
  Object.assign(window, { HealthUpload: { isPdf, isImage, isZip, ...readers } });
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

describe('upload decisions: a plain file\'s sourceFileName (D13)', () => {
  it.each(table.naming.rows.filter(r => r.kind === 'plain'))('$name → its raw name', async ({ name, web }) => {
    vi.mocked(labImport).mockResolvedValue(extraction({ classification: 'clinic_letter', reportDate: null, document: letter }));
    open();
    pick(text(name!), 1, 'application/pdf');
    fireEvent.click(await saveButton());
    await waitFor(() => expect(bulkSaveDocuments).toHaveBeenCalled());
    expect(vi.mocked(bulkSaveDocuments).mock.calls[0][0].map(d => d.sourceFileName)).toEqual([text(web)]);
  });
});

describe('upload decisions: what the review starts with (D1, D3)', () => {
  const rows = table.reviewDefaults.rows;

  it('a plain value starts ticked', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ values: [value('ldl', 2.8)] }));
    open();
    pick('labs.pdf');
    expect((await saveButton()).textContent).toMatch(/1 Value\b/);
    expect(row(rows, 'plain value').web.ticked).toBe(true);
  });

  it('a value with an extractor question starts ticked (D1)', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ values: [value('hdl', 1.4, { confidence: 'medium', question: 'Was this a blood test?' })] }));
    open();
    pick('labs.pdf');
    expect((await saveButton()).textContent).toMatch(/1 Value\b/);
    expect(row(rows, 'value with an extractor question').web.ticked).toBe(true);
  });

  it.each([
    ['document, sourceFileName not held', noHistory],
    ['document, sourceFileName held', { ...noHistory, documents: [{ id: 'D', documentType: 'clinic_letter', title: 'Earlier', documentDate: null, sourceFileName: 'letter.pdf', createdAt: '2024-06-02T00:00:00.000Z' }] } as unknown as UploadHistory],
  ] as const)('%s → its keep tick', async (name, history) => {
    vi.mocked(labImport).mockResolvedValue(extraction({ classification: 'clinic_letter', reportDate: null, document: letter }));
    open(history);
    pick('letter.pdf');
    const label = (await saveButton()).textContent ?? '';
    expect(/\d+ Document/.test(label)).toBe(row(rows, name).web.keepDocument);
  });

  it('a letter with values offers both (D3)', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ classification: 'clinic_letter', values: [value('ldl', 2.8)], document: letter }));
    open();
    pick('letter.pdf');
    const label = (await saveButton()).textContent ?? '';
    const web = row(rows, 'letter with values').web;
    expect([/1 Value\b/.test(label), /1 Document/.test(label)]).toEqual([web.values, web.document]);
  });
});

describe('upload decisions: what blocks Save (D2, D6)', () => {
  const rows = table.saveBlocks.rows;
  const blocked = (b: HTMLButtonElement) => (b.disabled ? 'blocked' : b.textContent);

  it('nothing ticked, no cloud: Save is blocked', async () => {
    vi.mocked(getDocumentArchiveMode).mockReturnValue('device-only');
    vi.mocked(labImport).mockResolvedValue(extraction({ values: [value('ldl', 2.8)] }));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Continue without keeping my files ›' }));
    pick('labs.pdf');
    fireEvent.change(await screen.findByDisplayValue('2.8'), { target: { value: '' } });
    expect(blocked(await saveButton())).toBe(row(rows, 'nothing ticked').web);
  });

  it('nothing ticked, cloud connected: Save files the original alone (D6)', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ values: [value('ldl', 2.8)] }));
    open();
    pick('labs.pdf');
    fireEvent.change(await screen.findByDisplayValue('2.8'), { target: { value: '' } });
    const label = blocked(await saveButton());
    expect(row(rows, 'nothing ticked, cloud connected').web).toBe('original only');
    expect(label).toBe('Save 1 Original');
  });

  it('an undated report with no day given: Save is blocked', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ reportDate: null, values: [value('ldl', 2.8)] }));
    open();
    pick('labs.pdf');
    await screen.findByDisplayValue('2.8');
    expect(blocked(await saveButton())).toBe(row(rows, 'undated report, no day given').web);
  });

  it('one value typed invalid blocks the whole Save (D2)', async () => {
    vi.mocked(labImport).mockResolvedValue(extraction({ values: [value('ldl', 2.8), value('hdl', 1.4)] }));
    open();
    pick('labs.pdf');
    fireEvent.change(await screen.findByDisplayValue('2.8'), { target: { value: '1.2.3' } });
    expect(blocked(await saveButton())).toBe(row(rows, 'one value typed invalid').web);
  });
});
