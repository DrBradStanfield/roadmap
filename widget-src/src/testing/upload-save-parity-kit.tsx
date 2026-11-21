// Test support: today's web upload Save (UploadModal's grid, lib/upload-save.ts `saveReview`) and the shared Save's
// web adapter (lib/roadmap-data.ts `saveUpload`, storage/upload-save-store.ts) run from the same starting record,
// the same reads and the same review choices, each over a real RoadmapStore, and their records reduced to what a
// person keeps: rows by content, ids and stamps left out. The caller mocks the transport, the hash, the analytics
// and Sentry (see components/UploadModal.shared-save-parity*.test.tsx). Imported by tests only.
import { fireEvent, render, screen, cleanup, act } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { inFlight, type UploadState } from '@roadmap/health-core/upload-flow';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import { reviewedWrites, uploadReview, type UploadReview } from '@roadmap/health-core/upload-review';
import type { ScreeningPerson } from '@roadmap/health-core/upload-screening';
import { UploadModal } from '../components/UploadModal';
import { deleteUserData, flushRoadmapStore, initRoadmapStore, loadAllHistorySync, loadLabValuesSync, loadLatestMeasurementsSync, recordFileSync, saveScreening, saveUpload } from '../lib/roadmap-data';
import { webUploadIO } from '../lib/upload-save-io';
import { uploadReviewCounts } from '../lib/upload-save-events';
import { uploadScreens } from '../lib/upload-screens';
import type { UploadSaveAnswer } from '../storage/upload-save-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { BACKEND_KEY } from '../storage/web-record-host';
import { RoadmapStore } from '../storage/roadmap-store';
import type { labImport } from '../lib/upload-api';
import { drive } from './upload-driver';
import type { HealthUploadAPI } from '../upload-entry';

/** One picked file: its name, and the key its reader answers to (a ZIP: its members). */
export type Pick = { name: string; read: string } | { name: string; members: Array<{ name: string; read: string }> };

export interface Seed {
  name: string;
  /** The record lives in a cloud (originals kept), else on the device. */
  cloud: boolean;
  /** The cloud refuses every original. */
  failWrite?: boolean;
  /** This tab's own erase runs as the first original is written: between the plan and the commit. */
  eraseMidway?: boolean;
  /** The starting record, written through the store's own writers. */
  record?: (store: RoadmapStore) => void | Promise<void>;
  files: Pick[];
  person?: ScreeningPerson;
  /** Today's choices, on the grid. Returns whether it opened "Show all". */
  grid?: () => boolean | Promise<boolean>;
  /** The same choices, as the shared state's events: `(file index in picked order, change)`. */
  choices?: (review: UploadReview, s: UploadState) => Array<{ file: number; change: ChoiceChange }>;
}

/** `showAll`: today's grid opened "Show all" (the `upload_review` key); the adapter is told the same. */
export interface Side { record: Snapshot; events: Array<[string, unknown]>; sentry: number; answer?: UploadSaveAnswer; done: boolean; showAll?: boolean }

/** A cloud whose originals fail, or that runs this tab's erase at the first one. */
class SeedCloud extends MemoryAdapter {
  constructor(cloud: MemoryCloud, private readonly seed: Seed) { super(cloud); }
  private erased = false;
  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    if (this.seed.eraseMidway && !this.erased) {
      this.erased = true;
      const erase = await deleteUserData();
      if (!erase.success) throw new Error(`Synthetic test: the erase was refused: ${erase.error}`);
    }
    if (this.seed.failWrite) throw new Error('Synthetic test: the cloud refused the original');
    return super.writeDocument(ref, bytes);
  }
}

/** A fresh record for one side: seeded through a store, then opened by the data layer as the page opens it. */
async function open(seed: Seed) {
  localStorage.clear();
  // A cloud page runs with its backend remembered, so it owns this device's off-file data and may erase (US-11 AC6).
  if (seed.cloud) localStorage.setItem(BACKEND_KEY, 'memory');
  const cloud = new MemoryCloud();
  const adapter = () => (seed.cloud ? new SeedCloud(cloud, seed) : new LocalStorageAdapter());
  const first = await RoadmapStore.create(seed.cloud ? new MemoryAdapter(cloud) : new LocalStorageAdapter());
  await seed.record?.(first);
  await first.flush();
  await initRoadmapStore(adapter());
}

const fileOf = (p: Pick) => new File([`read:${'read' in p ? p.read : p.members.map((m) => m.read).join(',')}`], p.name, { type: p.name.endsWith('.zip') ? 'application/zip' : 'application/pdf' });

/** Today: the grid over the real store, picked, chosen and saved as a person does. */
export async function todaySave(seed: Seed, tracked: Array<[string, unknown]>, sentryCalls: () => number): Promise<Side> {
  await open(seed);
  tracked.length = 0;
  const sentry0 = sentryCalls();
  const history = { measurements: loadAllHistorySync(), labValues: loadLabValuesSync() ?? [], documents: loadLatestMeasurementsSync()?.documents ?? [] };
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" metricUnitOverrides={{}} grading={{}} history={history}
    onComplete={() => {}} onScreeningUpdate={(key, value, erase) => void saveScreening(key, value, erase)} age={seed.person?.age} sex={seed.person?.sex} />);
  // On the device the page asks to connect a cloud first; the person goes on without (US-12 AC4).
  if (!seed.cloud) fireEvent.click(screen.getByRole('button', { name: /Continue without keeping my files/ }));
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: seed.files.map(fileOf) } });
  // A review with nothing to write offers no Save: today writes nothing.
  const save = await screen.findByRole('button', { name: /^Save / }).catch(() => null);
  const showAll = await seed.grid?.() ?? false;
  if (save) fireEvent.click(save);
  const done = !save ? false : await Promise.race([
    screen.findByRole('button', { name: 'Done' }).then(() => true, () => null),
    screen.findByText(/Please try again\./).then(() => false, () => null),
  ]);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await flushRoadmapStore().catch(() => {});
  const side = { record: snapshot(recordFileSync()!), events: [...tracked], sentry: sentryCalls() - sentry0, done: done === true, showAll };
  cleanup();
  return side;
}

/** The shared Save's web adapter: the same pick read by the web's own effects, the same choices sent, then `saveUpload`. */
export async function adapterSave(seed: Seed, upload: HealthUploadAPI, tracked: Array<[string, unknown]>, sentryCalls: () => number, showAll: boolean): Promise<Side> {
  await open(seed);
  tracked.length = 0;
  const sentry0 = sentryCalls();
  const run = drive(upload, seed.files.map(fileOf));
  for (let i = 0; i < 200 && !(run.state().phase === 'open' && inFlight(run.state()) === 0); i++) await new Promise((r) => setTimeout(r, 0));
  const now = new Date().toISOString();
  const ids = run.state().phase === 'choosing' ? [] : (run.state() as Extract<UploadState, { files: unknown }>).files.map((f) => f.id);
  for (const { file, change } of seed.choices?.(uploadReview(run.state(), recordFileSync()!, now), run.state()) ?? []) {
    run.send({ type: 'chose', id: ids[file], change, now });
  }
  const { review, view } = uploadScreens(run.state(), recordFileSync()!, now, seed.cloud, () => 'si', seed.person);
  // The list offers Save only when its view enables it, as the grid offers none with nothing to write.
  if (!view.save.enabled) return { record: snapshot(recordFileSync()!), events: [...tracked], sentry: sentryCalls() - sentry0, done: false };
  run.send({ type: 'saveStarted', reviewed: reviewedWrites(review) });
  const s = run.state();
  const answer = await saveUpload(s, now, webUploadIO(run.held), seed.person);
  // The flow's own events, as useUploadFlow sends them once the list mounts: `upload_review` once per finished Save,
  // `upload_saved` from the done state's outcome (useUploadFlow.ts, unchanged code).
  if (answer.ok) {
    tracked.push(['upload_review', uploadReviewCounts(review, s, showAll, true)]);
    tracked.push(['upload_saved', { count: answer.outcome.values + answer.outcome.documents }]);
  }
  await flushRoadmapStore().catch(() => {});
  return { record: snapshot(recordFileSync()!), events: [...tracked], sentry: sentryCalls() - sentry0, answer, done: answer.ok };
}

export type Snapshot = ReturnType<typeof snapshot>;
/**
 * What a person keeps of a record, ids and stamps left out: every value row by its test, day, value, unit, status and
 * the row it corrects (named by content); every document by its title, kind, date, name, hash, whether its original is
 * stored, whether it is a lab report's archive row and the rows it lists (named by content), and whether it is
 * deleted; the screening dates. Each table sorted.
 */
export function snapshot(file: RoadmapFile) {
  const name = new Map<string, string>();
  for (const m of file.measurements) name.set(m.id, `${m.metricType}|${m.recordedAt.slice(0, 10)}|${m.value}|${m.status}`);
  for (const l of file.labValues) name.set(l.id, `${l.metricName}|${l.recordedAt.slice(0, 10)}|${l.value}|${l.unit}|${l.status}`);
  const sorted = (xs: string[]) => [...xs].sort();
  const valueRow = (r: { id: string; correctsId?: string | null; source?: string }) => `${name.get(r.id)}${r.correctsId ? ` corrects ${name.get(r.correctsId) ?? 'another row'}` : ''}|${r.source ?? ''}`;
  return {
    measurements: sorted(file.measurements.map(valueRow)),
    labValues: sorted(file.labValues.map(valueRow)),
    documents: sorted(file.documents.map((d) => JSON.stringify({
      title: d.title, type: d.type, date: d.date, name: d.sourceFileName ?? null, hash: d.contentHash || null, stored: !!d.fileRef,
      archive: d.metadata?.labArchive === true, rows: Array.isArray(d.metadata?.rows) ? sorted((d.metadata.rows as string[]).map((id) => name.get(id) ?? 'unknown row')) : null,
      deleted: !!d.deleted,
    }))),
    screenings: Object.fromEntries(Object.entries(file.screenings).filter(([k, v]) => /LastDate$/.test(k) && v)),
  };
}

// --- the reads: synthetic values, plain names, no real person ---
type Import = Awaited<ReturnType<typeof labImport>>;
const core = (metric: string, v: number, more: object = {}) => ({ metric, valueSI: v, displayValue: v, displayUnit: metric.endsWith('_bp') ? 'mmHg' : 'mmol/L', displaySystem: 'si', confidence: 'high', ...more });
const lab = (reportDate: string | null, values: unknown[], additionalValues: unknown[] = [], more: object = {}) =>
  ({ result: { classification: 'lab_report', document: null, reportDate, values, additionalValues, ...more } }) as unknown as Import;
const letter = (title: string, documentDate: string, metadata: Record<string, unknown> = {}) => ({ result: {
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [],
  document: { classification: 'clinic_letter', title, documentDate, contentMarkdown: 'Synthetic letter text', metadata },
} }) as unknown as Import;
export const READS: Record<string, Import> = {
  labA: lab('2025-09-02', [core('ldl', 2.8), core('hdl', 1.4), core('systolic_bp', 120), core('diastolic_bp', 80)], [{ name: 'Ferritin', value: 90, unit: 'µg/L', referenceLow: 30, referenceHigh: 300 }]),
  labB: lab('2025-10-02', [core('ldl', 2.6)], [{ name: 'Ferritin', value: 70, unit: 'µg/L' }]),
  labPrev: lab('2025-09-02', [core('ldl', 2.8), core('ldl', 3.3, { recordedAt: '2025-03-01' })], [{ name: 'Ferritin', value: 85, unit: 'µg/L', recordedAt: '2025-03-01' }]),
  labUndated: lab(null, [core('ldl', 3.1)], [{ name: 'Ferritin', value: 60, unit: 'µg/L' }]),
  labRefused: lab('2025-09-02', [core('hdl', 1.4)], [{ name: 'Ferritin', value: 90, unit: 'mmol/L' }], { refusedValues: [{ metric: 'creatinine', value: 80, unit: 'mg/g', reason: 'This is a urine test.' }] }),
  labConflict: lab('2025-09-02', [core('ldl', 3.5), core('hdl', 1.4)]),
  labOutOfRange: lab('2025-09-02', [core('ldl', 95), core('hdl', 1.4)]),
  letterA: letter('Synthetic letter A', '2025-08-01'),
  letterC1: letter('Synthetic colonoscopy one', '2025-05-10', { screeningType: 'colorectal' }),
  letterC2: letter('Synthetic colonoscopy two', '2025-06-12', { screeningType: 'colorectal' }),
  letterOther: letter('Synthetic other check', '2025-04-04', { screeningType: 'thyroid' }),
};

/** The upload bundle: a PDF's page is its text (`read:<key>`); a ZIP lists its members by the keys it names. */
export const parityBundle = () => ({
  extractFromPdf: async (f: File) => ({ pages: [{ type: 'text', content: await f.text() }], truncated: false }),
  isPdf: (f: File) => f.name.endsWith('.pdf'), isZip: (f: File) => f.name.endsWith('.zip'), isImage: () => false,
  resizeImage: async () => 'base64', docxToText: async () => ({ text: '', truncated: false }),
  getZipEntries: async (zip: File) => (await zip.text()).slice('read:'.length).split(',').map((read, i) => ({
    name: `member-${i}-${read}.pdf`, bytes: 12, entry: { async: async () => new Blob([`read:${read}`]) },
  })),
}) as unknown as HealthUploadAPI;

/** The reader's answer for a page's text (`read:<key>`). */
export const readFor = (pages: unknown) => READS[((pages as Array<{ content: string }>)[0].content).slice('read:'.length)];
