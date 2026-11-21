// @vitest-environment jsdom
/**
 * US-14 AC12 through the web's real Save: ReviewTable → saveReview (lib/upload-save.ts) → the real
 * RoadmapStore → health-core saveDocuments, with a cloud whose document write throws. The letter's
 * original is new, behind no held row, so before AC12 its failure was not counted and the done screen
 * showed a plain checkmark. Only the network, the quota, the read and the hash are stubbed. Synthetic only.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { UploadModal } from './UploadModal';
import { flushRoadmapStore, initRoadmapStore } from '../lib/roadmap-data';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { stopLiveRefresh, trackLiveRefresh } from '../testing/health-tool-harness';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
// The store is real; only the archive mode says a cloud is connected, so the review keeps the original's bytes.
vi.mock('../lib/roadmap-data', async (original) => ({ ...await original<typeof import('../lib/roadmap-data')>(), getDocumentArchiveMode: () => 'cloud' }));
vi.mock('../lib/archive-payloads', async (original) => ({ ...await original<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async () => 'sha256-synthetic') }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));
afterEach(() => { cleanup(); stopLiveRefresh(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); delete (window as Window & { HealthUpload?: unknown }).HealthUpload; });

it('US-14 AC12: a new letter whose original the cloud refuses says so on the done screen', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no external calls'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  localStorage.clear();
  trackLiveRefresh();
  const cloud = new MemoryCloud();
  const adapter = new MemoryAdapter(cloud);
  adapter.writeDocument = async () => { throw new Error('synthetic quota refusal'); };
  await initRoadmapStore(adapter);
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue({ result: {
    classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [],
    document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2025-08-01', contentMarkdown: 'letter text', metadata: {} },
  } } as unknown as Awaited<ReturnType<typeof labImport>>);
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false })),
    isPdf: () => true, isZip: () => false, isImage: () => false,
  } });
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={{ measurements: [], labValues: [], documents: [] }} onComplete={() => {}} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic letter'], 'letter.pdf', { type: 'application/pdf' })] } });
  fireEvent.click(await screen.findByRole('button', { name: /^Save / }));
  await screen.findByRole('button', { name: 'Done' });

  const done = document.querySelector('.upload-done')!;
  expect(done.querySelector('.upload-done-text')?.textContent).toBe('1 document');
  expect([...done.querySelectorAll('p.upload-done-skipped')].map((p) => p.textContent)).toEqual(["The original file couldn't be stored; its details are saved."]);
  // The details are saved, metadata-only, with the bytes' hash (US-14 AC4).
  await flushRoadmapStore();
  const record = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
  expect(record.documents).toEqual([expect.objectContaining({ title: 'Synthetic letter', fileRef: '', contentHash: 'sha256-synthetic' })]);
});
