// @vitest-environment jsdom
/**
 * US-13 AC9: a review that throws while rendering shows a plain message with
 * Cancel, never a dead widget, and reports the error class to Sentry with no
 * values. Same harness shape as UploadModal.outcome.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_ENGINE } from '../testing/upload-engine';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { Sentry } from '../lib/sentry';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ recordFileSync: vi.fn(() => null), saveUpload: vi.fn(), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'cloud'), bulkSaveMeasurements: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async () => '') }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));
// The review throws as the undated-column notice did in review round 5.
const review = vi.hoisted(() => ({ throws: true }));
vi.mock('./UploadList', async importOriginal => {
  const actual = await importOriginal<typeof import('./UploadList')>();
  return { ...actual, UploadList: (props: Parameters<typeof actual.UploadList>[0]) => {
    if (review.throws) throw new TypeError("Cannot read properties of undefined (reading 'padStart')");
    return actual.UploadList(props);
  } };
});

type Import = Awaited<ReturnType<typeof labImport>>;
const withValues: Import = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } } as unknown as Import;

beforeEach(() => {
  vi.clearAllMocks();
  review.throws = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(withValues);
  Object.assign(window, { HealthUpload: { ...UPLOAD_ENGINE,
    extractFromPdf: vi.fn(async (f: File) => ({ pages: [{ type: 'text', content: f.name }], truncated: false })),
    isPdf: (f: File) => f.name.endsWith('.pdf'), isZip: () => false, isImage: () => false,
    resizeImage: vi.fn(), docxToText: vi.fn(),
  } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US-13 AC9: a review that fails to render is never a dead widget', () => {
  it('shows the message with Cancel, reports the error with no values, and Cancel leaves the review', async () => {
    const onClose = vi.fn();
    render(<UploadModal open onOpen={() => {}} onClose={onClose} unitSystem="si" onComplete={() => {}} />);
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'labs.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByText('Something went wrong showing these results. Your file was read; please try again.')).toBeDefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, context] = vi.mocked(Sentry.captureException).mock.calls[0] as [Error, Record<string, unknown>];
    expect(error).toBeInstanceOf(TypeError);
    expect(JSON.stringify(context)).not.toContain('3.9');
    expect(context).toEqual({ tags: { feature: 'upload_review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Something went wrong showing these results/)).toBeNull();
  });
});
