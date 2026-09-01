/**
 * Local-first data layer for the standalone (GitHub Pages / self-host) build.
 *
 * It re-exports the entire `api.ts` surface, then OVERRIDES the data functions to
 * run against a local-first RoadmapStore (the user's own cloud / localStorage)
 * instead of the Shopify app-proxy. A local export shadows the matching
 * `export *` name, so components keep importing the same names.
 *
 * Wiring: only the standalone Vite build redirects `lib/api` → this module (see
 * vite.config.standalone.ts). The live Shopify widget keeps using the real
 * `api.ts` untouched — so it cannot break before the deliberate cutover.
 *
 * Server / AI / email / A-B functions are inherited from `api.ts` via `export *`.
 * Off Shopify their proxy calls 404 and return their built-in fallbacks (a
 * graceful no-op); the real website AI path is Phase 4.
 */
import {
  buildMeasurementHistory,
  measurementsToInputs,
  type MeasurementHistoryMap,
  type ApiMeasurement,
  type ApiMedication,
  type ApiScreening,
  type FileReminderOptIn,
  type HealthInputs,
  type MeasurementSource,
  type ReminderScheduleItem,
} from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { ChatHistoryStore } from '../storage/chat-history-store';
import { setChatHistoryFactory } from './chat-history-access';
import { PROXY_PATH, parseJsonResponse } from './api';
import { SHOPIFY_SURFACE } from './build-flags';
import { Sentry } from './sentry';
import type { StorageAdapter } from '../storage/adapter';
import type {
  AddMeasurementResult,
  ApiDocument,
  ApiLabValue,
  ApiMedicationHistory,
  BulkLabValuesResult,
  BulkSaveResult,
  CorrectMeasurementResult,
  LatestMeasurementsResult,
} from './api-types';

export * from './api';

let store: RoadmapStore | null = null;

/** Initialise the data layer with a backend. Call once before rendering the app. */
export async function initRoadmapStore(adapter: StorageAdapter): Promise<void> {
  store = await RoadmapStore.create(adapter);
  // Chat history (chat-history.json) syncs over the SAME adapter, created
  // lazily on first chat use (see chat-history-access.ts for the policy).
  setChatHistoryFactory(() => ChatHistoryStore.create(adapter));
}

/** Flush pending writes (call before navigation). */
export async function flushRoadmapStore(): Promise<void> {
  await store?.flush();
}

/** Synchronous last-ditch flush for tab-close / visibilitychange (mobile-safe). */
export function flushRoadmapStoreSync(): void {
  store?.flushSync();
}

// --- AI lab extraction (Phase 4/5 transports) ---
// The upload transport lives in upload-api.ts (cross-origin to Brad's Fly
// endpoint — what the drstanfield.com v2 page uses). The Pages/self-host
// build swaps it for byok-upload.ts (user's own Anthropic key, browser
// direct) via vite.config.standalone.ts. The explicit re-export shadows the
// api.ts versions inherited from `export *` (which POST to the Shopify proxy
// path and would 404 here).
export { checkLabImportQuota, labImport, labImportBatch, pollBatchStatus } from './upload-api';

// --- document archive (§lab-uploads) ---
export function getDocumentArchiveMode(): 'no-prompt' | 'cloud' | 'device-only' {
  // On the device-only tier originals get no durable home — localStorage blobs
  // would also dangle after a backend switch (migrateLocalInto moves only the
  // JSON), so the upload UI prompts to connect first and the save path strips
  // the bytes if the user chooses to continue anyway.
  return store && store.backendId !== 'local' ? 'cloud' : 'device-only';
}

// --- synchronous prefill seed for HealthTool's initial inputs state ---
// The store is initialised before render (app.tsx awaits initRoadmapStore), so
// InputPanel's FIRST render can see the saved prefill (sex/height/birth) and
// detect a returning user → collapse "Starting Info" on refresh (matches prod).
// Without this the prefill only arrives via the async load AFTER mount, so the
// returning-user check captured false and the section never collapsed.
export function getInitialInputsSync(): Partial<HealthInputs> {
  return store ? store.getPrefillInputs() : {};
}

// --- lead capture (Shopify surface) — overrides api.ts's no-op stubs ---
export function getReportEmailCaptured(): boolean {
  return store?.getReportEmailCaptured() ?? false;
}
export function markReportEmailCaptured(): void {
  store?.markReportEmailCaptured();
}

// --- email reminders (§10) — used by the standalone RemindersControl ---
export function getReminderOptIn(): FileReminderOptIn | undefined {
  return store?.getReminderOptIn();
}
export function setReminderOptIn(fields: Omit<FileReminderOptIn, 'updatedAt' | 'lamport'>): void {
  store?.setReminderOptIn(fields);
}
export function computeCurrentReminderSchedule(): ReminderScheduleItem[] {
  return store?.computeReminderScheduleNow() ?? [];
}

// --- reads ---
export async function loadLatestMeasurements(): Promise<LatestMeasurementsResult | null> {
  return store ? store.loadLatestMeasurements() : null;
}
export async function loadAllHistory(): Promise<ApiMeasurement[]> {
  return store ? store.loadAllHistory() : [];
}
export async function loadMedicationHistory(): Promise<ApiMedicationHistory[]> {
  return store ? store.loadMedicationHistory() : [];
}
export async function loadLabValues(): Promise<ApiLabValue[] | null> {
  return store ? store.loadLabValues() : null;
}

// --- writes ---
export async function addMeasurement(metricType: string, value: number, recordedAt?: string): Promise<AddMeasurementResult> {
  return store ? store.addMeasurement(metricType, value, recordedAt) : { status: 'error' };
}
export async function correctMeasurement(oldId: string, newValueSI: number): Promise<CorrectMeasurementResult> {
  return store ? store.correctMeasurement(oldId, newValueSI) : { status: 'error' };
}
export async function saveChangedMeasurements(current: Partial<HealthInputs>, previous: Partial<HealthInputs>): Promise<boolean> {
  return store ? store.saveChangedMeasurements(current, previous) : false;
}
export async function saveMedication(medicationKey: string, drugName: string, doseValue: number | null = null, doseUnit: string | null = null): Promise<boolean> {
  return store ? store.saveMedication(medicationKey, drugName, doseValue, doseUnit) : false;
}
export async function saveSupplement(supplementKey: string, supplementName: string, doseValue: number | null = null, doseUnit: string | null = null, status = 'active', startedAt?: string): Promise<boolean> {
  return store ? store.saveSupplement(supplementKey, supplementName, doseValue, doseUnit, status, startedAt) : false;
}
export async function deleteSupplementApi(supplementKey: string): Promise<boolean> {
  return store ? store.deleteSupplementApi(supplementKey) : false;
}
export async function saveScreening(screeningKey: string, value: string): Promise<boolean> {
  return store ? store.saveScreening(screeningKey, value) : false;
}
export async function bulkSaveMeasurements(
  measurements: Array<{ metricType: string; value: number; recordedAt: string; source: MeasurementSource }>,
): Promise<BulkSaveResult> {
  return store ? store.bulkSaveMeasurements(measurements) : { saved: [], skippedDuplicates: 0, errorCount: measurements.length };
}
export async function bulkSaveLabValues(
  values: Array<{ metricName: string; value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null; recordedAt: string; source?: string }>,
): Promise<BulkLabValuesResult> {
  return store ? store.bulkSaveLabValues(values) : { saved: [], skippedDuplicates: 0, errorCount: values.length };
}
export async function bulkSaveDocuments(
  documents: Array<{ documentType: string; title: string; documentDate: string | null; contentMd: string; metadata: Record<string, unknown>; sourceFileName: string | null; file?: Blob }>,
): Promise<ApiDocument[]> {
  return store ? store.bulkSaveDocuments(documents) : [];
}
export async function deleteDocument(documentId: string): Promise<boolean> {
  return store ? store.deleteDocument(documentId) : false;
}
export async function deleteLabValue(labValueId: string): Promise<boolean> {
  return store ? store.deleteLabValue(labValueId) : false;
}
/**
 * Data snapshot for the BYOK chat's system-prompt context (byok-chat.ts).
 * Mirrors the website chat's guest-context shape: prefill inputs + the newest
 * active value per metric (US-07 AC4) + the raw medication/screening rows
 * (byok-chat converts them with health-core) + the dated blood-test/vitals
 * time series (chronological per metric, capped — same shape the storefront
 * build sends as guestInputs.measurementHistory).
 */
export function getByokChatInputs():
  | (Record<string, unknown> & {
      medications: ApiMedication[];
      screenings: ApiScreening[];
      measurementHistory?: MeasurementHistoryMap;
    })
  | null {
  if (!store) return null;
  const latest = store.loadLatestMeasurements();
  const measurementHistory = buildMeasurementHistory(store.loadAllHistory());
  return {
    ...latest.inputs,
    ...measurementsToInputs(latest.previousMeasurements),
    unitSystem: latest.inputs.unitSystem ?? 'si',
    medications: latest.medications,
    screenings: latest.screenings,
    ...(Object.keys(measurementHistory).length > 0 ? { measurementHistory } : {}),
  };
}

/** Standalone: history opens as a lightbox (host listens in standalone/app.tsx). */
export function openHistoryLightbox(metric: string | null): boolean {
  window.dispatchEvent(new CustomEvent('hr:open-history', { detail: { metric } }));
  return true;
}

/** Read an archived original from the user's own cloud (null off-cloud/missing). */
export async function readDocumentFile(fileRef: string): Promise<Blob | null> {
  if (!store) return null;
  try {
    return await store.readDocumentFile(fileRef);
  } catch (error) {
    console.warn('readDocumentFile failed', error);
    return null;
  }
}

/**
 * Teardown that must run BEFORE the erase, registered by the standalone entry.
 * `src/` must never import `standalone/`, so the dependency is injected rather
 * than imported. Today it is the reminders row on Brad's server: "delete all my
 * data" has to include the one copy that isn't on the device, and the token
 * authorising that delete lives inside the file the erase is about to wipe.
 */
let preEraseHook: (() => Promise<void>) | null = null;
export function setPreEraseHook(fn: () => Promise<void>): void {
  preEraseHook = fn;
}

export async function deleteUserData(): Promise<{ success: boolean; error?: string }> {
  if (!store) return { success: false, error: 'Data store not initialised' };
  try {
    await preEraseHook?.();
  } catch (error) {
    // Best-effort: an unreachable server must never block a user from erasing
    // their own device. The orphaned row is reported, not silently swallowed.
    console.warn('Pre-erase teardown failed', error);
    Sentry.captureException(error, { tags: { area: 'reminders', op: 'pre-erase' } });
  }
  return store.deleteUserData();
}

// ---------------------------------------------------------------------------
// Report actions — client-side on the local-first builds. Print/save-as-PDF
// is a true-to-screen snapshot; the Email Report button is GONE on both v2
// surfaces (Brad, 2026-06-11 — the mailto self-copy was a degraded plain-text
// duplicate of the guest-report email, which is now the delivery path on the
// Shopify surface).
// ---------------------------------------------------------------------------

/** The rendered plan panel, cloned with interactive chrome stripped. */
function clonePlanPanel(): HTMLElement | null {
  const panel = document.querySelector('.health-results-panel');
  if (!panel) return null;
  const clone = panel.cloneNode(true) as HTMLElement;
  // Strip interactive chrome + the sync-status box (meaningless on paper/email).
  clone.querySelectorAll('.no-print, .hr-sync, button, input, select, textarea').forEach((el) => el.remove());
  return clone;
}

/** Print = a true-to-screen snapshot of the rendered plan (no server). */
export async function getReportHtml(): Promise<{ success: boolean; html?: string; error?: string }> {
  const clone = clonePlanPanel();
  if (!clone) return { success: false, error: 'Your plan is still loading — try again in a moment.' };
  // link.href is already absolutized by the DOM, so styles resolve from the
  // print window (document.write into about:blank breaks relative URLs).
  const styles = [
    ...[...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
      (l) => `<link rel="stylesheet" href="${l.href}">`,
    ),
    ...[...document.querySelectorAll('style')].map((s) => s.outerHTML),
  ].join('\n');
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>My Health Plan — Health Plan by Dr Brad</title>${styles}` +
    `<style>body{margin:24px;background:#fff}.health-results-panel{box-shadow:none;max-width:none}</style>` +
    `</head><body>${clone.outerHTML}</body></html>`;
  return { success: true, html };
}

/** No Email Report button on local-first builds — stub kept only because
 *  ResultsPanel imports it unconditionally (production resolves api.ts's). */
export async function sendReportEmail(): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: 'Not available in this version.' };
}

/**
 * "Get Your Personalized Plan" on the local-first builds. Overrides api.ts's
 * sendGuestReport (which POSTs the full health inputs to the server and triggers
 * a Resend report email). Here what crosses is the email address plus the
 * client-computed reminder CALENDAR — labels + due dates, the constitution's
 * entire permitted footprint (US-23 AC1) — never a measurement, value, or
 * reason. Typing the address IS the reminders enrolment (opt-out model; the
 * disclosure line lives beside the input, and every email carries a one-click
 * unsubscribe). The PDF is generated entirely client-side (getReportHtml) by
 * the caller before this runs. The `inputs`/`medications`/`screenings` args
 * are accepted for signature-compatibility with the caller but ignored.
 *
 * Shopify v2 surface only: the email section is gated to VITE_SHOPIFY_SURFACE,
 * so this never fires on Pages (no Brad server there).
 */
export async function sendGuestReport(
  email: string,
  _inputs?: Record<string, unknown>,
  // Kept signature-compatible with api.ts's version BY HAND — the vite swap
  // means tsc never checks this graph against the callers (see ci.yml gates).
  _medications?: readonly ApiMedication[],
  _screenings?: readonly ApiScreening[],
): Promise<{ success: boolean; error?: string }> {
  // Self-guard, not just call-site gating (same posture as trackProductEvent):
  // off the Shopify surface there is no Brad server, so a future caller must
  // hit this wall, not a 404 that posts an email address into the void.
  if (!SHOPIFY_SURFACE) return { success: false, error: 'Not available in this version.' };
  try {
    const response = await fetch(`${PROXY_PATH}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        klaviyoCapture: { email, schedule: computeCurrentReminderSchedule() },
      }),
    });
    // reminder_optin for the typed lane is counted SERVER-side (the only party
    // that knows the enrolment landed, and the response deliberately carries
    // no enrolment state — it would be a membership oracle for typed emails).
    const result = await parseJsonResponse<{ success: boolean; error?: string }>(response);
    return result ?? { success: false, error: 'Network error' };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Welcome email is a server/account feature — local-first has no DB-backed
 * account to email (email is a typed opt-in at the reminders flow, §10).
 * No-op success so the shared guest-sync path in HealthTool neither POSTs
 * to the data API (it 401s) nor flags an email error.
 */
export async function sendWelcomeEmail(): Promise<{ success: boolean }> {
  return { success: true };
}
