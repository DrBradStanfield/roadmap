// @vitest-environment jsdom
/**
 * PR 1906 Codex pass item 3 (US-13 AC14): the review shows the whole rebuilt letter, as the document page
 * draws it (DocumentLightbox's renderer), with its links inert, and lets the person correct its kind;
 * Save writes the kind chosen. The record is in memory (testing/upload-store.ts). Synthetic only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { lastSaved, resetUploadStore } from '../testing/upload-store';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { uploadKnownIndex } from '../lib/roadmap-data';
import type { UploadHistory } from '../lib/api-types';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', async () => ({ ...(await import('../testing/upload-store')).uploadStoreMock(), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => ''), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false) }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '/apps/synthetic', parseJsonResponse: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: async (b: Blob) => `sha256-${await b.text()}` }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const history: UploadHistory = { measurements: [], labValues: [], documents: [] };

/** Each file's answer by the text its pages carry (its name). */
function answers(by: Record<string, Import | Promise<Import>>) {
  vi.mocked(labImport).mockImplementation(async p => by[p[0].content as string]);
}
const pdf = (name: string) => new File([name], name, { type: 'application/pdf' });
const pick = (...files: File[]) => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files } });
const saveButton = () => screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement;

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

const tail = 'The closing paragraph sits well past the first three hundred characters.';
const letterText = `## Plan\n\n${'Synthetic filler sentence for a long clinic letter. '.repeat(12)}\n\nSee [the guideline](https://example.org/guide) for details.\n\n${tail}`;
const letter = { result: { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [],
  document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2024-05-01', contentMarkdown: letterText, metadata: {} } } } as unknown as Import;

describe('the letter in the review (Codex pass item 3)', () => {
  it('shows the whole letter with its link inert, and saves the kind the person picks', async () => {
    answers({ 'letter.pdf': letter });
    render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={history} onComplete={() => {}} sex="male" />);
    pick(pdf('letter.pdf'));
    fireEvent.click(await screen.findByRole('button', { name: '1 letter or document will be saved' }));
    expect(letterText.indexOf(tail)).toBeGreaterThan(300);
    expect(screen.getByText(tail)).toBeTruthy();
    expect(screen.getByText(/the guideline/).closest('a')).toBeNull();
    expect(document.querySelector('.upload-modal a')).toBeNull();
    const kind = screen.getByRole('combobox', { name: 'Synthetic letter, clinic letter' }) as HTMLSelectElement;
    fireEvent.change(kind, { target: { value: 'discharge_summary' } });
    expect(screen.getByRole('combobox', { name: 'Synthetic letter, discharge summary' })).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().documents.map(d => d.type)).toEqual(['discharge_summary']);
  });
});
