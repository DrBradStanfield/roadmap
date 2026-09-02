/**
 * RoadmapStore — the local-first data layer that replaces `widget-src/src/lib/api.ts`.
 *
 * It exposes the SAME function surface the app already calls (loadLatestMeasurements,
 * addMeasurement, saveMedication, …) so wiring HealthTool is a near-mechanical
 * swap, but instead of POSTing to Shopify/Supabase it operates on an in-memory
 * working copy of the user's RoadmapFile and persists it to their own cloud (or
 * localStorage) through a SyncManager.
 *
 * Model: mutations update the in-memory file synchronously and schedule a
 * debounced, SERIALIZED persist (one save at a time; bursts collapse into one
 * cloud write). Reads translate the file's internal shapes into the camelCase
 * `Api*` shapes the components expect. The merge engine (health-core) owns
 * multi-device safety; this layer owns the app-facing surface + persistence.
 *
 * Phase-1 scope notes (kept honest):
 *  - Server/AI/email functions (lab-extract, chat, report email) are NOT here —
 *    they're website-only (Brad's server) or BYO-key (self-host); the standalone
 *    build hides them.
 *  - Medication-history chart annotations are derived from lightweight snapshots.
 */
import {
  buildDocumentRef,
  splitDocumentRef,
  classifyMedicationChange,
  classifySupplementChange,
  computeReminderSchedule,
  createMeasurement,
  dayOf,
  diffInputsToMeasurements,
  fileProfileToApi,
  fileScreeningRows,
  labSlotKey,
  latestActivePerMetric,
  localDay,
  measurementsToInputs,
  mergeFiles,
  migrateFile,
  PREFILL_FIELDS,
  SchemaTooNewError,
  screeningFieldName,
  stableStringify,
  type ApiMeasurement,
  type ApiMedication,
  type ApiScreening,
  type DocumentType,
  type FileDocument,
  type FileLabValue,
  type FileReminderOptIn,
  type FileSupplement,
  type HealthInputs,
  type MeasurementSource,
  type ReminderScheduleItem,
  type RoadmapFile,
} from '@roadmap/health-core';
import { getDeviceId } from './device-id';
import { ROADMAP_DOC, SyncManager, type SyncContext } from '@roadmap/health-core';
import { LocalStorageAdapter } from './local-storage-adapter';
import { ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core';
import { ensureIsoDatetime } from '../lib/recordedAt';
import { safeGetItem, safeRemoveItem, safeSetItem } from '../lib/storage';
import { Sentry } from '../lib/sentry';

/** Re-exported so the widget's own modules keep importing it from the store
 *  that uses it. It is defined in health-core (roadmap-doc.ts) because the
 *  hosted MCP server runs the same read-merge-write loop from Node (US-32). */
export { ROADMAP_DOC };

/**
 * Set while the on-device copy may hold changes a cloud backend hasn't seen
 * (US-09 AC4): a failed cloud persist mirrors the working copy locally under
 * this marker, and a failed connect-time lift (standalone/connect.ts) marks
 * the existing local file the same way. Cleared by the next successful cloud
 * save, after create() has merged the on-device copy back in. ONLY the
 * functions below write it — the key is exported for tests alone.
 */
export const PENDING_MIRROR_KEY = 'health_roadmap_pending_cloud_sync';

/** Fired on every marker flip; the sync-status UI listens (same convention as
 *  the standalone hr:* events). Dispatch is best-effort — absent in tests. */
export const SYNC_PENDING_EVENT = 'hr:sync-pending-changed';

/**
 * Fired when a re-read brought something new into the working copy — another
 * device, or an AI connector writing to the same file (US-34). HealthTool
 * listens and re-runs its own load path, so an open page shows the change
 * without a reload.
 */
export const REMOTE_CHANGED_EVENT = 'hr:remote-changed';

function notify(name: string): void {
  try {
    window.dispatchEvent(new Event(name));
  } catch {
    /* non-browser environment (tests) */
  }
}

/** Record that on-device data is ahead of the cloud (see PENDING_MIRROR_KEY). */
export function markSyncPending(): void {
  safeSetItem(PENDING_MIRROR_KEY, new Date().toISOString());
  notify(SYNC_PENDING_EVENT);
}

function clearSyncPending(): void {
  safeRemoveItem(PENDING_MIRROR_KEY);
  notify(SYNC_PENDING_EVENT);
}

/** True while on-device data is still waiting to reach the cloud. */
export function isSyncPending(): boolean {
  return safeGetItem(PENDING_MIRROR_KEY) != null;
}

// --- App-facing shapes (moved here from api.ts; the data ones come from health-core) ---

export interface ApiReminderPreference {
  reminderCategory: string;
  enabled: boolean;
}
export interface ApiSupplement {
  id: string;
  supplementKey: string;
  supplementName: string;
  doseValue: number | null;
  doseUnit: string | null;
  status: string;
  startedAt: string | null;
  updatedAt: string;
}
export interface ApiDocument {
  id: string;
  documentType: string;
  title: string;
  documentDate: string | null;
  contentMd: string;
  metadata: Record<string, unknown>;
  sourceFileName: string | null;
  createdAt: string;
  /** Cloud/device ref of the original uploaded file (mirrors api-types.ApiDocument). */
  fileRef?: string | null;
}
export interface ApiLabValue {
  id: string;
  metricName: string;
  value: number;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  recordedAt: string;
  source: string;
  createdAt: string;
}
export interface ApiMedicationHistory {
  id: string;
  medicationKey: string;
  drugName: string;
  doseValue: number | null;
  doseUnit: string | null;
  status: string;
  effectiveStart: string;
  effectiveEnd: string | null;
  changeType: string;
  source: string;
}
export interface LatestMeasurementsResult {
  inputs: Partial<HealthInputs>;
  previousMeasurements: ApiMeasurement[];
  medications: ApiMedication[];
  screenings: ApiScreening[];
  supplements: ApiSupplement[];
  reminderPreferences: ApiReminderPreference[];
  documents: ApiDocument[];
}
export type AddMeasurementResult =
  | { status: 'inserted'; row: ApiMeasurement }
  | { status: 'duplicate' }
  | { status: 'error' };
export type CorrectMeasurementResult =
  | { status: 'ok'; newId: string }
  | { status: 'conflict' }
  | { status: 'not_found' }
  | { status: 'error' };
export interface BulkSaveResult {
  saved: ApiMeasurement[];
  skippedDuplicates: number;
  errorCount: number;
}
export interface BulkLabValuesResult {
  saved: ApiLabValue[];
  skippedDuplicates: number;
  errorCount: number;
}

const PERSIST_DEBOUNCE_MS = 800;

/**
 * How the open page keeps up with a record something else is writing (US-34).
 * The provider says so when it can — the adapter's `watch` — and the two
 * moments a user comes back to the tab catch whatever a watch missed. The
 * slow poll is the fallback for backends with no change signal at all; a
 * watch-capable one never runs it. The throttle stops focus and
 * visibilitychange (which fire together on a tab switch) from making two round
 * trips out of one return.
 */
const REMOTE_POLL_MS = 60_000;
const REMOTE_THROTTLE_MS = 5_000;

// --- small pure helpers ---

const NUMERIC_SCREENING_KEYS = new Set(['lung_pack_years', 'prostate_psa_value']);

function newId(): string {
  return crypto.randomUUID();
}
function activeOnly<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.status === 'active');
}

/** The record minus its own clocks — what a person would call a change. Keys
 *  are sorted, as everywhere else content is compared: a merge rebuilds the
 *  objects it touches, and a reordered key is not a change anyone made. */
function contentOf(file: RoadmapFile): string {
  const { meta: _clocks, ...rest } = file;
  return stableStringify(rest);
}

export class RoadmapStore {
  private file: RoadmapFile;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persisting = false;
  private dirtyDuringPersist = false;
  /** True when a pending mirror existed but could not be read/merged at
   *  create() — persist success must then LEAVE the marker so the mirror is
   *  retried next load (e.g. once updated assets can parse its newer schema). */
  private mirrorSkipped = false;
  /** Leading-edge throttle for refreshFromRemote(), in epoch millis. */
  private lastRefresh = 0;
  private readonly deviceId: string;

  private constructor(
    private readonly sync: SyncManager<RoadmapFile>,
    private readonly adapter: StorageAdapter,
    file: RoadmapFile,
    deviceId: string,
  ) {
    this.file = file;
    this.deviceId = deviceId;
  }

  /** Load the user's record from the given backend and return a ready store. */
  static async create(adapter: StorageAdapter): Promise<RoadmapStore> {
    const deviceId = getDeviceId();
    const sync = new SyncManager(adapter, deviceId, ROADMAP_DOC);
    const store = new RoadmapStore(sync, adapter, await sync.load(), deviceId);
    // A previous cloud session failed to save and mirrored its changes
    // on-device (see persist()'s catch). Merge them in now and schedule a save
    // to lift them up; the marker clears only once a cloud save succeeds.
    if (adapter.id !== 'local' && isSyncPending()) {
      // Fault-tolerant like the mirror-WRITE side: an unreadable mirror must
      // not brick the load — continue on the cloud file. What happens to the
      // marker depends on WHY it was unreadable (see the catch below).
      try {
        const ctx: SyncContext = { deviceId, now: new Date().toISOString() };
        const { body } = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
        if (body != null) {
          store.file = ROADMAP_DOC.merge(store.file, ROADMAP_DOC.migrate(body, ctx), ctx);
          store.touch();
        } else {
          clearSyncPending(); // stale marker, nothing mirrored
        }
      } catch (error) {
        if (error instanceof SchemaTooNewError) {
          // Written by a newer bundle — readable once assets update. Keep the
          // marker (mirrorSkipped stops persist-success from clearing it).
          store.mirrorSkipped = true;
        } else {
          // Unparseable local data can never be read OR replaced (the mirror
          // write reads before merging, so it throws on the same bytes). A
          // sticky marker would show "waiting to sync" forever for data
          // nothing can recover — clear it; the bytes themselves stay put.
          clearSyncPending();
        }
      }
    }
    return store;
  }

  get backendId() {
    return this.sync.backendId;
  }

  // ===================================================================== reads

  loadLatestMeasurements(): LatestMeasurementsResult {
    const measurements = activeOnly(this.file.measurements);
    const allInputs = measurementsToInputs(measurements as ApiMeasurement[], fileProfileToApi(this.file.profile));

    const inputs: Partial<HealthInputs> = {};
    for (const field of PREFILL_FIELDS) {
      if (allInputs[field] !== undefined) (inputs as Record<string, unknown>)[field] = allInputs[field];
    }
    if (allInputs.unitSystem !== undefined) inputs.unitSystem = allInputs.unitSystem;

    return {
      inputs,
      previousMeasurements: latestActivePerMetric(measurements) as ApiMeasurement[],
      medications: this.file.medications as ApiMedication[],
      screenings: fileScreeningRows(this.file.screenings),
      supplements: this.file.supplements as ApiSupplement[],
      reminderPreferences: this.file.reminderPreferences.map((p) => ({
        reminderCategory: p.category,
        enabled: p.enabled,
      })),
      documents: this.liveDocuments().map(toApiDocument),
    };
  }

  loadAllHistory(): ApiMeasurement[] {
    return activeOnly(this.file.measurements) as ApiMeasurement[];
  }

  loadMedicationHistory(): ApiMedicationHistory[] {
    // Phase 1: no medication-change chart annotations. The chart reads
    // `changeType` (started/changed/stopped), which the append-only log doesn't
    // record at write time — fabricating it mislabels stops. Proper med-history
    // (changeType recorded on each change) is a later phase. Empty = no pins.
    return [];
  }

  loadLabValues(): ApiLabValue[] {
    return activeOnly(this.file.labValues) as ApiLabValue[];
  }

  /** Non-tombstoned documents — the ONE place the deleted-filter invariant lives. */
  private liveDocuments(): FileDocument[] {
    return this.file.documents.filter((d) => !d.deleted);
  }

  // ================================================================= mutations

  addMeasurement(metricType: string, value: number, recordedAt?: string): AddMeasurementResult {
    // No date picked = today, in the USER'S timezone and at the day granularity
    // the picked-date path already stores — otherwise an evening entry lands on
    // the previous UTC day and the two paths fight over one slot.
    const when = recordedAt ?? ensureIsoDatetime(localDay(new Date()));
    // Slot rule: one active value per (metric, day) — mirrors the server 409.
    const exists = activeOnly(this.file.measurements).some(
      (m) => m.metricType === metricType && dayOf(m.recordedAt) === dayOf(when),
    );
    if (exists) return { status: 'duplicate' };

    const row = createMeasurement({
      id: newId(),
      metricType,
      value,
      recordedAt: when,
      createdAt: new Date().toISOString(),
    });
    this.file.measurements.push(row);
    this.touch();
    return { status: 'inserted', row: row as ApiMeasurement };
  }

  correctMeasurement(oldId: string, newValueSI: number): CorrectMeasurementResult {
    const old = this.file.measurements.find((m) => m.id === oldId);
    if (!old || old.status !== 'active') return { status: 'not_found' };
    old.status = 'entered-in-error';
    const row = createMeasurement({
      id: newId(),
      metricType: old.metricType,
      value: newValueSI,
      recordedAt: old.recordedAt, // a correction keeps the original date
      createdAt: new Date().toISOString(),
      source: 'manual_correction',
      correctsId: oldId,
    });
    this.file.measurements.push(row);
    this.touch();
    return { status: 'ok', newId: row.id };
  }

  saveChangedMeasurements(current: Partial<HealthInputs>, previous: Partial<HealthInputs>): boolean {
    this.applyProfileChanges(current, previous);
    // diffInputsToMeasurements (health-core) owns the field→metric map + change detection.
    for (const { metricType, value } of diffInputsToMeasurements(current, previous)) {
      this.addMeasurement(metricType, value);
    }
    return true;
  }

  saveMedication(medicationKey: string, drugName: string, doseValue: number | null = null, doseUnit: string | null = null): boolean {
    // Classify against the current record BEFORE the upsert mutates it; a
    // non-null result appends one append-only history row (never edited or
    // deleted — merges across devices by id union). Identical re-saves and
    // non-taking ↔ non-taking flips classify null, so no duplicate rows.
    const prev = this.file.medications.find((m) => m.medicationKey === medicationKey);
    const changeType = classifyMedicationChange(prev, { drugName, doseValue, doseUnit });
    this.upsertByKey(this.file.medications, 'medicationKey', medicationKey, () => ({
      id: newId(), medicationKey, drugName, doseValue, doseUnit,
    }), (existing) => { existing.drugName = drugName; existing.doseValue = doseValue; existing.doseUnit = doseUnit; });
    if (changeType) {
      this.file.medicationHistory.push({
        id: newId(), medicationKey, drugName, doseValue, doseUnit,
        changeType, updatedAt: new Date().toISOString(),
      });
    }
    this.touch(); // one persist covers state + history — atomic file write
    return true;
  }

  saveSupplement(supplementKey: string, supplementName: string, doseValue: number | null = null, doseUnit: string | null = null, status = 'active', startedAt?: string): boolean {
    const prev = this.file.supplements.find((s) => s.supplementKey === supplementKey);
    const changeType = classifySupplementChange(prev, {
      supplementName, doseValue, doseUnit, status: status as FileSupplement['status'],
    });
    this.upsertByKey(this.file.supplements, 'supplementKey', supplementKey, () => ({
      id: newId(), supplementKey, supplementName, doseValue, doseUnit,
      status: status as FileSupplement['status'], startedAt: startedAt ?? new Date().toISOString(),
    }), (existing) => {
      existing.supplementName = supplementName; existing.doseValue = doseValue;
      existing.doseUnit = doseUnit; existing.status = status as FileSupplement['status'];
    });
    if (changeType) {
      this.file.supplementHistory.push({
        id: newId(), supplementKey, supplementName, doseValue, doseUnit,
        status: status as FileSupplement['status'],
        startedAt: prev?.startedAt ?? startedAt ?? new Date().toISOString(),
        changeType, updatedAt: new Date().toISOString(),
      });
    }
    this.touch(); // one persist covers state + history — atomic file write
    return true;
  }

  deleteSupplementApi(supplementKey: string): boolean {
    // Soft-stop through the save path so the flip is lamport-stamped (survives
    // last-write-wins merge against another device's copy) AND records the
    // 'stopped' history row. Re-deleting an already-stopped row appends nothing.
    const s = this.file.supplements.find((x) => x.supplementKey === supplementKey);
    if (s) this.saveSupplement(s.supplementKey, s.supplementName, s.doseValue, s.doseUnit, 'stopped', s.startedAt);
    return true;
  }

  saveScreening(screeningKey: string, value: string): boolean {
    const field = screeningFieldName(screeningKey);
    const parsed = NUMERIC_SCREENING_KEYS.has(screeningKey) ? parseFloat(value) : value;
    const s = this.file.screenings;
    (s as unknown as Record<string, unknown>)[field] = parsed;
    // Stamp the sync clock so this edit wins last-write-wins against the cloud
    // copy on the next merge. screenings is an LWW singleton (merge.ts: pickNewer
    // by lamport); without the bump it stays lamport:0 like the empty remote and
    // pickNewer can discard the local change — the change silently never persists.
    s.updatedAt = new Date().toISOString();
    s.lamport = (s.lamport ?? 0) + 1;
    this.touch();
    return true;
  }

  bulkSaveMeasurements(measurements: Array<{ metricType: string; value: number; recordedAt: string; source: MeasurementSource }>): BulkSaveResult {
    const saved: ApiMeasurement[] = [];
    let skippedDuplicates = 0;
    // One Set of taken (metric, day) slots → O(N+M), and intra-batch dedup too.
    const taken = new Set(activeOnly(this.file.measurements).map((m) => `${m.metricType}@${dayOf(m.recordedAt)}`));
    for (const m of measurements) {
      const slot = `${m.metricType}@${dayOf(m.recordedAt)}`;
      if (taken.has(slot)) { skippedDuplicates++; continue; }
      taken.add(slot);
      const row = createMeasurement({
        id: newId(), metricType: m.metricType, value: m.value,
        recordedAt: m.recordedAt, createdAt: new Date().toISOString(), source: m.source,
      });
      this.file.measurements.push(row);
      saved.push(row as ApiMeasurement);
    }
    if (saved.length) this.touch();
    return { saved, skippedDuplicates, errorCount: 0 };
  }

  bulkSaveLabValues(values: Array<{ metricName: string; value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null; recordedAt: string; source?: string }>): BulkLabValuesResult {
    const saved: ApiLabValue[] = [];
    let skippedDuplicates = 0;
    // Slot on `labSlotKey` — the same key the merge uses — so spelling
    // variants of one test ("Gamma GT" from an upload, "ggt" from manual add)
    // dedup against each other.
    const labSlot = (name: string, recordedAt: string) =>
      `${labSlotKey(name)}@${dayOf(recordedAt)}`;
    const taken = new Set(activeOnly(this.file.labValues).map((l) => labSlot(l.metricName, l.recordedAt)));
    for (const v of values) {
      const slot = labSlot(v.metricName, v.recordedAt);
      if (taken.has(slot)) { skippedDuplicates++; continue; }
      taken.add(slot);
      const row: FileLabValue = {
        id: newId(), metricName: v.metricName, value: v.value, unit: v.unit,
        referenceLow: v.referenceLow ?? null, referenceHigh: v.referenceHigh ?? null,
        recordedAt: v.recordedAt, createdAt: new Date().toISOString(),
        source: (v.source as MeasurementSource) ?? 'lab_import', status: 'active', correctsId: null,
      };
      this.file.labValues.push(row);
      saved.push(row as ApiLabValue);
    }
    if (saved.length) this.touch();
    return { saved, skippedDuplicates, errorCount: 0 };
  }

  /**
   * Save reviewed documents. When the payload carries the original bytes, the
   * blob is written to the user's cloud FIRST (organised path from
   * buildDocumentRef: 'Lab results/2024-05-10 Lipid panel.pdf'), THEN the
   * documents[] reference commits via the JSON write — §5.3's order, so an
   * interrupted save leaves a harmless orphan blob, never a dangling ref.
   * A failed blob write (e.g. GitHub's ~1 MB cap, localStorage quota) degrades
   * to metadata-only: the extracted values are never lost with the file.
   */
  async bulkSaveDocuments(
    documents: Array<{ documentType: string; title: string; documentDate: string | null; contentMd: string; metadata: Record<string, unknown>; sourceFileName: string | null; file?: Blob }>,
  ): Promise<ApiDocument[]> {
    const out: FileDocument[] = [];
    const existingRefs = new Set(this.file.documents.map((d) => d.fileRef).filter(Boolean));
    // Content-hash dedup: re-uploading a file the archive already holds (live,
    // not tombstoned) must not create a second entry or a " (2)" blob. The
    // review step dedups extracted VALUES but knows nothing about originals.
    const existingHashes = new Set(
      this.file.documents.filter((d) => !d.deleted && d.contentHash).map((d) => d.contentHash),
    );

    // Phase 1 (serial, order-dependent): dedup by hash, assign collision-safe
    // refs, build the metadata rows.
    const writes: Array<{ doc: FileDocument; ref: string; file: Blob; hash: string }> = [];
    for (const d of documents) {
      const hash = d.file ? await sha256Blob(d.file) : null;
      if (hash) {
        if (existingHashes.has(hash)) continue; // identical original already archived
        existingHashes.add(hash);
      }
      const doc: FileDocument = {
        id: newId(), title: d.title, type: d.documentType as DocumentType, date: d.documentDate,
        fileRef: '', contentHash: '', mimeType: '', extractedText: d.contentMd,
        addedAt: new Date().toISOString(), metadata: d.metadata, sourceFileName: d.sourceFileName,
      };
      if (d.file) {
        const ref = buildDocumentRef({
          type: doc.type,
          title: doc.title,
          date: doc.date ?? localDay(new Date()),
          sourceFileName: d.sourceFileName,
          existingRefs,
        });
        existingRefs.add(ref);
        writes.push({ doc, ref, file: d.file, hash: hash! });
      }
      out.push(doc);
    }

    // Phase 2: blob uploads, 3 at a time — serial writes made a 20-file batch
    // ~40 sequential round trips (20-40s on a slow link). The FIRST write into
    // each folder still runs alone (concurrent find-or-create of the same new
    // folder would create duplicates); the rest pool. A failed write degrades
    // to metadata-only, as before.
    const writeOne = async (w: { doc: FileDocument; ref: string; file: Blob; hash: string }) => {
      try {
        await this.adapter.writeDocument(w.ref, w.file);
        w.doc.fileRef = w.ref;
        w.doc.contentHash = w.hash;
        w.doc.mimeType = w.file.type || '';
      } catch (error) {
        console.warn(`Document file not stored (${w.ref})`, error);
        Sentry.captureException(error, {
          tags: { area: 'cloud-sync', op: 'write-document', backend: this.adapter.id },
        });
      }
    };
    const seenFolders = new Set<string>();
    const pooled: typeof writes = [];
    for (const w of writes) {
      const folder = splitDocumentRef(w.ref).folder ?? '';
      if (seenFolders.has(folder)) {
        pooled.push(w);
      } else {
        seenFolders.add(folder);
        await writeOne(w); // folder-creating write runs alone
      }
    }
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, pooled.length) }, async () => {
        while (next < pooled.length) await writeOne(pooled[next++]);
      }),
    );

    this.file.documents.push(...out);
    this.touch();
    return out.map(toApiDocument);
  }

  /** Read a stored document's bytes back (viewer). */
  async readDocumentFile(fileRef: string): Promise<Blob> {
    return this.adapter.readDocument(fileRef);
  }

  deleteDocument(documentId: string): boolean {
    const doc = this.file.documents.find((d) => d.id === documentId);
    if (!doc || doc.deleted) return false;
    // Tombstone, never splice — a hard-removed row resurrects from any other
    // copy via the union merge. The blob (if any) stays put as a harmless
    // orphan in the user's own cloud; they can remove it there if they wish.
    doc.deleted = true;
    this.touch();
    return true;
  }

  deleteLabValue(labValueId: string): boolean {
    const row = this.file.labValues.find((l) => l.id === labValueId);
    if (!row) return false;
    row.status = 'entered-in-error';
    this.touch();
    return true;
  }

  // ============================================================ reminders (§10)

  /**
   * Profile-only prefill (sex / height / birth / units) for HealthTool's initial
   * inputs seed (returning-user "Starting Info" collapse). Reads the profile
   * directly — these are all profile demographics, so there's no need to run the
   * full measurements→inputs pipeline (loadLatestMeasurements) just to drop 95%
   * of its output.
   */
  getPrefillInputs(): Partial<HealthInputs> {
    const p = this.file.profile;
    const out: Partial<HealthInputs> = {};
    for (const field of PREFILL_FIELDS) {
      const v = (p as unknown as Record<string, unknown>)[field];
      if (v !== undefined) (out as Record<string, unknown>)[field] = v;
    }
    if (p.unitSystem !== undefined) out.unitSystem = p.unitSystem;
    return out;
  }

  /** Has the user completed the Shopify-surface email-capture step? */
  getReportEmailCaptured(): boolean {
    return this.file.profile.reportEmailCaptured ?? false;
  }

  /** Mark the email-capture step done (monotonic, stamped + persisted). */
  markReportEmailCaptured(): void {
    const p = this.file.profile;
    if (p.reportEmailCaptured) return; // idempotent — only ever set true
    p.reportEmailCaptured = true;
    p.updatedAt = new Date().toISOString();
    p.lamport = (p.lamport ?? 0) + 1;
    this.touch();
  }

  getReminderOptIn(): FileReminderOptIn | undefined {
    return this.file.reminderOptIn;
  }

  /** Set/replace the opt-in singleton (status flips included), stamped + persisted. */
  setReminderOptIn(fields: Omit<FileReminderOptIn, 'updatedAt' | 'lamport'>): void {
    const prev = this.file.reminderOptIn;
    this.file.reminderOptIn = {
      ...fields,
      updatedAt: new Date().toISOString(),
      lamport: (prev?.lamport ?? 0) + 1,
    };
    this.touch();
  }

  /** The client-computed forward schedule that gets pushed to the server (§10). */
  computeReminderScheduleNow(): ReminderScheduleItem[] {
    return computeReminderSchedule(this.file, new Date());
  }

  async deleteUserData(): Promise<{ success: boolean; error?: string }> {
    // Bump the erase epoch so the empty file BEATS the merge — persist goes
    // through read-merge-write, whose never-lose-data semantics would otherwise
    // resurrect every record from the stored copy (and any other device's).
    const eraseEpoch = (this.file.meta.eraseEpoch ?? 0) + 1;
    // An erase must not silently re-consent the user. Under US-17's default-on
    // model the empty file reads as "never decided", so the next app load would
    // enrol them again — undoing an explicit opt-out (AC4) via a button that
    // promises the opposite. A higher eraseEpoch also wins the merge WHOLESALE,
    // so the 'cancelled' record on their other devices can't save them either.
    // Carry the decision, never the identity: no token, no email address.
    const optedOut = this.file.reminderOptIn?.status === 'cancelled'
      ? this.file.reminderOptIn.provider
      : null;
    this.file = migrateFile(null, { deviceId: this.deviceId, now: new Date().toISOString() });
    this.file.meta.eraseEpoch = eraseEpoch;
    if (optedOut) {
      this.file.reminderOptIn = {
        status: 'cancelled', token: '', email: '', provider: optedOut,
        updatedAt: new Date().toISOString(), lamport: 1,
      };
    }
    try {
      await this.flush();
      // The erase reached the cloud — wipe the on-device residue too (failure
      // mirror + marker + named files/documents), so no pre-erase copy outlives
      // the erase on this device (US-11). On a failed flush we keep the mirror
      // instead: it now holds the ERASED file, whose bumped eraseEpoch wins the
      // merge and carries the erase to the cloud next session.
      if (this.adapter.id !== 'local') {
        clearSyncPending();
        await new LocalStorageAdapter().disconnect();
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /** Force-persist any pending changes (call before navigation). */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!(await this.persist())) {
      throw new Error('Cloud sync failed — your latest changes are still on this device.');
    }
  }

  /** True while the working copy is AHEAD of the cloud: a save in flight, or
   *  one still sitting on the debounce. */
  private get writePending(): boolean {
    return this.persisting || this.persistTimer !== null;
  }

  /**
   * Re-read the record and merge what came back (US-34). Answers false when
   * nothing changed — including every case where re-reading would be wrong:
   * a local edit is waiting to go up (the debounce timer, or a save in
   * flight), so the working copy is AHEAD of the cloud and merging a stale
   * read over it would fight the pending write; and a localStorage-only
   * backend has no second writer to hear from.
   */
  async refreshFromRemote(): Promise<boolean> {
    if (this.adapter.id === 'local' || this.writePending) return false;
    const at = Date.now();
    if (at - this.lastRefresh < REMOTE_THROTTLE_MS) return false;
    this.lastRefresh = at;

    const before = contentOf(this.file);
    // The copy this merge is based on. A save can start AND finish while the
    // read is in the air, and `writePending` is false again by the time it
    // lands — so the test that the working copy did not move is the working
    // copy itself, not whether a write happens to be in flight now.
    const local = this.file;
    const merged = mergeFiles(local, await this.sync.load(), {
      deviceId: this.deviceId,
      now: new Date().toISOString(),
    });
    // A merge always bumps the file's own clock, so the comparison is on the
    // CONTENT: Drive returns no version, and re-rendering on every poll would
    // count a change nobody made.
    if (contentOf(merged) === before) return false;
    // A local edit that landed during the read would be lost by taking the
    // merge — it merged against a copy taken before the edit existed.
    if (this.file !== local) return false;
    this.file = merged;
    // The counting is HealthTool's: it fires `remote_change_applied` when it
    // has actually re-rendered. The store cannot import the API layer — the
    // v2 builds alias `lib/api` to `lib/roadmap-data`, which imports this
    // module, and the cycle would be real.
    notify(REMOTE_CHANGED_EVENT);
    return true;
  }

  /**
   * Start the live re-read: the provider's own change signal where there is
   * one, plus the two moments a user comes back to the tab. A backend with no
   * `watch` keeps the minute poll; one with a watch does not need it, and
   * paying for it anyway would be a round trip a second apart from a push that
   * already happened. A hidden tab watches and polls nothing — it has no
   * screen to keep up to date, and a phone left on a background tab would
   * spend the day holding a connection open. Returns the stop.
   */
  startLiveRefresh(): () => void {
    const watchable = !!this.adapter.watch;
    let watching: AbortController | null = null;
    // The push a throttled window swallowed. A watch fires once per remote
    // change and then goes quiet — the cursor has moved past it — so dropping
    // one on the throttle would lose that change until the user next came
    // back to the tab. It waits out the window instead.
    let trailing: ReturnType<typeof setTimeout> | null = null;

    // A failed re-read is not the user's problem and not a lost write: the
    // next trigger tries again, and nothing here is waiting on the answer.
    const reread = () => void this.refreshFromRemote().catch(() => {});
    const pushed = () => {
      if (trailing) return;
      const wait = REMOTE_THROTTLE_MS - (Date.now() - this.lastRefresh);
      if (wait <= 0) {
        reread();
        return;
      }
      trailing = setTimeout(() => {
        trailing = null;
        reread();
      }, wait);
    };

    const startWatch = () => {
      if (!watchable || watching) return;
      watching = new AbortController();
      this.adapter.watch!(ROADMAP_DOC.fileName, pushed, watching.signal);
    };
    const run = () => {
      if (document.visibilityState === 'hidden') {
        watching?.abort();
        watching = null;
        return;
      }
      startWatch();
      reread();
    };
    const timer = watchable ? null : setInterval(run, REMOTE_POLL_MS);
    document.addEventListener('visibilitychange', run);
    window.addEventListener('focus', run);
    if (document.visibilityState !== 'hidden') startWatch();
    return () => {
      if (timer) clearInterval(timer);
      if (trailing) clearTimeout(trailing);
      watching?.abort();
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('focus', run);
    };
  }

  /**
   * Synchronous last-ditch persist for tab-close / visibilitychange, where an
   * async flush may not finish (esp. mobile). Uses the adapter's synchronous
   * write when available (local tier); cloud backends fall back to a best-effort
   * async flush (network can't be synchronous).
   */
  flushSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.stampWrite();
    if (this.adapter.writeSync) this.adapter.writeSync(ROADMAP_DOC.fileName, this.file);
    else void this.persist();
  }

  /**
   * Advance the file's own clock before a write that bypasses mergeFiles — the
   * only other thing that stamps meta.updatedAt. migrateFile clamps every row
   * timestamp to that stamp, so without this an offline edit is rewound to the
   * last successful sync on the next load and loses a slot contest it won.
   */
  private stampWrite(): void {
    const now = new Date().toISOString();
    if (now > this.file.meta.updatedAt) this.file.meta.updatedAt = now;
  }

  // =================================================================== private

  private applyProfileChanges(current: Partial<HealthInputs>, previous: Partial<HealthInputs>): void {
    const p = this.file.profile;
    let changed = false;
    if (current.sex !== undefined && current.sex !== previous.sex) { p.sex = current.sex; changed = true; }
    if (current.birthYear !== undefined && current.birthYear !== previous.birthYear) { p.birthYear = current.birthYear; changed = true; }
    if (current.birthMonth !== undefined && current.birthMonth !== previous.birthMonth) { p.birthMonth = current.birthMonth; changed = true; }
    if (current.heightCm !== undefined && current.heightCm !== previous.heightCm) { p.heightCm = current.heightCm; changed = true; }
    if (current.unitSystem !== undefined && current.unitSystem !== previous.unitSystem) { p.unitSystem = current.unitSystem; changed = true; }
    // touch() as every other mutation does: a profile-only edit (sex, height,
    // birth date — no measurement changed with it) scheduled no save at all,
    // so it sat in memory until the next unrelated edit carried it up.
    if (changed) { p.updatedAt = new Date().toISOString(); p.lamport = (p.lamport ?? 0) + 1; this.touch(); }
  }

  /** Upsert a current-state row keyed by `keyField`, stamping the sync clock. */
  private upsertByKey<T extends { updatedAt?: string; lamport?: number }>(
    list: T[],
    keyField: keyof T,
    key: string,
    make: () => Omit<T, 'updatedAt' | 'lamport'>,
    update: (existing: T) => void,
  ): void {
    const existing = list.find((r) => (r as Record<string, unknown>)[keyField as string] === key);
    const now = new Date().toISOString();
    if (existing) {
      update(existing);
      existing.updatedAt = now;
      existing.lamport = (existing.lamport ?? 0) + 1;
    } else {
      list.push({ ...(make() as T), updatedAt: now, lamport: 0 });
    }
  }

  /** Mark dirty + schedule a debounced persist. */
  private touch(): void {
    if (this.persisting) this.dirtyDuringPersist = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Serialized read-merge-write. Re-runs if mutations land during the await. */
  /** @returns false when the save failed (already reported to Sentry). */
  private async persist(): Promise<boolean> {
    if (this.persisting) {
      this.dirtyDuringPersist = true;
      return true; // the in-flight loop will pick the changes up
    }
    this.persisting = true;
    // A remote change this save folds in is one refreshFromRemote() will never
    // find: it stands aside while a write is pending, and the merge below has
    // already taken the change into the working copy (US-34 AC1). Announce it
    // here or the screen stays stale until a reload.
    let remoteFolded = false;
    try {
      do {
        this.dirtyDuringPersist = false;
        const result = await this.sync.save(this.file);
        // Fold remote changes back in without dropping mutations made during the
        // await; merge is the source of truth for combining the two.
        const beforeMerge = contentOf(this.file);
        this.file = mergeFiles(this.file, result.file, {
          deviceId: this.deviceId,
          now: new Date().toISOString(),
        });
        if (contentOf(this.file) !== beforeMerge) remoteFolded = true;
      } while (this.dirtyDuringPersist);
      if (remoteFolded) notify(REMOTE_CHANGED_EVENT);
      // A skipped (unreadable) mirror holds data this save did NOT include —
      // keep its marker so the next load retries it.
      if (this.adapter.id !== 'local' && !this.mirrorSkipped) clearSyncPending();
      return true;
    } catch (error) {
      // The background cloud save failed — this MUST be observable (unreported,
      // it's silent data-at-risk), and the changes must NOT stay memory-only:
      // mirror the working copy on-device so a tab close can't lose it, and
      // leave the marker so the next cloud session merges it back up (US-09
      // AC4; Sentry JAVASCRIPT-REMIX-3X — a mid-session token-refresh failure
      // made every save throw while the UI still showed the connected state).
      // Most persist() call sites are fire-and-forget (`void this.persist()`),
      // so returning false (not rethrowing) keeps them from re-creating the
      // unhandled rejection Sentry's noise filters dropped; awaited callers
      // (flush) check the result.
      if (this.adapter.id !== 'local') {
        markSyncPending();
        // Deliberately the merged transfer primitive, NOT writeSync: the local
        // file may hold guest-era data this session never loaded (no marker
        // set), and a plain overwrite would destroy its only copy. The merge
        // preserves it — and lifts it up with the mirror on the next session.
        try {
          this.stampWrite();
          await saveRoadmapFileInto(new LocalStorageAdapter(), this.file);
        } catch {
          /* device storage unavailable — memory-only is the best we have */
        }
      }
      console.warn('Cloud sync failed', error);
      Sentry.captureException(error, {
        tags: { area: 'cloud-sync', op: 'persist', backend: this.adapter.id },
      });
      return false;
    } finally {
      this.persisting = false;
    }
  }
}

/** 'sha256-<hex>' content fingerprint — names the blob + detects corruption. */
async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256-${hex}`;
}

/**
 * Merge a raw roadmap-file body into `target` (migrate + read-merge-write).
 * The one cross-adapter transfer primitive: the connect-time lift-up and the
 * pre-switch copy-down (standalone/connect.ts) both delegate here, so
 * DocumentSpec/SyncManager knowledge stays in this schema-owning module.
 */
export async function saveRoadmapFileInto(target: StorageAdapter, body: unknown): Promise<void> {
  const deviceId = getDeviceId();
  const ctx = { deviceId, now: new Date().toISOString() };
  await new SyncManager(target, deviceId, ROADMAP_DOC).save(ROADMAP_DOC.migrate(body, ctx));
}

function toApiDocument(d: FileDocument): ApiDocument {
  return {
    id: d.id,
    documentType: d.type,
    title: d.title,
    documentDate: d.date,
    contentMd: d.extractedText,
    metadata: d.metadata ?? {},
    sourceFileName: d.sourceFileName ?? null,
    createdAt: d.addedAt,
    fileRef: d.fileRef || null,
  };
}
