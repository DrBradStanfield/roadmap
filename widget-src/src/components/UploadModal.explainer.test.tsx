// @vitest-environment jsdom
// US-12 AC32: the upload window explains the feature before anything is picked, on both picking
// screens (the device-only connect panel and the drop zone), and the explainer is gone once files
// are read. The connect panel keeps its gate (encourage, don't block); only its words change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UPLOAD_EXPLAINER_TEXT } from '@roadmap/health-core/upload-text';
import { UPLOAD_ENGINE } from '../testing/upload-engine';
import { findAllReviewValues, findReviewValue, reasonFor } from '../testing/import-review';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { getDocumentArchiveMode } from '../lib/roadmap-data';
import { openBackendPicker } from '../lib/storage-notice';

const flags = vi.hoisted(() => ({ shopify: true }));
vi.mock('../lib/build-flags', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/build-flags')>(),
  get SHOPIFY_SURFACE() { return flags.shopify; },
}));
vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ recordFileSync: vi.fn(() => null), saveUpload: vi.fn(), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/storage-notice', async importOriginal => ({ ...await importOriginal<typeof import('../lib/storage-notice')>(), openBackendPicker: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async () => '') }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const extraction = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } };
const onClose = vi.fn();
const show = () => render(<UploadModal open onOpen={() => {}} onClose={onClose} unitSystem="si" onComplete={() => {}} />);
const drawing = () => document.querySelector('.upload-explainer-drawing');
const pick = () => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], 'test.pdf', { type: 'application/pdf' })] } });
/** True when `a` comes before `b` in the document. */
const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  vi.clearAllMocks();
  flags.shopify = true;
  vi.mocked(getDocumentArchiveMode).mockReturnValue('cloud');
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(extraction as Awaited<ReturnType<typeof labImport>>);
  const extractFromPdf = vi.fn().mockResolvedValue({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false });
  Object.assign(window, { HealthUpload: { ...UPLOAD_ENGINE, extractFromPdf, isPdf: () => true, isZip: () => false, isImage: () => false } });
});
afterEach(cleanup);

describe('US-12 AC32: no cloud connected, the connect panel', () => {
  beforeEach(() => vi.mocked(getDocumentArchiveMode).mockReturnValue('device-only'));

  it('heads the panel with the drawing, what the upload does and who reads it, in that order', () => {
    show();
    const what = screen.getByText(UPLOAD_EXPLAINER_TEXT.what);
    const reader = screen.getByText(UPLOAD_EXPLAINER_TEXT.reader.server);
    const title = screen.getByRole('heading', { name: UPLOAD_EXPLAINER_TEXT.connectTitle });
    expect(drawing()).toBeTruthy();
    expect([before(drawing()!, what), before(what, reader), before(reader, title)]).toEqual([true, true, true]);
  });

  it('says what keeping the files does, and no longer shows the old title or notice', () => {
    show();
    expect(screen.getByText(UPLOAD_EXPLAINER_TEXT.connectText)).toBeTruthy();
    expect(screen.queryByText('Keep your original documents')).toBeNull();
    expect(screen.queryByText(/Our server never stores them/)).toBeNull();
  });

  it('keeps the gate: the button opens the picker, the skip shows the drop zone and the explainer stays', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Choose where to keep it' }));
    expect(openBackendPicker).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    cleanup();
    show();
    fireEvent.click(screen.getByRole('button', { name: UPLOAD_EXPLAINER_TEXT.connectSkip }));
    expect(screen.queryByRole('heading', { name: UPLOAD_EXPLAINER_TEXT.connectTitle })).toBeNull();
    expect(screen.getByText('Drop health records here, or click to browse')).toBeTruthy();
    expect(drawing()).toBeTruthy();
  });
});

describe('US-12 AC32: a cloud connected, the drop zone', () => {
  it('heads the drop zone with the drawing, what the upload does and who reads it, in that order', () => {
    show();
    const what = screen.getByText(UPLOAD_EXPLAINER_TEXT.what);
    const reader = screen.getByText(UPLOAD_EXPLAINER_TEXT.reader.server);
    const zone = screen.getByText('Drop health records here, or click to browse');
    expect([before(drawing()!, what), before(what, reader), before(reader, zone)]).toEqual([true, true, true]);
  });

  it('is gone once files are picked and read', async () => {
    show();
    pick();
    await findReviewValue('3.9');
    expect(drawing()).toBeNull();
    expect(screen.queryByText(UPLOAD_EXPLAINER_TEXT.what)).toBeNull();
  });

  // The web refuses only an over-limit file at the pick (fileVerdict); an unsupported one is tried and fails to read.
  it.each([
    ['one over-limit file', ['huge.pdf']],
    ['one over-limit file and one unsupported file', ['huge.pdf', 'notes.txt']],
  ])('stays gone after a pick of %s, so the notices sit under the drop zone', async (_, names) => {
    Object.assign((window as unknown as { HealthUpload: object }).HealthUpload, { isPdf: (f: File) => f.name.endsWith('.pdf') });
    show();
    const files = names.map(name => {
      const f = new File(['x'], name, { type: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain' });
      if (name === 'huge.pdf') Object.defineProperty(f, 'size', { value: 11 * 1024 * 1024 });
      return f;
    });
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files } });
    for (const name of names) await screen.findAllByText(new RegExp(name.replace('.', '\\.')));
    expect(screen.getByText('Drop health records here, or click to browse')).toBeTruthy();
    expect(drawing()).toBeNull();
    expect(screen.queryByText(UPLOAD_EXPLAINER_TEXT.what)).toBeNull();
  });

  it('is back on a fresh open, and on the next open after a discarded review', async () => {
    const { rerender } = show();
    expect(drawing()).toBeTruthy();
    pick();
    await findReviewValue('3.9');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    rerender(<UploadModal open={false} onOpen={() => {}} onClose={onClose} unitSystem="si" onComplete={() => {}} />);
    rerender(<UploadModal open onOpen={() => {}} onClose={onClose} unitSystem="si" onComplete={() => {}} />);
    expect(drawing()).toBeTruthy();
    expect(screen.getByText(UPLOAD_EXPLAINER_TEXT.what)).toBeTruthy();
  });
});

// US-12 AC9, AC32 (PR 2030 re-check): the files a pick left out past MAX_FILES belong to that pick alone.
// A stale count kept the old notice on a fresh open, and so hid the explainer.
describe('US-12 AC9, AC32: the left-out notice lives only as long as its pick', () => {
  const files = (n: number, bytes = 1) => Array.from({ length: n }, (_, i) => {
    const f = new File(['x'], `r${i}.pdf`, { type: 'application/pdf' });
    Object.defineProperty(f, 'size', { value: bytes });
    return f;
  });
  const pickMany = (list: File[]) => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: list } });
  const reopen = (rerender: ReturnType<typeof show>['rerender']) => {
    rerender(<UploadModal open={false} onOpen={() => {}} onClose={onClose} unitSystem="si" onComplete={() => {}} />);
    rerender(<UploadModal open onOpen={() => {}} onClose={onClose} unitSystem="si" onComplete={() => {}} />);
  };

  it('a pick past the limit whose every file is refused, closed and reopened, shows no notice and shows the explainer', async () => {
    const { rerender } = show();
    pickMany(files(201, 11 * 1024 * 1024));
    expect(await screen.findByText('1 more file')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    reopen(rerender);
    expect(screen.queryByText('1 more file')).toBeNull();
    expect(drawing()).toBeTruthy();
  });

  it('a pick past the limit of readable files still says what it left out on its review', async () => {
    show();
    pickMany(files(201));
    await findAllReviewValues('3.9');
    expect(reasonFor('1 more file')).toMatch(/^Not read\. One upload takes at most 200 files/);
    expect(drawing()).toBeNull();
  });

  it('after a discarded review that had the notice, a fresh open shows no notice and shows the explainer', async () => {
    const { rerender } = show();
    pickMany(files(201));
    await findAllReviewValues('3.9');
    expect(reasonFor('1 more file')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    reopen(rerender);
    expect(screen.queryByText('1 more file')).toBeNull();
    expect(drawing()).toBeTruthy();
  });
});

describe('US-12 AC32: the reader sentence follows the build', () => {
  it('the Pages build reads with the person own key, and says so', () => {
    flags.shopify = false;
    show();
    expect(screen.getByText(UPLOAD_EXPLAINER_TEXT.reader.ownKey)).toBeTruthy();
    expect(screen.queryByText(UPLOAD_EXPLAINER_TEXT.reader.server)).toBeNull();
  });
});
