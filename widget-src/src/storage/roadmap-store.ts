// The record written here goes to the user's own cloud or localStorage, never to
// our server. README.md, "Verifying this yourself", says how to check that live.
/**
 * RoadmapStore — the local-first data layer that replaces `widget-src/src/lib/api.ts`.
 *
 * It exposes the SAME function surface the app already calls (loadLatestMeasurements,
 * addMeasurement, saveMedication, …) so wiring HealthTool is a near-mechanical
 * swap, but instead of POSTing to Shopify/Supabase it operates on an in-memory
 * working copy of the user's RoadmapFile and persists it to their own cloud (or
 * localStorage) through health-core's RecordSession.
 *
 * Model: mutations go through `session.edit`, which updates the in-memory file
 * synchronously and schedules a debounced, SERIALIZED save (one save at a
 * time; bursts collapse into one cloud write). Reads translate the file's
 * internal shapes into the camelCase `Api*` shapes the components expect.
 * The session (health-core, shared with the iPhone app) owns saving,
 * re-reading, erasing and the erase guard; this layer owns the app-facing
 * surface, the document uploads and the live re-read's browser wiring.
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
  RecordSession,
  REMOTE_THROTTLE_MS,
  REMOTE_POLL_MS,
  saveRecordInto,
  bulkAppendValues,
  splitDocumentRef,
  classifyMedicationChange,
  classifySupplementChange,
  isEscalationKey,
  computeReminderSchedule,
  correctValue as correctRecordValue,
  createMeasurement,
  dayOf,
  diffInputsToMeasurements,
  fileProfileToApi,
  fileScreeningRows,
  isClinicalDay,
  latestActivePerMetric,
  localDay,
  measurementsToInputs,
  parseLocalisedNumber,
  PREFILL_FIELDS,
  screeningFieldName,
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
  type LpaUnit,
  type MeasurementRefusal,
  type MeasurementSource,
  type ReminderScheduleItem,
  type RoadmapFile,
  type RoadmapProfile,
} from '@roadmap/health-core';
import { getDeviceId } from './device-id';
import { ROADMAP_DOC, SyncManager, type SyncContext } from '@roadmap/health-core';
import { LocalStorageAdapter } from './local-storage-adapter';
import { type EraseResult, type RecordHost, type StorageAdapter } from '@roadmap/health-core';
import { ensureIsoDatetime } from '../lib/recordedAt';
import { webRecordHost } from './web-record-host';
import { Sentry } from '../lib/sentry';
import { recordFailure } from '../lib/error-diagnostics';

/** Re-exported so the widget's own modules keep importing it from the store
 *  that uses it. It is defined in health-core (roadmap-doc.ts) because the
 *  hosted MCP server runs the same read-merge-write loop from Node (US-32). */
export { ROADMAP_DOC };

/** The pending-mirror marker (US-09 AC4) is the web host's; re-exported for
 *  the modules that import it from the store. */
export { PENDING_MIRROR_KEY, SYNC_PENDING_EVENT, REMOTE_CHANGED_EVENT, markSyncPending, beginRoadmapLogOff, isSyncPending } from './web-record-host';
/** Defined in health-core's record session, which makes the erase. */
export { ERASE_UNREACHABLE } from '@roadmap/health-core';

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
  refused: MeasurementRefusal[];
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

// --- small pure helpers ---

const NUMERIC_SCREENING_KEYS = new Set(['lung_pack_years', 'prostate_psa_value']);

function newId(): string {
  return crypto.randomUUID();
}
function activeOnly<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.status === 'active');
}

export class RoadmapStore {
  private constructor(
    /** The open record: its save loop, re-read, erase and erase guard
     *  (health-core record-session.ts, shared with the iPhone app). */
    private readonly session: RecordSession,
    /** The device and its tier (health-core record-host.ts). */
    private readonly host: RecordHost,
  ) {}

  /** Load the user's record from the given backend and return a ready store. */
  static async create(adapter: StorageAdapter, cloudUnreachable = false): Promise<RoadmapStore> {
    const host = webRecordHost(adapter);
    return new RoadmapStore(await RecordSession.open(host, { cloudUnreachable }), host);
  }

  /** The working copy, read-only here: every change goes through `session.edit`. */
  private get file(): RoadmapFile {
    return this.session.file;
  }

  get backendId() {
    return this.session.backendId;
  }

  /** Which erase this copy is at, as one comparable string (US-16 AC2a). */
  get eraseIdentity(): string {
    return this.session.eraseIdentity;
  }

  /** The erase the page shows: the stamp of a write that brings none. */
  showErase(identity: string): void {
    this.session.showErase(identity);
  }
  get shownErase(): string {
    return this.session.shownErase;
  }
  /** Every write below takes `erase`, the erase the page showed when the
   *  write was asked for, and is refused as the session's `refuses` says
   *  (US-16 AC2a). A refusal is the method's error answer, never a throw. */
  private refuses(erase?: string): boolean {
    return this.session.refuses(erase);
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
    // An escalation row an earlier build wrote is an answer, not a medication
    // change (US-06 AC11): the file keeps it, the history view does not show it.
    return this.file.medicationHistory
      .filter(h => ['started', 'stopped', 'dose_changed', 'switched'].includes(h.changeType ?? '')
        && typeof h.medicationKey === 'string' && !isEscalationKey(h.medicationKey) && typeof h.drugName === 'string'
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

  addMeasurement(metricType: string, value: number, recordedAt?: string, erase?: string): AddMeasurementResult {
    if (this.refuses(erase)) return { status: 'error' };
    // No date picked = today, in the USER'S timezone and at the day granularity
    // the picked-date path already stores — otherwise an evening entry lands on
    // the previous UTC day and the two paths fight over one slot.
    const when = recordedAt ?? ensureIsoDatetime(localDay(new Date()));
    // US-29 AC4a: the reader drops a row without a real day; storing one fails every later save.
    if (!isClinicalDay(when)) return { status: 'error' };
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
    this.session.edit((file) => void file.measurements.push(row), erase);
    return { status: 'inserted', row: row as ApiMeasurement };
  }

  /** Correct one saved value, core or lab, by record-edits' one rule: append
   *  the new number on the SAME day with `correctsId`, flip the old row.
   *  `newValue` is in the unit the row is stored in (SI for a core metric). */
  correctValue(id: string, newValue: number, erase?: string): CorrectStatus {
    if (this.refuses(erase)) return 'error';
    const result = correctRecordValue(this.file, { id, newValue, now: new Date().toISOString() });
    if (!result.ok) return result.reason === 'not-found' || result.reason === 'not-active' ? 'changed' : 'invalid';
    this.session.edit(() => result.file, erase);
    return 'ok';
  }

  saveChangedMeasurements(current: Partial<HealthInputs>, previous: Partial<HealthInputs>, erase?: string): boolean {
    if (this.refuses(erase)) return false;
    this.applyProfileChanges(current, previous, erase);
    // diffInputsToMeasurements (health-core) owns the field→metric map + change detection.
    for (const { metricType, value } of diffInputsToMeasurements(current, previous)) {
      this.addMeasurement(metricType, value, undefined, erase);
    }
    return true;
  }

  saveMedication(medicationKey: string, drugName: string, doseValue: number | null = null, doseUnit: string | null = null, erase?: string): boolean {
    if (this.refuses(erase)) return false;
    // Classify against the current record BEFORE the upsert mutates it; a
    // non-null result appends one append-only history row (never edited or
    // deleted — merges across devices by id union). Identical re-saves and
    // non-taking ↔ non-taking flips classify null, so no duplicate rows.
    const prev = this.file.medications.find((m) => m.medicationKey === medicationKey);
    const changeType = classifyMedicationChange(prev, { medicationKey, drugName, doseValue, doseUnit });
    // One edit, one save: state + history in one atomic file write.
    return this.session.edit((file) => {
      this.upsertByKey(file.medications, 'medicationKey', medicationKey, () => ({
        id: newId(), medicationKey, drugName, doseValue, doseUnit,
      }), (existing) => { existing.drugName = drugName; existing.doseValue = doseValue; existing.doseUnit = doseUnit; });
      if (changeType) {
        file.medicationHistory.push({
          id: newId(), medicationKey, drugName, doseValue, doseUnit,
          changeType, updatedAt: new Date().toISOString(),
        });
      }
    }, erase);
  }

  saveSupplement(supplementKey: string, supplementName: string, doseValue: number | null = null, doseUnit: string | null = null, status = 'active', startedAt?: string, erase?: string): boolean {
    if (this.refuses(erase)) return false;
    const prev = this.file.supplements.find((s) => s.supplementKey === supplementKey);
    const changeType = classifySupplementChange(prev, {
      supplementName, doseValue, doseUnit, status: status as FileSupplement['status'],
    });
    // One edit, one save: state + history in one atomic file write.
    return this.session.edit((file) => {
      this.upsertByKey(file.supplements, 'supplementKey', supplementKey, () => ({
        id: newId(), supplementKey, supplementName, doseValue, doseUnit,
        status: status as FileSupplement['status'], startedAt: startedAt ?? new Date().toISOString(),
      }), (existing) => {
        existing.supplementName = supplementName; existing.doseValue = doseValue;
        existing.doseUnit = doseUnit; existing.status = status as FileSupplement['status'];
      });
      if (changeType) {
        file.supplementHistory.push({
          id: newId(), supplementKey, supplementName, doseValue, doseUnit,
          status: status as FileSupplement['status'],
          startedAt: prev?.startedAt ?? startedAt ?? new Date().toISOString(),
          changeType, updatedAt: new Date().toISOString(),
        });
      }
    }, erase);
  }

  deleteSupplementApi(supplementKey: string, erase?: string): boolean {
    // Soft-stop through the save path so the flip is lamport-stamped (survives
    // last-write-wins merge against another device's copy) AND records the
    // 'stopped' history row. Re-deleting an already-stopped row appends nothing.
    const s = this.file.supplements.find((x) => x.supplementKey === supplementKey);
    return s ? this.saveSupplement(s.supplementKey, s.supplementName, s.doseValue, s.doseUnit, 'stopped', s.startedAt, erase) : !this.refuses(erase);
  }

  saveScreening(screeningKey: string, value: string, erase?: string): boolean {
    if (this.refuses(erase)) return false;
    const field = screeningFieldName(screeningKey);
    // A blank or unreadable number is stored as null, which clears the field (US-10 AC6).
    const parsed = NUMERIC_SCREENING_KEYS.has(screeningKey) ? parseLocalisedNumber(value) ?? null : value;
    // Stamp this answer's clock, and only its own (US-10 AC6). Unstamped it
    // stays lamport:0 like the empty remote, and the merge can discard it; with
    // the whole object's stamp it would carry this copy of every other answer.
    const answer = { [field]: parsed } as Partial<FileScreenings>;
    return this.session.edit((file) => void (file.screenings = stampFields(file.screenings, answer, new Date().toISOString())), erase);
  }

  /** The reviewed batch, written by health-core's one bulk rule (shared with
   *  the connector's import, US-35 AC8): replace-on-`correctsId` only while
   *  that row still holds the slot, skip a taken slot, never two actives. */
  bulkSaveMeasurements(measurements: BulkMeasurementInput[]): BulkSaveResult {
    if (this.refuses()) return { saved: [], skippedDuplicates: 0, errorCount: measurements.length, refused: [] };
    const { saved, skippedDuplicates, measurementRefusals } = this.bulkSave(measurements.map((m) => ({ kind: 'measurement' as const, ...m })));
    // A refused number is the caller's to SHOW, like a refused lab unit: no
    // retry can change it, so it is not an error (US-12 AC6, US-35 AC17).
    return { saved: saved as ApiMeasurement[], skippedDuplicates, errorCount: 0, refused: measurementRefusals };
  }

  bulkSaveLabValues(values: BulkLabValueInput[]): BulkLabValuesResult {
    if (this.refuses()) return { saved: [], skippedDuplicates: 0, errorCount: values.length, refused: [] };
    const { saved, skippedDuplicates, refused } = this.bulkSave(values.map((v) => ({ kind: 'lab' as const, ...v, source: (v.source as MeasurementSource) ?? 'lab_import' })));
    return { saved: saved as ApiLabValue[], skippedDuplicates, errorCount: 0, refused };
  }

  private bulkSave(rows: BulkRow[]): ReturnType<typeof bulkAppendValues> {
    const result = bulkAppendValues(this.file, rows, new Date().toISOString());
    // Nothing saved hands back the same file: no change, no save.
    if (result.saved.length) this.session.edit(() => result.file);
    return result;
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
    // The batch stands for the erase the page showed as it started: refused
    // before any upload if that is not this copy's, and again at the commit,
    // since an erase can land while the uploads run.
    const erase = this.shownErase;
    if (this.refuses(erase)) return { saved: [], errorCount: documents.length };
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
          date: doc.date,
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
        await this.host.store.writeDocument(w.ref, w.file);
        w.doc.fileRef = w.ref;
        w.doc.contentHash = w.hash;
        w.doc.mimeType = w.file.type || '';
      } catch (error) {
        console.warn('Document file not stored');
        Sentry.captureException(recordFailure(error, 'Document file not stored'), {
          tags: { area: 'cloud-sync', op: 'write-document', backend: this.host.store.id },
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

    // A refused batch leaves its blobs as harmless orphans, and the
    // connector's metadata-only rows as they were.
    const failed = new Set(writes.filter((w) => w.failed).map((w) => w.doc));
    const saved = out.filter((d) => !failed.has(d));
    const committed = this.session.edit((file) => {
      for (const w of writes) {
        const superseded = w.supersedes && w.doc.fileRef && file.documents.find((d) => d.id === w.supersedes!.id);
        if (superseded) superseded.deleted = true;
      }
      file.documents.push(...saved);
    }, erase);
    if (!committed) return { saved: [], errorCount: documents.length };
    return { saved: saved.map(toApiDocument), errorCount: failed.size };
  }

  /** Read a stored document's bytes back (viewer). */
  async readDocumentFile(fileRef: string): Promise<Blob> {
    return this.host.store.readDocument(fileRef);
  }

  deleteDocument(documentId: string): boolean {
    const doc = this.file.documents.find((d) => d.id === documentId);
    if (!doc || doc.deleted || this.refuses()) return false;
    // Tombstone, never splice — a hard-removed row resurrects from any other
    // copy via the union merge. The blob (if any) stays put as a harmless
    // orphan in the user's own cloud; they can remove it there if they wish.
    return this.session.edit(() => void (doc.deleted = true));
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
  markReportEmailCaptured(): boolean {
    if (this.file.profile.reportEmailCaptured) return true; // idempotent — only ever set true
    return this.session.edit((file) => void (file.profile = stampFields(file.profile, { reportEmailCaptured: true }, new Date().toISOString())));
  }

  /** The unit the user chose for Lp(a)'s field (US-05 AC2), as the record holds it: unchecked. */
  getLpaUnit(): unknown {
    return this.file.profile.lpaUnit;
  }

  /** Remember Lp(a)'s field unit: a profile preference, stamped like the others so it syncs (US-05 AC2). */
  setLpaUnit(unit: LpaUnit): boolean {
    if (this.file.profile.lpaUnit === unit) return true;
    return this.session.edit((file) => void (file.profile = stampFields(file.profile, { lpaUnit: unit }, new Date().toISOString())));
  }

  getReminderOptIn(): FileReminderOptIn | undefined {
    return this.file.reminderOptIn;
  }

  /** Set/replace the opt-in singleton (status flips included), stamped + persisted. */
  setReminderOptIn(fields: Omit<FileReminderOptIn, 'updatedAt' | 'lamport'>, erase?: string): boolean {
    return this.session.edit((file) => {
      file.reminderOptIn = {
        ...fields,
        updatedAt: new Date().toISOString(),
        lamport: (file.reminderOptIn?.lamport ?? 0) + 1,
      };
    }, erase);
  }

  /** The client-computed forward schedule that gets pushed to the server (§10). */
  computeReminderScheduleNow(): ReminderScheduleItem[] {
    return computeReminderSchedule(this.file, new Date());
  }

  /**
   * Erase the record. `beforeErase` runs once the stored record has been read,
   * and only then: it is the irreversible part the caller owns (the reminders
   * teardown on Brad's server, the chat-history tombstones), so an erase
   * refused here has changed nothing anywhere (US-09 AC23).
   */
  deleteUserData(beforeErase?: () => Promise<void>): Promise<EraseResult> {
    return this.session.erase(beforeErase);
  }

  /** Force-persist any pending changes (call before navigation). */
  flush(): Promise<void> {
    return this.session.flush();
  }

  /** Re-read the record and merge what came back (US-34); see the session. */
  refreshFromRemote(): Promise<boolean> {
    return this.session.refreshFromRemote();
  }

  /**
   * Start the live re-read: the provider's own change signal where there is
   * one, plus the two moments a user comes back to the tab. A backend with no
   * `watch` keeps the minute poll; one with a watch does not need it, and
   * paying for it anyway would be a round trip a second apart from a push that
   * already happened. A hidden tab watches and polls nothing — it has no
   * screen to keep up to date, and a phone left on a background tab would
   * spend the day holding a connection open. Its return catches up on what
   * it missed. The local tier's watch holds no connection, so a hidden tab
   * keeps it and reads nothing; its return re-reads only when the stored
   * revision moved since this tab last read or wrote it, so a lone tab never
   * re-reads at all. Returns the stop.
   */
  startLiveRefresh(): () => void {
    const adapter = this.host.store;
    const watchable = !!adapter.watch;
    const local = this.host.tier === 'device';
    let watching: AbortController | null = null;
    // The push a throttled window swallowed. A watch fires once per remote
    // change and then goes quiet — the cursor has moved past it — so dropping
    // one on the throttle would lose that change until the user next came
    // back to the tab. It waits out the window instead.
    let trailing: ReturnType<typeof setTimeout> | null = null;
    // When the tab last hid. A re-read before then cannot have seen what the
    // hidden tab missed.
    let hiddenAt = 0;

    // A failed re-read is not the user's problem and not a lost write: the
    // next trigger tries again, and nothing here is waiting on the answer.
    const reread = () => void this.refreshFromRemote().catch(() => {});
    const pushed = () => {
      if (document.visibilityState === 'hidden' || trailing) return;
      const wait = REMOTE_THROTTLE_MS - (Date.now() - this.session.lastRefreshAt);
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
      adapter.watch!(ROADMAP_DOC.fileName, pushed, watching.signal);
    };
    const run = () => {
      if (document.visibilityState === 'hidden') {
        if (!local) {
          watching?.abort();
          watching = null;
        }
        // No read while hidden, a queued one included: it would move the
        // throttle on, and the return's catch-up would be dropped (US-34 AC6).
        if (trailing) clearTimeout(trailing);
        trailing = null;
        hiddenAt = Date.now();
        return;
      }
      startWatch();
      if (this.host.sync && this.host.sync.revision(ROADMAP_DOC.fileName) === this.session.seenRevision) return;
      // The return's catch-up waits out the throttle; it is never dropped. Once
      // it has read, a second trigger may be (focus and visibilitychange fire
      // together).
      if (this.session.lastRefreshAt <= hiddenAt) pushed();
      else reread();
    };
    const timer = watchable ? null : setInterval(run, REMOTE_POLL_MS);
    document.addEventListener('visibilitychange', run);
    window.addEventListener('focus', run);
    if (local || document.visibilityState !== 'hidden') startWatch();
    return () => {
      if (timer) clearInterval(timer);
      if (trailing) clearTimeout(trailing);
      watching?.abort();
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('focus', run);
    };
  }

  /** Clear the off-file health data for the erase this copy is at, sparing
   *  the originals of documents that outlive it (US-11 AC6); see the session. */
  clearOffFileData(): void {
    this.session.clearOffFileData();
  }

  /** Last-ditch save for tab close and hide (US-10 AC5); see the session. */
  flushSync(): void {
    this.session.flushSync();
  }

  // =================================================================== private

  private applyProfileChanges(current: Partial<HealthInputs>, previous: Partial<HealthInputs>, erase?: string): void {
    const changes: Record<string, unknown> = {};
    for (const field of [...PREFILL_FIELDS, 'unitSystem'] as const) {
      if (current[field] !== undefined && current[field] !== previous[field]) changes[field] = current[field];
    }
    if (Object.keys(changes).length === 0) return;
    // Only the fields changed take a new stamp (US-10 AC6). And an edit, which
    // schedules a save, as every other mutation is: a profile-only edit (sex,
    // height, birth date — no measurement changed with it) once scheduled no
    // save at all, so it sat in memory until the next unrelated edit carried it up.
    this.session.edit((file) => void (file.profile = stampFields(file.profile, changes as Partial<RoadmapProfile>, new Date().toISOString())), erase);
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

}

/**
 * Merge a raw roadmap-file body into `target` (migrate + read-merge-write).
 * The one cross-adapter transfer primitive: the connect-time lift-up and the
 * pre-switch copy-down (standalone/connect.ts) both delegate here, so
 * DocumentSpec/SyncManager knowledge stays in this schema-owning module.
 */
export async function saveRoadmapFileInto(target: StorageAdapter, body: unknown): Promise<void> {
  await saveRecordInto(target, body, { deviceId: getDeviceId(), now: new Date().toISOString() });
}

/**
 * Copy a cloud body DOWN onto this device, merged. A plain merge: against an
 * erased cloud file, the rows a fallback session is still holding survive
 * because no erase listed them (US-09 AC23).
 */
export async function copyCloudDownToDevice(body: unknown): Promise<void> {
  const deviceId = getDeviceId();
  const ctx: SyncContext = { deviceId, now: new Date().toISOString() };
  const sync = new SyncManager(new LocalStorageAdapter(), deviceId, ROADMAP_DOC);
  await sync.save(ROADMAP_DOC.merge(await sync.load(), ROADMAP_DOC.migrate(body, ctx), ctx));
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
