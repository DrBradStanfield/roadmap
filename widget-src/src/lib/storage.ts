import type { HealthInputs } from '@roadmap/health-core/types';
import { type ApiMeasurement, type ApiMedication, type ApiScreening, mergeLongitudinalInputs, PREFILL_FIELDS } from '@roadmap/health-core/mappings';
import { type ChatContextPayload, chatContextOf } from '@roadmap/health-core/chat-context';
import { type LabEgfr, withLabEgfr, labEgfrFrom } from '@roadmap/health-core/plan';
import { type UnitSystem, detectUnitSystem } from '@roadmap/health-core/units';
import { sanitizeInputs } from '@roadmap/health-core/validation';
import { dayOf, localDay } from '@roadmap/health-core/merge';
import { isComparator } from '@roadmap/health-core/lab-limits';
import { isClinicalDay } from '@roadmap/health-core/measurement-history';
import type { ApiReminderPreference } from './api-types';
import { randomId } from './random-id';

/** The mirror: HealthTool's copy of the saved record, which the chatbot embed
 *  and the blog bubble read (US-15 AC10). It holds what is saved, never a
 *  value typed into the form and not yet saved. */
export const MIRROR_KEY = 'health_roadmap_data';
/** Fired on this page by every write to the mirror. Another tab's write
 *  arrives as a `storage` event for MIRROR_KEY instead. */
export const MIRROR_CHANGED_EVENT = 'hr:inputs-changed';
const UNIT_PREF_KEY = 'health_roadmap_unit_system';

/** Where this page may write health data on the device (US-09 AC2c, AC2e,
 *  AC2h). 'loading': no record has opened yet; it may only while this
 *  device's log-off id is the one the page loaded with, and it holds another
 *  tab's log-off heard meanwhile until it knows which kind of page it is.
 *  'device': its device copy is its only store, so it always may. 'cloud': a
 *  cloud record opened here, so it may only while the id is the one it loaded
 *  with. 'stopped': its own log-off, or another tab's heard on a cloud page.
 *  Never back: log-off navigates away. It lives in this module, which every
 *  device writer imports, so all of them check the same state. */
export type HealthWrites =
  | { mode: 'loading'; logOffHeard: boolean }
  | { mode: 'device' }
  | { mode: 'cloud' }
  | { mode: 'stopped' };
export type HealthWritesEvent = 'deviceOpened' | 'cloudOpened' | 'logOffHeard' | 'stop';
export function healthWritesTransition(state: HealthWrites, event: HealthWritesEvent): HealthWrites {
  if (state.mode === 'stopped' || event === 'stop') return { mode: 'stopped' };
  if (event === 'logOffHeard') {
    if (state.mode === 'loading') return { mode: 'loading', logOffHeard: true };
    // A device page's copy is its only store, so a heard log-off never stops it.
    return state.mode === 'cloud' ? { mode: 'stopped' } : state;
  }
  if (event === 'cloudOpened') return state.mode === 'loading' && state.logOffHeard ? { mode: 'stopped' } : { mode: 'cloud' };
  // A load that fell back to the device drops the heard log-off; a cloud page stays one.
  return state.mode === 'cloud' ? state : { mode: 'device' };
}
let healthWrites: HealthWrites = { mode: 'loading', logOffHeard: false };
const dispatchHealthWrites = (event: HealthWritesEvent) => { healthWrites = healthWritesTransition(healthWrites, event); };
export function stopLocalHealthWrites(): void {
  dispatchHealthWrites('stop');
}
/** A cloud record has opened on this page (the web host's mirror.opened()). */
export function noteCloudPage(): void {
  dispatchHealthWrites('cloudOpened');
}
/** This page runs on the device tier: a guest, or a cloud load's fallback. */
export function noteDevicePage(): void {
  dispatchHealthWrites('deviceOpened');
}
/** Another tab's log-off signal reached this page. */
export function noteLogOffHeard(): void {
  dispatchHealthWrites('logOffHeard');
}
/** This page's own log-off, or another tab's it heard: the device was wiped. */
export function healthWritesStopped(): boolean {
  return healthWrites.mode === 'stopped';
}
/** The one check every on-device health writer makes.
 *  The single rule for on-device health writes; callers import it, never copy it. */
export function healthWritesAllowed(): boolean {
  if (healthWrites.mode === 'device') return true;
  return healthWrites.mode !== 'stopped' && logOffId() === logOffIdAtLoad;
}

interface StoredData {
  inputs: Partial<HealthInputs>;
  previousMeasurements?: ApiMeasurement[];
  medications?: ApiMedication[];
  screenings?: ApiScreening[];
  reminderPreferences?: ApiReminderPreference[];
  /** The saved lab eGFR candidate (US-07 AC7): the other chats hold no lab rows. */
  labEgfr?: LabEgfr | null;
  /** The newest usable saved PSA (US-06 AC14): the newest row per metric may be one the plan cannot use. */
  psa?: ApiMeasurement | null;
  savedAt: string;
}

export interface LoadedData {
  inputs: Partial<HealthInputs>;
  previousMeasurements: ApiMeasurement[];
  medications: ApiMedication[];
  screenings: ApiScreening[];
  reminderPreferences: ApiReminderPreference[];
  labEgfr: LabEgfr | null;
  psa: ApiMeasurement | null;
}

/**
 * Write the mirror: the saved profile as `inputs`, the newest saved row per
 * metric, the medications and screenings on record, and the saved lab eGFR
 * (labEgfrOf over the record's lab rows). Tells the page.
 */
export function saveToLocalStorage(inputs: Partial<HealthInputs>, previousMeasurements?: ApiMeasurement[], medications?: ApiMedication[], screenings?: ApiScreening[], reminderPreferences?: ApiReminderPreference[], labEgfr?: LabEgfr | null, psa?: ApiMeasurement | null): void {
  // After log-off the mirror stays gone: a cloud tab's later saves end here
  // (patchMirror too) and would put the health copy back (US-09 AC2e).
  if (!healthWritesAllowed()) return;
  try {
    const data: StoredData = {
      inputs,
      previousMeasurements,
      medications,
      screenings,
      reminderPreferences,
      // A lab eGFR printed as a limit keeps its limit and drops the plan's
      // representative, which an older embed would read as exact (US-12 AC20).
      labEgfr: labEgfr?.labEgfrLimit ? { labEgfrDate: labEgfr.labEgfrDate, labEgfrLimit: labEgfr.labEgfrLimit } : labEgfr,
      psa: psa ?? null,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(MIRROR_KEY, JSON.stringify(data));
    window.dispatchEvent(new Event(MIRROR_CHANGED_EVENT));
  } catch (error) {
    console.warn('Failed to save to localStorage:', error);
  }
}

/**
 * Replace one part of the mirror (the saved profile, the medications or the
 * screenings) and keep the rest, so no saver can write form inputs into it.
 */
export function patchMirror(patch: { profile?: Partial<HealthInputs> } & Partial<Pick<LoadedData, 'medications' | 'screenings' | 'labEgfr'>>): void {
  const cached = loadFromLocalStorage();
  saveToLocalStorage(
    patch.profile ?? cached?.inputs ?? {},
    cached?.previousMeasurements ?? [],
    patch.medications ?? cached?.medications ?? [],
    patch.screenings ?? cached?.screenings ?? [],
    cached?.reminderPreferences ?? [],
    patch.labEgfr !== undefined ? patch.labEgfr : cached?.labEgfr ?? null,
    cached?.psa ?? null,
  );
}

/**
 * Load health inputs and previousMeasurements from localStorage.
 */
export function loadFromLocalStorage(): LoadedData | null {
  try {
    const stored = localStorage.getItem(MIRROR_KEY);
    if (!stored) return null;

    const data: StoredData = JSON.parse(stored);

    // Validate ALL input fields against the Zod schema (single source of truth).
    // localStorage is an untrusted boundary — extensions, corrupted writes, or
    // stale data can inject NaN, Infinity, or out-of-range values that crash
    // the widget. Invalid fields are stripped.
    const sanitizedInputs = sanitizeInputs(data.inputs ?? {});
    // `inputs` is the saved profile. Any other field there is a stale form
    // value an older bundle wrote, which must not outrank a saved value
    // (US-15 AC10), so only the profile and the unit system are kept.
    const inputs: Partial<HealthInputs> = {};
    for (const field of [...PREFILL_FIELDS, 'unitSystem'] as const) {
      if (sanitizedInputs[field] !== undefined) (inputs as Record<string, unknown>)[field] = sanitizedInputs[field];
    }
    const lab = sanitizeInputs({ labEgfr: data.labEgfr?.labEgfr, labEgfrDate: data.labEgfr?.labEgfrDate });
    // A lab eGFR printed as a limit (US-12 AC20): its code and bound, graded again by the plan's rule.
    const sentLimit = data.labEgfr?.labEgfrLimit;
    const limit = sentLimit && isComparator(sentLimit.comparator) && Number.isFinite(sentLimit.bound) ? sentLimit : null;

    return {
      inputs,
      // Coerce measurement values to numbers and filter out non-finite values.
      // Stale localStorage may contain PostgREST NUMERIC strings (e.g. "5.2")
      // or corrupted NaN/Infinity values.
      previousMeasurements: (data.previousMeasurements ?? [])
        .filter(m => m.value != null && (m.value as unknown) !== '' && Number.isFinite(Number(m.value)))
        // A comparator this build cannot read makes the row unreadable, as in the record (US-12 AC20, US-65).
        .filter(m => m.comparator === undefined || isComparator(m.comparator))
        .map(m => ({ ...m, value: Number(m.value) })),
      medications: data.medications ?? [],
      screenings: data.screenings ?? [],
      reminderPreferences: data.reminderPreferences ?? [],
      labEgfr: lab.labEgfrDate === undefined ? null
        : limit ? labEgfrFrom(limit.bound, lab.labEgfrDate, limit.comparator)
        : lab.labEgfr !== undefined ? labEgfrFrom(lab.labEgfr, lab.labEgfrDate) : null,
      // An untrusted copy: a PSA row only with a number (this field was only ever
      // written as one, so null, "" or text is no PSA, never a 0), a real day and
      // a readable comparator.
      psa: data.psa && typeof data.psa.value === 'number' && Number.isFinite(data.psa.value) && isClinicalDay(data.psa.recordedAt)
        && (data.psa.comparator === undefined || isComparator(data.psa.comparator))
        ? { ...data.psa, metricType: 'psa' } : null,
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
    localStorage.removeItem(MIRROR_KEY);
    localStorage.removeItem('health_roadmap_authenticated');
    // An embed on this page mutes after an erase (US-11).
    window.dispatchEvent(new Event(MIRROR_CHANGED_EVENT));
  } catch (error) {
    console.warn('Failed to clear localStorage:', error);
  }
}

// Health data that lives OUTSIDE the roadmap file, one key each. An erase has
// to name them: a prefix wipe of `health_roadmap_*` would take the cloud
// tokens, the remembered backend, the device id and the consent flags with it,
// logging the user out and resetting decisions they already made.
/** Uploaded document blobs (LocalStorageAdapter writes them under this). */
export const DOC_KEY_PREFIX = 'health_roadmap_doc_v2:';
/** The blood-test matrix's typed-but-unsaved values (BloodTestTimeline). */
export const BT_TIMELINE_DRAFT_KEY = 'health_roadmap_bt_timeline_draft';
/** The vitals matrix's typed-but-unsaved values (StartingInfoVitals). */
export const VITALS_DRAFT_KEY = 'health_roadmap_vitals_draft';
/** The Lp(a) rows the user kept as saved when asked (US-05 AC3, lpa-unit.ts). */
export const LPA_CHECK_KEPT_KEY = 'health_roadmap_lpa_check_kept';

/**
 * Remove the stored document blobs, both matrices' unsaved drafts and the
 * Lp(a) check's kept answers — the on-device health data an erase would
 * otherwise leave behind. `keepDocument` spares the blobs of documents an
 * erase did not remove (US-09 AC20, AC23): by default none is spared.
 */
export function clearOffFileHealthData(keepDocument: (ref: string) => boolean = () => false): void {
  clearMatrixDrafts();
  removeByPrefix(DOC_KEY_PREFIX, (key) => keepDocument(key.slice(DOC_KEY_PREFIX.length)));
  safeRemoveItem(LPA_CHECK_KEPT_KEY);
}

/** Fired by `clearMatrixDrafts`: a matrix on screen drops its own copy of
 *  the draft too (useMatrixDraft), or its next keystroke writes it back. */
export const DRAFTS_CLEARED_EVENT = 'hr:drafts-cleared';

/** Remove both matrices' unsaved drafts: an erase, made here or on another
 *  device, leaves none behind (US-11). */
function clearMatrixDrafts(): void {
  safeRemoveItem(BT_TIMELINE_DRAFT_KEY);
  safeRemoveItem(VITALS_DRAFT_KEY);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DRAFTS_CLEARED_EVENT));
}

/** Remove every stored key under `prefix` (document blobs, named record
 *  files), except those `keep` names. */
export function removeByPrefix(prefix: string, keep: (key: string) => boolean = () => false): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix) && !keep(key)) safeRemoveItem(key);
    }
  } catch {
    /* storage unavailable — nothing to clear */
  }
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

/** Read + JSON-parse a localStorage value; null if absent or corrupt. */
export function getJson<T>(key: string): T | null {
  const raw = safeGetItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** JSON-stringify + write a localStorage value. */
export function setJson(key: string, value: unknown): void {
  safeSetItem(key, JSON.stringify(value));
}

// health_roadmap_log_off_id: a random id, new at every log-off on this device,
// never an account or email. A cloud sign-in carries the id it began under and
// counts only while that id is current (US-09 AC45). It sits outside every
// prefix a log-off or an erase wipes, so neither can set it back to an old id.
const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
/** The id a sign-in began under: null before this device's first log-off. */
export type LogOffId = string | null;
export function logOffId(): LogOffId {
  return safeGetItem(LOG_OFF_ID_KEY);
}
/** Read once, as this page loads; never reassigned (US-09 AC2c). */
// Read once at load; a page restored from the back-forward cache keeps it and is refused. Do not re-read it on pageshow.
const logOffIdAtLoad: LogOffId = logOffId();
/** A synchronous claim, not a mode: set before log-off's first await and never
 *  cleared (the page reloads), so a sign-in finishing during log-off's awaits
 *  is refused even when a full localStorage dropped the new id. It is not
 *  'stopped': a log-off heard from another tab stops health writes but leaves
 *  a sign-in begun under the new id free to save. */
let ownLogOffBegun = false;
/** At log-off, before any await. */
export function newLogOffId(): void {
  ownLogOffBegun = true;
  safeSetItem(LOG_OFF_ID_KEY, randomId());
}

/** Save a cloud sign-in entry with `gen` inside it, in one write, or the
 *  chosen provider as plain text, only while `gen` is this device's current
 *  log-off id (US-09 AC45). True when it was written. */
export function setSignIn(key: string, value: object | string, gen: LogOffId): boolean {
  if (ownLogOffBegun || gen !== logOffId()) return false;
  try {
    localStorage.setItem(key, signInText(value, gen));
    return true;
  } catch {
    return false;
  }
}
const signInText = (value: object | string, gen: LogOffId): string =>
  (typeof value === 'string' ? value : JSON.stringify({ ...value, gen }));

/** Save a sign-in kept in several entries, in order. When one is not saved,
 *  those this call saved are removed, each only while it still holds what this
 *  call wrote, so no partial sign-in is left. True when all were saved. */
export function setSignIns(entries: Record<string, object>, gen: LogOffId): boolean {
  const saved: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (setSignIn(key, value, gen)) { saved.push(key); continue; }
    for (const done of saved) if (safeGetItem(done) === signInText(entries[done], gen)) safeRemoveItem(done);
    return false;
  }
  return true;
}

/** The id an entry was saved under; one with none was saved before the first log-off. */
const genOf = (entry: object): LogOffId => (entry as { gen?: LogOffId }).gen ?? null;

/** A sign-in entry saved under the current log-off id, without that id; null otherwise. */
export function getSignIn<T>(key: string): T | null {
  const entry = getJson<object>(key);
  if (!entry || typeof entry !== 'object' || genOf(entry) !== logOffId()) return null;
  const { gen: _gen, ...rest } = entry as { gen?: LogOffId };
  return rest as T;
}

/** At page load: remove the entries under `keys` saved under another log-off id. */
export function sweepStaleSignIns(keys: readonly string[]): void {
  for (const key of keys) {
    const entry = getJson<object>(key);
    if (entry && typeof entry === 'object' && genOf(entry) !== logOffId()) safeRemoveItem(key);
  }
}


/**
 * The chat context for the bundles outside the widget (blog bubble, chatbot
 * embed), built as the widget builds its own (chatContextOf): the saved
 * profile, the latest saved values and their dates, the medications and
 * screenings on record, the saved lab eGFR when the plan reads it (US-07 AC7),
 * and the unit system the widget shows (US-15 AC10). Null if there is no data.
 */
export function loadGuestInputs(): ChatContextPayload | null {
  const cached = loadFromLocalStorage();
  if (!cached) return null;
  // The newest usable PSA stands in for the newest PSA row, in the snapshot
  // and the history alike, so the chat reads what the widget's cards read (US-06 AC14).
  const rows = cached.psa ? [...cached.previousMeasurements.filter(m => m.metricType !== 'psa'), cached.psa] : cached.previousMeasurements;
  const merged = mergeLongitudinalInputs(cached.inputs, rows);
  if (Object.keys(merged).length === 0) return null;
  const creatinine = rows.find(m => m.metricType === 'creatinine')?.recordedAt;
  const inputs = withLabEgfr(merged, typeof creatinine === 'string' ? dayOf(creatinine) : null, cached.labEgfr, localDay(new Date()));
  return chatContextOf(inputs, chatUnitSystem(cached.inputs.unitSystem), cached.medications, cached.screenings, rows);
}

/** The unit system a chat sends, as HealthTool picks it: the saved
 *  preference, else the record's, else the locale's (US-15 AC10). */
function chatUnitSystem(recorded: UnitSystem | undefined): UnitSystem {
  return loadUnitPreference() ?? recorded ?? detectUnitSystem();
}
