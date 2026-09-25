// The record written here goes to the user's own cloud or localStorage, never to
// our server. README.md, "Verifying this yourself", says how to check that live.
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
 *  - Medication-history chart annotations use explicit change types saved at write time.
 */
import { sha256Blob } from '../lib/archive-payloads';
import {
  buildDocumentRef,
  type BulkRow,
  bulkAppendValues,
  splitDocumentRef,
  classifyMedicationChange,
  classifySupplementChange,
  computeReminderSchedule,
  correctValue as correctRecordValue,
  createMeasurement,
  dayOf,
  diffInputsToMeasurements,
  earliestRowStamp,
  fileProfileToApi,
  fileScreeningRows,
  latestActivePerMetric,
  localDay,
  measurementsToInputs,
  mergeFiles,
  migrateFile,
  PREFILL_FIELDS,
  SchemaTooNewError,
  screeningFieldName,
  stableStringify,
  stampFields,
  type ApiMeasurement,
  type ApiMedication,
  type ApiScreening,
  type DocumentType,
  type FileDocument,
  type FileReminderOptIn,
  type FileScreenings,
  type FileSupplement,
  type HealthInputs,
  type LabUnitRefusal,
  type MeasurementSource,
  type ReminderScheduleItem,
  type RoadmapFile,
  type RoadmapProfile,
} from '@roadmap/health-core';
import { getDeviceId } from './device-id';
import { ROADMAP_DOC, SyncManager, type SyncContext } from '@roadmap/health-core';
import { LocalStorageAdapter, NAMED_FILE_PREFIX } from './local-storage-adapter';
import { ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core';
import { ensureIsoDatetime } from '../lib/recordedAt';
import { clearMatrixDrafts, clearOffFileHealthData, removeByPrefix, safeGetItem, safeRemoveItem, safeSetItem } from '../lib/storage';
import { Sentry } from '../lib/sentry';
import { recordFailure, storageFailureClass } from '../lib/error-diagnostics';

/** Re-exported so the widget's own modules keep importing it from the store
 *  that uses it. It is defined in health-core (roadmap-doc.ts) because the
 *  hosted MCP server runs the same read-merge-write loop from Node (US-32). */
export { ROADMAP_DOC };

/**
 * Set while the on-device copy may hold changes a cloud backend hasn't seen
 * (US-09 AC4): a failed cloud persist mirrors the working copy locally under
 * this marker; a failed connect-time lift and an on-device fallback session
 * (standalone/connect.ts) mark the existing local file the same way. Cleared by the next successful cloud
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

/** Record that on-device data is ahead of the cloud (see PENDING_MIRROR_KEY).
 *  The stamp is WHEN it went ahead — the LAST moment the two were in step, not
 *  the moment the failure surfaced: rows typed during the debounce, or while
 *  the doomed request was in flight, predate the failure and must still count
 *  as unsynced. It only ever moves EARLIER while it stands, so a second failure
 *  cannot orphan the first one's edits (US-09 AC13). */
export function markSyncPending(since = new Date().toISOString()): void {
  const existing = syncPendingSince();
  if (existing == null || since < existing) safeSetItem(PENDING_MIRROR_KEY, since);
  notify(SYNC_PENDING_EVENT);
}

function clearSyncPending(): void {
  safeRemoveItem(PENDING_MIRROR_KEY);
  notify(SYNC_PENDING_EVENT);
}

/** Since when on-device data has been waiting to reach the cloud (null: it
 *  isn't). The merge-up reads it — see `mergeFiles`' `keepNewerThan`. */
export function syncPendingSince(): string | null {
  return safeGetItem(PENDING_MIRROR_KEY);
}

/** True while on-device data is still waiting to reach the cloud. */
export function isSyncPending(): boolean {
  return syncPendingSince() != null;
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
  /** 'sha256-<hex>' of the original's bytes (mirrors api-types.ApiDocument). */
  contentHash?: string | null;
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
  changeType: string;
  /** When the change was recorded, not a claimed treatment date. */
  recordedAt: string;
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
/** How a correction ended. `changed`: the value named is not there any
 *  more, or another row has replaced it (another device, a connector).
 *  `invalid`: the record does not take that number (outside the metric's
 *  range). `error`: no record is open. */
export type CorrectStatus = 'ok' | 'changed' | 'invalid' | 'error';
export interface BulkSaveResult {
  saved: ApiMeasurement[];
  skippedDuplicates: number;
  errorCount: number;
}
export interface BulkLabValuesResult {
  saved: ApiLabValue[];
  skippedDuplicates: number;
  errorCount: number;
  refused: LabUnitRefusal[];
}
/** One reviewed upload row. `correctsId` is set only when the reviewer ticked
 *  "Replace" on a slot another writer (a connector, another device) already
 *  holds — it turns the write into a FHIR correction instead of a skip. */
export interface BulkMeasurementInput {
  metricType: string; value: number; recordedAt: string; source: MeasurementSource; correctsId?: string;
}
export interface BulkLabValueInput {
  metricName: string; value: number; unit: string;
  referenceLow?: number | null; referenceHigh?: number | null;
  recordedAt: string; source?: string; correctsId?: string;
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

const RECORD_CLOCKS = new Set(['updatedAt', 'lamport', 'fieldStamps']);

/**
 * What a person would SEE of the record: `contentOf` with each list read as a
 * set and every record's own clocks (`updatedAt`, `lamport`, `fieldStamps`)
 * left out. A merge re-sorts rows by id, and against an empty backend it
 * trades one singleton's stamp for the other's; neither is a change anyone
 * made. This decides only what is ANNOUNCED (US-34 AC3). Taking a merge in
 * still goes by `contentOf`: a skipped clock-only lead would leave the profile
 * lamport behind the cloud's, and the next profile edit would lose the merge.
 */
function visibleContentOf(file: RoadmapFile): string {
  const { meta: _clocks, ...rest } = file;
  const seen: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    seen[key] = Array.isArray(value) ? value.map((row) => stableStringify(row, RECORD_CLOCKS)).sort() : value;
  }
  return stableStringify(seen, RECORD_CLOCKS);
}

export class RoadmapStore {
  private file: RoadmapFile;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** The save in flight, if one is: a persist() call made meanwhile joins it. */
  private running: Promise<boolean> | null = null;
  private dirtyDuringPersist = false;
  /** True when a pending mirror existed but could not be read/merged at
   *  create() — persist success must then LEAVE the marker so the mirror is
   *  retried next load (e.g. once updated assets can parse its newer schema). */
  private mirrorSkipped = false;
  /** Leading-edge throttle for refreshFromRemote(), in epoch millis. */
  private lastRefresh = 0;
  /** Every change to the working copy counts one (touch). A save moves
   *  `savedChanges` up to the count it started from, and only when it lands,
   *  so a failed save leaves its changes unsaved for the next hide to retry. */
  private changes = 0;
  private savedChanges = 0;
  /** The kinds of device refusal reported this page load: every hide retries
   *  a refused save, and meets the same refusal (US-10 AC5). */
  private readonly refusalsReported = new Set<string>();
  private readonly deviceId: string;
  /** The last moment this device's copy and the cloud were known to agree: the
   *  load, then every successful save. A failed save marks the pending mirror
   *  from HERE, so everything typed since it survives the merge back up. */
  private lastSyncedAt = new Date().toISOString();

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
    const since = syncPendingSince();
    if (adapter.id !== 'local' && since != null) {
      // Fault-tolerant like the mirror-WRITE side: an unreadable mirror must
      // not brick the load — continue on the cloud file. What happens to the
      // marker depends on WHY it was unreadable (see the catch below).
      try {
        // `keepNewerThan` makes the epoch gate spare this device's own edits:
        // a fallback session runs on a file at epoch 0, so an erased cloud
        // would otherwise take the file wholesale and discard them (US-09
        // AC13). The on-device copy goes in as `local` — the argument the
        // option speaks about, and the one it has always meant.
        const ctx: SyncContext = { deviceId, now: new Date().toISOString(), keepNewerThan: since };
        const { body } = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
        if (body != null) {
          store.file = ROADMAP_DOC.merge(ROADMAP_DOC.migrate(body, ctx), store.file, ctx);
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
    return this.file.medicationHistory
      .filter(h => ['started', 'stopped', 'dose_changed', 'switched'].includes(h.changeType ?? '')
        && typeof h.medicationKey === 'string' && typeof h.drugName === 'string'
        && Number.isFinite(Date.parse(h.updatedAt)))
      .map(h => ({
        id: h.id, medicationKey: h.medicationKey, drugName: h.drugName,
        doseValue: h.doseValue, doseUnit: h.doseUnit,
        changeType: h.changeType!, recordedAt: h.updatedAt,
      }))
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
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

  /** Correct one saved value, core or lab, by record-edits' one rule: append
   *  the new number on the SAME day with `correctsId`, flip the old row.
   *  `newValue` is in the unit the row is stored in (SI for a core metric). */
  correctValue(id: string, newValue: number): CorrectStatus {
    const result = correctRecordValue(this.file, { id, newValue, now: new Date().toISOString() });
    if (!result.ok) return result.reason === 'not-found' || result.reason === 'not-active' ? 'changed' : 'invalid';
    this.file = result.file;
    this.touch();
    return 'ok';
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
    // Stamp this answer's clock, and only its own (US-10 AC6). Unstamped it
    // stays lamport:0 like the empty remote, and the merge can discard it; with
    // the whole object's stamp it would carry this copy of every other answer.
    const answer = { [field]: parsed } as Partial<FileScreenings>;
    this.file.screenings = stampFields(this.file.screenings, answer, new Date().toISOString());
    this.touch();
    return true;
  }

  /** The reviewed batch, written by health-core's one bulk rule (shared with
   *  the connector's import, US-35 AC8): replace-on-`correctsId` only while
   *  that row still holds the slot, skip a taken slot, never two actives. */
  bulkSaveMeasurements(measurements: BulkMeasurementInput[]): BulkSaveResult {
    return this.bulkSave(measurements.map((m) => ({ kind: 'measurement' as const, ...m }))) as BulkSaveResult;
  }

  bulkSaveLabValues(values: BulkLabValueInput[]): BulkLabValuesResult {
    return this.bulkSave(values.map((v) => ({ kind: 'lab' as const, ...v, source: (v.source as MeasurementSource) ?? 'lab_import' }))) as BulkLabValuesResult;
  }

  private bulkSave(rows: BulkRow[]): { saved: Array<ApiMeasurement | ApiLabValue>; skippedDuplicates: number; errorCount: number; refused: LabUnitRefusal[] } {
    const result = bulkAppendValues(this.file, rows, new Date().toISOString());
    this.file = result.file;
    if (result.saved.length) this.touch();
    // Always empty for measurements; for labs, the rows the caller must SHOW.
    return { saved: result.saved as Array<ApiMeasurement | ApiLabValue>, skippedDuplicates: result.skippedDuplicates, errorCount: 0, refused: result.refused };
  }

  /**
   * Save reviewed documents. When the payload carries the original bytes, the
   * blob is written to the user's cloud FIRST (organised path from
   * buildDocumentRef: 'Lab results/2024-05-10 Lipid panel.pdf'), THEN the
   * documents[] reference commits via the JSON write — §5.3's order, so an
   * interrupted save leaves a harmless orphan blob, never a dangling ref.
   * A failed blob write (e.g. GitHub's ~1 MB cap, localStorage quota) degrades
   * to metadata-only: the extracted values are never lost with the file. Except
   * behind a connector row (below): there the metadata already exists, so the
   * upload files nothing and reports the failure in `errorCount` for a retry.
   *
   * `contentHash` is ONE key for the website and the connector (US-35 AC6): a
   * live row that carries the hash AND a `fileRef` is the archived original,
   * so the upload is a no-op; a row with the hash and no `fileRef` came in
   * through the connector metadata-only, and THIS upload is the user archiving
   * that original — the new row lands with the blob and the old one is
   * tombstoned, never edited (documents are immutable under merge).
   */
  async bulkSaveDocuments(
    documents: Array<{ documentType: string; title: string; documentDate: string | null; contentMd: string; metadata: Record<string, unknown>; sourceFileName: string | null; file?: Blob }>,
  ): Promise<{ saved: ApiDocument[]; errorCount: number }> {
    const out: FileDocument[] = [];
    const existingRefs = new Set(this.file.documents.map((d) => d.fileRef).filter(Boolean));
    // Content-hash dedup: re-uploading a file the archive already holds (live,
    // not tombstoned) must not create a second entry or a " (2)" blob. The
    // review step dedups extracted VALUES but knows nothing about originals.
    const hashed = this.file.documents.filter((d) => !d.deleted && d.contentHash);
    const archived = new Set(hashed.filter((d) => d.fileRef).map((d) => d.contentHash));
    const metadataOnly = new Map(hashed.filter((d) => !d.fileRef).map((d) => [d.contentHash, d]));

    // Phase 1 (serial, order-dependent): dedup by hash, assign collision-safe
    // refs, build the metadata rows.
    const writes: Array<{ doc: FileDocument; ref: string; file: Blob; hash: string; supersedes?: FileDocument; failed?: boolean }> = [];
    for (const d of documents) {
      const hash = d.file ? await sha256Blob(d.file) : null;
      if (hash) {
        if (archived.has(hash)) continue; // identical original already archived
        archived.add(hash);
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
        // The connector's metadata-only row for these bytes is tombstoned only
        // once the blob lands: a failed write must not lose the hash key.
        writes.push({ doc, ref, file: d.file, hash: hash!, supersedes: metadataOnly.get(hash!) });
      }
      out.push(doc);
    }

    // Phase 2: blob uploads, 3 at a time — serial writes made a 20-file batch
    // ~40 sequential round trips (20-40s on a slow link). The FIRST write into
    // each folder still runs alone (concurrent find-or-create of the same new
    // folder would create duplicates); the rest pool. A failed write degrades
    // to metadata-only — unless a connector row already holds these bytes: a
    // plain row beside it would list the letter twice, and every later upload
    // would offer to archive it again (Sentry 7715862604).
    const writeOne = async (w: (typeof writes)[number]) => {
      try {
        await this.adapter.writeDocument(w.ref, w.file);
        w.doc.fileRef = w.ref;
        w.doc.contentHash = w.hash;
        w.doc.mimeType = w.file.type || '';
        if (w.supersedes) w.supersedes.deleted = true;
      } catch (error) {
        console.warn('Document file not stored');
        Sentry.captureException(recordFailure(error, 'Document file not stored'), {
          tags: { area: 'cloud-sync', op: 'write-document', backend: this.adapter.id },
        });
        w.failed = Boolean(w.supersedes);
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

    const failed = new Set(writes.filter((w) => w.failed).map((w) => w.doc));
    const saved = out.filter((d) => !failed.has(d));
    this.file.documents.push(...saved);
    this.touch();
    return { saved: saved.map(toApiDocument), errorCount: failed.size };
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
    if (this.file.profile.reportEmailCaptured) return; // idempotent — only ever set true
    this.file.profile = stampFields(this.file.profile, { reportEmailCaptured: true }, new Date().toISOString());
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
    // Bump past the STORED epoch as well, read now: another tab or device may
    // have erased and started again since this copy was read, and an erase at
    // an equal epoch unions with that record instead of beating it (US-11
    // AC7). An unreadable record leaves this copy's epoch, as before. A change
    // still on the debounce is one the erase throws away: saving it during
    // the read would only send a pre-erase copy up ahead of the erase.
    this.cancelDebounce();
    const stored = await this.sync.load().then((file) => file.meta.eraseEpoch ?? 0, () => 0);
    const eraseEpoch = Math.max(stored, this.file.meta.eraseEpoch ?? 0) + 1;
    // An erase must not silently re-consent the user. Under US-17's default-on
    // model the empty file reads as "never decided", so the next app load would
    // enrol them again — undoing an explicit opt-out (AC4), and for an ENROLLED
    // user refilling the server row the pre-erase hook just tore down, with no
    // token left here to cancel it. So anyone who HAD an opt-in, active or
    // cancelled, comes out of the erase with reminders off; the manual toggle
    // still re-enrols, because that is the user asking. A higher eraseEpoch
    // wins the merge WHOLESALE, so the record on their other devices can't
    // save them either. Carry the decision, never the identity: no token, no
    // email address.
    const priorProvider = this.file.reminderOptIn?.provider ?? null;
    this.file = migrateFile(null, { deviceId: this.deviceId, now: new Date().toISOString() });
    this.file.meta.eraseEpoch = eraseEpoch;
    if (priorProvider) {
      this.file.reminderOptIn = {
        status: 'cancelled', token: '', email: '', provider: priorProvider,
        updatedAt: new Date().toISOString(), lamport: 1,
      };
    }
    this.touch(); // a change like any other: a failed flush leaves it for a hide to retry
    try {
      await this.flush();
      // The erase reached the cloud — wipe the on-device residue too (failure
      // mirror + marker + named files/documents), so no pre-erase copy outlives
      // the erase on this device (US-11). On a failed flush we keep the mirror
      // instead: it now holds the ERASED file, whose bumped eraseEpoch wins the
      // merge and carries the erase to the cloud next session.
      // Document blobs and the unsaved lab-value draft sit outside the roadmap
      // file, so the erased file alone doesn't reach them. Clear them by NAME
      // in every mode — a localStorage-only user gets no disconnect() below
      // (it would delete the erased file we just wrote), and used to keep both.
      clearOffFileHealthData();
      if (this.adapter.id === 'local') {
        // The other record files (chat-history.json) sit under the adapter's
        // named-file prefix, which only disconnect() clears — and disconnect()
        // here would delete the erased record file we just wrote. Their
        // contents are already tombstoned (roadmap-data.ts erases chat history
        // BEFORE this), so removing the keys can resurrect nothing.
        removeByPrefix(NAMED_FILE_PREFIX);
      } else {
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
    this.cancelDebounce();
    if (!(await this.persist())) {
      throw new Error('Cloud sync failed — your latest changes are still on this device.');
    }
  }

  /** True while the working copy is AHEAD of the cloud: a save in flight, or
   *  one still sitting on the debounce. */
  private get writePending(): boolean {
    return this.running !== null || this.persistTimer !== null;
  }

  /** True while a change to the working copy has not landed, a failed save's
   *  included (US-10 AC5). */
  private get unsaved(): boolean {
    return this.changes !== this.savedChanges;
  }

  /**
   * Re-read the record and merge what came back (US-34). Answers false when
   * nothing changed — including every case where re-reading would be wrong:
   * a local edit is waiting to go up (the debounce timer, or a save in
   * flight), so the working copy is AHEAD of the cloud and merging a stale
   * read over it would fight the pending write. The local tier never
   * re-reads, a known gap: another tab's write reaches this one only at its
   * next save (US-10 AC5).
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
    // CONTENT, not on a version: re-rendering on every poll would count a
    // change nobody made.
    if (contentOf(merged) === before) return false;
    // A local edit that landed during the read would be lost by taking the
    // merge — it merged against a copy taken before the edit existed.
    if (this.file !== local) return false;
    // The counting is HealthTool's: it fires `remote_change_applied` when it
    // has actually re-rendered. The store cannot import the API layer — the
    // v2 builds alias `lib/api` to `lib/roadmap-data`, which imports this
    // module, and the cycle would be real. A change of clocks alone is taken
    // in and announced to nobody: there is nothing new to show.
    if (this.adopt(merged)) notify(REMOTE_CHANGED_EVENT);
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
   * Last-ditch save for tab close and hide, and only of what is unsaved, a
   * failed save's changes included (US-10 AC5). The local tier merges into
   * the one file every tab shares, synchronously, so the write has landed
   * when this returns, whatever the async save may come to await; then it
   * takes the merge in, as a save does. The cloud tier, and a refused local
   * write, fall back to the async save.
   */
  flushSync(): void {
    if (!this.unsaved) return;
    this.cancelDebounce();
    if (this.adapter instanceof LocalStorageAdapter) {
      try {
        const ctx = { deviceId: this.deviceId, now: new Date().toISOString() };
        const { body, version } = this.adapter.readSync(ROADMAP_DOC.fileName);
        const merged = ROADMAP_DOC.merge(this.file, ROADMAP_DOC.migrate(body, ctx), ctx);
        this.adapter.writeSync(ROADMAP_DOC.fileName, merged, version);
        this.savedChanges = this.changes;
        if (this.adopt(merged)) notify(REMOTE_CHANGED_EVENT);
        return;
      } catch {
        // Another tab's write in between: the async save re-reads, merges and
        // lands it. A newer app's record, unreadable bytes or a full disk: it
        // meets the same refusal, and reports it (US-10 AC5).
      }
    }
    void this.persist();
  }

  // =================================================================== private

  private applyProfileChanges(current: Partial<HealthInputs>, previous: Partial<HealthInputs>): void {
    const changes: Record<string, unknown> = {};
    for (const field of [...PREFILL_FIELDS, 'unitSystem'] as const) {
      if (current[field] !== undefined && current[field] !== previous[field]) changes[field] = current[field];
    }
    if (Object.keys(changes).length === 0) return;
    // Only the fields changed take a new stamp (US-10 AC6). And touch() as
    // every other mutation does: a profile-only edit (sex, height, birth date —
    // no measurement changed with it) scheduled no save at all, so it sat in
    // memory until the next unrelated edit carried it up.
    this.file.profile = stampFields(this.file.profile, changes as Partial<RoadmapProfile>, new Date().toISOString());
    this.touch();
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

  /** Take a merge in as the working copy, and answer whether it brought in
   *  something a person would see, for the caller to announce. One that
   *  carries an erase made on another device (a higher eraseEpoch than this
   *  copy's) clears the drafts typed here, as the erase clears them where it
   *  is made (US-11). */
  private adopt(merged: RoadmapFile): boolean {
    const seen = visibleContentOf(this.file);
    if ((merged.meta.eraseEpoch ?? 0) > (this.file.meta.eraseEpoch ?? 0)) clearMatrixDrafts();
    this.file = merged;
    return visibleContentOf(merged) !== seen;
  }

  /** Mark dirty + schedule a debounced persist. */
  private touch(): void {
    this.changes += 1;
    if (this.running) this.dirtyDuringPersist = true;
    this.cancelDebounce();
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Cancel the debounced save: the caller saves now, or throws the change away. */
  private cancelDebounce(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  /**
   * Serialized read-merge-write, run by saveLoop(). A call made while a save
   * runs joins it: the save goes round again for the new changes, and the
   * call answers when the whole save ends. A later pass that fails fails the
   * call too: a false failure, never a false success. Answering at once let
   * an awaited flush, and so an erase, report a save that had not happened
   * (US-11 AC7).
   * @returns false when the save failed (already reported to Sentry).
   */
  private persist(): Promise<boolean> {
    if (this.running) {
      this.dirtyDuringPersist = true;
      return this.running;
    }
    return (this.running = this.saveLoop());
  }

  /** Re-runs while mutations land during the await. */
  private async saveLoop(): Promise<boolean> {
    // A remote change this save folds in is one refreshFromRemote() will never
    // find: it stands aside while a write is pending, and the merge below has
    // already taken the change into the working copy (US-34 AC1). Announce it
    // here or the screen stays stale until a reload.
    let remoteFolded = false;
    try {
      do {
        this.dirtyDuringPersist = false;
        const saving = this.changes;
        const result = await this.sync.save(this.file);
        this.savedChanges = saving;
        // Fold remote changes back in without dropping mutations made during the
        // await; merge is the source of truth for combining the two.
        if (this.adopt(mergeFiles(this.file, result.file, {
          deviceId: this.deviceId,
          now: new Date().toISOString(),
        }))) remoteFolded = true;
      } while (this.dirtyDuringPersist);
      // Ended before anyone hears of it: a listener that saves again starts a
      // new save, instead of joining this finished one.
      this.running = null;
      if (remoteFolded) notify(REMOTE_CHANGED_EVENT);
      this.lastSyncedAt = new Date().toISOString();
      // A skipped (unreadable) mirror holds data this save did NOT include —
      // keep its marker so the next load retries it.
      if (this.adapter.id !== 'local' && !this.mirrorSkipped) clearSyncPending();
      return true;
    } catch (error) {
      this.running = null; // as above: ended before the marker is announced
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
        markSyncPending(this.lastSyncedAt);
        // Deliberately the merged transfer primitive, NOT a plain overwrite: the
        // local file may hold guest-era data this session never loaded (no
        // marker set), and an overwrite would destroy its only copy. The merge
        // preserves it — and lifts it up with the mirror on the next session.
        // It migrates this copy first, and migrate clamps every row clock to
        // meta.updatedAt: advance it, or an offline edit is rewound to the
        // last successful sync and loses a slot contest it won.
        try {
          const now = new Date().toISOString();
          if (now > this.file.meta.updatedAt) this.file.meta.updatedAt = now;
          await saveRoadmapFileInto(new LocalStorageAdapter(), this.file);
        } catch {
          /* device storage unavailable — memory-only is the best we have */
        }
      }
      console.warn('Cloud sync failed');
      // Only the device tier names its refusal (6M): a cloud failure's cause
      // is the transport, which `recordFailure` already classifies. A device
      // refuses every retry the same way, and each hide retries a refused
      // save, so each kind of refusal is reported once per page load.
      const cause = this.adapter.id === 'local' ? storageFailureClass(error) : undefined;
      if (cause) {
        const kind = `${error instanceof Error ? error.name : ''}/${cause}`;
        if (this.refusalsReported.has(kind)) return false;
        this.refusalsReported.add(kind);
      }
      Sentry.captureException(recordFailure(error, 'Cloud sync failed'), {
        tags: { area: 'cloud-sync', op: 'persist', backend: this.adapter.id, ...(cause ? { cause } : {}) },
      });
      return false;
    }
  }
}

/**
 * Merge a raw roadmap-file body into `target` (migrate + read-merge-write).
 * The one cross-adapter transfer primitive: the connect-time lift-up and the
 * pre-switch copy-down (standalone/connect.ts) both delegate here, so
 * DocumentSpec/SyncManager knowledge stays in this schema-owning module.
 */
export async function saveRoadmapFileInto(
  target: StorageAdapter,
  body: unknown,
  /** Set ONLY when `body` is this device's own copy and the target is the cloud
   *  (the connect-time lift): it spares the rows written since that moment from
   *  the erase-epoch gate (US-09 AC13). The copy-down runs the other way round,
   *  so it must never pass it. */
  keepNewerThan?: string,
): Promise<void> {
  const deviceId = getDeviceId();
  const ctx = { deviceId, now: new Date().toISOString(), keepNewerThan };
  await new SyncManager(target, deviceId, ROADMAP_DOC, { keepNewerThan }).save(ROADMAP_DOC.migrate(body, ctx));
}

/**
 * Copy a cloud body DOWN onto this device, merged. The DEVICE file is the
 * `local` side, which is the side `keepNewerThan` speaks about: an erased cloud
 * file wins the epoch gate, so without it a copy-down before a backend switch
 * would wipe the very rows a fallback session is still holding (US-09 AC13).
 */
export async function copyCloudDownToDevice(body: unknown, keepNewerThan?: string): Promise<void> {
  const deviceId = getDeviceId();
  const ctx: SyncContext = { deviceId, now: new Date().toISOString(), keepNewerThan };
  const sync = new SyncManager(new LocalStorageAdapter(), deviceId, ROADMAP_DOC, { keepNewerThan });
  await sync.save(ROADMAP_DOC.merge(await sync.load(), ROADMAP_DOC.migrate(body, ctx), ctx));
}

/**
 * The oldest row this device holds. A first lift that fails has synced NOTHING,
 * so that is the moment from which its data is unsynced (US-09 AC13). Undefined
 * when the file is empty or unreadable — the caller then falls back to now.
 */
export async function localUnsyncedSince(): Promise<string | undefined> {
  try {
    const { body } = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
    if (body == null) return undefined;
    const ctx = { deviceId: getDeviceId(), now: new Date().toISOString() };
    return earliestRowStamp(ROADMAP_DOC.migrate(body, ctx)) ?? undefined;
  } catch {
    return undefined;
  }
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
    contentHash: d.contentHash || null,
  };
}
