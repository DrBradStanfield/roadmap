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
  type BulkRow,
  LiveRefresh,
  RecordSession,
  bulkAppendValues,
  placeMeasurement,
  saveDocuments,
  documentView,
  type DocumentPayload,
  type MoveKeep,
  type MoveRejection,
  type MovePlan,
  setReminderOptIn,
  setScreening,
  stampProfile,
  upsertMedication,
  upsertSupplement,
  medicationChanges,
  computeReminderSchedule,
  correctValue as correctRecordValue,
  moveBloodTest as moveRecordBloodTest,
  planBloodTestMove,
  diffInputsToMeasurements,
  fileProfileToApi,
  fileScreeningRows,
  isClinicalDay,
  latestActivePerMetric,
  localDay,
  measurementsToInputs,
  PREFILL_FIELDS,
  type ApiMeasurement,
  type ApiMedication,
  type ApiScreening,
  type FileDocument,
  type FileReminderOptIn,
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
import { ROADMAP_DOC } from '@roadmap/health-core';
import { type EraseResult, type EraseSteps, type RecordHost, type StorageAdapter } from '@roadmap/health-core';
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
/** How a blood test move ended (US-04 AC5), as a correction does. `changed`:
 *  the test on that day is not what the page showed. `invalid` carries the
 *  record's refusal, for the page to say. */
export type MoveOutcome = { status: Exclude<CorrectStatus, 'invalid'> } | { status: 'invalid'; refusal: MoveRejection };
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
      documents: this.liveDocuments().map(documentView),
    };
  }

  loadAllHistory(): ApiMeasurement[] {
    return activeOnly(this.file.measurements) as ApiMeasurement[];
  }

  loadMedicationHistory(): ApiMedicationHistory[] {
    return medicationChanges(this.file.medicationHistory);
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
    // health-core's slot rule and row (record-edits placeMeasurement, shared
    // with every other writer): one active value per (metric, day).
    const result = placeMeasurement(this.file, { metricType, value, recordedAt: when, now: new Date().toISOString() });
    if (!result.ok) return { status: 'duplicate' };
    this.session.edit(() => result.file, erase);
    return { status: 'inserted', row: result.row as ApiMeasurement };
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

  /** What moving the blood test on `from` to `to` would do, or why it cannot
   *  (US-04 AC5). Writes nothing: the page shows it for the person to confirm. */
  previewMove(from: string, to: string): MovePlan | MoveRejection {
    return planBloodTestMove(this.file, from, to, { now: new Date().toISOString() });
  }

  /** Move the blood test on `from` to `to` by record-edits' one rule, as
   *  previewed: `expectedIds` are the rows shown, `keep` answers each clash. */
  moveBloodTest(from: string, to: string, expectedIds: string[], keep: MoveKeep, erase?: string): MoveOutcome {
    if (this.refuses(erase)) return { status: 'error' };
    const result = moveRecordBloodTest(this.file, { from, to, expectedIds, keep, now: new Date().toISOString() });
    if (!result.ok) return result.reason === 'value-changed' ? { status: 'changed' } : { status: 'invalid', refusal: result };
    this.session.edit(() => result.file, erase);
    return { status: 'ok' };
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
    // health-core's one rule, shared with the iPhone app: the keyed row with
    // its sync clock, and a history row only when the change classifies.
    // One edit, one save: state + history in one atomic file write.
    const save = { medicationKey, drugName, doseValue, doseUnit };
    return this.session.edit((file) => upsertMedication(file, save, new Date().toISOString()).file, erase);
  }

  saveSupplement(supplementKey: string, supplementName: string, doseValue: number | null = null, doseUnit: string | null = null, status = 'active', startedAt?: string, erase?: string): boolean {
    if (this.refuses(erase)) return false;
    // health-core's one rule, shared with the iPhone app (as saveMedication).
    const save = { supplementKey, supplementName, doseValue, doseUnit, status: status as FileSupplement['status'], startedAt };
    return this.session.edit((file) => upsertSupplement(file, save, new Date().toISOString()).file, erase);
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
    // health-core's rule (state-edits setScreening): this answer's own stamp,
    // a blank or unreadable number stored as null (US-10 AC6).
    return this.session.edit((file) => setScreening(file, screeningKey, value, new Date().toISOString()), erase);
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
   * Save reviewed documents through health-core's one rule (saveDocuments,
   * shared with the iPhone app): blob first, then the rows; hash dedup; a
   * failed blob degrades to metadata-only; held metadata-only rows of the
   * same kind are tombstoned once the original lands (US-13 AC1, US-14 AC4).
   */
  async bulkSaveDocuments(
    documents: Array<DocumentPayload<Blob>>,
  ): Promise<{ saved: ApiDocument[]; errorCount: number; unstored?: number }> {
    // The batch stands for the erase the page showed as it started: refused
    // before any upload if that is not this copy's, and again at the commit,
    // since an erase can land while the uploads run.
    const erase = this.shownErase;
    if (this.refuses(erase)) return { saved: [], errorCount: documents.length };
    const { saved, unstored, commit } = await saveDocuments(this.file, documents, {
      hash: sha256Blob,
      write: (ref, file) => this.host.store.writeDocument(ref, file),
      mimeType: (file) => file.type || '',
      onWriteError: (error) => {
        console.warn('Document file not stored');
        Sentry.captureException(recordFailure(error, 'Document file not stored'), {
          tags: { area: 'cloud-sync', op: 'write-document', backend: this.host.store.id },
        });
      },
    });
    if (!this.session.edit(commit, erase)) return { saved: [], errorCount: documents.length };
    return { saved: saved.map(documentView), errorCount: 0, ...(unstored ? { unstored } : {}) };
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
      if (v != null) (out as Record<string, unknown>)[field] = v;
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
    return this.session.edit((file) => stampProfile(file, { reportEmailCaptured: true }, new Date().toISOString()));
  }

  /** The unit the user chose for Lp(a)'s field (US-05 AC2), as the record holds it: unchecked. */
  getLpaUnit(): unknown {
    return this.file.profile.lpaUnit;
  }

  /** Remember Lp(a)'s field unit: a profile preference, stamped like the others so it syncs (US-05 AC2). */
  setLpaUnit(unit: LpaUnit): boolean {
    if (this.file.profile.lpaUnit === unit) return true;
    return this.session.edit((file) => stampProfile(file, { lpaUnit: unit }, new Date().toISOString()));
  }

  getReminderOptIn(): FileReminderOptIn | undefined {
    return this.file.reminderOptIn;
  }

  /** Set/replace the opt-in singleton (status flips included), stamped + persisted. */
  setReminderOptIn(fields: Omit<FileReminderOptIn, 'updatedAt' | 'lamport'>, erase?: string): boolean {
    return this.session.edit((file) => setReminderOptIn(file, fields, new Date().toISOString()), erase);
  }

  /** The client-computed forward schedule that gets pushed to the server (§10). */
  computeReminderScheduleNow(): ReminderScheduleItem[] {
    return computeReminderSchedule(this.file, new Date());
  }

  /** "Delete all my data": the stored record is read first, then the server
   *  teardown and the chat tombstones, then the record, in the session's order;
   *  a refused erase runs neither step (US-09 AC23, US-11 AC2). */
  deleteAllData(steps: EraseSteps = {}): Promise<EraseResult & { chatErased: boolean }> {
    return this.session.deleteAllData(steps);
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
   * Start the live re-read (US-34): health-core's LiveRefresh decides when to
   * read; the page tells it when the tab shows or hides. visibilitychange and
   * focus both ask where the tab is now. Returns the stop.
   */
  startLiveRefresh(): () => void {
    const isVisible = () => document.visibilityState !== 'hidden';
    const live = new LiveRefresh(this.session, this.host, { reread: () => this.refreshFromRemote(), isVisible });
    const check = () => (isVisible() ? live.visible() : live.hidden());
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    live.start();
    return () => {
      live.stop();
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
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
      // A cleared form field is absent from current, but is still a write.
      // Keep its key as null so the field stamp carries the clear (US-10 AC9).
      if (current[field] !== previous[field]) changes[field] = current[field] ?? null;
    }
    if (Object.keys(changes).length === 0) return;
    // Only the fields changed take a new stamp (US-10 AC6). And an edit, which
    // schedules a save, as every other mutation is: a profile-only edit (sex,
    // height, birth date — no measurement changed with it) once scheduled no
    // save at all, so it sat in memory until the next unrelated edit carried it up.
    this.session.edit((file) => stampProfile(file, changes as Partial<RoadmapProfile>, new Date().toISOString()), erase);
  }
}

