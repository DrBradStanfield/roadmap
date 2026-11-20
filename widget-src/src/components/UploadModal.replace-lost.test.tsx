// @vitest-environment jsdom
/**
 * PR 1906 owner ruling 2026-11-20 (US-13 AC7): a Replace whose target another writer moves away while the
 * review is open is dropped by the shared state and its value unticked, so nothing is written without the
 * person's say and the review is not stuck; typed again, the value saves as a new row. Also the three
 * numbers the review shows (the sure line, the check section, Save's label) add up. The record is in
 * memory (testing/upload-store.ts). Synthetic only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { lastSaved, resetUploadStore } from '../testing/upload-store';
import { recordOf } from '../testing/review-harness';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { uploadKnownIndex } from '../lib/roadmap-data';
import type { UploadHistory } from '../lib/api-types';
import { showAllValues } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', async () => ({ ...(await import('../testing/upload-store')).uploadStoreMock(), getDocumentArchiveMode: vi.fn(() => 'cloud'), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => ''), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false) }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '/apps/synthetic', parseJsonResponse: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: async (b: Blob) => `sha256-${await b.text()}` }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

type Import = Awaited<ReturnType<typeof labImport>>;
const lab = (metric: string, v: number, day = '2024-06-01', more: Record<string, unknown> = {}): Import =>
  ({ result: { classification: 'lab_report', document: null, reportDate: day, values: [{ metric, valueSI: v, displayValue: v, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [], ...more } }) as unknown as Import;
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

const modal = (h: UploadHistory) => <UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={h} onComplete={() => {}} sex="male" />;
const renderWith = (h: UploadHistory) => render(modal(h));

const H = { id: 'H', metricType: 'ldl', value: 4.2, recordedAt: '2024-06-01T00:00:00.000Z', createdAt: '2024-06-01T00:00:00.000Z' };
const both = { 'labs.pdf': lab('ldl', 3.9, '2024-06-01', { values: [
  { metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' },
  { metric: 'hdl', valueSI: 1.4, displayValue: 1.4, displayUnit: 'mmol/L', confidence: 'high' },
] }) };

describe('a Replace whose target moves away during the review (owner ruling 2026-11-20)', () => {
  it('Replace goes, the value is unticked, Save stays for the rest; typed again it saves as a new row', async () => {
    const before = { ...history, measurements: [H] };
    resetUploadStore(recordOf(before));
    answers(both);
    const view = renderWith(before);
    pick(pdf('labs.pdf'));
    await screen.findByText(/^1 file/);
    showAllValues();
    fireEvent.click(screen.getByRole('checkbox', { name: /Replace the saved LDL Cholesterol value/ }));
    // Another writer moves the saved LDL to the next day; the page reads the record again.
    const after = { ...history, measurements: [{ ...H, id: 'H2', recordedAt: '2024-06-02T00:00:00.000Z' }] };
    resetUploadStore(recordOf(after));
    view.rerender(modal(after));
    showAllValues();
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Replace the saved LDL Cholesterol value/ })).toBeNull());
    expect(saveButton().textContent).toBe('Save 1 value');
    expect(saveButton().disabled).toBe(false);
    const ldl = screen.getByLabelText(/LDL Cholesterol value from 1 Jun 2024/) as HTMLInputElement;
    expect(ldl.value).toBe('');
    fireEvent.change(ldl, { target: { value: '3.9' } });
    expect(saveButton().textContent).toBe('Save 2 values');
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().values.map(v => [v.metricName, v.value, v.correctsId ?? null]).sort()).toEqual([['hdl', 1.4, null], ['ldl', 3.9, null]]);
  });
});

describe('the review numbers add up (item 6)', () => {
  it('the sure line and the check section together are Save count', async () => {
    answers({ 'labs.pdf': lab('ldl', 3.9, '2024-06-01', { values: [
      { metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' },
      { metric: 'hdl', valueSI: 1.4, displayValue: 1.4, displayUnit: 'mmol/L', confidence: 'high' },
      // A value the reader asked about: saved unless cleared, listed under "Check".
      { metric: 'triglycerides', valueSI: 1.1, displayValue: 1.1, displayUnit: 'mmol/L', confidence: 'low', question: 'Is this fasting?' },
    ] }) });
    renderWith(history);
    pick(pdf('labs.pdf'));
    const save = await screen.findByRole('button', { name: /^Save \d+ values?$/ });
    const n = (re: RegExp, text: string | null | undefined) => Number(re.exec(text ?? '')?.[1] ?? 0);
    const title = document.querySelector('.review-check-title')?.textContent ?? '';
    const check = /^Check this value/.test(title) ? 1 : n(/^Check these (\d+)/, title);
    const sure = n(/^(\d+) values? will be saved/, document.querySelector('.review-overview-line')?.textContent);
    expect(check).toBeGreaterThan(0);
    expect(sure + check).toBe(n(/^Save (\d+)/, save.textContent));
  });
});

describe('a typed value whose Replace target moves away (Codex pass item 1)', () => {
  it('the typed number goes from the cell, Save writes HDL alone; typed again LDL saves as a new row', async () => {
    const before = { ...history, measurements: [H] };
    resetUploadStore(recordOf(before));
    answers(both);
    const view = renderWith(before);
    pick(pdf('labs.pdf'));
    await screen.findByText(/^1 file/);
    showAllValues();
    fireEvent.change(screen.getByDisplayValue('3.9'), { target: { value: '4.4' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Replace the saved LDL Cholesterol value/ }));
    const after = { ...history, measurements: [{ ...H, id: 'H2', recordedAt: '2024-06-02T00:00:00.000Z' }] };
    resetUploadStore(recordOf(after));
    view.rerender(modal(after));
    showAllValues();
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Replace the saved LDL Cholesterol value/ })).toBeNull());
    const ldl = screen.getByLabelText(/LDL Cholesterol value from 1 Jun 2024/) as HTMLInputElement;
    expect(ldl.value).toBe('');
    expect(saveButton().textContent).toBe('Save 1 value');
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().values.map(v => [v.metricName, v.value])).toEqual([['hdl', 1.4]]);
  });

  it('typed again after the Replace went, LDL saves as a new row', async () => {
    const before = { ...history, measurements: [H] };
    resetUploadStore(recordOf(before));
    answers(both);
    const view = renderWith(before);
    pick(pdf('labs.pdf'));
    await screen.findByText(/^1 file/);
    showAllValues();
    fireEvent.change(screen.getByDisplayValue('3.9'), { target: { value: '4.4' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Replace the saved LDL Cholesterol value/ }));
    const after = { ...history, measurements: [{ ...H, id: 'H2', recordedAt: '2024-06-02T00:00:00.000Z' }] };
    resetUploadStore(recordOf(after));
    view.rerender(modal(after));
    showAllValues();
    await waitFor(() => expect((screen.getByLabelText(/LDL Cholesterol value from 1 Jun 2024/) as HTMLInputElement).value).toBe(''));
    fireEvent.change(screen.getByLabelText(/LDL Cholesterol value from 1 Jun 2024/), { target: { value: '4.4' } });
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().values.map(v => [v.metricName, v.value, v.correctsId ?? null]).sort()).toEqual([['hdl', 1.4, null], ['ldl', 4.4, null]]);
  });
});

describe('an out-of-range value in conflict, its Replace off (Codex pass item 2)', () => {
  it('Save is enabled and writes HDL alone; Replace on blocks it with the existing reason', async () => {
    const before = { ...history, measurements: [{ ...H, value: 2.5 }] };
    resetUploadStore(recordOf(before));
    answers({ 'labs.pdf': lab('ldl', 999, '2024-06-01', { values: [
      { metric: 'ldl', valueSI: 999, displayValue: 999, displayUnit: 'mmol/L', confidence: 'high' },
      { metric: 'hdl', valueSI: 1.4, displayValue: 1.4, displayUnit: 'mmol/L', confidence: 'high' },
    ] }) });
    renderWith(before);
    pick(pdf('labs.pdf'));
    await screen.findByText(/^1 file/);
    showAllValues();
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    const replace = screen.getByRole('checkbox', { name: /Replace the saved LDL Cholesterol value/ });
    fireEvent.click(replace);
    expect(saveButton().disabled).toBe(true);
    expect(document.querySelector('.review-save-why')?.textContent).toBe('Correct or clear the values with errors before saving.');
    fireEvent.click(replace);
    fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Done' });
    expect(lastSaved().values.map(v => [v.metricName, v.value])).toEqual([['hdl', 1.4]]);
  });
});
