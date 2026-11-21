// @vitest-environment jsdom
/**
 * US-14 AC11 on the web: a lab report whose only content is values the extractor refused (`refusedValues`) keeps
 * its original in the person's cloud, as the shared upload does (health-core `labReadFound`). Before, the web's
 * `isFileable` (archive-payloads.ts) took only a document, values or extra labs, so Save stayed disabled and the
 * original was dropped. Through the real Save: ReviewTable, saveReview, the real RoadmapStore, saveDocuments. Only
 * the network, the quota, the read and the hash are stubbed. Synthetic only.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { LAB_ARCHIVE_FLAG } from '@roadmap/health-core/document-rows';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { UploadModal } from './UploadModal';
import { flushRoadmapStore, initRoadmapStore } from '../lib/roadmap-data';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { stopLiveRefresh, trackLiveRefresh } from '../testing/health-tool-harness';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/roadmap-data', async (original) => ({ ...await original<typeof import('../lib/roadmap-data')>(), getDocumentArchiveMode: () => 'cloud' }));
vi.mock('../lib/archive-payloads', async (original) => ({ ...await original<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async () => 'sha256-synthetic') }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));
afterEach(() => { cleanup(); stopLiveRefresh(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); delete (window as Window & { HealthUpload?: unknown }).HealthUpload; });

it('US-14 AC11: a report with only refused values offers Save and stores its original in the cloud', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no external calls'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  trackLiveRefresh();
  const cloud = new MemoryCloud();
  await initRoadmapStore(new MemoryAdapter(cloud));
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue({ result: {
    classification: 'lab_report', reportDate: '2025-08-01', values: [], additionalValues: [], document: null,
    refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'unit unknown' }],
  } } as unknown as Awaited<ReturnType<typeof labImport>>);
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false })),
    isPdf: () => true, isZip: () => false, isImage: () => false,
  } });
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={{ measurements: [], labValues: [], documents: [] }} onComplete={() => {}} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic report'], 'report.pdf', { type: 'application/pdf' })] } });

  const save = await screen.findByRole<HTMLButtonElement>('button', { name: 'Save 1 original' });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await screen.findByRole('button', { name: 'Done' });

  await flushRoadmapStore();
  const record = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
  expect(record.labValues).toEqual([]);
  const [row] = record.documents;
  expect(record.documents).toHaveLength(1);
  expect(row).toMatchObject({ contentHash: 'sha256-synthetic', metadata: expect.objectContaining({ [LAB_ARCHIVE_FLAG]: true }) });
  expect(row.fileRef).toBeTruthy();
  expect([...cloud.docs.keys()]).toEqual([row.fileRef]);
});
