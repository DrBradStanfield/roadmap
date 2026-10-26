/** Local-first health records and client-side reports, on every widget surface. */
import {
  type ApiMeasurement,
  type FileReminderOptIn,
  type HealthInputs,
  type LpaUnit,
  type MetricType,
  labUnitForEvent,
  labUnitTaken,
  type ReminderScheduleItem,
  knownMinorOf,
  resolveLabCatalogEntry,
} from '@roadmap/health-core';
import { MEASUREMENT_REFUSALS_WITH_METRIC } from '@roadmap/health-core/product-events';
import { RoadmapStore, type BulkLabValueInput, type BulkMeasurementInput, type CorrectStatus } from '../storage/roadmap-store';
import { ChatHistoryStore } from '../storage/chat-history-store';
import { getChatHistory, setChatHistoryFactory } from './chat-history-access';
import { PROXY_PATH, parseJsonResponse, trackProductEvent } from './server-api';
import { SHOPIFY_SURFACE } from './build-flags';
import type { StorageAdapter } from '@roadmap/health-core';
import type {
  AddMeasurementResult,
  ApiDocument,
  ApiLabValue,
  ApiMedicationHistory,
  BulkLabValuesResult,
  BulkSaveResult,
  LatestMeasurementsResult,
} from './api-types';


let store: RoadmapStore | null = null;

/** Initialise the data layer with a backend. Call once before rendering the app.
 *  `cloudUnreachable`: the session runs on-device because the cloud the user
 *  chose could not be read (US-09 AC13). */
export async function initRoadmapStore(adapter: StorageAdapter, cloudUnreachable = false): Promise<void> {
  store = await RoadmapStore.create(adapter, cloudUnreachable);
  // The page about to render shows this erase; it moves the mark as it shows
  // another, and the store refuses a write made against an older one (US-16 AC2a).
  store.showErase(store.eraseIdentity);
  // Both surfaces init here, so this is the one place the live re-read starts
  // (US-34). It runs for the life of the page; nothing unmounts the data layer.
  store.startLiveRefresh();
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

// --- document archive (§lab-uploads) ---
export function getDocumentArchiveMode(): 'no-prompt' | 'cloud' | 'device-only' {
  // On the device-only tier originals get no durable home — localStorage blobs
  // would also dangle after a backend switch (migrateLocalInto moves only the
  // JSON), so the upload UI prompts to connect first and the save path strips
  // the bytes if the user chooses to continue anyway.
  return getBackendKind() === 'cloud' ? 'cloud' : 'device-only';
}

/** Which erase the record is at; it moves with every erase, this tab's or
 *  another device's once re-read (US-16 AC2a). */
export function getEraseIdentity(): string {
  return store?.eraseIdentity ?? '';
}
/** The erase the page shows, and its mark once the page shows another. */
export function getShownErase(): string {
  return store?.shownErase ?? '';
}
/** After an erase: clear this device's off-file health data by the record
 *  session's one rule, which spares the originals of documents that outlive
 *  the erase (US-11 AC6). The page never clears stored originals itself. */
export function clearOffFileAfterErase(): void {
  store?.clearOffFileData();
}
export function markEraseShown(identity: string): void {
  store?.showErase(identity);
}

/** Where the record lives, as the usage counters name it (US-34). */
export function getBackendKind(): 'local' | 'cloud' {
  return store && store.backendId !== 'local' ? 'cloud' : 'local';
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

// --- lead capture (Shopify surface) ---
export function getReportEmailCaptured(): boolean {
  return store?.getReportEmailCaptured() ?? false;
}
export function markReportEmailCaptured(): boolean {
  return store?.markReportEmailCaptured() ?? false;
}

// --- Lp(a)'s field unit, a profile preference (US-05 AC2; lpa-unit.ts reads it) ---
export function getLpaUnit(): unknown {
  return store?.getLpaUnit();
}
export function setLpaUnit(unit: LpaUnit): boolean {
  return store?.setLpaUnit(unit) ?? false;
}

// --- email reminders (§10) — used by the standalone RemindersControl ---
export function getReminderOptIn(): FileReminderOptIn | undefined {
  return store?.getReminderOptIn();
}
export function setReminderOptIn(fields: Omit<FileReminderOptIn, 'updatedAt' | 'lamport'>, erase?: string): boolean {
  return store?.setReminderOptIn(fields, erase) ?? false;
}
export function computeCurrentReminderSchedule(): ReminderScheduleItem[] {
  return store?.computeReminderScheduleNow() ?? [];
}
/** The record holds a known age under 18 (US-07 AC6): reminders are never
 *  enrolled or pushed, since the server holds no age to stop them. */
export function isKnownMinorNow(): boolean {
  return knownMinorOf(store?.getPrefillInputs() ?? {});
}

// --- reads ---
export async function loadLatestMeasurements(): Promise<LatestMeasurementsResult | null> {
  return loadLatestMeasurementsSync();
}
export function loadLatestMeasurementsSync(): LatestMeasurementsResult | null {
  return store ? store.loadLatestMeasurements() : null;
}
/** Whether a loaded record holds anything the form shows. One test, shared by
 *  HealthTool's load and the email landing notice (US-22 AC13), so "empty"
 *  cannot mean two things. */
export function hasSavedRecord(result: LatestMeasurementsResult | null): result is LatestMeasurementsResult {
  return !!result && (Object.keys(result.inputs).length > 0 || result.previousMeasurements.length > 0 || result.medications.length > 0 || result.screenings.length > 0);
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
// `erase`: the erase the page showed when the write was asked for (US-16
// AC2a); without it, the one it shows now.
export async function addMeasurement(metricType: string, value: number, recordedAt?: string, erase?: string): Promise<AddMeasurementResult> {
  return store ? store.addMeasurement(metricType, value, recordedAt, erase) : { status: 'error' };
}
/** Correct a saved core or lab value; `newValue` is in the unit it is stored in. */
export async function correctValue(id: string, newValue: number, erase?: string): Promise<CorrectStatus> {
  return store ? store.correctValue(id, newValue, erase) : 'error';
}
export async function saveChangedMeasurements(current: Partial<HealthInputs>, previous: Partial<HealthInputs>, erase?: string): Promise<boolean> {
  return store ? store.saveChangedMeasurements(current, previous, erase) : false;
}
export async function saveMedication(medicationKey: string, drugName: string, doseValue: number | null = null, doseUnit: string | null = null, erase?: string): Promise<boolean> {
  return store ? store.saveMedication(medicationKey, drugName, doseValue, doseUnit, erase) : false;
}
export async function saveSupplement(supplementKey: string, supplementName: string, doseValue: number | null = null, doseUnit: string | null = null, status = 'active', startedAt?: string, erase?: string): Promise<boolean> {
  return store ? store.saveSupplement(supplementKey, supplementName, doseValue, doseUnit, status, startedAt, erase) : false;
}
export async function deleteSupplementApi(supplementKey: string): Promise<boolean> {
  return store ? store.deleteSupplementApi(supplementKey) : false;
}
export async function saveScreening(screeningKey: string, value: string, erase?: string): Promise<boolean> {
  return store ? store.saveScreening(screeningKey, value, erase) : false;
}
export async function bulkSaveMeasurements(measurements: BulkMeasurementInput[]): Promise<BulkSaveResult> {
  if (!store) return { saved: [], skippedDuplicates: 0, errorCount: measurements.length, refused: [] };
  const result = store.bulkSaveMeasurements(measurements);
  // Counted like a refused lab unit, in closed words only (US-35 AC17). The
  // metric rides only on an invalid value: an out-of-range one would say this
  // visitor's value is past a bound, and an unknown metric is free text. An
  // out-of-range metric still keys the tab's throttle, locally, so two tests
  // past their bounds count twice.
  for (const row of result.refused) {
    if (MEASUREMENT_REFUSALS_WITH_METRIC.includes(row.reason)) trackProductEvent('measurement_refused', { metric: row.metricType as MetricType, refusal: row.reason });
    else if (row.reason === 'out-of-range') trackProductEvent('measurement_refused', { refusal: row.reason }, row.metricType);
    else trackProductEvent('measurement_refused', { refusal: row.reason });
  }
  return result;
}
export async function bulkSaveLabValues(values: BulkLabValueInput[]): Promise<BulkLabValuesResult> {
  if (!store) return { saved: [], skippedDuplicates: 0, errorCount: values.length, refused: [] };
  const result = store.bulkSaveLabValues(values);
  // The one place every lab writer passes, so each refused row is counted once:
  // only a spelling the test does not take, the signal for the next one to teach it (US-21 AC15).
  // A unit that is not a unit word is counted without it (US-21 AC11); a blank one as `(blank)` (AC22).
  for (const row of result.refused) {
    if (!labUnitTaken(resolveLabCatalogEntry(row.key), row.unit)) {
      const unit = labUnitForEvent(row.unit);
      trackProductEvent('lab_unit_refused', unit ? { key: row.key, unit } : { key: row.key });
    }
  }
  return result;
}
export async function bulkSaveDocuments(
  documents: Array<{ documentType: string; title: string; documentDate: string | null; contentMd: string; metadata: Record<string, unknown>; sourceFileName: string | null; file?: Blob }>,
): Promise<{ saved: ApiDocument[]; errorCount: number; unstored?: number }> {
  return store ? store.bulkSaveDocuments(documents) : { saved: [], errorCount: documents.length };
}
export async function deleteDocument(documentId: string): Promise<boolean> {
  return store ? store.deleteDocument(documentId) : false;
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
  } catch {
    console.warn('readDocumentFile failed');
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

export async function deleteUserData(): Promise<{ success: boolean; error?: string; warning?: string; chatErased: boolean }> {
  if (!store) return { success: false, error: 'Data store not initialised', chatErased: false };
  // The order and the best-effort rules are the record session's (health-core
  // deleteAllData): it reads the record first, and an erase that cannot read
  // it is refused before either step runs (US-09 AC23). Chat goes through the
  // singleton, so an open chat panel's instance is the one erased.
  return store.deleteAllData({ teardown: preEraseHook ?? undefined, chat: getChatHistory });
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

/**
 * "Get Your Personalized Plan" sends the email address plus the
 * client-computed reminder CALENDAR — labels + due dates, the constitution's
 * entire permitted footprint (US-23 AC1) — never a measurement, value, or
 * reason. Typing the address IS the reminders enrolment (opt-out model; the
 * disclosure line lives beside the input, and every email carries a one-click
 * unsubscribe). The PDF is generated entirely client-side (getReportHtml) by
 * the caller before this runs.
 *
 * Shopify v2 surface only: the email section is gated to VITE_SHOPIFY_SURFACE,
 * so this never fires on Pages (no Brad server there).
 */
export async function sendGuestReport(
  email: string,
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
