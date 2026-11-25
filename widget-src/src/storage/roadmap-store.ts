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
import { type AddLabValueRequest, type AddLabValueResult, addLabValue as addRecordLabValue, bulkAppendValues, placeMeasurement, type MoveKeep, type MoveRejection, type MovePlan, correctValue as correctRecordValue, moveBloodTest as moveRecordBloodTest, planBloodTestMove } from '@roadmap/health-core/record-edits';
import { LiveRefresh } from '@roadmap/health-core/live-refresh';
import { RecordSession, saveRecordInto, type EraseResult, type EraseSteps } from '@roadmap/health-core/record-session';
import { documentView, writtenLabRows } from '@roadmap/health-core/document-save';
import { setReminderOptIn, setScreening, stampProfile, upsertMedication, upsertSupplement } from '@roadmap/health-core/state-edits';
import { medicationChanges } from '@roadmap/health-core/medication-annotations';
import { computeReminderSchedule, type ReminderScheduleItem } from '@roadmap/health-core/reminder-schedule';
import { diffInputsToMeasurements, measurementsToInputs, PREFILL_FIELDS, type ApiMeasurement, type ApiMedication } from '@roadmap/health-core/mappings';
import { fileProfileToApi, fileScreeningRows } from '@roadmap/health-core/file-inputs';
import { isClinicalDay, latestActivePerMetric } from '@roadmap/health-core/measurement-history';
import { localDay } from '@roadmap/health-core/merge';
import type { FileDocument, FileReminderOptIn, FileSupplement, RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { type HealthInputs, isAlcoholAnswer } from '@roadmap/health-core/types';
import type { LpaUnit } from '@roadmap/health-core/units';
import { isCoreRow, currentValueRows } from '@roadmap/health-core/blood-tests';
import { egfrSeries, whtrSeries, type EgfrPoint, type WhtrPoint } from '@roadmap/health-core/plan';
import { isReadableRow, readableView } from '@roadmap/health-core/readable-rows';
import { ROADMAP_DOC } from '@roadmap/health-core/roadmap-doc';
import type { StorageAdapter } from '@roadmap/health-core/adapter';

/** The worked-out series My health's rows read (US-62 AC21). */
export interface DerivedSeries { whtr: WhtrPoint[]; egfr: EgfrPoint[] }
import type { RecordHost } from '@roadmap/health-core/record-host';
import { ensureIsoDatetime } from '../lib/recordedAt';
import { webRecordHost } from './web-record-host';
import { saveUploadThrough, type UploadEngine, type UploadSaveAnswer, type WebUploadIO } from './upload-save-store';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import type { ScreeningPerson } from '@roadmap/health-core/upload-screening';

/** Re-exported so the widget's own modules keep importing it from the store
 *  that uses it. It is defined in health-core (roadmap-doc.ts) because the
 *  hosted MCP server runs the same read-merge-write loop from Node (US-32). */
export { ROADMAP_DOC };

/** The pending-mirror marker (US-09 AC4) is the web host's; re-exported for
 *  the modules that import it from the store. */
export { PENDING_MIRROR_KEY, SYNC_PENDING_EVENT, SAVE_STATUS_EVENT, REMOTE_CHANGED_EVENT, markSyncPending, beginRoadmapLogOff, isSyncPending } from './web-record-host';
/** Defined in health-core's record session, which makes the erase. */
export { ERASE_UNREACHABLE } from '@roadmap/health-core/record-session';

// App-facing view shapes: one home, lib/api-types.ts (untangle W2-4).
import type { AddMeasurementResult, ApiLabValue, ApiMedicationHistory, ApiSupplement, BulkSaveResult, LatestMeasurementsResult } from '../lib/api-types';
import type { BirthRefusal, CorrectStatus, MoveOutcome, ProfileRangeRefusal, ProfileSave, BulkMeasurementInput } from './store-value-saves';
import { applyProfileChanges, valueView } from './store-value-saves';
import { tapFirstRead, writeMovedRecord, type BloodTableReport } from './store-open-migration';
/** Moved by workflow (US-64); re-exported for the modules that import them from the store. */
export type { BirthRefusal, CorrectStatus, MoveOutcome, ProfileRangeRefusal, ProfileSave, BulkMeasurementInput } from './store-value-saves';
export type { BloodTableReport } from './store-open-migration';

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
    let stored: unknown = null;
    const session = await RecordSession.open({ ...host, store: tapFirstRead(host.store, (body) => { stored = body; }) }, { cloudUnreachable });
    const store = new RoadmapStore(session, host);
    store.bloodTablesUnified = store.writeMovedRecord(stored);
    return store;
  }

  /** What the open moved into one blood-test table, once that write landed;
   *  null when it moved nothing or the write failed (US-66 AC13). */
  bloodTablesUnified: Promise<BloodTableReport | null> = Promise.resolve(null);

  /** US-66 AC14's one write after the open (store-open-migration.ts). */
  private writeMovedRecord(stored: unknown): Promise<BloodTableReport | null> {
    return writeMovedRecord(this.session, stored);
  }

  /** The working copy, read-only: every change goes through `session.edit`. The upload reads it for known files. */
  get file(): RoadmapFile {
    return this.session.file;
  }

  /** The readers' view: rows and profile fields this build cannot read left
   *  out; they stay in the file (US-65). Edits use `file`. */
  private get readable() {
    return readableView(this.session.file);
  }

  /** The record as screens read it. */
  private get view(): RoadmapFile {
    return this.readable.file;
  }

  /** How many entries this build could not read; kept, never shown (US-65). */
  get unreadableCount(): number {
    return this.readable.count;
  }

  /** Whether the record holds a `key` medication row this build cannot read
   *  (US-65): a chat change over it offers no Undo (US-67 N3). `answered`: only
   *  a row that is not 'not_yet', the escalation answer a chat change resets
   *  as the iPhone engine reads it (US-06 AC12). */
  holdsUnreadableMedication(key: string, answered = false): boolean {
    return this.file.medications.some((m) => m.medicationKey === key && !isReadableRow('medications', m) && !(answered && m.drugName === 'not_yet'));
  }

  get backendId() { return this.session.backendId; }
  /** What the storage line says of the save (US-09 AC30); see the session. */
  get saveStatus() { return this.session.saveStatus; }
  get retryDue() { return this.session.retryDue; } // US-09 AC30: Settings says an upload will come

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
  refuses(erase?: string): boolean {
    return this.session.refuses(erase);
  }

  // ===================================================================== reads

  loadLatestMeasurements(): LatestMeasurementsResult {
    const measurements = this.loadAllHistory();
    const allInputs = measurementsToInputs(measurements, fileProfileToApi(this.view.profile));

    const inputs: Partial<HealthInputs> = {};
    for (const field of PREFILL_FIELDS) {
      if (allInputs[field] !== undefined) (inputs as Record<string, unknown>)[field] = allInputs[field];
    }
    if (allInputs.unitSystem !== undefined) inputs.unitSystem = allInputs.unitSystem;

    return {
      inputs,
      previousMeasurements: latestActivePerMetric(measurements),
      medications: this.view.medications as ApiMedication[],
      screenings: fileScreeningRows(this.view.screenings),
      supplements: this.view.supplements as ApiSupplement[],
      reminderPreferences: this.view.reminderPreferences.map((p) => ({
        reminderCategory: p.category,
        enabled: p.enabled,
      })),
      documents: this.liveDocuments().map(documentView),
    };
  }

  /** The active vitals and core blood tests, a core test under its key as
   *  `metricType` (US-66 AC7). */
  loadAllHistory(): ApiMeasurement[] {
    return currentValueRows(this.view).map(valueView);
  }

  loadMedicationHistory(): ApiMedicationHistory[] {
    return medicationChanges(this.view.medicationHistory);
  }

  /** The active extra lab rows. A core row is a blood test the history
   *  shows, never an extra row too (US-66 AC8). */
  loadLabValues(): ApiLabValue[] {
    return activeOnly(this.view.labValues).filter((row) => !isCoreRow(row)) as ApiLabValue[];
  }

  /** My health's worked-out rows (US-62 AC21), the iPhone's series: each day's
   *  waist over the current height, and each day's eGFR, lab or calculated. The
   *  profile is the screen's (`shown`): an answer typed is read before its save lands. */
  loadDerivedSeries(shown: Partial<Pick<RoadmapFile['profile'], 'heightCm' | 'sex' | 'birthYear' | 'birthMonth'>>, now = new Date()): DerivedSeries {
    const file = { ...this.view, profile: { ...this.view.profile, ...shown } };
    return { whtr: whtrSeries(file), egfr: egfrSeries(file, now) };
  }

  /** Non-tombstoned documents — the ONE place the deleted-filter invariant lives. */
  private liveDocuments(): FileDocument[] {
    return this.view.documents.filter((d) => !d.deleted);
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
    if (!result.ok) return { status: result.reason === 'slot-occupied' ? 'duplicate' : 'invalid' };
    this.session.edit(() => result.file, erase);
    return { status: 'inserted', row: valueView(result.row) };
  }

  /** Correct one saved value, core or lab, by record-edits' one rule: append
   *  the new number on the SAME day with `correctsId`, flip the old row.
   *  `newValue` is in the unit the row is stored in (SI for a core metric). */
  correctValue(id: string, newValue: number, erase?: string): CorrectStatus {
    if (this.refuses(erase)) return 'error';
    const result = correctRecordValue(this.file, { id, newValue, now: new Date().toISOString() });
    if (!result.ok) {
      if (result.reason === 'not-found' || result.reason === 'not-active') return 'changed';
      return result.reason === 'invalid-value' ? { refused: result.message } : 'invalid';
    }
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

  /** `birthRefused`: a birth month it refused (US-54 AC5b), which the caller
   *  replaces in the form with the record's pair. */
  saveChangedMeasurements(current: Partial<HealthInputs>, previous: Partial<HealthInputs>, erase?: string): ProfileSave {
    if (this.refuses(erase)) return { ok: false };
    const refused: ProfileRangeRefusal = {};
    const birthRefused = this.applyProfileChanges(current, previous, erase, refused);
    // diffInputsToMeasurements (health-core) owns the field→metric map + change detection.
    const added: ApiMeasurement[] = [];
    for (const { metricType, value } of diffInputsToMeasurements(current, previous)) {
      const result = this.addMeasurement(metricType, value, undefined, erase);
      if (result.status === 'inserted') added.push(result.row);
    }
    return { ok: true, birthRefused, added, ...(Object.keys(refused).length > 0 ? { refused } : {}) };
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
  bulkSaveMeasurements(measurements: BulkMeasurementInput[], erase?: string): BulkSaveResult {
    if (this.refuses(erase)) return { saved: [], skippedDuplicates: 0, errorCount: measurements.length, refused: [] };
    const result = bulkAppendValues(this.file, measurements.map((m) => ({ kind: 'measurement' as const, ...m })), new Date().toISOString());
    // Nothing saved hands back the same file: no change, no save.
    if (result.saved.length) this.session.edit(() => result.file, erase);
    // A refused number is the caller's to SHOW, like a refused lab unit: no
    // retry can change it, so it is not an error (US-12 AC6, US-35 AC17).
    return { saved: result.saved.map(valueView), skippedDuplicates: result.skippedDuplicates, errorCount: 0, refused: result.measurementRefusals, labRows: writtenLabRows(result) };
  }

  /** One lab value a person adds, by health-core's one lab add (`addLabValue`, the iPhone's too):
   *  null when this copy refuses to write (an erase it has not shown). */
  addLabValue(input: AddLabValueRequest, erase?: string): AddLabValueResult | null {
    if (this.refuses(erase)) return null;
    const result = addRecordLabValue(this.file, input, new Date().toISOString());
    if (result.ok) this.session.edit(() => result.file, erase);
    return result;
  }

  /** The shared upload's one Save, its rows in one edit (upload-save-store.ts). */
  saveUpload(engine: UploadEngine, s: UploadState, now: string, cloudConnected: boolean, io: WebUploadIO, person?: ScreeningPerson): Promise<UploadSaveAnswer> {
    return saveUploadThrough(this.session, { write: (ref, blob) => this.host.store.writeDocument(ref, blob), backend: this.host.store.id }, engine, s, now, cloudConnected, io, person);
  }

  /** Read a stored document's bytes back (viewer). */
  async readDocumentFile(fileRef: string): Promise<Blob> {
    return this.host.store.readDocument(fileRef);
  }

  deleteDocument(documentId: string, erase?: string): boolean {
    const doc = this.file.documents.find((d) => d.id === documentId);
    if (!doc || doc.deleted || this.refuses(erase)) return false;
    // Tombstone, never splice — a hard-removed row resurrects from any other
    // copy via the union merge. The blob (if any) stays put as a harmless
    // orphan in the user's own cloud; they can remove it there if they wish.
    return this.session.edit(() => void (doc.deleted = true), erase);
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
    const p = this.view.profile;
    const out: Partial<HealthInputs> = {};
    for (const field of PREFILL_FIELDS) {
      const v = (p as unknown as Record<string, unknown>)[field];
      if (v != null) (out as Record<string, unknown>)[field] = v;
    }
    // A hand-edited file may hold any value: only the two answers reach the form (US-60).
    if (!isAlcoholAnswer(out.alcohol)) delete out.alcohol;
    if (p.unitSystem !== undefined) out.unitSystem = p.unitSystem;
    return out;
  }

  /** Has the user completed the Shopify-surface email-capture step? */
  getReportEmailCaptured(): boolean {
    return this.view.profile.reportEmailCaptured ?? false;
  }

  /** Mark the email-capture step done (monotonic, stamped + persisted). */
  markReportEmailCaptured(erase?: string): boolean {
    if (this.file.profile.reportEmailCaptured) return true; // idempotent — only ever set true
    return this.session.edit((file) => stampProfile(file, { reportEmailCaptured: true }, new Date().toISOString()), erase);
  }

  /** The unit the user chose for Lp(a)'s field (US-05 AC2), as readers see it. */
  getLpaUnit(): unknown {
    return this.view.profile.lpaUnit;
  }

  /** Remember Lp(a)'s field unit: a profile preference, stamped like the others so it syncs (US-05 AC2). */
  setLpaUnit(unit: LpaUnit, erase?: string): boolean {
    if (this.file.profile.lpaUnit === unit) return true;
    return this.session.edit((file) => stampProfile(file, { lpaUnit: unit }, new Date().toISOString()), erase);
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
    return computeReminderSchedule(this.view, new Date());
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

  /** Leaving this cloud (US-09 AC2g): merge the working copy, saved or still
   *  waiting to save, into this device's copy, which the new connect lifts.
   *  A cloud session saves to the device only when a save fails, so after a
   *  failed connect the page's later saves reach the old cloud alone. */
  async copyToDevice(): Promise<void> {
    if (this.host.tier !== 'cloud') return;
    const ctx = { deviceId: this.host.deviceId(), now: new Date(this.host.clock.now()).toISOString() };
    await saveRecordInto(this.host.mirror.adapter, this.file, ctx);
  }

  /** Re-read the record and merge what came back (US-34); see the session. */
  refreshFromRemote(): Promise<boolean> {
    return this.session.refreshFromRemote();
  }

  /**
   * Start the live re-read (US-34): health-core's LiveRefresh decides when to
   * read; the page tells it when the tab shows or hides. visibilitychange and
   * focus both ask where the tab is now; `online` retries a failed save (US-09 AC30). Returns the stop.
   */
  startLiveRefresh(): () => void {
    const isVisible = () => document.visibilityState !== 'hidden';
    const live = new LiveRefresh(this.session, this.host, { reread: () => this.refreshFromRemote(), isVisible });
    const check = () => (isVisible() ? live.visible() : live.hidden());
    const signals: Array<[EventTarget, string, () => void]> = [[document, 'visibilitychange', check], [window, 'focus', check], [window, 'online', () => live.online()]];
    for (const [target, name, run] of signals) target.addEventListener(name, run);
    live.start();
    return () => {
      live.stop();
      for (const [target, name, run] of signals) target.removeEventListener(name, run);
    };
  }

  /** Clear the off-file health data for this copy's erase, sparing outliving originals (US-11 AC6; see the session).
   *  A failed clear is reported ('Record upkeep failed') and not retried in this session: it never stops the page's reset. */
  clearOffFileData(): void {
    try { this.session.clearOffFileData(); } catch (error) { this.host.report(error, { op: 'clear-off-file', repeat: false }); }
  }

  /** Last-ditch save for tab close and hide (US-10 AC5); see the session. */
  flushSync(): void {
    this.session.flushSync();
  }

  // =================================================================== private

  /** The profile write every web profile save enters (store-value-saves.ts). */
  private applyProfileChanges(current: Partial<HealthInputs>, previous: Partial<HealthInputs>, erase?: string, outOfRange: ProfileRangeRefusal = {}): BirthRefusal | null {
    return applyProfileChanges(this.session, current, previous, erase, outOfRange);
  }
}

