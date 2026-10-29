// @vitest-environment jsdom
// US-02 AC4 / US-13: real review, upload save handler and local persistence.
// Only extraction, archive bytes and telemetry are synthetic boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { flushRoadmapStore, initRoadmapStore } from '../lib/roadmap-data';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async original => ({ ...await original<typeof import('../lib/archive-payloads')>(), attachOriginals: vi.fn(async results => results), synthesizeLabArchiveEntries: vi.fn(() => []) }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

beforeEach(async () => {
  localStorage.clear();
  vi.clearAllMocks();
  await initRoadmapStore(new LocalStorageAdapter());
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue({ result: {
    classification: 'lab_report', document: null, reportDate: '2025-01-10',
    values: [{ metric: 'ldl', valueSI: 3.2, displayValue: 3.2, displayUnit: 'mmol/L', confidence: 'high' }],
    additionalValues: [{ name: 'Base excess', value: -2, unit: 'mmol/L' }, { name: 'Synthetic test', value: 4, unit: 'mg/L' }],
  } });
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'Synthetic report' }], truncated: false })),
    isPdf: () => true, isZip: () => false, isImage: () => false, resizeImage: vi.fn(), docxToText: vi.fn(),
  } });
});
afterEach(async () => { cleanup(); await flushRoadmapStore(); });

async function disk() {
  await flushRoadmapStore();
  return (await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body as RoadmapFile;
}

async function review() {
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}}
    history={{ measurements: [], labValues: [], documents: [] }} onComplete={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Continue without keeping my files ›' }));
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' })] } });
  return await screen.findByDisplayValue('4') as HTMLInputElement;
}

describe('US-02 AC4 / AC7: ranged comma readings reach the persisted record', () => {
  it('persists creatinine 1234, never 1.234, while retaining the untouched negative', async () => {
    vi.mocked(labImport).mockResolvedValue({ result: {
      classification: 'lab_report', document: null, reportDate: '2025-01-10',
      values: [{ metric: 'creatinine', valueSI: 80, displayValue: 80, displayUnit: 'µmol/L', confidence: 'high' }],
      additionalValues: [{ name: 'Base excess', value: -2, unit: 'mmol/L' }, { name: 'Synthetic test', value: 4, unit: 'mg/L' }],
    } });
    await review();
    fireEvent.change(screen.getByDisplayValue('80'), { target: { value: '1,234' } });
    const button = screen.getByRole('button', { name: /^Save / }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Done' });
    const file = await disk();
    expect(file.measurements.map(r => [r.metricType, r.value])).toEqual([['creatinine', 1234]]);
    expect(file.labValues.map(r => [r.metricName, r.value])).toContainEqual(['Base excess', -2]);
  });

  it.each([
    ['1,234', 'Did you mean 1234 or 1.234?'],
    ['1,234,567', 'Type the number without commas.'],
    ['1.2.3', 'Enter a number'],
    ['+5', 'Type one decimal number, without signs, < > or spaces'],
  ])('refuses free-form %j without writing any rows, then persists the explicit correction', async (text, message) => {
    const input = await review();
    fireEvent.change(input, { target: { value: text } });
    const button = screen.getByRole('button', { name: /^Save / }) as HTMLButtonElement;
    expect(screen.getByText(message)).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect((await disk()).measurements).toEqual([]);
    expect((await disk()).labValues).toEqual([]);
    fireEvent.change(input, { target: { value: '1234' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Done' });
    expect((await disk()).labValues.map(r => [r.metricName, r.value])).toContainEqual(['Synthetic test', 1234]);
  });
});

describe('US-02 AC4: reviewed numeric text reaches the actual record unchanged', () => {
  it('saves untouched negative extraction alongside valid core and lab values', async () => {
    await review();
    const button = screen.getByRole('button', { name: /^Save / }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Done' });
    const file = await disk();
    expect(file.labValues.map(r => [r.metricName, r.value])).toEqual(expect.arrayContaining([['Base excess', -2], ['Synthetic test', 4]]));
    expect(file.measurements.map(r => [r.metricType, r.value])).toContainEqual(['ldl', 3.2]);
  });

  it.each(['paste', 'drop'] as const)('refuses multiline %s, then saves select-all correction as 5.2, not 5.22', async method => {
    const input = await review();
    input.select();
    if (method === 'paste') fireEvent.paste(input, { clipboardData: { getData: () => '1\n2' } });
    else fireEvent.drop(input, { dataTransfer: { getData: () => '1\n2' } });
    const button = screen.getByRole('button', { name: /^Save / }) as HTMLButtonElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect((await disk()).labValues).toEqual([]);
    input.select();
    fireEvent.paste(input, { clipboardData: { getData: () => '5,2 mg/L' } });
    expect(input.value).toBe('5,2');
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Done' });
    expect((await disk()).labValues.map(r => [r.metricName, r.value])).toEqual(expect.arrayContaining([['Base excess', -2], ['Synthetic test', 5.2]]));
  });
});
