import type { HealthInputs, ApiMeasurement, ApiMedication, ApiScreening } from '@roadmap/health-core';
import type { UnitSystem } from '@roadmap/health-core';
import { healthInputSchema } from '@roadmap/health-core';
import type { ApiReminderPreference } from './api';

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
 * Set the authenticated flag so the auto-redirect knows to re-establish
 * the storefront session on direct navigation. Only called when the API
 * confirms the user has cloud data — never from Liquid templates.
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
