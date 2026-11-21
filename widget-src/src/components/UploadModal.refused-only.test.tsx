// @vitest-environment jsdom
/**
 * US-14 AC11 on the web: with a cloud, a lab report whose only content is values the extractor refused
 * (`refusedValues`) keeps its original in the person's cloud, as the shared upload does (health-core
 * `labReadFound`). Before, the web's `isFileable` (archive-payloads.ts) took only a document, values or extra labs,
 * so Save stayed disabled and the original was dropped. With no cloud nothing is kept for it: no hash-only row,
 * which the date rule would then call known forever, so it is read again next time. Through the real Save:
 * ReviewTable, saveReview, the real RoadmapStore, saveDocuments. Only the network, the quota, the read, the hash
 * and the archive mode are stubbed. Synthetic only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { LAB_ARCHIVE_FLAG } from '@roadmap/health-core/document-rows';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { knownIndex } from '@roadmap/health-core/upload-known';
import { UploadModal } from './UploadModal';
import { bulkSaveLabValues, flushRoadmapStore, initRoadmapStore } from '../lib/roadmap-data';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { stopLiveRefresh, trackLiveRefresh } from '../testing/health-tool-harness';

const mode = vi.hoisted(() => ({ archive: 'cloud' as 'cloud' | 'no-prompt' }));
vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
// The real store; `bulkSaveLabValues` passes through to it, so a test can fail one write.
vi.mock('../lib/roadmap-data', async (original) => { const real = await original<typeof import('../lib/roadmap-data')>(); return { ...real, getDocumentArchiveMode: () => mode.archive, bulkSaveLabValues: vi.fn(real.bulkSaveLabValues) }; });
// Each file's hash is its own text, so two files are two sets of bytes.
vi.mock('../lib/archive-payloads', async (original) => ({ ...await original<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async (b: Blob) => `sha256-${await b.text()}`) }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));
afterEach(() => { cleanup(); stopLiveRefresh(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); delete (window as Window & { HealthUpload?: unknown }).HealthUpload; mode.archive = 'cloud'; });

const DAY = '2025-08-01';
const refusedOnly = { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], document: null,
  refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'unit unknown' }] };
const withValue = { classification: 'lab_report', reportDate: DAY, values: [], document: null,
  additionalValues: [{ name: 'Ferritin', value: 80, unit: 'µg/L' }] };

/** Open the modal on a fresh store, pick `files` (each read as the matching result), and return the cloud. */
async function pick(files: Array<[name: string, result: object]>) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no external calls'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  trackLiveRefresh();
  const cloud = new MemoryCloud();
  await initRoadmapStore(new MemoryAdapter(cloud));
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  const byText = new Map(files.map(([name, result]) => [name, result]));
  Object.assign(window, { HealthUpload: {
    extractFromPdf: vi.fn(async (f: File) => ({ pages: [{ type: 'text', content: f.name }], truncated: false })),
    isPdf: () => true, isZip: () => false, isImage: () => false,
  } });
  vi.mocked(labImport).mockImplementation((async (pages: Array<{ content: string }>) =>
    ({ result: byText.get(pages[0]?.content ?? '') })) as unknown as typeof labImport);
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" grading={{}} history={{ measurements: [], labValues: [], documents: [] }} onComplete={() => {}} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: files.map(([name]) => new File([name], name, { type: 'application/pdf' })) } });
  return cloud;
}
/** The done screen as the person sees it: each element, its classes and its text (Brad 2026-11-22: the layout stays nice). */
const doneLines = () => [...document.querySelector('.upload-done')!.children].map((el) => `${el.tagName.toLowerCase()}.${el.className}: ${el.textContent}`);
const [ICON, DONE] = ['div.upload-done-icon: \u2713', 'button.btn-primary upload-done-btn: Done'];
// The letter's existing file notice, unchanged here.
const NOTICE = 'div.upload-file-notices: Check these files:l.pdf Filed as a document. No blood test values found.';
const letter = { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [],
  document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: DAY, contentMarkdown: 'letter text', metadata: {} } };
const saved = async (cloud: MemoryCloud) => { await flushRoadmapStore(); return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile; };

it('US-14 AC11: with a cloud, a report with only refused values offers Save and stores its original', async () => {
  const cloud = await pick([['report.pdf', refusedOnly]]);
  const save = await screen.findByRole<HTMLButtonElement>('button', { name: 'Save 1 original' });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await screen.findByRole('button', { name: 'Done' });
  // US-14 AC13: the hidden archive row is no document; the kept line, the iPhone's words, is the main line.
  expect(doneLines()).toEqual([ICON, 'p.upload-done-text: 1 original file kept in your cloud.', DONE]);

  const record = await saved(cloud);
  expect(record.labValues).toEqual([]);
  expect(record.documents).toHaveLength(1);
  const [row] = record.documents;
  expect(row).toMatchObject({ contentHash: 'sha256-report.pdf', metadata: expect.objectContaining({ [LAB_ARCHIVE_FLAG]: true }) });
  expect(row.fileRef).toBeTruthy();
  expect([...cloud.docs.keys()]).toEqual([row.fileRef]);
});

it('US-14 AC11: with no cloud, a refused-only report beside one that saves leaves no row and is read again next time', async () => {
  mode.archive = 'no-prompt'; // no cloud, and no connect-first panel before the dropzone
  const cloud = await pick([['a.pdf', withValue], ['b.pdf', refusedOnly]]);
  fireEvent.click(await screen.findByRole('button', { name: /^Save / }));
  await screen.findByRole('button', { name: 'Done' });

  const record = await saved(cloud);
  expect(record.labValues).toEqual([expect.objectContaining({ metricName: 'Ferritin', status: 'active' })]);
  expect(record.documents.map((d) => d.contentHash)).toEqual(['sha256-a.pdf']); // A's hash-only archive row; none for B
  expect(cloud.docs.size).toBe(0);
  expect(knownIndex(record).has('sha256-b.pdf')).toBe(false); // so the next pick reads B again
});

describe('US-14 AC13: the done screen after a Save that kept originals, with a cloud, through the real Save', () => {
  it.each([
    ['three refused-only reports', [['a.pdf', refusedOnly], ['b.pdf', refusedOnly], ['c.pdf', refusedOnly]], ['p.upload-done-text: 3 original files kept in your cloud.']],
    ['a report that saves a value beside a refused-only one', [['a.pdf', withValue], ['b.pdf', refusedOnly]],
      ['p.upload-done-text: 1 additional lab value', 'p.upload-done-skipped: 1 original file kept in your cloud.']],
    ['a letter beside a refused-only report', [['l.pdf', letter], ['b.pdf', refusedOnly]],
      ['p.upload-done-text: 1 document', 'p.upload-done-skipped: 1 original file kept in your cloud.', NOTICE]],
    ['a report that saves a value alone: its original is not counted a document', [['a.pdf', withValue]], ['p.upload-done-text: 1 additional lab value']],
    ['a letter alone still counts as a document', [['l.pdf', letter]], ['p.upload-done-text: 1 document', NOTICE]],
  ] as Array<[string, Array<[string, object]>, string[]]>)('%s', async (_name, files, lines) => {
    await pick(files);
    fireEvent.click(await screen.findByRole('button', { name: /^Save / }));
    await screen.findByRole('button', { name: 'Done' });
    expect(doneLines()).toEqual([ICON, ...lines, DONE]);
  });
});

it('US-14 AC13: the first value write fails and the retry writes it: the done screen names the value, never the original as kept', async () => {
  const cloud = await pick([['a.pdf', withValue]]);
  vi.mocked(bulkSaveLabValues).mockRejectedValueOnce(new Error('synthetic store failure'));
  fireEvent.click(await screen.findByRole('button', { name: /^Save / }));
  await screen.findByText('Some items could not be saved. Please try again.');
  fireEvent.click(screen.getByRole('button', { name: /^Save / }));
  await screen.findByRole('button', { name: 'Done' });
  expect(doneLines()).toEqual([ICON, 'p.upload-done-text: 1 additional lab value', DONE]);
  expect((await saved(cloud)).labValues).toEqual([expect.objectContaining({ metricName: 'Ferritin', status: 'active' })]);
});
