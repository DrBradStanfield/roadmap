/**
 * The Health Roadmap v2 file schema — the single JSON document that lives in
 * the USER's own cloud (Google Drive / Dropbox / GitHub / self-host).
 *
 * This is the local-first replacement for the Supabase tables. Brad's servers
 * never store this. See `claude_business/docs/health-roadmap-v2-implementation.md`
 * §3 for the schema and §5.3 for the merge/conflict model.
 *
 * Design rules (from the decision record):
 *  - All clinical values in SI canonical units, exactly as today.
 *  - Human-readable internal keys in the file (`sex: 'male'`, `metricType: 'ldl'`),
 *    NOT the DB-encoded integers — a `coding` map (added in Phase 0+) produces
 *    FHIR on demand without bloating the file.
 *  - Append-only arrays (measurements, labValues, *History, documents) are never
 *    mutated or hard-deleted; corrections add a row and flip the prior row to
 *    `entered-in-error`.
 *  - Mutable current-state objects (profile, screenings, medications, supplements,
 *    reminderPreferences) carry a logical-clock `lamport` + `updatedAt` so merge
 *    is last-write-wins by *logical* clock, not wall-clock (avoids device skew).
 */
import type { Suggestion, ScreeningInputs } from './types';
import type { MeasurementSource, MeasurementStatus, DocumentType } from './validation';

/** Bump only when the on-disk shape changes in a way `migrate.ts` must handle. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Sync bookkeeping carried on every mutable record so merge can pick a winner. */
export interface SyncStamp {
  /** ISO 8601 wall-clock of the last write (informational + merge tiebreak). */
  updatedAt: string;
  /**
   * Logical clock at write time (primary merge key — skew-proof). Optional so
   * migrated/legacy rows without it still compare (treated as 0).
   */
  lamport?: number;
}

/** Top-level sync state for the whole file. */
export interface RoadmapFileMeta {
  createdAt: string;      // ISO — earliest creation across devices
  updatedAt: string;      // ISO — last write to the file
  lastDeviceId: string;   // device that produced this revision
  lamport: number;        // file-level logical clock (monotonic per device)
  /**
   * "Delete All My Data" counter. A file with a HIGHER epoch wins a merge
   * WHOLESALE — without it, the merge's never-lose-data union semantics would
   * resurrect deleted records from any other copy. Optional: absent
   * (pre-epoch files) reads as 0.
   */
  eraseEpoch?: number;
}

/** Demographics + preferences (was the `profiles` row + a localStorage override). */
export interface RoadmapProfile extends SyncStamp {
  sex?: 'male' | 'female';
  birthYear?: number;
  birthMonth?: number;
  heightCm?: number;
  unitSystem?: 'si' | 'conventional';
  /** Per-metric display-unit overrides (was localStorage-only `health_roadmap_unit_overrides`). */
  unitOverrides?: Record<string, 'si' | 'conventional'>;
}

/** One immutable measurement row (mirrors a `health_measurements` row, camelCase). */
export interface FileMeasurement {
  id: string;
  metricType: string;       // MetricTypeValue
  value: number;            // SI canonical unit
  recordedAt: string;       // ISO 8601 — the slot key (by day) with metricType
  createdAt: string;        // ISO 8601 — within-slot recency tiebreak
  source: MeasurementSource;
  status: MeasurementStatus; // 'active' | 'entered-in-error'
  correctsId: string | null; // id of the row this one corrects
  externalId: string | null; // e.g. HealthKit sample UUID (dedup)
}

/** A non-core lab value (beyond the 14 canonical metrics), append-only. */
export interface FileLabValue {
  id: string;
  metricName: string;       // free-form, e.g. 'ferritin'
  value: number;
  unit: string;             // original lab unit (no SI conversion)
  referenceLow: number | null;
  referenceHigh: number | null;
  recordedAt: string;       // ISO 8601 — slot key (by day) with metricName
  createdAt: string;
  source: MeasurementSource;
  status: MeasurementStatus;
  correctsId: string | null;
}

/** Current state of one medication slot (keyed by medicationKey). FHIR-compatible. */
export interface FileMedication extends SyncStamp {
  id: string;
  medicationKey: string;    // MEDICATION_KEYS, e.g. 'statin'
  drugName: string;         // e.g. 'atorvastatin', 'yes', 'not_yet'
  doseValue: number | null;
  doseUnit: string | null;
}

/** Current state of one supplement (keyed by supplementKey). */
export interface FileSupplement extends SyncStamp {
  id: string;
  supplementKey: string;
  supplementName: string;
  doseValue: number | null;
  doseUnit: string | null;
  status: 'active' | 'stopped';
  startedAt: string;
}

/** Flat screening workflow object (the `screenings` table flattened) + sync stamp. */
export type FileScreenings = ScreeningInputs & SyncStamp;

/** One reminder-category preference (keyed by category). */
export interface FileReminderPreference extends SyncStamp {
  category: string;         // ReminderCategory
  enabled: boolean;
}

/**
 * The user's email-reminder opt-in (§10 of the decision record).
 * The capability token lives HERE — in the user's own cloud file — so it
 * follows them across devices; the server also stores it to power the unsubscribe link. Cancellation
 * flips `status` rather than deleting the object, so last-write-wins merge
 * propagates the cancel to every device (an absent field can't win a merge).
 */
export interface FileReminderOptIn extends SyncStamp {
  status: 'active' | 'cancelled';
  /** Opaque server-issued capability token — manages ONLY the reminder schedule. */
  token: string;
  /** Provider-verified destination address (display + change-detection only). */
  email: string;
  provider: 'google-drive' | 'dropbox' | 'github';
}

/** Metadata for an uploaded document; the bytes live next to the JSON in `documents/`. */
export interface FileDocument {
  id: string;
  title: string;
  type: DocumentType;
  date: string | null;      // YYYY-MM-DD
  fileRef: string;          // path relative to the folder, e.g. 'documents/doc_1.pdf' ('' if text-only)
  contentHash: string;      // 'sha256-...' — names the blob + detects corruption ('' if text-only)
  mimeType: string;         // '' if text-only
  extractedText: string;    // kept so history/chatbot search survives without Supabase
  addedAt: string;          // ISO
  metadata?: Record<string, unknown>; // LLM extraction metadata (was DB `metadata`)
  sourceFileName?: string | null;     // original upload filename (was DB `source_file_name`)
  /**
   * Tombstone — a hard-removed row would RESURRECT from any other copy via the
   * union merge, so deletion flips this instead (kept forever; reads filter it;
   * merge ORs it so a delete seen by one device is never undone by another).
   */
  deleted?: boolean;
}

/** A point-in-time snapshot of "what was I advised" (decision record §9). */
export interface RecommendationSnapshot {
  date: string;             // YYYY-MM-DD
  suggestions: Suggestion[];
}

/** The complete user record — one per `Health Roadmap` folder. */
export interface RoadmapFile {
  schemaVersion: number;
  meta: RoadmapFileMeta;
  profile: RoadmapProfile;
  measurements: FileMeasurement[];          // append-only
  medications: FileMedication[];            // current state, keyed by medicationKey
  medicationHistory: FileMedication[];      // append-only log
  supplements: FileSupplement[];            // current state, keyed by supplementKey
  supplementHistory: FileSupplement[];      // append-only log
  screenings: FileScreenings;               // current state (singleton)
  labValues: FileLabValue[];                // append-only
  documents: FileDocument[];                // metadata; bytes in documents/
  reminderPreferences: FileReminderPreference[]; // current state, keyed by category
  recommendationSnapshots: RecommendationSnapshot[];
  /** Email-reminder opt-in (optional — absent until the user opts in). */
  reminderOptIn?: FileReminderOptIn;
}

/** Create a brand-new, empty record for a first-time user. */
export function createEmptyFile(opts: { deviceId: string; now: string }): RoadmapFile {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: {
      createdAt: opts.now,
      updatedAt: opts.now,
      lastDeviceId: opts.deviceId,
      lamport: 0,
    },
    profile: { updatedAt: opts.now, lamport: 0 },
    measurements: [],
    medications: [],
    medicationHistory: [],
    supplements: [],
    supplementHistory: [],
    screenings: { updatedAt: opts.now, lamport: 0 },
    labValues: [],
    documents: [],
    reminderPreferences: [],
    recommendationSnapshots: [],
  };
}

/**
 * Build a FileMeasurement row with the standard defaults (manual/active/no
 * correction). Callers supply the identifying fields; the audit defaults are
 * filled in. Used by the app's save path and the dev/test harnesses so the
 * row shape lives in one place.
 */
export function createMeasurement(
  fields: Pick<FileMeasurement, 'id' | 'metricType' | 'value' | 'recordedAt' | 'createdAt'> &
    Partial<Pick<FileMeasurement, 'source' | 'status' | 'correctsId' | 'externalId'>>,
): FileMeasurement {
  return {
    source: 'manual',
    status: 'active',
    correctsId: null,
    externalId: null,
    ...fields,
  };
}

/**
 * Deterministic JSON stringify (object keys sorted recursively). Used as the
 * final, content-based tiebreak in merge so two devices converge identically.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
