/**
 * Shared data-shape types for the widget's data layer.
 *
 * These are the load-bearing `Api*` (and supporting) TYPE exports consumed by
 * 10+ v2 components AND by the local-first data layer (`roadmap-data.ts`,
 * `roadmap-store.ts`). They live here — decoupled from any fetch
 * implementation — so the runtime data module (`api.ts`) can be trimmed without
 * disturbing the type graph. `api.ts` re-exports everything here for back-compat
 * import paths; new code may import directly from `./api-types`.
 */
import type { HealthInputs, DocumentType, ApiMeasurement, ApiMedication, ApiScreening } from '@roadmap/health-core';

export interface ApiReminderPreference {
  reminderCategory: string;
  enabled: boolean;
}

/** Snapshot of the user's saved data needed by the upload review modal
 *  for dedup badges + matrix context columns. One object, not three
 *  separate props, so call sites don't grow with each new history
 *  dimension. */
export interface UploadHistory {
  bloodTests: ApiMeasurement[];
  labValues: ApiLabValue[];
  documents: ApiDocument[];
}

/** Result from loading latest measurements: pre-fill inputs + raw measurements for "Previous:" labels. */
export interface LatestMeasurementsResult {
  /** Only demographic/height fields for pre-filling the form. */
  inputs: Partial<HealthInputs>;
  /** Raw latest measurements with dates, for "Previous:" labels and results fallback. */
  previousMeasurements: ApiMeasurement[];
  /** Medication statuses from the medications table. */
  medications: ApiMedication[];
  /** Cancer screening statuses from the screenings table. */
  screenings: ApiScreening[];
  /** Supplement records (logged-in users only). */
  supplements: ApiSupplement[];
  /** Reminder notification preferences. */
  reminderPreferences: ApiReminderPreference[];
  /** Active health documents — for the home panel + upload-review dup index. */
  documents: ApiDocument[];
}

export type AddMeasurementResult =
  | { status: 'inserted'; row: ApiMeasurement }
  | { status: 'duplicate' }
  | { status: 'error' };

/** Medication history record (from medication_history table). */
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

/** API supplement record. */
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

export interface PageContent {
  type: 'text' | 'image';
  content: string;
  mimeType?: string;
}

export interface ExtractedValue {
  metric: string;
  valueSI: number;
  displayValue: number;
  displayUnit: string;
  /** Which unit system displayUnit/displayValue belong to. Optional for
   *  back-compat with API responses predating the May 2026 redesign. */
  displaySystem?: import('@roadmap/health-core').UnitSystem;
  confidence: 'high' | 'medium' | 'low';
  question?: string;
}

/** Document data returned by the LLM for non-lab documents.
 *  Classification is validated server-side against DOCUMENT_TYPES. */
export interface DocumentResult {
  classification: DocumentType;
  title: string;
  documentDate: string | null;
  contentMarkdown: string;
  metadata: Record<string, unknown>;
}

/** A lab value outside the 11 core metrics — stored as-is (no unit conversion). */
export interface AdditionalLabValue {
  name: string;
  value: number;
  unit: string;
  referenceLow?: number | null;
  referenceHigh?: number | null;
}

export interface LabImportResult {
  classification: string;
  reportDate: string | null;
  values: ExtractedValue[];
  additionalValues: AdditionalLabValue[];
  document: DocumentResult | null;
}

/** Saved lab value from the API */
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

/** Saved document from the API */
export interface ApiDocument {
  id: string;
  documentType: string;
  title: string;
  documentDate: string | null;
  contentMd: string;
  metadata: Record<string, unknown>;
  sourceFileName: string | null;
  createdAt: string;
  /** Path of the archived original in the user's own cloud (v2 local-first only). */
  fileRef?: string | null;
  /** 'sha256-<hex>' of the original's bytes — ONE dedup key with the connector (US-35 AC6). */
  contentHash?: string | null;
}

export type UploadErrorCode = 'rate_limit' | 'timeout' | 'server_restart' | 'no_files' | 'server_error' | 'network';

export interface BatchPollResponse {
  status: 'processing' | 'ended';
  completed: number;
  total: number;
  results?: Array<LabImportResult & { fileName: string }>;
  error?: string;
  errorCode?: UploadErrorCode;
}

export interface BulkSaveResult {
  saved: ApiMeasurement[];
  /** How many submitted rows were already present (active) at (user, metric, recorded_at). */
  skippedDuplicates: number;
  /** How many submitted rows hit a server error (rare; surface in UI). */
  errorCount: number;
}

export type CorrectMeasurementResult =
  | { status: 'ok'; newId: string }
  | { status: 'conflict' }
  | { status: 'not_found' }
  | { status: 'error' };

export interface BulkLabValuesResult {
  saved: ApiLabValue[];
  /** How many rows were already present (active) at this (user, metric_name, recorded_at). */
  skippedDuplicates: number;
  /** How many rows hit a server error. */
  errorCount: number;
}
