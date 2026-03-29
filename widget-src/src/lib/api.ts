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

export interface ApiReminderPreference {
  reminderCategory: string;
  enabled: boolean;
}

interface MeasurementsResponse {
  success: boolean;
  data?: ApiMeasurement[];
  profile?: ApiProfile | null;
  medications?: ApiMedication[];
  screenings?: ApiScreening[];
  reminderPreferences?: ApiReminderPreference[];
  error?: string;
}

interface SingleMeasurementResponse {
  success: boolean;
  data?: ApiMeasurement;
  error?: string;
}

// App proxy path — requests go through Shopify to the backend
// Shopify adds logged_in_customer_id + HMAC signature automatically
export const PROXY_PATH = '/apps/health-tool-1';

/**
 * Helper to wrap API calls with consistent error handling.
 * Logs warning, reports to Sentry, and returns fallback value.
 */
async function apiCall<T>(
  operation: () => Promise<T>,
  errorMessage: string,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    console.warn(errorMessage, error);
    Sentry.captureException(error);
    return fallback;
  }
}

/**
 * Safely parse a JSON response, returning null if the content-type isn't JSON.
 * Shopify's app proxy can return HTML (maintenance/error pages) with a 200 status.
 * Calling response.json() on HTML throws a SyntaxError — this guard prevents that.
 * Genuine malformed JSON (with correct content-type) still throws for Sentry reporting.
 */
export async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }
  return response.json() as Promise<T>;
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
  /** Reminder notification preferences. */
  reminderPreferences: ApiReminderPreference[];
}

/**
 * Load latest measurements (one per metric) + profile demographics from cloud storage.
 * Returns pre-fill inputs (demographics + height only) and raw measurements separately.
 */
export async function loadLatestMeasurements(): Promise<LatestMeasurementsResult | null> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`);
    if (!response.ok) return null;

    const result = await parseJsonResponse<MeasurementsResponse>(response);
    if (!result || !result.success || !result.data) return null;

    // Build full inputs from measurements + profile
    const allInputs = measurementsToInputs(result.data, result.profile);

    // Extract only pre-fill fields (demographics + height)
    const inputs: Partial<HealthInputs> = {};
    for (const field of PREFILL_FIELDS) {
      if (allInputs[field] !== undefined) {
        (inputs as any)[field] = allInputs[field];
      }
    }
    // Also include unitSystem preference from profile (not a form field, but needed for display)
    if (allInputs.unitSystem !== undefined) {
      inputs.unitSystem = allInputs.unitSystem;
    }

    return { inputs, previousMeasurements: result.data, medications: result.medications ?? [], screenings: result.screenings ?? [], reminderPreferences: result.reminderPreferences ?? [] };
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

    const result = await parseJsonResponse<MeasurementsResponse>(response);
    return result?.success ? result.data || [] : [];
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

    const result = await parseJsonResponse<SingleMeasurementResponse>(response);
    return result?.success ? result.data || null : null;
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

    const result = await parseJsonResponse<{ success: boolean }>(response);
    return result?.success ?? false;
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
  height?: number;
}): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    if (!response.ok) return false;

    const result = await parseJsonResponse<{ success: boolean }>(response);
    return result?.success ?? false;
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

    const result = await parseJsonResponse<MeasurementsResponse>(response);
    return result?.success ? result.data || [] : [];
  } catch (error) {
    console.warn('Error loading all history:', error);
    Sentry.captureException(error);
    return [];
  }
}

/**
 * Delete all user data (measurements, profile, auth user).
 * Returns { success, error? } so callers can show specific failure reasons.
 */
export async function deleteUserData(): Promise<{ success: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch(`${PROXY_PATH}/api/user-data`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmDelete: true }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      if (response.status === 429) {
        return { success: false, error: 'You can only delete data once every 5 minutes. Please wait and try again.' };
      }
      if (response.status === 401) {
        return { success: false, error: 'Not logged in. Please sign in and try again.' };
      }
      return { success: false, error: `Something went wrong (${response.status}). Please try again later.` };
    }

    const result = await parseJsonResponse<{ success: boolean }>(response);
    if (!result) return { success: false, error: 'Server error. Please try again later.' };
    return { success: result.success, error: result.success ? undefined : 'Server error. Please try again later.' };
  } catch (error) {
    console.warn('Error deleting user data:', error);
    Sentry.captureException(error);
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { success: false, error: 'Request timed out. Please check your connection and try again.' };
    }
    return { success: false, error: 'Network error. Please check your connection and try again.' };
  }
}

/**
 * Save a medication status (upsert). FHIR-compatible with separate drug name and dose.
 */
export async function saveMedication(
  medicationKey: string,
  drugName: string,
  doseValue: number | null = null,
  doseUnit: string | null = null,
): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ medication: { medicationKey, drugName, doseValue, doseUnit } }),
    });
    if (!response.ok) return false;

    const result = await parseJsonResponse<{ success: boolean }>(response);
    return result?.success ?? false;
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

    const result = await parseJsonResponse<{ success: boolean }>(response);
    return result?.success ?? false;
  } catch (error) {
    console.warn('Error saving screening:', error);
    Sentry.captureException(error);
    return false;
  }
}

/**
 * Save a reminder preference (enable/disable a category).
 */
export async function saveReminderPreference(
  category: string,
  enabled: boolean,
): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/reminders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminderPreference: { category, enabled } }),
    });
    if (!response.ok) return false;

    const result = await parseJsonResponse<{ success: boolean }>(response);
    return result?.success ?? false;
  } catch (error) {
    console.warn('Error saving reminder preference:', error);
    Sentry.captureException(error);
    return false;
  }
}

/**
 * Set global reminder opt-out.
 */
export async function setGlobalReminderOptout(optout: boolean): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/reminders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ globalOptout: optout }),
    });
    if (!response.ok) return false;

    const result = await parseJsonResponse<{ success: boolean }>(response);
    return result?.success ?? false;
  } catch (error) {
    console.warn('Error setting global reminder optout:', error);
    Sentry.captureException(error);
    return false;
  }
}

/**
 * Trigger the welcome email and return success/failure.
 */
export async function sendWelcomeEmail(): Promise<{ success: boolean }> {
  return apiCall(
    async () => {
      const response = await fetch(`${PROXY_PATH}/api/measurements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sendWelcomeEmail: true }),
      });
      const result = await parseJsonResponse<{ success: boolean }>(response);
      return result ?? { success: false };
    },
    'Error sending welcome email',
    { success: false },
  );
}

/**
 * Email the user their current health report.
 */
export async function sendReportEmail(): Promise<{ success: boolean; error?: string }> {
  return apiCall(
    async () => {
      const response = await fetch(`${PROXY_PATH}/api/measurements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sendReportEmail: true }),
      });
      const result = await parseJsonResponse<{ success: boolean; error?: string }>(response);
      return result ?? { success: false, error: 'Network error' };
    },
    'Error sending report email',
    { success: false, error: 'Network error' },
  );
}

/**
 * Get the health report as HTML (for printing).
 */
export async function getReportHtml(): Promise<{ success: boolean; html?: string; error?: string }> {
  return apiCall(
    async () => {
      const response = await fetch(`${PROXY_PATH}/api/measurements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ getReportHtml: true }),
      });
      const result = await parseJsonResponse<{ success: boolean; html?: string; error?: string }>(response);
      return result ?? { success: false, error: 'Network error' };
    },
    'Error fetching report HTML',
    { success: false, error: 'Network error' },
  );
}

/**
 * Send feedback via the feedback API endpoint.
 */
export async function sendFeedback(
  email: string,
  message: string,
): Promise<boolean> {
  return apiCall(
    async () => {
      const response = await fetch(`${PROXY_PATH}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, message, website: '' }),
      });
      if (!response.ok) return false;
      const result = await parseJsonResponse<{ success: boolean }>(response);
      return result?.success ?? false;
    },
    'Error sending feedback',
    false,
  );
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

// ---------------------------------------------------------------------------
// Lab Import
// ---------------------------------------------------------------------------

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
  confidence: 'high' | 'medium' | 'low';
  question?: string;
}

/** Document data returned by the LLM for non-lab documents */
export interface DocumentResult {
  classification: string;
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
  unrecognized: string[];
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
}

/** Human-readable labels for document types. Shared across components. */
export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  scan_result: 'Scan Result',
  clinic_letter: 'Clinic Letter',
  discharge_summary: 'Discharge Summary',
  pathology_report: 'Pathology Report',
  vaccination_record: 'Vaccination Record',
  other: 'Document',
};

/** Format a YYYY-MM-DD date string for display. */
export function formatDocumentDate(dateStr: string | null): string {
  if (!dateStr) return 'Date unknown';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface LabImportResponse {
  success: boolean;
  data?: LabImportResult;
  remaining?: number;
  error?: string;
}

/**
 * Preflight check: returns remaining quota without consuming a request.
 * Call before starting file processing to avoid wasted client-side work.
 */
export async function checkLabImportQuota(): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/lab-import`);
    if (!response.ok) return { allowed: false, remaining: 0 };
    const data = await parseJsonResponse<{ allowed: boolean; remaining: number }>(response);
    return data ?? { allowed: true, remaining: 0 };
  } catch (error) {
    // Optimistic: don't block uploads on network errors — the POST will enforce the limit
    console.warn('Quota check failed:', error);
    return { allowed: true, remaining: 0 };
  }
}

/**
 * Send extracted page content to the LLM proxy for lab result extraction.
 * One call per file — do not batch across files.
 */
export async function labImport(
  pages: PageContent[],
  unitSystem: 'si' | 'conventional',
): Promise<{ result: LabImportResult | null; remaining?: number; error?: string }> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/lab-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages, unitSystem }),
    });

    if (response.status === 429) {
      return { result: null, error: 'Daily upload limit reached. You can upload more tomorrow.' };
    }
    if (!response.ok) {
      return { result: null, error: 'Extraction failed' };
    }

    const data = await parseJsonResponse<LabImportResponse>(response);
    if (!data?.success || !data.data) {
      return { result: null, error: data?.error || 'Extraction failed' };
    }

    return { result: data.data, remaining: data.remaining };
  } catch (error) {
    console.warn('Lab import error:', error);
    Sentry.captureException(error);
    return { result: null, error: 'Network error' };
  }
}

// ---------------------------------------------------------------------------
// Batch Import (Anthropic Batch API)
// ---------------------------------------------------------------------------

interface BatchCreateResponse {
  success: boolean;
  batchId?: string;
  totalFiles?: number;
  error?: string;
}

interface BatchPollResponse {
  status: 'processing' | 'ended';
  completed: number;
  total: number;
  results?: Array<LabImportResult & { fileName: string }>;
  error?: string;
}

/**
 * Create a batch of files for LLM processing.
 * Returns a batchId for polling.
 */
export async function labImportBatch(
  files: Array<{ fileName: string; pages: PageContent[] }>,
): Promise<{ batchId: string | null; error?: string }> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/lab-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: true, files }),
    });

    if (response.status === 429) {
      return { batchId: null, error: 'Daily upload limit reached. You can upload more tomorrow.' };
    }
    if (!response.ok) {
      return { batchId: null, error: 'Failed to start batch processing' };
    }

    const data = await parseJsonResponse<BatchCreateResponse>(response);
    if (!data?.success || !data.batchId) {
      return { batchId: null, error: data?.error || 'Batch creation failed' };
    }
    return { batchId: data.batchId };
  } catch (error) {
    console.warn('Batch import error:', error);
    Sentry.captureException(error);
    return { batchId: null, error: 'Network error' };
  }
}

/**
 * Poll batch status. Returns results when batch is complete.
 */
export async function pollBatchStatus(
  batchId: string,
): Promise<BatchPollResponse> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/lab-import?batchId=${encodeURIComponent(batchId)}`);
    // 404 = batch not found (server restarted) — terminal failure
    if (response.status === 404) {
      return { status: 'ended', completed: 0, total: 0, error: 'Batch not found — server may have restarted. Please try again.' };
    }
    if (!response.ok) {
      return { status: 'processing', completed: 0, total: 0 };
    }
    const data = await parseJsonResponse<BatchPollResponse>(response);
    return data ?? { status: 'processing', completed: 0, total: 0 };
  } catch {
    return { status: 'processing', completed: 0, total: 0 };
  }
}

interface BulkSaveResponse {
  success: boolean;
  data?: ApiMeasurement[];
  savedCount?: number;
  error?: string;
}

/**
 * Save multiple measurements in a single request (from lab import review).
 */
export async function bulkSaveMeasurements(
  measurements: Array<{ metricType: string; value: number; recordedAt: string; source: string }>,
): Promise<ApiMeasurement[]> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bulkMeasurements: measurements }),
    });
    if (!response.ok) return [];

    const data = await parseJsonResponse<BulkSaveResponse>(response);
    return data?.success ? data.data || [] : [];
  } catch (error) {
    console.warn('Bulk save error:', error);
    Sentry.captureException(error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Health Documents
// ---------------------------------------------------------------------------

/**
 * Fetch all health documents for the current user.
 */
export async function getHealthDocuments(): Promise<ApiDocument[]> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/health-documents`);
    if (!response.ok) return [];
    const data = await parseJsonResponse<{ documents: ApiDocument[] }>(response);
    return data?.documents || [];
  } catch (error) {
    console.warn('Failed to fetch health documents:', error);
    return [];
  }
}

/**
 * Save documents extracted from uploaded files.
 */
export async function bulkSaveDocuments(
  documents: Array<{
    documentType: string;
    title: string;
    documentDate: string | null;
    contentMd: string;
    metadata: Record<string, unknown>;
    sourceFileName: string | null;
  }>,
): Promise<ApiDocument[]> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/health-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bulkDocuments: documents }),
    });
    if (!response.ok) return [];
    const data = await parseJsonResponse<{ success: boolean; documents: ApiDocument[] }>(response);
    return data?.success ? data.documents || [] : [];
  } catch (error) {
    console.warn('Bulk save documents error:', error);
    Sentry.captureException(error);
    return [];
  }
}

/**
 * Delete a health document by ID.
 */
export async function deleteDocument(documentId: string): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/health-documents`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId }),
    });
    return response.ok;
  } catch (error) {
    console.warn('Delete document error:', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lab Values (flexible storage for all non-core metrics)
// ---------------------------------------------------------------------------

/**
 * Load lab values for the authenticated user.
 */
export async function loadLabValues(
  metricName?: string,
  limit = 500,
  offset = 0,
): Promise<ApiLabValue[]> {
  try {
    const params = new URLSearchParams();
    if (metricName) params.set('metric_name', metricName);
    if (limit !== 500) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const qs = params.toString();

    const response = await fetch(
      `${PROXY_PATH}/api/lab-values${qs ? `?${qs}` : ''}`,
    );
    if (!response.ok) return [];
    const data = await parseJsonResponse<{ labValues: ApiLabValue[] }>(response);
    return data?.labValues || [];
  } catch (error) {
    console.warn('Load lab values error:', error);
    return [];
  }
}

/**
 * Bulk save lab values extracted from uploaded files.
 */
export async function bulkSaveLabValues(
  values: Array<{
    metricName: string;
    value: number;
    unit: string;
    referenceLow?: number | null;
    referenceHigh?: number | null;
    recordedAt: string;
    source?: string;
  }>,
): Promise<ApiLabValue[]> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/lab-values`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bulkLabValues: values }),
    });
    if (!response.ok) return [];
    const data = await parseJsonResponse<{ success: boolean; labValues: ApiLabValue[] }>(response);
    return data?.success ? data.labValues || [] : [];
  } catch (error) {
    console.warn('Bulk save lab values error:', error);
    Sentry.captureException(error);
    return [];
  }
}

/**
 * Delete a lab value by ID.
 */
export async function deleteLabValue(labValueId: string): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/lab-values`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labValueId }),
    });
    return response.ok;
  } catch (error) {
    console.warn('Delete lab value error:', error);
    return false;
  }
}
