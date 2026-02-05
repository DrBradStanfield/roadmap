import type { HealthInputs } from '@roadmap/health-core';
import {
  measurementsToInputs,
  diffInputsToMeasurements,
  diffProfileFields,
  PREFILL_FIELDS,
  type ApiMeasurement,
  type ApiProfile,
  type ApiMedication,
  type ApiScreening,
} from '@roadmap/health-core';
import { Sentry } from './sentry';

interface MeasurementsResponse {
  success: boolean;
  data?: ApiMeasurement[];
  profile?: ApiProfile | null;
  medications?: ApiMedication[];
  screenings?: ApiScreening[];
  error?: string;
}

interface SingleMeasurementResponse {
  success: boolean;
  data?: ApiMeasurement;
  error?: string;
}

// App proxy path — requests go through Shopify to the backend
// Shopify adds logged_in_customer_id + HMAC signature automatically
const PROXY_PATH = '/apps/health-tool-1';

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
}

/**
 * Load latest measurements (one per metric) + profile demographics from cloud storage.
 * Returns pre-fill inputs (demographics + height only) and raw measurements separately.
 */
export async function loadLatestMeasurements(): Promise<LatestMeasurementsResult | null> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`);
    if (!response.ok) return null;

    const result: MeasurementsResponse = await response.json();
    if (!result.success || !result.data) return null;

    // Build full inputs from measurements + profile
    const allInputs = measurementsToInputs(result.data, result.profile);

    // Extract only pre-fill fields (demographics + height)
    const inputs: Partial<HealthInputs> = {};
    for (const field of PREFILL_FIELDS) {
      if (allInputs[field] !== undefined) {
        (inputs as any)[field] = allInputs[field];
      }
    }

    return { inputs, previousMeasurements: result.data, medications: result.medications ?? [], screenings: result.screenings ?? [] };
  } catch (error) {
    console.warn('Error loading measurements:', error);
    Sentry.captureException(error);
    return null;
  }
}

/**
 * Load measurement history for a specific metric type.
 */
export async function loadMeasurementHistory(
  metricType: string,
  limit = 50,
): Promise<ApiMeasurement[]> {
  try {
    const response = await fetch(
      `${PROXY_PATH}/api/measurements?metric_type=${metricType}&limit=${limit}`,
    );
    if (!response.ok) return [];

    const result: MeasurementsResponse = await response.json();
    return result.success ? result.data || [] : [];
  } catch (error) {
    console.warn('Error loading history:', error);
    Sentry.captureException(error);
    return [];
  }
}

/**
 * Add a single measurement. Value must be in SI canonical units.
 */
export async function addMeasurement(
  metricType: string,
  value: number,
  recordedAt?: string,
): Promise<ApiMeasurement | null> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metricType, value, recordedAt }),
    });
    if (!response.ok) return null;

    const result: SingleMeasurementResponse = await response.json();
    return result.success ? result.data || null : null;
  } catch (error) {
    console.warn('Error adding measurement:', error);
    Sentry.captureException(error);
    return null;
  }
}

/**
 * Delete a measurement by ID.
 */
export async function deleteMeasurement(measurementId: string): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ measurementId }),
    });
    if (!response.ok) return false;

    const result: { success: boolean } = await response.json();
    return result.success;
  } catch (error) {
    console.warn('Error deleting measurement:', error);
    Sentry.captureException(error);
    return false;
  }
}

/**
 * Save profile field updates (sex, birthYear, birthMonth, unitSystem).
 */
async function saveProfileChanges(profile: {
  sex?: number;
  birthYear?: number;
  birthMonth?: number;
  unitSystem?: number;
}): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    if (!response.ok) return false;

    const result: { success: boolean } = await response.json();
    return result.success;
  } catch (error) {
    console.warn('Error saving profile:', error);
    Sentry.captureException(error);
    return false;
  }
}

/**
 * Load all measurement history across all metrics (for the History page).
 */
export async function loadAllHistory(
  limit = 100,
  offset = 0,
): Promise<ApiMeasurement[]> {
  try {
    const response = await fetch(
      `${PROXY_PATH}/api/measurements?all_history=true&limit=${limit}&offset=${offset}`,
    );
    if (!response.ok) return [];

    const result: MeasurementsResponse = await response.json();
    return result.success ? result.data || [] : [];
  } catch (error) {
    console.warn('Error loading all history:', error);
    Sentry.captureException(error);
    return [];
  }
}

/**
 * Delete all user data (measurements, profile, auth user).
 */
export async function deleteUserData(): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/user-data`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmDelete: true }),
    });
    if (!response.ok) return false;

    const result: { success: boolean } = await response.json();
    return result.success;
  } catch (error) {
    console.warn('Error deleting user data:', error);
    Sentry.captureException(error);
    return false;
  }
}

/**
 * Save a medication status (upsert).
 */
export async function saveMedication(
  medicationKey: string,
  value: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ medication: { medicationKey, value } }),
    });
    if (!response.ok) return false;

    const result: { success: boolean } = await response.json();
    return result.success;
  } catch (error) {
    console.warn('Error saving medication:', error);
    Sentry.captureException(error);
    return false;
  }
}

/**
 * Save a screening status (upsert).
 */
export async function saveScreening(
  screeningKey: string,
  value: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screening: { screeningKey, value } }),
    });
    if (!response.ok) return false;

    const result: { success: boolean } = await response.json();
    return result.success;
  } catch (error) {
    console.warn('Error saving screening:', error);
    Sentry.captureException(error);
    return false;
  }
}

/**
 * Save changed fields — profile fields go to profiles table, measurements stay immutable.
 */
export async function saveChangedMeasurements(
  current: Partial<HealthInputs>,
  previous: Partial<HealthInputs>,
): Promise<boolean> {
  // Save profile changes (if any)
  const profileChanges = diffProfileFields(current, previous);
  if (profileChanges) {
    const profileSaved = await saveProfileChanges(profileChanges);
    if (!profileSaved) return false;
  }

  // Save measurement changes (if any)
  const measurementChanges = diffInputsToMeasurements(current, previous);
  if (measurementChanges.length === 0) return true;

  const results = await Promise.all(
    measurementChanges.map((c) => addMeasurement(c.metricType, c.value)),
  );
  return results.every((r) => r !== null);
}
