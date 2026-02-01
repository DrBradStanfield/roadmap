import type { HealthInputs } from '../../../../packages/health-core/src';
import {
  measurementsToInputs,
  diffInputsToMeasurements,
  type ApiMeasurement,
} from '../../../../packages/health-core/src';

const APP_URL = 'https://health-tool-app.fly.dev';

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

/**
 * Load latest measurements (one per metric) from cloud storage.
 */
export async function loadLatestMeasurements(
  token: string,
): Promise<Partial<HealthInputs> | null> {
  const response = await fetch(`${APP_URL}/api/customer-measurements`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) return null;

  const result: MeasurementsResponse = await response.json();
  if (!result.success || !result.data) return null;

  return measurementsToInputs(result.data);
}

/**
 * Load measurement history for a specific metric type.
 */
export async function loadMeasurementHistory(
  token: string,
  metricType: string,
  limit = 50,
): Promise<ApiMeasurement[]> {
  const response = await fetch(
    `${APP_URL}/api/customer-measurements?metric_type=${metricType}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) return [];

  const result: MeasurementsResponse = await response.json();
  return result.success ? result.data || [] : [];
}

/**
 * Add a single measurement. Value must be in SI canonical units.
 */
export async function addMeasurement(
  token: string,
  metricType: string,
  value: number,
  recordedAt?: string,
): Promise<ApiMeasurement | null> {
  const response = await fetch(`${APP_URL}/api/customer-measurements`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ metricType, value, recordedAt }),
  });

  if (!response.ok) return null;

  const result: SingleMeasurementResponse = await response.json();
  return result.success ? result.data || null : null;
}

/**
 * Delete a measurement by ID.
 */
export async function deleteMeasurement(
  token: string,
  measurementId: string,
): Promise<boolean> {
  const response = await fetch(`${APP_URL}/api/customer-measurements`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ measurementId }),
  });

  if (!response.ok) return false;

  const result: { success: boolean } = await response.json();
  return result.success;
}

/**
 * Save only changed fields as individual measurements.
 */
export async function saveChangedMeasurements(
  token: string,
  current: Partial<HealthInputs>,
  previous: Partial<HealthInputs>,
): Promise<boolean> {
  const changes = diffInputsToMeasurements(current, previous);
  if (changes.length === 0) return true;

  const results = await Promise.all(
    changes.map((c) => addMeasurement(token, c.metricType, c.value)),
  );
  return results.every((r) => r !== null);
}
