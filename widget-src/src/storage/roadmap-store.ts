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
  createMeasurement,
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
  type FileSupplement,
  type HealthInputs,
  type MeasurementSource,
  type RoadmapFile,
  type ScreeningInputs,
} from '@roadmap/health-core';
import { getDeviceId } from './device-id';
import { SyncManager } from './sync-manager';
import type { StorageAdapter } from './adapter';

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

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}
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

  private constructor(private readonly sync: SyncManager, file: RoadmapFile, deviceId: string) {
    this.file = file;
    this.deviceId = deviceId;
  }

  /** Load the user's record from the given backend and return a ready store. */
  static async create(adapter: StorageAdapter): Promise<RoadmapStore> {
    const deviceId = getDeviceId();
    const sync = new SyncManager(adapter, deviceId);
    const file = await sync.load();
    return new RoadmapStore(sync, file, deviceId);
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
      documents: this.file.documents.map(toApiDocument),
    };
  }

  loadAllHistory(): ApiMeasurement[] {
    return activeOnly(this.file.measurements) as ApiMeasurement[];
  }

  loadMeasurementHistory(metricType: string): ApiMeasurement[] {
    return activeOnly(this.file.measurements).filter((m) => m.metricType === metricType) as ApiMeasurement[];
  }

  loadMedicationHistory(): ApiMedicationHistory[] {
    // Lightweight annotations from the append-only snapshots (see header note).
    return this.file.medicationHistory.map((m) => ({
      id: m.id,
      medicationKey: m.medicationKey,
      drugName: m.drugName,
      doseValue: m.doseValue,
      doseUnit: m.doseUnit,
      status: 'active',
      effectiveStart: m.updatedAt,
      effectiveEnd: null,
      changeType: 'changed',
      source: 'manual',
    }));
  }

  loadLabValues(): ApiLabValue[] {
    return activeOnly(this.file.labValues) as ApiLabValue[];
  }

  getHealthDocuments(): ApiDocument[] {
    return this.file.documents.map(toApiDocument);
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
    const fieldToMetric: Array<[keyof HealthInputs, string]> = [
      ['weightKg', 'weight'], ['waistCm', 'waist'], ['hba1c', 'hba1c'], ['ldlC', 'ldl'],
      ['totalCholesterol', 'total_cholesterol'], ['hdlC', 'hdl'], ['triglycerides', 'triglycerides'],
      ['systolicBp', 'systolic_bp'], ['diastolicBp', 'diastolic_bp'], ['apoB', 'apob'],
      ['creatinine', 'creatinine'], ['psa', 'psa'], ['lpa', 'lpa'],
    ];
    for (const [field, metric] of fieldToMetric) {
      const cur = current[field];
      if (cur !== undefined && cur !== previous[field]) {
        this.addMeasurement(metric, cur as number);
      }
    }
    return true;
  }

  saveMedication(medicationKey: string, drugName: string, doseValue: number | null = null, doseUnit: string | null = null): boolean {
    this.upsertByKey(this.file.medications, 'medicationKey', medicationKey, () => ({
      id: newId(), medicationKey, drugName, doseValue, doseUnit,
    }), (existing) => { existing.drugName = drugName; existing.doseValue = doseValue; existing.doseUnit = doseUnit; });
    // append a snapshot for chart annotations
    this.file.medicationHistory.push({
      id: newId(), medicationKey, drugName, doseValue, doseUnit, updatedAt: new Date().toISOString(),
    });
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
    for (const m of measurements) {
      const exists = activeOnly(this.file.measurements).some(
        (x) => x.metricType === m.metricType && dayOf(x.recordedAt) === dayOf(m.recordedAt),
      );
      if (exists) { skippedDuplicates++; continue; }
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
    for (const v of values) {
      const exists = activeOnly(this.file.labValues).some(
        (x) => x.metricName === v.metricName && dayOf(x.recordedAt) === dayOf(v.recordedAt),
      );
      if (exists) { skippedDuplicates++; continue; }
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

  bulkSaveDocuments(documents: Array<{ documentType: string; title: string; documentDate: string | null; contentMd: string; metadata: Record<string, unknown>; sourceFileName: string | null }>): ApiDocument[] {
    const out: FileDocument[] = documents.map((d) => ({
      id: newId(), title: d.title, type: d.documentType as DocumentType, date: d.documentDate,
      fileRef: '', contentHash: '', mimeType: '', extractedText: d.contentMd,
      addedAt: new Date().toISOString(), metadata: d.metadata, sourceFileName: d.sourceFileName,
    }));
    this.file.documents.push(...out);
    this.touch();
    return out.map(toApiDocument);
  }

  deleteDocument(documentId: string): boolean {
    const i = this.file.documents.findIndex((d) => d.id === documentId);
    if (i === -1) return false;
    this.file.documents.splice(i, 1);
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

  async deleteUserData(): Promise<{ success: boolean; error?: string }> {
    this.file = migrateFile(null, { deviceId: this.deviceId, now: new Date().toISOString() });
    try {
      await this.flush();
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /** Force-persist any pending changes (call on beforeunload / before navigation). */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
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
  private async persist(): Promise<void> {
    if (this.persisting) {
      this.dirtyDuringPersist = true;
      return;
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
    } finally {
      this.persisting = false;
    }
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
  };
}
