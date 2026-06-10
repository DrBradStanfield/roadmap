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
  computeReminderSchedule,
  createMeasurement,
  dayOf,
  diffInputsToMeasurements,
  encodeSex,
  encodeUnitSystem,
  measurementsToInputs,
  mergeFiles,
  migrateFile,
  PREFILL_FIELDS,
  SCREENING_KEYS,
  type ApiMeasurement,
  type ApiProfile,
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
  type ScreeningInputs,
} from '@roadmap/health-core';
import { getDeviceId } from './device-id';
import { SyncManager } from './sync-manager';
import type { StorageAdapter } from './adapter';
import { Sentry } from '../lib/sentry';

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

// --- small pure helpers ---

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
const NUMERIC_SCREENING_KEYS = new Set(['lung_pack_years', 'prostate_psa_value']);

function newId(): string {
  return crypto.randomUUID();
}
function activeOnly<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.status === 'active');
}

export class RoadmapStore {
  private file: RoadmapFile;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persisting = false;
  private dirtyDuringPersist = false;
  private readonly deviceId: string;

  private constructor(
    private readonly sync: SyncManager,
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
    const sync = new SyncManager(adapter, deviceId);
    const file = await sync.load();
    return new RoadmapStore(sync, adapter, file, deviceId);
  }

  get backendId() {
    return this.sync.backendId;
  }

  // ===================================================================== reads

  loadLatestMeasurements(): LatestMeasurementsResult {
    const measurements = activeOnly(this.file.measurements);
    const apiProfile = this.toApiProfile();
    const allInputs = measurementsToInputs(measurements as ApiMeasurement[], apiProfile);

    const inputs: Partial<HealthInputs> = {};
    for (const field of PREFILL_FIELDS) {
      if (allInputs[field] !== undefined) (inputs as Record<string, unknown>)[field] = allInputs[field];
    }
    if (allInputs.unitSystem !== undefined) inputs.unitSystem = allInputs.unitSystem;

    return {
      inputs,
      previousMeasurements: measurements as ApiMeasurement[],
      medications: this.file.medications as ApiMedication[],
      screenings: this.screeningsToRows(),
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

  loadMeasurementHistory(metricType: string): ApiMeasurement[] {
    return activeOnly(this.file.measurements).filter((m) => m.metricType === metricType) as ApiMeasurement[];
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

  getHealthDocuments(): ApiDocument[] {
    return this.liveDocuments().map(toApiDocument);
  }

  /** Non-tombstoned documents — the ONE place the deleted-filter invariant lives. */
  private liveDocuments(): FileDocument[] {
    return this.file.documents.filter((d) => !d.deleted);
  }

  // ================================================================= mutations

  addMeasurement(metricType: string, value: number, recordedAt?: string): AddMeasurementResult {
    const when = recordedAt ?? new Date().toISOString();
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

  deleteMeasurement(measurementId: string): boolean {
    const row = this.file.measurements.find((m) => m.id === measurementId);
    if (!row) return false;
    row.status = 'entered-in-error'; // append-only: flip, never hard-delete
    this.touch();
    return true;
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
    this.upsertByKey(this.file.medications, 'medicationKey', medicationKey, () => ({
      id: newId(), medicationKey, drugName, doseValue, doseUnit,
    }), (existing) => { existing.drugName = drugName; existing.doseValue = doseValue; existing.doseUnit = doseUnit; });
    this.touch();
    return true;
  }

  saveSupplement(supplementKey: string, supplementName: string, doseValue: number | null = null, doseUnit: string | null = null, status = 'active', startedAt?: string): boolean {
    this.upsertByKey(this.file.supplements, 'supplementKey', supplementKey, () => ({
      id: newId(), supplementKey, supplementName, doseValue, doseUnit,
      status: status as FileSupplement['status'], startedAt: startedAt ?? new Date().toISOString(),
    }), (existing) => {
      existing.supplementName = supplementName; existing.doseValue = doseValue;
      existing.doseUnit = doseUnit; existing.status = status as FileSupplement['status'];
    });
    this.touch();
    return true;
  }

  deleteSupplementApi(supplementKey: string): boolean {
    const s = this.file.supplements.find((x) => x.supplementKey === supplementKey);
    if (s) { s.status = 'stopped'; this.touch(); }
    return true;
  }

  saveScreening(screeningKey: string, value: string): boolean {
    const field = snakeToCamel(screeningKey) as keyof ScreeningInputs;
    const parsed = NUMERIC_SCREENING_KEYS.has(screeningKey) ? parseFloat(value) : value;
    (this.file.screenings as unknown as Record<string, unknown>)[field] = parsed;
    this.touch();
    return true;
  }

  saveReminderPreference(category: string, enabled: boolean): boolean {
    this.upsertByKey(this.file.reminderPreferences, 'category', category,
      () => ({ category, enabled }), (existing) => { existing.enabled = enabled; });
    this.touch();
    return true;
  }

  setGlobalReminderOptout(optout: boolean): boolean {
    // Disable/enable every known preference category.
    for (const p of this.file.reminderPreferences) p.enabled = !optout;
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
    const taken = new Set(activeOnly(this.file.labValues).map((l) => `${l.metricName}@${dayOf(l.recordedAt)}`));
    for (const v of values) {
      const slot = `${v.metricName}@${dayOf(v.recordedAt)}`;
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
          date: doc.date ?? new Date().toISOString().slice(0, 10),
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
    this.file = migrateFile(null, { deviceId: this.deviceId, now: new Date().toISOString() });
    this.file.meta.eraseEpoch = eraseEpoch;
    try {
      await this.flush();
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
    if (this.adapter.writeSync) this.adapter.writeSync(this.file);
    else void this.persist();
  }

  // =================================================================== private

  private toApiProfile(): ApiProfile {
    const p = this.file.profile;
    return {
      sex: p.sex ? encodeSex(p.sex) : null,
      birthYear: p.birthYear ?? null,
      birthMonth: p.birthMonth ?? null,
      unitSystem: p.unitSystem ? encodeUnitSystem(p.unitSystem) : null,
      firstName: null,
      lastName: null,
      height: p.heightCm ?? null,
    };
  }

  private applyProfileChanges(current: Partial<HealthInputs>, previous: Partial<HealthInputs>): void {
    const p = this.file.profile;
    let changed = false;
    if (current.sex !== undefined && current.sex !== previous.sex) { p.sex = current.sex; changed = true; }
    if (current.birthYear !== undefined && current.birthYear !== previous.birthYear) { p.birthYear = current.birthYear; changed = true; }
    if (current.birthMonth !== undefined && current.birthMonth !== previous.birthMonth) { p.birthMonth = current.birthMonth; changed = true; }
    if (current.heightCm !== undefined && current.heightCm !== previous.heightCm) { p.heightCm = current.heightCm; changed = true; }
    if (current.unitSystem !== undefined && current.unitSystem !== previous.unitSystem) { p.unitSystem = current.unitSystem; changed = true; }
    if (changed) { p.updatedAt = new Date().toISOString(); p.lamport = (p.lamport ?? 0) + 1; }
  }

  private screeningsToRows(): ApiScreening[] {
    const s = this.file.screenings;
    const rows: ApiScreening[] = [];
    for (const key of SCREENING_KEYS) {
      const field = snakeToCamel(key) as keyof ScreeningInputs;
      const v = (s as unknown as Record<string, unknown>)[field];
      if (v !== undefined && v !== null && v !== '') {
        rows.push({ id: key, screeningKey: key, value: String(v), updatedAt: s.updatedAt });
      }
    }
    return rows;
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
    try {
      do {
        this.dirtyDuringPersist = false;
        const result = await this.sync.save(this.file);
        // Fold remote changes back in without dropping mutations made during the
        // await; merge is the source of truth for combining the two.
        this.file = mergeFiles(this.file, result.file, {
          deviceId: this.deviceId,
          now: new Date().toISOString(),
        });
      } while (this.dirtyDuringPersist);
      return true;
    } catch (error) {
      // The background cloud save failed — the user's changes are still in
      // memory (a later mutation reschedules), but this MUST be observable:
      // unreported, it's silent data-at-risk. Most persist() call sites are
      // fire-and-forget (`void this.persist()`), so without this catch it
      // became an unhandled rejection that Sentry's noise filters dropped.
      // Returning false (not rethrowing) keeps those sites from re-creating
      // the unhandled rejection; awaited callers (flush) check the result.
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
  };
}
