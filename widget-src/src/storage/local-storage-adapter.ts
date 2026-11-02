/**
 * The "no-sync / single-device" tier (implementation plan §5.1) — a real
 * StorageAdapter backed by localStorage. This is what a user gets before they
 * connect a cloud, and it's how the standalone app runs on GitHub Pages with no
 * Brad server and no cloud key. Same SyncManager code path as the cloud
 * adapters, so wiring the app once covers both.
 *
 * Caveat (surfaced to the user elsewhere): localStorage is device-only and can
 * be evicted by the browser. The cloud file is the durable store; this is a cache.
 */
import {
  DOC_KEY_PREFIX, localHealthWritesStopped, removeByPrefix, safeGetItem, safeRemoveItem, safeSetItem, stopLocalHealthWrites,
} from '../lib/storage';
import {
  ConflictError,
  ROADMAP_FILE_NAME,
  StorageError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from '@roadmap/health-core';

// The roadmap file keeps its ORIGINAL keys (existing users' device data lives
// under them); other named files (chat-history.json, …) get namespaced keys.
const FILE_KEY = 'health_roadmap_file_v2';
/** Namespaced key prefix for the non-record files (chat-history.json, …), and
 *  their version keys. The record file's own keys never carry the colon, so a
 *  sweep of this prefix leaves health-roadmap.json alone — which is what an
 *  erase needs in local mode, where the file must survive to carry eraseEpoch. */
export const NAMED_FILE_PREFIX = 'health_roadmap_file_v2:';

// Page-lifetime barrier: logout navigates away. Never reopen it in this page;
// an async save may still hold pre-logout health data. Other named files are
// separate stores and are deliberately outside this roadmap-only barrier.
// Every other cloud-mode tab on this device latches too (US-09 AC2c): a
// content-free key set and removed at once reaches them as `storage` events,
// leaving no residue.
const LOG_OFF_SIGNAL_KEY = 'health_roadmap_log_off_signal';
// The flag itself is in lib/storage, shared with the mirror and the drafts.
export function stopRoadmapLocalWrites(): void {
  stopLocalHealthWrites();
  signalLogOff();
}
/** Tell the other tabs. A full localStorage drops the write silently, so
 *  log-off sends it again once the device wipe has freed space (Codex R1). */
export function signalLogOff(): void {
  safeSetItem(LOG_OFF_SIGNAL_KEY, '1');
  safeRemoveItem(LOG_OFF_SIGNAL_KEY);
}
function latchOnLogOffSignal(event: Event): void {
  if ((event as StorageEvent).key === LOG_OFF_SIGNAL_KEY) stopLocalHealthWrites();
}
/** Only a cloud-mode page listens: there the device copy is a mirror. A local
 *  page's device copy is its only store, so latching would lose its edits.
 *  Re-adding the same listener is a no-op. */
export function latchOnOtherTabsLogOff(): void {
  if (typeof window !== 'undefined') window.addEventListener('storage', latchOnLogOffSignal);
}
export function roadmapLocalWritesStopped(): boolean {
  return localHealthWritesStopped();
}

// Content-free invalidation only: no message ids, text, health values or times.
// Keep it outside the wiped prefixes so a later log-off cannot reset the fence.
const LOCAL_ERASE_GENERATION_KEY = 'health_roadmap_local_erase_generation';
export function localEraseGeneration(): string | null {
  return safeGetItem(LOCAL_ERASE_GENERATION_KEY);
}
export function clearLocalNamedFiles(): void {
  // Shared stores also run without a browser; then there is no device copy.
  if (typeof localStorage === 'undefined') return;
  removeByPrefix(NAMED_FILE_PREFIX);
  try {
    localStorage.setItem(LOCAL_ERASE_GENERATION_KEY, crypto.randomUUID());
  } catch (error) {
    // A missing fence could let an old tab write erased content back. Do not
    // report completed cleanup if invalidation could not be stored.
    throw new StorageError('Could not complete on-device history cleanup.', undefined, error);
  }
}

function fileKey(fileName: string): string {
  return fileName === ROADMAP_FILE_NAME ? FILE_KEY : NAMED_FILE_PREFIX + fileName;
}
function versionKey(fileName: string): string {
  return `${fileKey(fileName)}_rev`;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly id = 'local' as const;
  readonly label = 'This device only';

  async connect(): Promise<void> {
    /* nothing to authorise */
  }
  isConnected(): boolean {
    return true;
  }
  async disconnect(): Promise<void> {
    safeRemoveItem(fileKey(ROADMAP_FILE_NAME));
    safeRemoveItem(versionKey(ROADMAP_FILE_NAME));
    // Named record files (chat-history.json, …) and stored documents live under
    // their prefixes — clear both so log-off leaves no health data behind on a
    // shared device. Documents go first: the named-file fence write can throw.
    removeByPrefix(DOC_KEY_PREFIX);
    clearLocalNamedFiles();
  }

  // localStorage is synchronous, so read and write wrap readSync and writeSync.
  // The tab-close save calls those directly, so its write lands before the
  // handler returns (US-10 AC5).
  async read(fileName: string): Promise<ReadResult> {
    return this.readSync(fileName);
  }

  async write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    return this.writeSync(fileName, body, expectedVersion);
  }

  readSync(fileName: string): ReadResult {
    const raw = safeGetItem(fileKey(fileName));
    if (raw == null) return { body: null, version: null };
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (error) {
      throw new StorageError('Local data is corrupt and could not be read.', undefined, error);
    }
    return { body, version: safeGetItem(versionKey(fileName)) ?? '0' };
  }

  writeSync(fileName: string, body: object, expectedVersion: string | null): WriteResult {
    // Check at the synchronous write boundary, including saves whose async
    // read/merge began BEFORE logout. A catch-only guard is too early.
    if (fileName === ROADMAP_FILE_NAME && roadmapLocalWritesStopped()) {
      throw new StorageError('On-device roadmap persistence stopped for logout.');
    }
    // `?? '0'` is defensive: localStorage is externally mutable, so tolerate a
    // present file with a missing version key (treat it as version 0).
    const current = safeGetItem(fileKey(fileName)) == null ? null : safeGetItem(versionKey(fileName)) ?? '0';
    if (expectedVersion !== current) {
      // Best-effort multi-tab guard: catches a tab that wrote in between, on its
      // next save. This is NOT a true cross-tab compare-and-swap (localStorage
      // has none): two tabs can read one version before either hears the
      // other's write. SyncManager re-reads & re-merges.
      throw new ConflictError(`expected version ${expectedVersion}, but local is ${current}`);
    }
    // A count and a random suffix: a record removed (a log-off) and made again
    // must never repeat a revision a tab has already seen (US-34 AC6). Only
    // equality is ever asked of it, so an older bundle's plain count checks too.
    const next = `${(parseInt(current ?? '0', 10) || 0) + 1}-${Math.random().toString(36).slice(2, 10)}`;
    const previous = safeGetItem(fileKey(fileName));
    const written = JSON.stringify(body);
    try {
      localStorage.setItem(fileKey(fileName), written);
    } catch (error) {
      throw new StorageError(FULL, undefined, error);
    }
    try {
      localStorage.setItem(versionKey(fileName), next);
    } catch (error) {
      // A record left under the old revision would let a stale tab's save
      // pass the check above and replace it, so the old record goes back
      // (US-34 AC6a). It fitted before this save. If another tab wrote in
      // between, or the old record will not fit, the revision goes instead:
      // removing a key cannot hit the quota, and every tab then re-reads.
      const restored = safeGetItem(fileKey(fileName)) === written && restoreItem(fileKey(fileName), previous);
      if (!restored) safeRemoveItem(versionKey(fileName));
      throw new StorageError(FULL, restored ? undefined : 'This change may have been stored. Read the record again before trying it a second time.', error);
    }
    return { version: next };
  }

  /** The file's stored revision, null when there is none: the version
   *  writeSync checks, so an erase can replace bytes no record reads (US-11
   *  AC9). Cheap, so a tab can ask each time it comes back (US-34 AC6). */
  revision(fileName: string): string | null {
    return safeGetItem(fileKey(fileName)) == null ? null : safeGetItem(versionKey(fileName)) ?? '0';
  }

  /** Another tab's save. The browser fires `storage` in every OTHER tab of
   *  this origin when one tab changes a key (US-34 AC6). Only this file's key
   *  counts, and a clear(), which names no key. */
  watch(fileName: string, onChange: () => void, signal: AbortSignal): void {
    const key = fileKey(fileName);
    const heard = (event: StorageEvent) => {
      if (event.key === key || event.key === null) onChange();
    };
    window.addEventListener('storage', heard, { signal });
  }

  async readDocument(ref: string): Promise<Blob> {
    const dataUrl = safeGetItem(DOC_KEY_PREFIX + ref);
    if (dataUrl == null) throw new StorageError(`document not found: ${ref}`);
    return (await fetch(dataUrl)).blob(); // data: URLs are fetchable → preserves mime type
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    const dataUrl = await blobToDataUrl(bytes);
    try {
      // Direct setItem (not safeSetItem) so a quota overflow surfaces instead of
      // silently dropping the document — no silent data loss.
      localStorage.setItem(DOC_KEY_PREFIX + ref, dataUrl);
    } catch (error) {
      throw new StorageError(
        'Could not store the document on this device (local storage is likely full). Connect a cloud backend for documents.',
        undefined,
        error,
      );
    }
  }
}

const FULL = 'Could not save on this device (local storage may be full).';

/** Put a key back as it was (`null`: absent). False when the write refuses. */
function restoreItem(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
