import type { HealthInputs, ApiMeasurement, ApiMedication, ApiScreening, ChatContextPayload } from '@roadmap/health-core';
import type { UnitSystem } from '@roadmap/health-core';
import { sanitizeInputs, mergeLongitudinalInputs, chatContextOf, detectUnitSystem, PREFILL_FIELDS } from '@roadmap/health-core';
import type { ApiReminderPreference } from './api-types';

/** The mirror: HealthTool's copy of the saved record, which the chatbot embed
 *  and the blog bubble read (US-15 AC10). It holds what is saved, never a
 *  value typed into the form and not yet saved. */
export const MIRROR_KEY = 'health_roadmap_data';
/** Fired on this page by every write to the mirror. Another tab's write
 *  arrives as a `storage` event for MIRROR_KEY instead. */
export const MIRROR_CHANGED_EVENT = 'hr:inputs-changed';
const UNIT_PREF_KEY = 'health_roadmap_unit_system';

interface StoredData {
  inputs: Partial<HealthInputs>;
  previousMeasurements?: ApiMeasurement[];
  medications?: ApiMedication[];
  screenings?: ApiScreening[];
  reminderPreferences?: ApiReminderPreference[];
  savedAt: string;
}

export interface LoadedData {
  inputs: Partial<HealthInputs>;
  previousMeasurements: ApiMeasurement[];
  medications: ApiMedication[];
  screenings: ApiScreening[];
  reminderPreferences: ApiReminderPreference[];
}

/**
 * Write the mirror: the saved profile as `inputs`, the newest saved row per
 * metric, and the medications and screenings on record. Tells the page.
 */
export function saveToLocalStorage(inputs: Partial<HealthInputs>, previousMeasurements?: ApiMeasurement[], medications?: ApiMedication[], screenings?: ApiScreening[], reminderPreferences?: ApiReminderPreference[]): void {
  try {
    const data: StoredData = {
      inputs,
      previousMeasurements,
      medications,
      screenings,
      reminderPreferences,
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
export function patchMirror(patch: { profile?: Partial<HealthInputs> } & Partial<Pick<LoadedData, 'medications' | 'screenings'>>): void {
  const cached = loadFromLocalStorage();
  saveToLocalStorage(
    patch.profile ?? cached?.inputs ?? {},
    cached?.previousMeasurements ?? [],
    patch.medications ?? cached?.medications ?? [],
    patch.screenings ?? cached?.screenings ?? [],
    cached?.reminderPreferences ?? [],
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

    return {
      inputs,
      // Coerce measurement values to numbers and filter out non-finite values.
      // Stale localStorage may contain PostgREST NUMERIC strings (e.g. "5.2")
      // or corrupted NaN/Infinity values.
      previousMeasurements: (data.previousMeasurements ?? [])
        .filter(m => m.value != null && (m.value as unknown) !== '' && Number.isFinite(Number(m.value)))
        .map(m => ({ ...m, value: Number(m.value) })),
      medications: data.medications ?? [],
      screenings: data.screenings ?? [],
      reminderPreferences: data.reminderPreferences ?? [],
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

/**
 * Remove every stored document blob and both matrices' unsaved drafts — the
 * on-device health data an erase would otherwise leave behind.
 */
export function clearOffFileHealthData(): void {
  clearMatrixDrafts();
  removeByPrefix(DOC_KEY_PREFIX);
}

/** Fired by `clearMatrixDrafts`: a matrix on screen drops its own copy of
 *  the draft too (useMatrixDraft), or its next keystroke writes it back. */
export const DRAFTS_CLEARED_EVENT = 'hr:drafts-cleared';

/** Remove both matrices' unsaved drafts: an erase, made here or on another
 *  device, leaves none behind (US-11). */
export function clearMatrixDrafts(): void {
  safeRemoveItem(BT_TIMELINE_DRAFT_KEY);
  safeRemoveItem(VITALS_DRAFT_KEY);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DRAFTS_CLEARED_EVENT));
}

/** Remove every stored key under `prefix` (document blobs, named record files). */
export function removeByPrefix(prefix: string): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) safeRemoveItem(key);
    }
  } catch {
    /* storage unavailable — nothing to clear */
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
 * screenings on record, and the unit system the widget shows (US-15 AC10).
 * Null if there is no data.
 */
export function loadGuestInputs(): ChatContextPayload | null {
  const cached = loadFromLocalStorage();
  if (!cached) return null;
  const inputs = mergeLongitudinalInputs(cached.inputs, cached.previousMeasurements);
  if (Object.keys(inputs).length === 0) return null;
  return chatContextOf(inputs, chatUnitSystem(cached.inputs.unitSystem), cached.medications, cached.screenings, cached.previousMeasurements);
}

/** The unit system a chat sends, as HealthTool picks it: the saved
 *  preference, else the record's, else the locale's (US-15 AC10). */
function chatUnitSystem(recorded: UnitSystem | undefined): UnitSystem {
  return loadUnitPreference() ?? recorded ?? detectUnitSystem();
}
