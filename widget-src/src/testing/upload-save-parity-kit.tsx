// Test support: today's web upload Save (UploadModal's grid, lib/upload-save.ts `saveReview`) and the shared Save's
// web adapter (lib/roadmap-data.ts `saveUpload`, storage/upload-save-store.ts) run from the same starting record,
// the same reads and the same review choices, each over a real RoadmapStore, and their records reduced to what a
// person keeps: every field of every row, ids named by content and stamps left out, and each stored original's bytes
// and type. The caller mocks the transport, the hash, the analytics and Sentry (see
// components/UploadModal.shared-save-parity*.test.tsx). Imported by tests only.
import { fireEvent, render, screen, cleanup, act } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { inFlight, type SaveOutcome as SharedOutcome, type UploadState } from '@roadmap/health-core/upload-flow';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import { reviewedWrites, uploadReview, type UploadReview } from '@roadmap/health-core/upload-review';
import { uploadSave } from '@roadmap/health-core/upload-save';
import type { ScreeningPerson } from '@roadmap/health-core/upload-screening';
import { UploadModal } from '../components/UploadModal';
import { deleteUserData, flushRoadmapStore, initRoadmapStore, loadAllHistorySync, loadLabValuesSync, loadLatestMeasurementsSync, recordFileSync, saveScreening } from '../lib/roadmap-data';
import type { SaveOutcome as TodayOutcome } from '../lib/upload-save-outcome';
import { sharedSave } from '../lib/upload-shared-save';
import { uploadScreens } from '../lib/upload-screens';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { BACKEND_KEY } from '../storage/web-record-host';
import { RoadmapStore } from '../storage/roadmap-store';
import type { labImport } from '../lib/upload-api';
import { UNDATED_PREVIOUS } from '@roadmap/health-core/lab-extraction';
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
  /** Runs as the first original is written: between the plan and the commit (an erase, another writer's edit). */
  midway?: () => Promise<void>;
  /** The first Save fails (today: its documents' write rejects; shared: the Save rejects), and the person saves again. */
  failFirst?: boolean;
  /** The starting record, written through the store's own writers. */
  record?: (store: RoadmapStore) => void | Promise<void>;
  files: Pick[];
  person?: ScreeningPerson;
  /** Today's choices, on the grid. */
  grid?: () => void | Promise<void>;
  /** The same choices, as the shared state's events: `(file index in picked order, change)`. */
  choices?: (review: UploadReview, s: UploadState) => Array<{ file: number; change: ChoiceChange }>;
}

/** The counts each Save says it made, comparable across both: values, documents, skipped values, refused lines. */
export interface Counts { values: number; documents: number; skipped: number; refused: number }
export interface Side { record: Snapshot; events: Array<[string, unknown]>; sentry: number; done: boolean; counts: Counts | null }

/** The test's hooks into each side, set by the caller's mocks. */
export interface Probes {
  tracked: Array<[string, unknown]>;
  sentryCalls: () => number;
  /** Today's session totals, each attempt's as it lands (useUploadFlow.ts `withAttempt`). */
  todayTotals: TodayOutcome[];
  /** Fail the next document save today, or the next shared Save. */
  failNext: { today: boolean; shared: boolean };
}

/** A cloud whose originals fail, or that runs the seed's midway step at the first one. */
class SeedCloud extends MemoryAdapter {
  constructor(cloud: MemoryCloud, private readonly seed: Seed) { super(cloud); }
  private reached = false;
  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    if (this.seed.midway && !this.reached) { this.reached = true; await this.seed.midway(); }
    if (this.seed.failWrite) throw new Error('Synthetic test: the cloud refused the original');
    return super.writeDocument(ref, bytes);
  }
}

/** This tab's own erase, as Settings runs it. */
export async function eraseHere(): Promise<void> {
  const erase = await deleteUserData();
  if (!erase.success) throw new Error(`Synthetic test: the erase was refused: ${erase.error}`);
}

/** A fresh record for one side: seeded through a store, then opened by the data layer as the page opens it. */
async function open(seed: Seed): Promise<MemoryCloud | null> {
  localStorage.clear();
  // A cloud page runs with its backend remembered, so it owns this device's off-file data and may erase (US-11 AC6).
  if (seed.cloud) localStorage.setItem(BACKEND_KEY, 'memory');
  const cloud = new MemoryCloud();
  const first = await RoadmapStore.create(seed.cloud ? new MemoryAdapter(cloud) : new LocalStorageAdapter());
  await seed.record?.(first);
  await first.flush();
  await initRoadmapStore(seed.cloud ? new SeedCloud(cloud, seed) : new LocalStorageAdapter());
  return seed.cloud ? cloud : null;
}

const fileOf = (p: Pick) => new File([`read:${'read' in p ? p.read : p.members.map((m) => m.read).join(',')}`], p.name, { type: p.name.endsWith('.zip') ? 'application/zip' : 'application/pdf' });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** Today: the grid over the real store, picked, chosen and saved as a person does. */
export async function todaySave(seed: Seed, probes: Probes): Promise<Side> {
  const cloud = await open(seed);
  probes.tracked.length = 0;
  probes.todayTotals.length = 0;
  const sentry0 = probes.sentryCalls();
  const history = { measurements: loadAllHistorySync(), labValues: loadLabValuesSync() ?? [], documents: loadLatestMeasurementsSync()?.documents ?? [] };
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} unitSystem="si" metricUnitOverrides={{}} grading={{}} history={history}
    onComplete={() => {}} onScreeningUpdate={(key, value, erase) => void saveScreening(key, value, erase)} age={seed.person?.age} sex={seed.person?.sex} />);
  // On the device the page asks to connect a cloud first; the person goes on without (US-12 AC4).
  if (!seed.cloud) fireEvent.click(screen.getByRole('button', { name: /Continue without keeping my files/ }));
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: seed.files.map(fileOf) } });
  // A review with nothing to write offers no Save: today writes nothing.
  const save = await screen.findByRole('button', { name: /^Save / }).catch(() => null);
  await seed.grid?.();
  const outcome = async () => Promise.race([
    screen.findByRole('button', { name: 'Done' }).then(() => true, () => null),
    screen.findByText(/Please try again\./).then(() => false, () => null),
  ]);
  let done: boolean | null = false;
  if (save) {
    probes.failNext.today = !!seed.failFirst;
    fireEvent.click(save);
    done = await outcome();
    if (seed.failFirst && done === false) {
      await tick();
      fireEvent.click(screen.getByRole('button', { name: /^Save / }));
      done = await outcome();
    }
  }
  await tick();
  await flushRoadmapStore().catch(() => {});
  const total = probes.todayTotals.at(-1);
  const side: Side = {
    record: await snapshot(recordFileSync()!, cloud), events: [...probes.tracked], sentry: probes.sentryCalls() - sentry0, done: done === true,
    counts: total ? { values: total.values + total.labValues, documents: total.documents.length, skipped: total.skippedValues + total.skippedLabValues, refused: total.refusedLabUnits.length + total.refusedMeasurements.length } : null,
  };
  cleanup();
  return side;
}

/** The shared Save's web adapter: the same pick read by the web's own effects, the same choices sent, then the Save the
 *  flow will run (`sharedSave`), answered with the flow's own event; a failed Save is saved again from `saveFailed`. */
export async function adapterSave(seed: Seed, upload: HealthUploadAPI, probes: Probes): Promise<Side> {
  const cloud = await open(seed);
  probes.tracked.length = 0;
  const sentry0 = probes.sentryCalls();
  const run = drive(upload, seed.files.map(fileOf));
  for (let i = 0; i < 200 && !(run.state().phase === 'open' && inFlight(run.state()) === 0); i++) await new Promise((r) => setTimeout(r, 0));
  const now = new Date().toISOString();
  const ids = run.state().phase === 'choosing' ? [] : (run.state() as Extract<UploadState, { files: unknown }>).files.map((f) => f.id);
  for (const { file, change } of seed.choices?.(uploadReview(run.state(), recordFileSync()!, now), run.state()) ?? []) {
    run.send({ type: 'chose', id: ids[file], change, now });
  }
  const { review, view } = uploadScreens(run.state(), recordFileSync()!, now, seed.cloud, () => 'si', seed.person);
  let outcome: SharedOutcome | null = null;
  // The list offers Save only when its view enables it, as the grid offers none with nothing to write.
  if (view.save.enabled) {
    probes.failNext.shared = !!seed.failFirst;
    for (let attempt = 0; attempt < 2 && run.state().phase !== 'done'; attempt++) {
      run.send({ type: 'saveStarted', reviewed: reviewedWrites(review) });
      const s = run.state();
      if (s.phase !== 'saving') break;
      const event = await sharedSave(upload, s, run.held, seed.person, () => {});
      run.send(event);
      if (event.type === 'saved') outcome = event.outcome;
      else if (!seed.failFirst) break;
    }
  }
  await flushRoadmapStore().catch(() => {});
  return {
    record: await snapshot(recordFileSync()!, cloud), events: [...probes.tracked], sentry: probes.sentryCalls() - sentry0, done: outcome !== null,
    counts: outcome ? { values: outcome.values, documents: outcome.documents, skipped: (outcome.skippedValues ?? 0) + (outcome.skippedLabValues ?? 0), refused: outcome.refused?.length ?? 0 } : null,
  };
}

export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
/** Stamps, the only fields left out besides ids. */
const STAMPS = new Set(['createdAt', 'addedAt', 'updatedAt', 'lamport', 'deviceId', 'lastDeviceId']);
/**
 * What a person keeps of a record: every field of every value row and document (metadata keys, extracted text, the
 * original's ref and type included), every id named by the content of the row it names, stamps left out, a value's
 * day compared as the day (`dayForms` names the form each upload wrote); each stored original's bytes and type, read
 * from the cloud; the screening dates. Each table sorted.
 */
export async function snapshot(written: RoadmapFile, cloud: MemoryCloud | null) {
  // The forms an upload wrote its values' days in (owner ruling 2026-11-22, U1): a bare day or ISO midnight name one
  // slot (merge.ts `dayOf`, record-edits.ts `slotKey`), so the tables compare the day and this list names each form.
  const form = (at: string) => (/^\d{4}-\d{2}-\d{2}$/.test(at) ? 'day' : /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(at) ? 'iso-midnight' : `other ${at}`);
  const dayForms = [...new Set([...written.measurements, ...written.labValues].filter((r) => r.source.startsWith('lab_import')).map((r) => form(r.recordedAt)))].sort();
  const file: RoadmapFile = JSON.parse(JSON.stringify(written).replace(/"recordedAt":"(\d{4}-\d{2}-\d{2})T00:00:00\.000Z"/g, '"recordedAt":"$1"'));
  const name = new Map<string, string>();
  for (const m of file.measurements) name.set(m.id, `${m.metricType}|${m.recordedAt}|${m.value}|${m.status}`);
  for (const l of file.labValues) name.set(l.id, `${l.metricName}|${l.recordedAt}|${l.value}|${l.unit}|${l.status}`);
  const table = (rows: object[]) => rows.map((row) => JSON.stringify(row, (key, v) => {
    if (STAMPS.has(key)) return undefined;
    if ((key === 'id' || key === 'correctsId') && typeof v === 'string') return name.get(v) ?? `another ${key}`;
    if (key === 'rows' && Array.isArray(v)) return v.map((id: string) => name.get(id) ?? 'unknown row').sort();
    return v;
  })).sort();
  const originals = await Promise.all(file.documents.filter((d) => d.fileRef).map(async (d) => {
    const blob = cloud?.docs.get(d.fileRef);
    return `${d.fileRef}: ${blob ? `${blob.type || '(no type)'} ${await blob.text()}` : 'missing'}`;
  }));
  return {
    measurements: table(file.measurements),
    labValues: table(file.labValues),
    documents: table(file.documents),
    originals: originals.sort(),
    screenings: Object.fromEntries(Object.entries(file.screenings).filter(([k, v]) => /LastDate$/.test(k) && v)),
    dayForms,
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
  labPrevUndated: lab('2025-09-02', [core('ldl', 2.8), core('ldl', 3.3, { recordedAt: UNDATED_PREVIOUS })]),
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
  uploadSave, uploadReview,
  getZipEntries: async (zip: File) => (await zip.text()).slice('read:'.length).split(',').map((read, i) => ({
    name: `member-${i}-${read}.pdf`, bytes: 12, entry: { async: async () => new Blob([`read:${read}`]) },
  })),
}) as unknown as HealthUploadAPI;

/** The reader's answer for a page's text (`read:<key>`). */
export const readFor = (pages: unknown) => READS[((pages as Array<{ content: string }>)[0].content).slice('read:'.length)];
