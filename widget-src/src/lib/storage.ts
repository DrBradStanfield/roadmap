import type { HealthInputs, ApiMeasurement, ApiMedication, ApiScreening } from '@roadmap/health-core';
import type { UnitSystem } from '@roadmap/health-core';
import { sanitizeInputs } from '@roadmap/health-core';
import type { ApiReminderPreference } from './api-types';

const STORAGE_KEY = 'health_roadmap_data';
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
 * Save health inputs (and optionally previousMeasurements) to localStorage.
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    console.warn('Failed to save to localStorage:', error);
  }
}

/**
 * Load health inputs and previousMeasurements from localStorage.
 */
export function loadFromLocalStorage(): LoadedData | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;

    const data: StoredData = JSON.parse(stored);

    // Validate ALL input fields against the Zod schema (single source of truth).
    // localStorage is an untrusted boundary — extensions, corrupted writes, or
    // stale data can inject NaN, Infinity, or out-of-range values that crash
    // the widget. Invalid fields are stripped; unknown fields pass through.
    const sanitizedInputs = sanitizeInputs(data.inputs);

    return {
      inputs: sanitizedInputs,
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
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('health_roadmap_authenticated');
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

/**
 * Remove every stored document blob and the unsaved lab-value draft — the
 * on-device health data an erase would otherwise leave behind.
 */
export function clearOffFileHealthData(): void {
  safeRemoveItem(BT_TIMELINE_DRAFT_KEY);
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(DOC_KEY_PREFIX)) safeRemoveItem(key);
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


/** Assemble guest health inputs from localStorage for chat context. Returns null if no data. */
export function loadGuestInputs(): Record<string, unknown> | null {
  const cached = loadFromLocalStorage();
  if (!cached || Object.keys(cached.inputs).length === 0) return null;
  return {
    ...cached.inputs,
    medications: cached.medications ?? [],
    screenings: cached.screenings ?? [],
  };
}
