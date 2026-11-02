// @vitest-environment jsdom
// US-12 AC20: the real review → lib → store → a fresh read. An uploaded
// "< 10" Lp(a) shows its symbol before the number and saves as a limit; the
// same cell edited to "12" loses the symbol and saves an exact value.
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { UploadModal } from './UploadModal';
import { initRoadmapStore, flushRoadmapStore, bulkSaveMeasurements, loadAllHistory } from '../lib/roadmap-data';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async original => ({ ...await original<typeof import('../lib/archive-payloads')>(), attachOriginals: vi.fn(async r => r), synthesizeLabArchiveEntries: () => [] }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));
const stops: Array<() => void> = [];
afterEach(() => { cleanup(); for (const stop of stops.splice(0)) stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); delete (window as Window & { HealthUpload?: unknown }).HealthUpload; });

it.each([
  { edit: null, saved: { value: 10, comparator: '<' } },
  { edit: '12', saved: { value: 12 } },
])('US-12 AC20: an uploaded "< 10" Lp(a), edited to $edit, saves $saved', async ({ edit, saved }) => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no external calls'); }));
  const cloud = new MemoryCloud();
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) { const stop = start.call(this); stops.push(stop); return stop; });
  await initRoadmapStore(new MemoryAdapter(cloud));
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue({ result: {
    classification: 'lab_report', reportDate: '2024-06-01', document: null,
    values: [{ metric: 'lpa', valueSI: 10, displayValue: 10, displayUnit: 'nmol/L', confidence: 'high', comparator: '<' }],
    additionalValues: [],
  } });
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false })),
    isPdf: () => true, isZip: () => false, isImage: () => false,
  } });
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={{ measurements: [], labValues: [], documents: [] }} onComplete={() => {}} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], 'labs.pdf', { type: 'application/pdf' })] } });
  const input = await screen.findByLabelText(/^Lp\(a\) value from/) as HTMLInputElement;
  const cell = input.closest('.bt-cell-value')!;
  // The number stays the input's text; the symbol shows before it, and is heard.
  expect(input.value).toBe('10');
  expect(cell.querySelector('.bt-cell-limit')?.textContent).toBe('<');
  expect(input.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent)).toContain('<');
  if (edit) {
    input.focus();
    fireEvent.change(input, { target: { value: edit } });
    // Edited is exact: the symbol goes, and the input keeps the focus.
    expect(cell.querySelector('.bt-cell-limit')).toBeNull();
    expect(document.activeElement).toBe(input);
  }
  fireEvent.click(screen.getByRole('button', { name: /^Save / }));
  await screen.findByRole('button', { name: 'Done' });
  await flushRoadmapStore();
  const fresh = await RoadmapStore.create(new MemoryAdapter(cloud));
  const rows = fresh.loadAllHistory().filter(r => r.status === 'active' && r.metricType === 'lpa');
  expect(rows.map(r => ({ value: r.value, ...(r.comparator ? { comparator: r.comparator } : {}) }))).toEqual([saved]);
  const persisted = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
  // US-66 AC1: the Lp(a) is a core lab row in the file, with its comparator or none.
  expect(persisted.measurements).toEqual([]);
  expect(persisted.labValues.filter((r: { metricName: string; core?: true }) => r.core && r.metricName === 'lpa').map((r: { comparator?: string }) => r.comparator)).toEqual([saved.comparator]);
});

// Codex review of 0a2b89b0 (C1): a held exact Lp(a) 10 and an offered "< 10" on
// the same day are two results. The review offers Replace, and a ticked Replace
// writes the limit as a correction; before, the numbers alone matched, so the
// cell read as already saved and the limit was dropped.
it('US-12 AC20: a held exact value and an uploaded limit of the same number offer Replace, and replacing writes the limit', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no external calls'); }));
  const cloud = new MemoryCloud();
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) { const stop = start.call(this); stops.push(stop); return stop; });
  await initRoadmapStore(new MemoryAdapter(cloud));
  await bulkSaveMeasurements([{ metricType: 'lpa', value: 10, recordedAt: '2024-06-01', source: 'manual' }]);
  const held = (await loadAllHistory()).find(r => r.metricType === 'lpa')!;
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue({ result: {
    classification: 'lab_report', reportDate: '2024-06-01', document: null,
    values: [{ metric: 'lpa', valueSI: 10, displayValue: 10, displayUnit: 'nmol/L', confidence: 'high', comparator: '<' }],
    additionalValues: [],
  } });
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false })),
    isPdf: () => true, isZip: () => false, isImage: () => false,
  } });
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={{ measurements: [held], labValues: [], documents: [] }} onComplete={() => {}} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], 'labs.pdf', { type: 'application/pdf' })] } });
  const replace = await screen.findByLabelText(/^Replace the saved Lp\(a\) value/) as HTMLInputElement;
  fireEvent.click(replace);
  fireEvent.click(screen.getByRole('button', { name: /^Save / }));
  await screen.findByRole('button', { name: 'Done' });
  await flushRoadmapStore();
  const fresh = await RoadmapStore.create(new MemoryAdapter(cloud));
  const active = fresh.loadAllHistory().filter(r => r.status === 'active' && r.metricType === 'lpa');
  expect(active.map(r => ({ value: r.value, comparator: r.comparator, correctsId: r.correctsId }))).toEqual([{ value: 10, comparator: '<', correctsId: held.id }]);
});
