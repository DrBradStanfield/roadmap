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
import type { ApiMeasurement, HealthInputs, MeasurementSource } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
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
} from './api';

export * from './api';

let store: RoadmapStore | null = null;

/** Initialise the data layer with a backend. Call once before rendering the app. */
export async function initRoadmapStore(adapter: StorageAdapter): Promise<void> {
  store = await RoadmapStore.create(adapter);
}

/** Flush pending writes (call before navigation). */
export async function flushRoadmapStore(): Promise<void> {
  await store?.flush();
}

/** Synchronous last-ditch flush for tab-close / visibilitychange (mobile-safe). */
export function flushRoadmapStoreSync(): void {
  store?.flushSync();
}

// --- reads ---
export async function loadLatestMeasurements(): Promise<LatestMeasurementsResult | null> {
  return store ? store.loadLatestMeasurements() : null;
}
export async function loadMeasurementHistory(metricType: string): Promise<ApiMeasurement[]> {
  return store ? store.loadMeasurementHistory(metricType) : [];
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
export async function getHealthDocuments(): Promise<ApiDocument[]> {
  return store ? store.getHealthDocuments() : [];
}

// --- writes ---
export async function addMeasurement(metricType: string, value: number, recordedAt?: string): Promise<AddMeasurementResult> {
  return store ? store.addMeasurement(metricType, value, recordedAt) : { status: 'error' };
}
export async function deleteMeasurement(measurementId: string): Promise<boolean> {
  return store ? store.deleteMeasurement(measurementId) : false;
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
export async function saveReminderPreference(category: string, enabled: boolean): Promise<boolean> {
  return store ? store.saveReminderPreference(category, enabled) : false;
}
export async function setGlobalReminderOptout(optout: boolean): Promise<boolean> {
  return store ? store.setGlobalReminderOptout(optout) : false;
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
  documents: Array<{ documentType: string; title: string; documentDate: string | null; contentMd: string; metadata: Record<string, unknown>; sourceFileName: string | null }>,
): Promise<ApiDocument[]> {
  return store ? store.bulkSaveDocuments(documents) : [];
}
export async function deleteDocument(documentId: string): Promise<boolean> {
  return store ? store.deleteDocument(documentId) : false;
}
export async function deleteLabValue(labValueId: string): Promise<boolean> {
  return store ? store.deleteLabValue(labValueId) : false;
}
export async function deleteUserData(): Promise<{ success: boolean; error?: string }> {
  return store ? store.deleteUserData() : { success: false, error: 'Data store not initialised' };
}

// ---------------------------------------------------------------------------
// Report actions — client-side on the standalone build (decision record H3:
// the server-rendered report + server-sent report email are website-only and
// the email variant was killed outright; standalone prints the live plan and
// offers a mailto self-copy instead).
// ---------------------------------------------------------------------------

/** The rendered plan panel, cloned with interactive chrome stripped. */
function clonePlanPanel(): HTMLElement | null {
  const panel = document.querySelector('.health-results-panel');
  if (!panel) return null;
  const clone = panel.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.no-print, button, input, select, textarea').forEach((el) => el.remove());
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

/** Email = open the user's mail app with a plain-text copy of the plan. */
export async function sendReportEmail(): Promise<{ success: boolean; error?: string }> {
  const clone = clonePlanPanel();
  if (!clone) return { success: false, error: 'Your plan is still loading — try again in a moment.' };
  // innerText needs layout (a detached clone degrades to run-on textContent),
  // so attach off-screen for the read.
  clone.style.cssText = 'position:absolute;left:-99999px;top:0';
  document.body.appendChild(clone);
  const text = clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
  clone.remove();
  if (!text) return { success: false, error: 'Your plan is still loading — try again in a moment.' };
  const body =
    'My health plan (generated by Health Plan by Dr Brad — drstanfield.com):\n\n' +
    text.slice(0, 1600) +
    (text.length > 1600 ? '\n\n… (open the app to see the full plan, or use Print)' : '');
  // mailto with no recipient = a self-copy compose in the user's mail app.
  window.location.href = `mailto:?subject=${encodeURIComponent('My health plan')}&body=${encodeURIComponent(body)}`;
  return { success: true };
}
