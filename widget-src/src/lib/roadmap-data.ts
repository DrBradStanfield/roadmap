/** Local-first health records and client-side reports, on every widget surface. */
import type { AddLabValueRequest, AddLabValueResult, MeasurementRefusal, MoveKeep, MoveRejection, MovePlan } from '@roadmap/health-core/record-edits';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { dayOf } from '@roadmap/health-core/merge';
import type { EraseChatStep } from '@roadmap/health-core/erase-outcome';
import type { FileReminderOptIn, RoadmapFile } from '@roadmap/health-core/roadmap-file';
import type { HealthInputs } from '@roadmap/health-core/types';
import type { LpaUnit, MetricType } from '@roadmap/health-core/units';
import { MEASUREMENT_REFUSALS_WITH_METRIC, type MEASURES } from '@roadmap/health-core/product-events';
import type { ReminderScheduleItem } from '@roadmap/health-core/reminder-schedule';
import type { ReminderRowFields } from '@roadmap/health-core/state-edits';
import type { SaveStatus } from '@roadmap/health-core/save-state';
import { knownMinorOf } from '@roadmap/health-core/calculations';
import { readableView } from '@roadmap/health-core/readable-rows';
import { knownIndex, readIsLegacy, type KnownIndex } from '@roadmap/health-core/upload-known';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import { RoadmapStore, type DerivedSeries, type BulkMeasurementInput, type CorrectStatus, type MoveOutcome, type ProfileSave } from '../storage/roadmap-store';
import { ChatHistoryStore } from '../storage/chat-history-store';
import { openChatHistory, setChatHistoryFactory } from './chat-history-access';
import { eraseBegan, setChatEraseReader } from './chat-erase';
import { PROXY_PATH, parseJsonResponse, trackProductEvent } from './server-api';
import { countRefusedSpellings } from './refused-spellings';
import { clearLocalStorage } from './storage';
import { SHOPIFY_SURFACE } from './build-flags';
import type { StorageAdapter } from '@roadmap/health-core/adapter';
import type { ScreeningPerson } from '@roadmap/health-core/upload-screening';
import { SAVE_FAILED, type UploadEngine, type UploadSaveAnswer, type WebSaving, type WebUploadIO } from '../storage/upload-save-store';
import type {
  AddMeasurementResult,
  ApiLabValue,
  ApiMedicationHistory,
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
  // US-66 AC13: the open moved blood tests into one table and wrote it: counts only, never a name or value.
  void store.bloodTablesUnified.then((report) => { if (report) trackProductEvent('blood_tests_unified', report); });
  // Both surfaces init here, so this is the one place the live re-read starts
  // (US-34). It runs for the life of the page; nothing unmounts the data layer.
  store.startLiveRefresh();
  // Chat history (chat-history.json) syncs over the SAME adapter, created
  // lazily on first chat use (see chat-history-access.ts for the policy).
  // It is read again after an erase, this page's or another device's (US-11 AC2g).
  setChatHistoryFactory(() => ChatHistoryStore.create(adapter), getEraseIdentity);
  setChatEraseReader(getEraseIdentity);
}

/** Flush pending writes (call before navigation). */
export async function flushRoadmapStore(): Promise<void> {
  await store?.flush();
}

/** Before leaving a cloud: this page's record onto the device (US-09 AC2g). */
export async function copyRecordToDevice(): Promise<void> {
  await store?.copyToDevice();
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

/** The record's files by content, as it is now (US-12 AC27): the upload reads it once per pick. Never
 *  cached across picks: a delete or save edits the record in place, and the next pick must see it. */
export function uploadKnownIndex(): KnownIndex {
  return store ? knownIndex(store.file) : new Map();
}

/** After a read: the record holds this document from before hashing, by name and date (upload-known.ts). */
export function isLegacyUpload(name: string, read: UnifiedExtractionResult): boolean {
  return !!store && readIsLegacy(store.file, name, read);
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
/** The erase a request is asked under: the one the page shows (US-16 AC2a). */
export const askedUnder = getShownErase;
/** Whether the record is still at the erase `asked` names, and the page still
 *  shows it. Whole identities, never epochs: a merge can move the identity
 *  within one epoch (US-16 AC2a). The record half refuses while this tab's
 *  erase runs, from its confirm (lead A6); the shown half covers the gap
 *  between the record moving and the screen showing it. */
export function stillShown(asked: string): boolean {
  return asked === getEraseIdentity() && asked === getShownErase() && !store?.refuses(asked);
}
/** Whether this tab's erase runs, from its confirm to the end of its write
 *  (the session's erasing mode, which refuses a write at any erase). */
export function eraseRunsHere(): boolean {
  return !!store && store.refuses(store.eraseIdentity);
}
/** After an erase: clear this device's off-file health data by the record
 *  session's one rule, which spares the originals of documents that outlive
 *  the erase (US-11 AC6). The page never clears stored originals itself. The
 *  legacy v1 blob goes first. The page's forget door and the crash screen's (US-11 AC14). */
export function clearOffFileAfterErase(): void {
  clearLocalStorage();
  store?.clearOffFileData(); // a failed clear stays owed: the next load clears again (US-11 AC6)
}
export function markEraseShown(identity: string): void {
  store?.showErase(identity);
}

/** Where the record lives, as the usage counters name it (US-34). */
export function getBackendKind(): 'local' | 'cloud' {
  return store && store.backendId !== 'local' ? 'cloud' : 'local';
}

/** The open record's save status, for the storage line as it mounts; it then
 *  follows SAVE_STATUS_EVENT (US-09 AC30). Saved while no record is open. */
export function currentSaveStatus(): SaveStatus {
  return store?.saveStatus ?? 'saved';
}

/** True while a failed save will be retried (US-09 AC30), for Settings' waiting line; it
 *  follows SAVE_STATUS_EVENT too. False while no record is open. */
export function currentRetryDue(): boolean {
  return store?.retryDue ?? false;
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

/** The record as the store holds it now, unreadable rows included: what a write is checked against (US-75 AC5). Null while none is open. */
export function recordFileSync(): RoadmapFile | null {
  return store?.file ?? null;
}
/** The record as screens and the plan read it (US-65 readableView), for a plan the page works out itself (US-75 AC4). */
export function readableRecordSync(): RoadmapFile | null {
  return store ? readableView(store.file).file : null;
}

/** US-65: how many record entries this build could not read (kept unchanged, not shown). */
export function getUnreadableCount(): number {
  return store?.unreadableCount ?? 0;
}

/** US-67 N3: whether the record holds a `key` medication row this build cannot read. */
export function holdsUnreadableMedication(key: string, answered = false): boolean {
  return store?.holdsUnreadableMedication(key, answered) ?? false;
}

// --- lead capture (Shopify surface) ---
export function getReportEmailCaptured(): boolean {
  return store?.getReportEmailCaptured() ?? false;
}
export function markReportEmailCaptured(erase: string): boolean {
  return store?.markReportEmailCaptured(erase) ?? false;
}

// --- Lp(a)'s field unit, a profile preference (US-05 AC2; lpa-unit.ts reads it) ---
export function getLpaUnit(): unknown {
  return store?.getLpaUnit();
}
export function setLpaUnit(unit: LpaUnit, erase: string): boolean {
  return store?.setLpaUnit(unit, erase) ?? false;
}

// --- email reminders (§10) — used by the standalone RemindersControl ---
export function getReminderOptIn(): FileReminderOptIn | undefined {
  return store?.getReminderOptIn();
}
/** Opt-in rows, one token each, in one guarded edit; every other token's row stays (US-17 AC19). */
export function setReminderRows(rows: ReminderRowFields[], erase: string): boolean {
  return store?.setReminderRows(rows, erase) ?? false;
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
// Each async read below is `async () => xSync()` on purpose: a store throw becomes a rejection, which email-landing.tsx and useRecordReads.ts catch (US-09 AC16; lead W2-13 closed).
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
  // Supplements and documents count too: a record of only those still opens the whole form (US-62 AC13).
  return !!result && (Object.keys(result.inputs).length > 0 || result.previousMeasurements.length > 0 || result.medications.length > 0 || result.screenings.length > 0
    || result.supplements.length > 0 || result.documents.length > 0);
}
export async function loadAllHistory(): Promise<ApiMeasurement[]> {
  return loadAllHistorySync();
}
export function loadAllHistorySync(): ApiMeasurement[] {
  return store ? store.loadAllHistory() : [];
}
export async function loadMedicationHistory(): Promise<ApiMedicationHistory[]> {
  return store ? store.loadMedicationHistory() : [];
}
export async function loadLabValues(): Promise<ApiLabValue[] | null> {
  return loadLabValuesSync();
}
export function loadLabValuesSync(): ApiLabValue[] | null {
  return store ? store.loadLabValues() : null;
}
/** My health's worked-out series (US-62 AC21), over the screen's profile; none before the store opens. */
export function loadDerivedSeries(shown: Parameters<RoadmapStore['loadDerivedSeries']>[0]): DerivedSeries {
  return store ? store.loadDerivedSeries(shown) : { whtr: [], egfr: [] };
}

// --- writes ---
// `erase`, required: the erase the page showed when the write was asked for (US-16 AC2a).
/** US-07 AC11's usage signal: each prompted measure the rows just ADDED, once, by name
 *  alone. A blood pressure counts only once both halves of its day are on record. */
const MEASURE_OF: Partial<Record<MetricType, (typeof MEASURES)[number]>> = { waist: 'waist', systolic_bp: 'blood_pressure', diastolic_bp: 'blood_pressure' };
const OTHER_HALF: Partial<Record<MetricType, MetricType>> = { systolic_bp: 'diastolic_bp', diastolic_bp: 'systolic_bp' };
export function countMeasuresAdded(added: ApiMeasurement[]): void {
  if (!store || added.length === 0) return;
  const active = store.loadAllHistory();
  const complete = (row: ApiMeasurement) => {
    const other = OTHER_HALF[row.metricType as MetricType];
    return !other || active.some((m) => m.metricType === other && dayOf(m.recordedAt) === dayOf(row.recordedAt));
  };
  const measures = new Set(added.filter(complete).map((row) => MEASURE_OF[row.metricType as MetricType]).filter((m) => m !== undefined));
  for (const measure of measures) trackProductEvent('measurement_added', { measure });
}
/** `counted` false: the caller counts the row itself once the store has kept it (US-74 review C8). */
export async function addMeasurement(metricType: string, value: number, recordedAt: string | undefined, erase: string, counted = true): Promise<AddMeasurementResult> {
  const result: AddMeasurementResult = store ? await store.addMeasurement(metricType, value, recordedAt, erase) : { status: 'error' };
  if (counted && result.status === 'inserted') countMeasuresAdded([result.row]);
  return result;
}
/** Correct a saved core or lab value; `newValue` is in the unit it is stored in. */
export async function correctValue(id: string, newValue: number, erase: string): Promise<CorrectStatus> {
  return store ? store.correctValue(id, newValue, erase) : 'error';
}
/** What moving a saved blood test would do (US-04 AC5); null with no record open. */
export function previewMove(from: string, to: string): MovePlan | MoveRejection | null {
  return store ? store.previewMove(from, to) : null;
}
/** Move a saved blood test to the day it was drawn, as previewed (US-04 AC5). */
export async function moveBloodTest(from: string, to: string, expectedIds: string[], keep: MoveKeep, erase: string): Promise<MoveOutcome> {
  return store ? store.moveBloodTest(from, to, expectedIds, keep, erase) : { status: 'error' };
}
export async function saveChangedMeasurements(current: Partial<HealthInputs>, previous: Partial<HealthInputs>, erase: string): Promise<ProfileSave> {
  const result: ProfileSave = store ? await store.saveChangedMeasurements(current, previous, erase) : { ok: false };
  if (result.ok) countMeasuresAdded(result.added);
  return result;
}
export async function saveMedication(medicationKey: string, drugName: string, doseValue: number | null = null, doseUnit: string | null = null, erase: string): Promise<boolean> {
  return store ? store.saveMedication(medicationKey, drugName, doseValue, doseUnit, erase) : false;
}
export async function saveSupplement(supplementKey: string, supplementName: string, doseValue: number | null = null, doseUnit: string | null = null, status = 'active', startedAt: string | undefined, erase: string): Promise<boolean> {
  return store ? store.saveSupplement(supplementKey, supplementName, doseValue, doseUnit, status, startedAt, erase) : false;
}
export async function deleteSupplementApi(supplementKey: string, erase: string): Promise<boolean> {
  return store ? store.deleteSupplementApi(supplementKey, erase) : false;
}
export async function saveScreening(screeningKey: string, value: string, erase: string): Promise<boolean> {
  return store ? store.saveScreening(screeningKey, value, erase) : false;
}
/** One refused core value, counted like a refused lab unit, in closed words only (US-35 AC17). The
 *  metric rides only on an invalid value: an out-of-range one would say this
 *  visitor's value is past a bound, and an unknown metric is free text. An
 *  out-of-range metric still keys the tab's throttle, locally, so two tests
 *  past their bounds count twice. */
function countMeasurementRefused(reason: MeasurementRefusal['reason'], metricType: string | undefined): void {
  if (MEASUREMENT_REFUSALS_WITH_METRIC.includes(reason)) trackProductEvent('measurement_refused', { metric: metricType as MetricType, refusal: reason });
  else if (reason === 'out-of-range') trackProductEvent('measurement_refused', { refusal: reason }, metricType);
  else trackProductEvent('measurement_refused', { refusal: reason });
}
export async function bulkSaveMeasurements(measurements: BulkMeasurementInput[], erase: string): Promise<BulkSaveResult> {
  if (!store) return { saved: [], skippedDuplicates: 0, errorCount: measurements.length, refused: [] };
  const result = store.bulkSaveMeasurements(measurements, erase);
  for (const row of result.refused) countMeasurementRefused(row.reason, row.metricType);
  countMeasuresAdded(result.saved.filter((row) => !row.correctsId));
  return result;
}
/** A lab value a person adds (US-21 AC2, US-25 AC25), by health-core's one lab add; null when nothing could be written. */
export async function addLabValue(input: AddLabValueRequest, erase: string): Promise<AddLabValueResult | null> {
  const result = store ? store.addLabValue(input, erase) : null;
  if (result && !result.ok && result.refused) countRefusedSpellings([result.refused]);
  return result;
}
/** The shared upload's one Save (storage/upload-save-store.ts), and the counts today's writers send for it: each lab
 *  the review did not send for its unit or number, by its own refusal (`lab_unit_refused`, US-21 AC15, as the grid's
 *  Save counts them), and the vitals the commit added. A core value the write refuses never reaches Save: the review
 *  holds it as unsure until it is cleared. With no record open, the Save fails. The flow's Save (lib/upload-shared-save.ts) calls it. */
export async function saveUpload(engine: UploadEngine, s: WebSaving, now: string, io: WebUploadIO, person?: ScreeningPerson): Promise<UploadSaveAnswer> {
  if (!store) return { ok: false, reason: 'no-record', message: SAVE_FAILED };
  // The review uploadSave judges, on the record it starts from (uploadSave builds its own; it takes none).
  const refused = engine.uploadReview(s, store.file, now).classification.values.flatMap((v) => (v.group === 'notSaved' && v.refusal && 'lab' in v.refusal ? [v.refusal.lab] : []));
  const answer = await store.saveUpload(engine, s, now, getDocumentArchiveMode() === 'cloud', io, person);
  if (!answer.ok) return answer;
  countRefusedSpellings(refused);
  // The rows the commit refused, the record having changed since the review (US-12 AC6): each core value as the
  // store's writer counts it, each lab unit refusal as `countRefusedSpellings` words it (the code is made only for a
  // unit the test does not take). A lab `value` code sends nothing: no event counts a refused lab number today.
  for (const code of answer.outcome.refusedCodes ?? []) {
    if (code.kind === 'measurement') countMeasurementRefused(code.reason, code.metricType);
    else if (code.reason === 'unit') trackProductEvent('lab_unit_refused', code.unit !== undefined ? { key: code.key, unit: code.unit } : { key: code.key });
  }
  countMeasuresAdded(answer.added);
  return answer;
}
export async function deleteDocument(documentId: string, erase: string): Promise<boolean> {
  return store ? store.deleteDocument(documentId, erase) : false;
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
 * Teardown for the erase, registered by the standalone entry. `src/` must
 * never import `standalone/`, so the dependency is injected rather than
 * imported. Today it is the reminders row on Brad's server: "delete all my
 * data" has to include the one copy that isn't on the device. The token that
 * authorises it is gone from the erased file, so the hook (prepare) reads it
 * inside the erase, before the swap, and returns the step that sends it
 * (commit), run only once the erase stands (US-11 AC4c).
 */
/** `read`: every opt-in the erase read up to its swap; `landed`: the opt-in of the copy that took its write, as read back (US-11 AC15). */
export type EraseSeen = { read: FileReminderOptIn[]; landed: FileReminderOptIn | undefined };
type EraseCommit = (seen: EraseSeen) => Promise<void>;
let preEraseHook: (() => Promise<EraseCommit | null>) | null = null;
export function setPreEraseHook(fn: () => Promise<EraseCommit | null>): void {
  preEraseHook = fn;
}

export async function deleteUserData(): Promise<{ success: boolean; error?: string; warning?: string; chat: EraseChatStep | null }> {
  if (!store) return { success: false, error: 'Data store not initialised', chat: null };
  eraseBegan(); // a chat reply asked before this is not saved (US-11 AC2h)
  // The order and the best-effort rules are the record session's (health-core
  // deleteAllData): it reads the record first, and an erase that cannot read
  // it is refused before either step runs (US-09 AC23). Chat goes through the
  // singleton, so an open chat panel's instance is the one erased. A history
  // that could not be opened rejects, so the session reports it and never
  // counts it erased (US-11 AC2c): 'unread' in the cloud, 'unopened' on this
  // device, where a record erase that stands removes the file itself (AC3).
  // `step` stays null until the chat step begins, so the page says only what
  // ran (US-11 AC13). Counted erased with no chat layer registered: no history.
  let step: EraseChatStep | null = null;
  const failed: EraseChatStep = getBackendKind() === 'local' ? 'unopened' : 'unread';
  const chat = () => {
    step = 'unreached';
    return openChatHistory().catch((error: unknown) => {
      step = failed;
      throw error;
    });
  };
  const prepare = preEraseHook;
  let commit = null as EraseCommit | null;
  // Every opt-in the erase read, handed over at its swap (US-11 AC15); memory only.
  const seen: EraseSeen = { read: [], landed: undefined };
  const before = store.eraseIdentity;
  const { chatErased, ...result } = await store.deleteAllData({
    teardown: prepare ? async () => { commit = await prepare(); } : undefined,
    chat,
    swapping: (optIns) => { seen.read = optIns; },
    landed: (optIn) => { seen.landed = optIn; },
  });
  // The erased copy stands, landed or held for a retry (useErase's signal): only
  // then does the server step run, once. A refused erase cancels nothing (S59).
  if (store.eraseIdentity !== before) await commit?.(seen);
  const ran = step as EraseChatStep | null; // set in the closures above, which TS's narrowing does not see
  return { ...result, chat: ran && (chatErased ? 'erased' : ran) };
}

// ---------------------------------------------------------------------------
// Report actions — client-side on the local-first builds. Print/save-as-PDF
// is a true-to-screen snapshot; the Email Report button is GONE on both v2
// surfaces (Brad, 2026-06-11 — the mailto self-copy was a degraded plain-text
// duplicate of the guest-report email, which is now the delivery path on the
// Shopify surface).
// ---------------------------------------------------------------------------

/** The plan as its PDF prints it (My health keeps it hidden, ResultsPanel's
 *  PlanReport), cloned and shown, with interactive chrome stripped. */
function clonePlanPanel(): HTMLElement | null {
  const panel = document.querySelector('.health-results-panel');
  if (!panel) return null;
  const clone = panel.cloneNode(true) as HTMLElement;
  clone.hidden = false;
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
