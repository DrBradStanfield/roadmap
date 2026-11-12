import type { HealthInputs } from '@roadmap/health-core/types';
import { type ApiMeasurement, type ApiMedication, type ApiScreening, mergeLongitudinalInputs, PREFILL_FIELDS } from '@roadmap/health-core/mappings';
import { type ChatContextPayload, chatContextOf } from '@roadmap/health-core/chat-context';
import { type LabEgfr, withLabEgfr, labEgfrFrom } from '@roadmap/health-core/plan';
import { type UnitSystem, detectUnitSystem } from '@roadmap/health-core/units';
import { sanitizeInputs } from '@roadmap/health-core/validation';
import { dayOf, localDay } from '@roadmap/health-core/merge';
import { isComparator } from '@roadmap/health-core/lab-limits';
import { isClinicalDay } from '@roadmap/health-core/measurement-history';
import type { ApiReminderPreference } from './api-types';

/** The mirror: HealthTool's copy of the saved record, which the chatbot embed
 *  and the blog bubble read (US-15 AC10). It holds what is saved, never a
 *  value typed into the form and not yet saved. */
export const MIRROR_KEY = 'health_roadmap_data';
/** Fired on this page by every write to the mirror. Another tab's write
 *  arrives as a `storage` event for MIRROR_KEY instead. */
export const MIRROR_CHANGED_EVENT = 'hr:inputs-changed';
const UNIT_PREF_KEY = 'health_roadmap_unit_system';

/** Set once this page must stop writing health data to the device: its own
 *  log-off, or, in a cloud-mode page, another tab's (US-09 AC2c). It lives in
 *  this module, which every device writer imports, so the mirror and the
 *  matrix drafts check the same latch as the record's device copy (US-09 AC2e).
 *  Never reset in the page: log-off navigates away. */
let healthWritesStopped = false;
export function stopLocalHealthWrites(): void {
  healthWritesStopped = true;
}
export function localHealthWritesStopped(): boolean {
  return healthWritesStopped;
}

interface StoredData {
  inputs: Partial<HealthInputs>;
  previousMeasurements?: ApiMeasurement[];
  medications?: ApiMedication[];
  screenings?: ApiScreening[];
  reminderPreferences?: ApiReminderPreference[];
  /** The saved lab eGFR candidate (US-07 AC7): the other chats hold no lab rows. */
  labEgfr?: LabEgfr | null;
  /** The newest usable saved PSA (US-06 AC14): the newest row per metric may be one the plan cannot use. */
  psa?: ApiMeasurement | null;
  savedAt: string;
}

export interface LoadedData {
  inputs: Partial<HealthInputs>;
  previousMeasurements: ApiMeasurement[];
  medications: ApiMedication[];
  screenings: ApiScreening[];
  reminderPreferences: ApiReminderPreference[];
  labEgfr: LabEgfr | null;
  psa: ApiMeasurement | null;
}

/**
 * Write the mirror: the saved profile as `inputs`, the newest saved row per
 * metric, the medications and screenings on record, and the saved lab eGFR
 * (labEgfrOf over the record's lab rows). Tells the page.
 */
export function saveToLocalStorage(inputs: Partial<HealthInputs>, previousMeasurements?: ApiMeasurement[], medications?: ApiMedication[], screenings?: ApiScreening[], reminderPreferences?: ApiReminderPreference[], labEgfr?: LabEgfr | null, psa?: ApiMeasurement | null): void {
  // After log-off the mirror stays gone: a cloud tab's later saves end here
  // (patchMirror too) and would put the health copy back (US-09 AC2e).
  if (healthWritesStopped) return;
  try {
    const data: StoredData = {
      inputs,
      previousMeasurements,
      medications,
      screenings,
      reminderPreferences,
      // A lab eGFR printed as a limit keeps its limit and drops the plan's
      // representative, which an older embed would read as exact (US-12 AC20).
      labEgfr: labEgfr?.labEgfrLimit ? { labEgfrDate: labEgfr.labEgfrDate, labEgfrLimit: labEgfr.labEgfrLimit } : labEgfr,
      psa: psa ?? null,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(MIRROR_KEY, JSON.stringify(data));
    window.dispatchEvent(new Event(MIRROR_CHANGED_EVENT));
  } catch (error) {
    console.warn('Failed to save to localStorage:', error);
  }
}

/**
 * Replace one part of the mirror (the saved profile, the medications or the
 * screenings) and keep the rest, so no saver can write form inputs into it.
 */
export function patchMirror(patch: { profile?: Partial<HealthInputs> } & Partial<Pick<LoadedData, 'medications' | 'screenings' | 'labEgfr'>>): void {
  const cached = loadFromLocalStorage();
  saveToLocalStorage(
    patch.profile ?? cached?.inputs ?? {},
    cached?.previousMeasurements ?? [],
    patch.medications ?? cached?.medications ?? [],
    patch.screenings ?? cached?.screenings ?? [],
    cached?.reminderPreferences ?? [],
    patch.labEgfr !== undefined ? patch.labEgfr : cached?.labEgfr ?? null,
    cached?.psa ?? null,
  );
}

/**
 * Load health inputs and previousMeasurements from localStorage.
 */
export function loadFromLocalStorage(): LoadedData | null {
  try {
    const stored = localStorage.getItem(MIRROR_KEY);
    if (!stored) return null;

    const data: StoredData = JSON.parse(stored);

    // Validate ALL input fields against the Zod schema (single source of truth).
    // localStorage is an untrusted boundary — extensions, corrupted writes, or
    // stale data can inject NaN, Infinity, or out-of-range values that crash
    // the widget. Invalid fields are stripped.
    const sanitizedInputs = sanitizeInputs(data.inputs ?? {});
    // `inputs` is the saved profile. Any other field there is a stale form
    // value an older bundle wrote, which must not outrank a saved value
    // (US-15 AC10), so only the profile and the unit system are kept.
    const inputs: Partial<HealthInputs> = {};
    for (const field of [...PREFILL_FIELDS, 'unitSystem'] as const) {
      if (sanitizedInputs[field] !== undefined) (inputs as Record<string, unknown>)[field] = sanitizedInputs[field];
    }
    const lab = sanitizeInputs({ labEgfr: data.labEgfr?.labEgfr, labEgfrDate: data.labEgfr?.labEgfrDate });
    // A lab eGFR printed as a limit (US-12 AC20): its code and bound, graded again by the plan's rule.
    const sentLimit = data.labEgfr?.labEgfrLimit;
    const limit = sentLimit && isComparator(sentLimit.comparator) && Number.isFinite(sentLimit.bound) ? sentLimit : null;

    return {
      inputs,
      // Coerce measurement values to numbers and filter out non-finite values.
      // Stale localStorage may contain PostgREST NUMERIC strings (e.g. "5.2")
      // or corrupted NaN/Infinity values.
      previousMeasurements: (data.previousMeasurements ?? [])
        .filter(m => m.value != null && (m.value as unknown) !== '' && Number.isFinite(Number(m.value)))
        // A comparator this build cannot read makes the row unreadable, as in the record (US-12 AC20, US-65).
        .filter(m => m.comparator === undefined || isComparator(m.comparator))
        .map(m => ({ ...m, value: Number(m.value) })),
      medications: data.medications ?? [],
      screenings: data.screenings ?? [],
      reminderPreferences: data.reminderPreferences ?? [],
      labEgfr: lab.labEgfrDate === undefined ? null
        : limit ? labEgfrFrom(limit.bound, lab.labEgfrDate, limit.comparator)
        : lab.labEgfr !== undefined ? labEgfrFrom(lab.labEgfr, lab.labEgfrDate) : null,
      // An untrusted copy: a PSA row only with a number (this field was only ever
      // written as one, so null, "" or text is no PSA, never a 0), a real day and
      // a readable comparator.
      psa: data.psa && typeof data.psa.value === 'number' && Number.isFinite(data.psa.value) && isClinicalDay(data.psa.recordedAt)
        && (data.psa.comparator === undefined || isComparator(data.psa.comparator))
        ? { ...data.psa, metricType: 'psa' } : null,
    };
  } catch (error) {
    console.warn('Failed to load from localStorage:', error);
    return null;
  }
}

/**
 * Clear stored health data from localStorage
 */
export function clearLocalStorage(): void {
  try {
    localStorage.removeItem(MIRROR_KEY);
    localStorage.removeItem('health_roadmap_authenticated');
    // An embed on this page mutes after an erase (US-11).
    window.dispatchEvent(new Event(MIRROR_CHANGED_EVENT));
  } catch (error) {
    console.warn('Failed to clear localStorage:', error);
  }
}

// Health data that lives OUTSIDE the roadmap file, one key each. An erase has
// to name them: a prefix wipe of `health_roadmap_*` would take the cloud
// tokens, the remembered backend, the device id and the consent flags with it,
// logging the user out and resetting decisions they already made.
/** Uploaded document blobs (LocalStorageAdapter writes them under this). */
export const DOC_KEY_PREFIX = 'health_roadmap_doc_v2:';
/** The blood-test matrix's typed-but-unsaved values (BloodTestTimeline). */
export const BT_TIMELINE_DRAFT_KEY = 'health_roadmap_bt_timeline_draft';
/** The vitals matrix's typed-but-unsaved values (StartingInfoVitals). */
export const VITALS_DRAFT_KEY = 'health_roadmap_vitals_draft';
/** The Lp(a) rows the user kept as saved when asked (US-05 AC3, lpa-unit.ts). */
export const LPA_CHECK_KEPT_KEY = 'health_roadmap_lpa_check_kept';
/** The erase identity the off-file data below was last cleared for, and nothing
 *  else (RecordHost.clearedErase, US-11 AC6). Log-off removes it. */
export const CLEARED_ERASE_KEY = 'health_roadmap_cleared_erase';

/**
 * Remove the stored document blobs, both matrices' unsaved drafts and the
 * Lp(a) check's kept answers — the on-device health data an erase would
 * otherwise leave behind. `keepDocument` spares the blobs of documents an
 * erase did not remove (US-09 AC20, AC23): by default none is spared.
 * Answers whether every key it removed reads back as gone: safeRemoveItem
 * drops the error of a remove the storage refused.
 */
export function clearOffFileHealthData(keepDocument: (ref: string) => boolean = () => false): boolean {
  const keep = (key: string) => keepDocument(key.slice(DOC_KEY_PREFIX.length));
  clearMatrixDrafts();
  removeByPrefix(DOC_KEY_PREFIX, keep);
  safeRemoveItem(LPA_CHECK_KEPT_KEY);
  return keysUnder(DOC_KEY_PREFIX).every(keep)
    && [BT_TIMELINE_DRAFT_KEY, VITALS_DRAFT_KEY, LPA_CHECK_KEPT_KEY].every((key) => safeGetItem(key) == null);
}

/** Fired by `clearMatrixDrafts`: a matrix on screen drops its own copy of
 *  the draft too (useMatrixDraft), or its next keystroke writes it back. */
export const DRAFTS_CLEARED_EVENT = 'hr:drafts-cleared';

/** Remove both matrices' unsaved drafts: an erase, made here or on another
 *  device, leaves none behind (US-11). */
function clearMatrixDrafts(): void {
  safeRemoveItem(BT_TIMELINE_DRAFT_KEY);
  safeRemoveItem(VITALS_DRAFT_KEY);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DRAFTS_CLEARED_EVENT));
}

/** Remove every stored key under `prefix` (document blobs, named record
 *  files), except those `keep` names. */
export function removeByPrefix(prefix: string, keep: (key: string) => boolean = () => false): void {
  for (const key of keysUnder(prefix)) if (!keep(key)) safeRemoveItem(key);
}

/** The stored keys under `prefix`; none when storage is unavailable. */
function keysUnder(prefix: string): string[] {
  try {
    return Object.keys(localStorage).filter((key) => key.startsWith(prefix));
  } catch {
    return [];
  }
}

/**
 * Save the user's preferred unit system to localStorage.
 */
export function saveUnitPreference(system: UnitSystem): void {
  try {
    localStorage.setItem(UNIT_PREF_KEY, system);
  } catch (error) {
    console.warn('Failed to save unit preference:', error);
  }
}

/**
 * Load the user's preferred unit system from localStorage.
 * Returns null if no preference has been saved.
 */
export function loadUnitPreference(): UnitSystem | null {
  try {
    const stored = localStorage.getItem(UNIT_PREF_KEY);
    if (stored === 'si' || stored === 'conventional') return stored;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generic safe accessors — for modules that manage their own localStorage keys.
// In sandboxed iframes (about:srcdoc), property access throws SecurityError.
// ---------------------------------------------------------------------------

export function safeGetItem(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function safeSetItem(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch {}
}

export function safeRemoveItem(key: string): void {
  try { localStorage.removeItem(key); } catch {}
}

/** Read + JSON-parse a localStorage value; null if absent or corrupt. */
export function getJson<T>(key: string): T | null {
  const raw = safeGetItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** JSON-stringify + write a localStorage value. */
export function setJson(key: string, value: unknown): void {
  safeSetItem(key, JSON.stringify(value));
}


/**
 * The chat context for the bundles outside the widget (blog bubble, chatbot
 * embed), built as the widget builds its own (chatContextOf): the saved
 * profile, the latest saved values and their dates, the medications and
 * screenings on record, the saved lab eGFR when the plan reads it (US-07 AC7),
 * and the unit system the widget shows (US-15 AC10). Null if there is no data.
 */
export function loadGuestInputs(): ChatContextPayload | null {
  const cached = loadFromLocalStorage();
  if (!cached) return null;
  // The newest usable PSA stands in for the newest PSA row, in the snapshot
  // and the history alike, so the chat reads what the widget's cards read (US-06 AC14).
  const rows = cached.psa ? [...cached.previousMeasurements.filter(m => m.metricType !== 'psa'), cached.psa] : cached.previousMeasurements;
  const merged = mergeLongitudinalInputs(cached.inputs, rows);
  if (Object.keys(merged).length === 0) return null;
  const creatinine = rows.find(m => m.metricType === 'creatinine')?.recordedAt;
  const inputs = withLabEgfr(merged, typeof creatinine === 'string' ? dayOf(creatinine) : null, cached.labEgfr, localDay(new Date()));
  return chatContextOf(inputs, chatUnitSystem(cached.inputs.unitSystem), cached.medications, cached.screenings, rows);
}

/** The unit system a chat sends, as HealthTool picks it: the saved
 *  preference, else the record's, else the locale's (US-15 AC10). */
function chatUnitSystem(recorded: UnitSystem | undefined): UnitSystem {
  return loadUnitPreference() ?? recorded ?? detectUnitSystem();
}
