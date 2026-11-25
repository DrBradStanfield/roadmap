// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { UPLOAD_ENGINE } from '../testing/upload-engine';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { UploadModal } from './UploadModal';
import { initRoadmapStore, addMeasurement, correctValue, flushRoadmapStore, getShownErase } from '../lib/roadmap-data';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { trackLiveRefresh, stopLiveRefresh } from '../testing/health-tool-harness';
import { seedOpenLabValues } from '../testing/seed-record';
vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
// Extraction and original-file archival are outside this value-save witness.
vi.mock('../lib/archive-payloads', async original => ({ ...await original<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async () => '') }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));
afterEach(() => { cleanup(); stopLiveRefresh(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); delete (window as Window & { HealthUpload?: unknown }).HealthUpload; });

// US-12 AC6a, US-13 AC3, US-35 AC8: the real list → the shared Save → the store → a fresh read (mount 3b).
it.each([
  { lab: false, outcome: 'correction' },
  { lab: false, outcome: 'stale' },
  { lab: false, outcome: 'duplicate' },
  { lab: false, outcome: 'mixed' },
  { lab: true, outcome: 'correction' },
  { lab: true, outcome: 'stale' },
  { lab: true, outcome: 'duplicate' },
])('US-12 AC6a: lab=$lab, $outcome', async ({ lab, outcome }) => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no external calls'); }));
  const cloud = new MemoryCloud();
  localStorage.clear();
  trackLiveRefresh();
  await initRoadmapStore(new MemoryAdapter(cloud));
  async function add(value: number) {
    if (lab) {
      const saved = seedOpenLabValues([{ metricName: 'Synthetic test', value, unit: 'units', recordedAt: '2024-06-01' }]);
      expect(saved).toHaveLength(1);
      return saved[0].id;
    }
    const result = await addMeasurement('ldl', value, '2024-06-01', getShownErase());
    if (result.status !== 'inserted') throw new Error('fixture failed');
    return result.row.id;
  }
  const duplicate = outcome === 'duplicate';
  const oldId = duplicate ? undefined : await add(4);
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue({ result: {
    classification: 'lab_report', reportDate: '2024-06-01', document: null,
    values: lab ? [] : [
      { metric: 'ldl', valueSI: 3, displayValue: 3, displayUnit: 'mmol/L', confidence: 'high' },
      ...(outcome === 'mixed' ? [{ metric: 'hdl' as const, valueSI: 1.3, displayValue: 1.3, displayUnit: 'mmol/L', confidence: 'high' as const }] : []),
    ],
    additionalValues: lab ? [{ name: 'Synthetic test', value: 3, unit: 'units' }] : [],
  } });
  Object.assign(window, { HealthUpload: { ...UPLOAD_ENGINE,
    extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false })),
    isPdf: () => true, isZip: () => false, isImage: () => false,
  } });
  const completed = vi.fn();
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" onComplete={completed} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], 'labs.pdf', { type: 'application/pdf' })] } });
  if (oldId) {
    await waitFor(() => expect(document.querySelector('.upload-list-replace input')).not.toBeNull());
    const replace = document.querySelector<HTMLInputElement>('.upload-list-replace input')!;
    fireEvent.click(replace);
    expect(replace.checked).toBe(true);
  } else await screen.findByRole('button', { name: /^Save / });
  // Keep review history unchanged while the real store receives another writer's value.
  const stale = outcome === 'stale' || outcome === 'mixed';
  if (stale) expect(await correctValue(oldId!, 3.5, getShownErase())).toBe('ok');
  if (duplicate) await add(3);
  await flushRoadmapStore();
  fireEvent.click(screen.getByRole('button', { name: /^Save / }));
  await screen.findByRole('button', { name: 'Done' });
  const text = document.body.textContent;
  if (stale || duplicate) {
    expect(text).toContain(`1 ${lab ? 'additional lab' : 'blood test'} value was not added.`);
    expect(text).toContain('Check your blood test table');
    expect(text).not.toContain('already saved');
    expect(text).not.toContain('try again');
  } else expect(text).not.toContain('was not added');
  if (outcome === 'mixed') expect(text).toContain('Saved 1 value.');
  else if (stale || duplicate) expect(text).not.toContain('Saved 1');
  expect(completed).toHaveBeenCalledOnce();
  await flushRoadmapStore();
  const fresh = await RoadmapStore.create(new MemoryAdapter(cloud));
  const rows = lab ? fresh.loadLabValues() : fresh.loadAllHistory().filter(r => r.status === 'active');
  expect(rows.map(r => r.value).sort()).toEqual(outcome === 'mixed' ? [1.3, 3.5] : [stale ? 3.5 : 3]);
  const persisted = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
  // Every blood test, core or extra, is a lab row (US-66).
  expect(persisted.labValues.some((r: {value: number}) => r.value === 3)).toBe(!stale);
});
