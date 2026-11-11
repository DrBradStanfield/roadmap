/**
 * Shared upload PR 1 (US-12): golden pins of the web's upload decisions today, read from
 * the table both clients run (packages/health-core/src/__fixtures__/upload-decisions.json;
 * the phone: ios/HealthRoadmapTests/UploadDecisionPinsTests.swift). No behaviour change:
 * a later move into health-core keeps every row green, unedited. The rows the modal
 * decides (pick, naming, review, save) are in components/UploadModal.decision-pins.test.tsx.
 * Synthetic names and bytes only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import JSZip from 'jszip';
import table from '../../../packages/health-core/src/__fixtures__/upload-decisions.json';
import { IMPORT_LIMITS } from '@roadmap/health-core/import-hints';
import { zipMemberName } from '@roadmap/health-core/lab-extraction';
import { BATCH_THRESHOLD, MAX_FILE_SIZE, processPipeline, type FileNotice, type ReadInput } from './upload-pipeline';
import { getZipEntries, isZip } from './zip-extract';
import { isPdf } from './pdf-extract';
import { isImage } from './image-resize';
import { MAX_FILES } from '../hooks/useUploadFlow';
import { FileNotices } from '../components/UploadNotices';
import type { HealthUploadAPI } from '../upload-entry';

// The Shopify build's words: the per-file notices the server path shows.
vi.mock('./build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

type Piece = string | { repeat: string; times: number };
/** A name from the table: a string, or pieces where {repeat, times} is that many copies. */
const text = (spec: Piece | Piece[]): string =>
  (Array.isArray(spec) ? spec : [spec]).map(p => (typeof p === 'string' ? p : p.repeat.repeat(p.times))).join('');

afterEach(() => { vi.unstubAllGlobals(); });

/** The upload bundle with its real type checks and readers that only say they ran. */
function fakeUpload(): HealthUploadAPI {
  return {
    isPdf, isImage, isZip, getZipEntries,
    extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text' as const, content: 'x' }], truncated: false })),
    resizeImage: vi.fn(async () => 'b64'),
    docxToText: vi.fn(async () => ({ text: 'x', truncated: false, picturesOnly: false })),
  } as unknown as HealthUploadAPI;
}

/** One file through the real pipeline and the real labImport, the server answering `reply`. */
async function readOne(input: ReadInput, reply: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(reply));
  const notices: FileNotice[] = [];
  const upload = fakeUpload();
  const results = await processPipeline(upload, [input], new AbortController(), () => {}, 'si', notices).catch(() => []);
  return { results, notices, upload };
}

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = () => Promise.resolve(json({ success: true, data: { classification: 'lab_report', reportDate: null, values: [], additionalValues: [], document: null } }, 200));

/** A notice's words as FileNotices shows them, its name left out. */
function words(notice: FileNotice): string {
  const html = renderToStaticMarkup(<FileNotices notices={[notice]} />);
  const li = html.match(/<li>(.*?)<\/li>/)![1];
  return li.replace(/<span[^>]*>.*?<\/span>/, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}

describe('upload decisions: web limits (D8)', () => {
  it('reads with the limits the table names', () => {
    const web = table.limits.web;
    expect(MAX_FILE_SIZE).toBe(web.fileBytes);
    expect(MAX_FILES).toBe(web.filesPerPick);
    expect(IMPORT_LIMITS.websiteFiles).toBe(web.zipMembers);
    expect(IMPORT_LIMITS.websitePdfPages).toBe(web.pdfPages);
    expect(IMPORT_LIMITS.websiteTextPageChars).toBe(web.textPageChars);
    expect(BATCH_THRESHOLD).toBe(web.batchFrom);
  });
});

describe('upload decisions: a ZIP member read or skipped (D9)', () => {
  it.each(table.zipMembers.rows)('$path → $web', async ({ path, web }) => {
    const zip = new JSZip();
    zip.file(path, 'x');
    const file = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'labs.zip', { type: 'application/zip' });
    expect((await getZipEntries(file)).map(e => e.name)).toEqual(web ? [path] : []);
  });
});

describe('upload decisions: ZIP member counts (D8)', () => {
  it.each(table.zipCounts.rows)('$members members → $web.read read, the rest dropped without a notice', async ({ members, web }) => {
    const zip = new JSZip();
    for (let i = 0; i < members; i++) zip.file(`r${String(i).padStart(3, '0')}.pdf`, 'x');
    const file = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'labs.zip', { type: 'application/zip' });
    expect((await getZipEntries(file)).length).toBe(web.read);
  });
});

describe('upload decisions: a file read or not by its size (D8)', () => {
  // The pick checks the same limit first (UploadModal.decision-pins.test.tsx); a ZIP member meets only this one.
  it.each(table.fileSizes.rows.filter(r => r.name.endsWith('.pdf')))('$name of $bytes bytes → $web', async ({ name, bytes, web }) => {
    const file = new File(['x'], name, { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: bytes });
    const { notices, upload } = await readOne({ fileName: name, getFile: async () => file }, ok);
    expect(notices.some(n => n.reason === 'tooLarge') ? 'tooLarge' : 'read').toBe(web);
    expect(vi.mocked(upload.extractFromPdf).mock.calls.length).toBe(web === 'read' ? 1 : 0);
  });

  it('a ZIP member over the cap is noted alone; the ZIP goes on (zipMemberOverCap)', async () => {
    const row = table.fileSizes.zipMemberOverCap;
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: row.bytes });
    vi.stubGlobal('fetch', vi.fn(ok));
    const notices: FileNotice[] = [];
    const inputs: ReadInput[] = [
      { fileName: 'labs.zip/big.pdf', getFile: async () => big },
      { fileName: 'labs.zip/small.pdf', getFile: async () => new File(['x'], 'small.pdf', { type: 'application/pdf' }) },
    ];
    const results = await processPipeline(fakeUpload(), inputs, new AbortController(), () => {}, 'si', notices);
    expect(row.web).toBe('memberNoticed');
    expect(notices).toEqual([{ name: 'labs.zip/big.pdf', reason: 'tooLarge' }]);
    expect(results.map(r => r.fileName)).toEqual(['labs.zip/small.pdf']);
  });
});

describe('upload decisions: a ZIP member\'s sourceFileName', () => {
  it.each(table.naming.rows.filter(r => r.kind === 'zip'))('$zip member → its zipMemberName', ({ zip, path, web }) => {
    expect(zipMemberName(zip!, text(path!))).toBe(text(web));
  });
});

describe('upload decisions: failure → words, Shopify build (D14)', () => {
  const reply = (row: (typeof table.failures.rows)[number]) => () =>
    row.network ? Promise.reject(new TypeError('Failed to fetch'))
      : Promise.resolve(json(row.errorCode ? { errorCode: row.errorCode } : { error: 'x' }, row.status!));

  it.each(table.failures.rows.filter(r => r.web))('$case → its notice', async (row) => {
    const { results, notices } = await readOne({ fileName: 'labs.pdf', getFile: async () => new File(['x'], 'labs.pdf', { type: 'application/pdf' }) }, reply(row));
    expect(results.map(r => !!r.error)).toEqual([true]);
    expect(notices).toHaveLength(1);
    expect(words(notices[0])).toBe(row.web!.words);
    // The web offers no per-file Try again.
    expect(row.web!.retry).toBe(false);
  });

  it('the web has no request timeout, so no words for one (timeout row)', () => {
    expect(table.failures.rows.find(r => r.case === 'timeout')!.web).toBeNull();
  });
});
