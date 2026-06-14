import type { HealthInputs, ApiMeasurement, ApiMedication, ApiScreening } from '@roadmap/health-core';
import type { UnitSystem } from '@roadmap/health-core';
import { healthInputSchema } from '@roadmap/health-core';
import type { ApiReminderPreference } from './api-types';

/**
 * Sanitize inputs against the Zod schema (single source of truth).
 * Validates each field individually — invalid fields are stripped,
 * unknown fields (e.g. unitSystem) pass through unchanged.
 */
function sanitizeInputs(inputs: Partial<HealthInputs>): Partial<HealthInputs> {
  const shape = healthInputSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (!(key in shape) || shape[key].safeParse(value).success) {
      result[key] = value;
    }
  }
  return result as Partial<HealthInputs>;
}

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
        .filter(m => m.value != null && m.value !== '' && Number.isFinite(Number(m.value)))
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

/**
 * Set the authenticated flag. Only called when the data layer confirms the
 * user has saved data — never from Liquid templates. Sole remaining reader:
 * the legacy rollback bundle (health-tool.js), where it drives the
 * redirect-failed UI + guest stale-cache clear in HealthTool. On the v2
 * surfaces this flag is write-only — `data-logged-in="true"` is hardcoded,
 * so every reading branch is short-circuited (LOCAL_FIRST early-return) or
 * unreachable (the !isLoggedIn branches never run). The old
 * history-block.liquid reader was removed when /pages/health-history was
 * deleted (2026-06-14).
 */
export function setAuthenticatedFlag(): void {
  try { localStorage.setItem('health_roadmap_authenticated', '1'); } catch {}
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

/** Check if auth redirect was attempted (sessionStorage). */
export function getAuthRedirectFlag(): boolean {
  try { return !!sessionStorage.getItem('health_roadmap_auth_redirect'); } catch { return false; }
}

/** Read and clear the email confirmation flag (sessionStorage). Returns flag value or null. */
export function consumeEmailConfirmFlag(): string | null {
  try {
    const flag = sessionStorage.getItem('health_roadmap_email_confirm');
    if (flag) sessionStorage.removeItem('health_roadmap_email_confirm');
    return flag;
  } catch { return null; }
}

/** Check if the authenticated flag exists (localStorage). */
export function hasAuthenticatedFlag(): boolean {
  try { return !!localStorage.getItem('health_roadmap_authenticated'); } catch { return false; }
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
