// @vitest-environment jsdom
// US-12 AC32: the upload window explains the feature before anything is picked, on both picking
// screens (the device-only connect panel and the drop zone), and the explainer is gone once files
// are read. The connect panel keeps its gate (encourage, don't block); only its words change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UPLOAD_EXPLAINER_TEXT } from '@roadmap/health-core/upload-text';
import { UPLOAD_ENGINE } from '../testing/upload-engine';
import { findReviewValue } from '../testing/import-review';
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
});

describe('US-12 AC32: the reader sentence follows the build', () => {
  it('the Pages build reads with the person own key, and says so', () => {
    flags.shopify = false;
    show();
    expect(screen.getByText(UPLOAD_EXPLAINER_TEXT.reader.ownKey)).toBeTruthy();
    expect(screen.queryByText(UPLOAD_EXPLAINER_TEXT.reader.server)).toBeNull();
  });
});
