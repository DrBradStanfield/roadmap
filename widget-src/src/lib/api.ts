import type { HealthInputs } from '@roadmap/health-core';
import {
  measurementsToInputs,
  diffInputsToMeasurements,
  type ApiMeasurement,
} from '@roadmap/health-core';

interface MeasurementsResponse {
  success: boolean;
  data?: ApiMeasurement[];
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

/**
 * Load latest measurements (one per metric) from cloud storage.
 */
export async function loadLatestMeasurements(): Promise<Partial<HealthInputs> | null> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`);
    if (!response.ok) return null;

    const result: MeasurementsResponse = await response.json();
    if (!result.success || !result.data) return null;

    return measurementsToInputs(result.data);
  } catch (error) {
    console.warn('Error loading measurements:', error);
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
    return false;
  }
}

/**
 * Save only changed fields as individual measurements.
 */
export async function saveChangedMeasurements(
  current: Partial<HealthInputs>,
  previous: Partial<HealthInputs>,
): Promise<boolean> {
  const changes = diffInputsToMeasurements(current, previous);
  if (changes.length === 0) return true;

  const results = await Promise.all(
    changes.map((c) => addMeasurement(c.metricType, c.value)),
  );
  return results.every((r) => r !== null);
}
