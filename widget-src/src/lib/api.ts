import type { HealthInputs, MeasurementSource, ProductEventName } from '@roadmap/health-core';
import { safeGetItem, safeSetItem } from './storage';
import { SHOPIFY_SURFACE } from './build-flags';
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
// Shared data-shape types live in api-types.ts (decoupled from the fetch impls
// so they survive independent of this module). Re-exported here so the many
// `from '../lib/api'` import paths keep resolving.
import type {
  ApiReminderPreference,
  ApiSupplement,
  ApiLabValue,
  ApiDocument,
  ApiMedicationHistory,
  LatestMeasurementsResult,
  AddMeasurementResult,
  CorrectMeasurementResult,
  BulkSaveResult,
  BulkLabValuesResult,
  PageContent,
  LabImportResult,
  BatchPollResponse,
  UploadErrorCode,
} from './api-types';
export * from './api-types';

interface MeasurementsResponse {
  success: boolean;
  data?: ApiMeasurement[];
  profile?: ApiProfile | null;
  medications?: ApiMedication[];
  screenings?: ApiScreening[];
  supplements?: ApiSupplement[];
  reminderPreferences?: ApiReminderPreference[];
  /** Active health documents — needed both for the home Health Documents
   *  panel and for the upload-review dup-check. */
  documents?: ApiDocument[];
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

    return {
      inputs,
      previousMeasurements: result.data,
      medications: result.medications ?? [],
      screenings: result.screenings ?? [],
      supplements: result.supplements ?? [],
      reminderPreferences: result.reminderPreferences ?? [],
      documents: result.documents ?? [],
    };
  } catch (error) {
    console.warn('Error loading measurements:', error);
    Sentry.captureException(error);
    return null;
  }
}

/**
 * Add a single measurement. Value must be in SI canonical units.
 *
 * Returns a discriminated union so callers can distinguish a real failure
 * from a server-side `409` "active row already exists for this metric+date"
 * (the user should click-to-correct the existing row instead).
 */
export async function addMeasurement(
  metricType: string,
  value: number,
  recordedAt?: string,
): Promise<AddMeasurementResult> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metricType, value, recordedAt }),
    });
    if (response.status === 409) return { status: 'duplicate' };
    if (!response.ok) {
      // Surface silent 4xx/5xx — the matrix's auto-save clears the draft on
      // any non-success, so an invisible 400 (e.g. malformed `recordedAt`)
      // looks like "value disappeared" to the user. Capture the response
      // body so the failing payload is in Sentry without leaking PHI.
      let body: string | undefined;
      try { body = (await response.clone().text()).slice(0, 500); } catch {}
      Sentry.captureMessage('addMeasurement non-ok response', {
        level: 'error',
        extra: { status: response.status, body, metricType, hasRecordedAt: recordedAt != null },
      });
      return { status: 'error' };
    }

    const result = await parseJsonResponse<SingleMeasurementResponse>(response);
    if (result?.success && result.data) {
      return { status: 'inserted', row: result.data };
    }
    return { status: 'error' };
  } catch (error) {
    console.warn('Error adding measurement:', error);
    Sentry.captureException(error);
    return { status: 'error' };
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

/** Load all medication history for chart annotations. */
export async function loadMedicationHistory(): Promise<ApiMedicationHistory[]> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements?medication_history=true`);
    if (!response.ok) return [];
    const result = await response.json();
    return result?.success ? result.data || [] : [];
  } catch (error) {
    console.warn('Error loading medication history:', error);
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

/** Save a supplement (upsert). */
export async function saveSupplement(
  supplementKey: string,
  supplementName: string,
  doseValue: number | null = null,
  doseUnit: string | null = null,
  status: string = 'active',
  startedAt?: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplement: { supplementKey, supplementName, doseValue, doseUnit, status, startedAt } }),
    });
    if (!response.ok) return false;
    const result = await parseJsonResponse<{ success: boolean }>(response);
    return result?.success ?? false;
  } catch (error) {
    console.warn('Error saving supplement:', error);
    Sentry.captureException(error);
    return false;
  }
}

/** Delete (stop) a supplement. */
export async function deleteSupplementApi(supplementKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteSupplement: { supplementKey } }),
    });
    if (!response.ok) return false;
    const result = await parseJsonResponse<{ success: boolean }>(response);
    return result?.success ?? false;
  } catch (error) {
    console.warn('Error deleting supplement:', error);
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
 * Send a guest report email (no login required).
 * Submits health data + email to the backend, which generates and sends the report.
 */
export async function sendGuestReport(
  email: string,
  inputs: Record<string, unknown>,
  medications?: Record<string, unknown>,
  screenings?: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  return apiCall(
    async () => {
      const response = await fetch(`${PROXY_PATH}/api/measurements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guestReport: { email, inputs, medications, screenings },
        }),
      });
      const result = await parseJsonResponse<{ success: boolean; error?: string }>(response);
      return result ?? { success: false, error: 'Network error' };
    },
    'Error sending guest report',
    { success: false, error: 'Network error' },
  );
}

/**
 * Synchronous prefill seed — local-first only (the shim overrides it from the
 * RoadmapStore). The production widget seeds inputs from localStorage instead,
 * so this returns nothing.
 */
export function getInitialInputsSync(): Partial<HealthInputs> {
  return {};
}

/**
 * Lead-capture flag — local-first only. The production widget has no
 * client-side store, so these are no-ops (the email box always shows; the
 * roadmap-data.ts shim overrides them with the real RoadmapStore-backed flag).
 */
export function getReportEmailCaptured(): boolean {
  return false;
}
export function markReportEmailCaptured(): void {
  /* no-op in the production build */
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
  // Duplicates are non-fatal here: the same value already exists at this
  // timestamp, so the sync goal (value present in DB) is satisfied.
  return results.every((r) => r.status !== 'error');
}

// ---------------------------------------------------------------------------
// Lab Import — shapes (PageContent, ExtractedValue, LabImportResult, …) live in
// api-types.ts; the fetch transports follow below.
// ---------------------------------------------------------------------------

/**
 * Legacy href target for full-history links. The /pages/health-history page was
 * removed from production on 2026-06-14, so this only resolves if that page is
 * recreated. On every live (v2/local-first) surface the click is intercepted by
 * openHistoryLightbox() (roadmap-data.ts override) and this constant is never
 * navigated to — it only supplies the `<a href>` fallback for no-JS /
 * right-click-open.
 */
export const HISTORY_PAGE_PATH = '/pages/health-history';

/**
 * Open the history view in a lightbox instead of navigating. Returns true if
 * handled. False here (legacy rollback bundle only — it falls back to the
 * HISTORY_PAGE_PATH href); the standalone/local-first shim overrides it to
 * open the lightbox (Brad's call 2026-06-11: lightbox, not a separate page).
 */
export function openHistoryLightbox(_metric: string | null): boolean {
  return false;
}

/**
 * Read an archived original document file. v1 (Shopify) stores no originals —
 * always null here; the standalone shim overrides with the cloud-store read.
 */
export async function readDocumentFile(_fileRef: string): Promise<Blob | null> {
  return null;
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
/** `message` (optional) overrides the modal's default quota-exceeded copy —
 *  the BYOK transport uses it for its "connect your key" gate. */
export async function checkLabImportQuota(): Promise<{ allowed: boolean; remaining: number; message?: string }> {
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
): Promise<{ result: LabImportResult | null; remaining?: number; error?: string; errorCode?: UploadErrorCode }> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/lab-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages, unitSystem }),
    });

    if (response.status === 429) {
      return { result: null, error: 'Daily upload limit reached. You can upload more tomorrow.', errorCode: 'rate_limit' };
    }
    if (!response.ok) {
      return { result: null, error: 'Extraction failed', errorCode: 'server_error' };
    }

    const data = await parseJsonResponse<LabImportResponse>(response);
    if (!data?.success || !data.data) {
      return { result: null, error: data?.error || 'Extraction failed', errorCode: 'server_error' };
    }

    return { result: data.data, remaining: data.remaining };
  } catch (error) {
    console.warn('Lab import error:', error);
    Sentry.captureException(error);
    return { result: null, error: 'Network error', errorCode: 'network' };
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

/**
 * Create a batch of files for LLM processing.
 * Returns a batchId for polling.
 */
export async function labImportBatch(
  files: Array<{ fileName: string; pages: PageContent[] }>,
): Promise<{ batchId: string | null; error?: string; errorCode?: UploadErrorCode }> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/lab-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: true, files }),
    });

    if (response.status === 429) {
      return { batchId: null, error: 'Daily upload limit reached. You can upload more tomorrow.', errorCode: 'rate_limit' };
    }
    if (!response.ok) {
      return { batchId: null, error: 'Failed to start batch processing', errorCode: 'server_error' };
    }

    const data = await parseJsonResponse<BatchCreateResponse>(response);
    if (!data?.success || !data.batchId) {
      return { batchId: null, error: data?.error || 'Batch creation failed', errorCode: 'server_error' };
    }
    return { batchId: data.batchId };
  } catch (error) {
    console.warn('Batch import error:', error);
    Sentry.captureException(error);
    return { batchId: null, error: 'Network error', errorCode: 'network' };
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
      return { status: 'ended', completed: 0, total: 0, error: 'Batch not found — server may have restarted.', errorCode: 'server_restart' };
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
  skippedDuplicates?: number;
  errorCount?: number;
  totalCount?: number;
  error?: string;
}


/**
 * Save multiple measurements in a single request (from lab import review).
 * Returns the inserted rows plus dup/error counts so the UI can surface
 * "Saved X of Y" with an honest accounting of the gap.
 */
export async function bulkSaveMeasurements(
  measurements: Array<{ metricType: string; value: number; recordedAt: string; source: MeasurementSource }>,
): Promise<BulkSaveResult> {
  const emptyResult = (errorCount: number): BulkSaveResult => ({ saved: [], skippedDuplicates: 0, errorCount });
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bulkMeasurements: measurements }),
    });
    if (!response.ok) return emptyResult(measurements.length);

    const data = await parseJsonResponse<BulkSaveResponse>(response);
    if (!data?.success) return emptyResult(measurements.length);
    return {
      saved: data.data ?? [],
      skippedDuplicates: data.skippedDuplicates ?? 0,
      errorCount: data.errorCount ?? 0,
    };
  } catch (error) {
    console.warn('Bulk save error:', error);
    Sentry.captureException(error);
    return emptyResult(measurements.length);
  }
}

/**
 * FHIR replaces: correct a saved measurement. newValueSI is in SI canonical units
 * (caller converts from display units).
 *
 * Returns a discriminated union so the caller can show specific UX:
 *   ok        — newId returned
 *   conflict  — 409: another value saved at the same date during the round-trip
 *   not_found — 404: row missing, not owned, or already corrected
 *   error     — network / unexpected
 */
export async function correctMeasurement(
  oldId: string,
  newValueSI: number,
): Promise<CorrectMeasurementResult> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        correctMeasurement: { oldId, newValue: newValueSI },
      }),
    });
    if (response.status === 404) return { status: 'not_found' };
    if (response.status === 409) return { status: 'conflict' };
    if (!response.ok) return { status: 'error' };
    const data = await parseJsonResponse<{ success: boolean; newId?: string }>(response);
    if (data?.success && data.newId) return { status: 'ok', newId: data.newId };
    return { status: 'error' };
  } catch (error) {
    console.warn('Correct measurement error:', error);
    Sentry.captureException(error);
    return { status: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Health Documents
// ---------------------------------------------------------------------------

/**
 * How uploaded ORIGINALS are kept. The Shopify/v1 build keeps extracted text
 * only (no prompt, no archive); the local-first build overrides this:
 * 'cloud' = originals are archived in the user's cloud folders;
 * 'device-only' = no durable home — the upload UI shows the connect-first
 * prompt (decision record: encourage, don't block).
 */
export function getDocumentArchiveMode(): 'no-prompt' | 'cloud' | 'device-only' {
  return 'no-prompt';
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
    /** Original bytes — used by the local-first build (user's cloud archive);
     *  ignored here (v1 keeps extracted text only). */
    file?: Blob;
  }>,
): Promise<ApiDocument[]> {
  try {
    const bulkDocuments = documents.map(({ file: _file, ...d }) => d);
    const response = await fetch(`${PROXY_PATH}/api/health-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bulkDocuments }),
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
 * Load lab values for the authenticated user. Returns `null` on failure so
 * the caller can leave the cached list intact instead of blanking it on a
 * transient API error.
 */
export async function loadLabValues(
  metricName?: string,
  limit = 500,
  offset = 0,
): Promise<ApiLabValue[] | null> {
  try {
    const params = new URLSearchParams();
    if (metricName) params.set('metric_name', metricName);
    if (limit !== 500) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const qs = params.toString();

    const response = await fetch(
      `${PROXY_PATH}/api/lab-values${qs ? `?${qs}` : ''}`,
    );
    if (!response.ok) return null;
    const data = await parseJsonResponse<{ labValues: ApiLabValue[] }>(response);
    return data?.labValues ?? null;
  } catch (error) {
    console.warn('Load lab values error:', error);
    return null;
  }
}

/**
 * Bulk save lab values extracted from uploaded files. Mirrors the
 * bulkSaveMeasurements shape so the done-screen tally can show
 * "saved / skipped / failed" honestly across both endpoints.
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
): Promise<BulkLabValuesResult> {
  const emptyResult = (errorCount: number): BulkLabValuesResult => ({ saved: [], skippedDuplicates: 0, errorCount });
  try {
    const response = await fetch(`${PROXY_PATH}/api/lab-values`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bulkLabValues: values }),
    });
    if (!response.ok) return emptyResult(values.length);
    const data = await parseJsonResponse<{
      success: boolean;
      labValues?: ApiLabValue[];
      skippedDuplicates?: number;
      errorCount?: number;
    }>(response);
    if (!data?.success) return emptyResult(values.length);
    return {
      saved: data.labValues ?? [],
      skippedDuplicates: data.skippedDuplicates ?? 0,
      errorCount: data.errorCount ?? 0,
    };
  } catch (error) {
    console.warn('Bulk save lab values error:', error);
    Sentry.captureException(error);
    return emptyResult(values.length);
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

// ---------------------------------------------------------------------------
// A/B Testing
// ---------------------------------------------------------------------------

let cachedVisitorId: string | null = null;

export function getVisitorId(): string {
  if (cachedVisitorId) return cachedVisitorId;
  const KEY = 'hr_vid';
  const stored = safeGetItem(KEY);
  if (stored) { cachedVisitorId = stored; return stored; }
  const id = crypto.randomUUID?.() ??
    Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b, i) => {
        if (i === 6) b = (b & 0x0f) | 0x40;  // version 4
        if (i === 8) b = (b & 0x3f) | 0x80;  // variant 1
        return b.toString(16).padStart(2, '0');
      })
      .join('')
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  safeSetItem(KEY, id);
  cachedVisitorId = id;
  return id;
}

// Key format shared with inline script in app-block.liquid: { tests: { testId: variantId, ... } }
// Backwards compat: also reads old single-test format { t: testId, v: variantId }
export function getABAssignments(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem('hr_ab') || '{}');
    if (raw.tests) return raw.tests;
    if (raw.t && raw.v) return { [raw.t]: raw.v };
  } catch { /* no assignment */ }
  return {};
}

function trackABEvent(eventType: 'impression' | 'conversion'): void {
  const assignments = getABAssignments();
  const visitorId = getVisitorId();
  for (const [testId, variantId] of Object.entries(assignments)) {
    // Skip redundant impression calls — server deduplicates, but this avoids the network roundtrip
    if (eventType === 'impression') {
      const sentKey = `hr_ab_imp_${testId}`;
      if (safeGetItem(sentKey)) continue;
      safeSetItem(sentKey, '1');
    }
    apiCall(
      () => fetch(`${PROXY_PATH}/api/ab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [eventType]: { testId, variantId, visitorId } }),
      }),
      `AB ${eventType} tracking failed`,
      null,
    );
  }
}

export function trackABImpression(): void { trackABEvent('impression'); }
export function trackABConversion(): void { trackABEvent('conversion'); }

// ---------------------------------------------------------------------------
// Product funnel events (anonymous behavioral counters — usage-audit 2026-08)
// ---------------------------------------------------------------------------

export interface ProductEventMetadata {
  provider?: 'google-drive' | 'dropbox' | 'github' | 'webdav' | 'local';
  count?: number;
}

/**
 * Fire-and-forget anonymous funnel event. Event names are the shared
 * PRODUCT_EVENT_NAMES enum in health-core; the server rejects anything else.
 *
 * - Only fires on the Shopify surface: the Pages/self-host build has no Brad
 *   server, so this must no-op there (VITE_SHOPIFY_SURFACE gate).
 * - Throttled to once per event name per tab session (sessionStorage), so
 *   re-renders and repeat actions don't spam the endpoint.
 * - Never attach health values or free text — metadata is a closed allow-list.
 */
export function trackProductEvent(
  eventName: ProductEventName,
  metadata?: ProductEventMetadata,
): void {
  if (!SHOPIFY_SURFACE) return;
  try {
    const sentKey = `hr_pe_${eventName}`;
    if (sessionStorage.getItem(sentKey)) return;
    sessionStorage.setItem(sentKey, '1');
  } catch { /* sessionStorage unavailable — still send once */ }
  const visitorId = getVisitorId();
  apiCall(
    () => fetch(`${PROXY_PATH}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventName, visitorId, ...(metadata ? { metadata } : {}) }),
      // Several call sites navigate/reload right after firing (cloud connect,
      // save flows) — keepalive lets the request survive the page teardown.
      keepalive: true,
    }),
    'Product event tracking failed',
    null,
  );
}
