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
import { safeGetItem, safeRemoveItem, safeSetItem } from '../lib/storage';
import {
  ConflictError,
  ROADMAP_FILE_NAME,
  StorageError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from './adapter';

// The roadmap file keeps its ORIGINAL keys (existing users' device data lives
// under them); other named files (chat-history.json, …) get namespaced keys.
const FILE_KEY = 'health_roadmap_file_v2';
const NAMED_PREFIX = 'health_roadmap_file_v2:';
const DOC_PREFIX = 'health_roadmap_doc_v2:';

function fileKey(fileName: string): string {
  return fileName === ROADMAP_FILE_NAME ? FILE_KEY : NAMED_PREFIX + fileName;
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
    safeRemoveItem(FILE_KEY);
    safeRemoveItem(`${FILE_KEY}_rev`);
    // Named record files (chat-history.json, …) live under the prefix.
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(NAMED_PREFIX)) safeRemoveItem(key);
      }
    } catch {
      /* storage unavailable — nothing to clear */
    }
  }

  async read(fileName: string): Promise<ReadResult> {
    const raw = safeGetItem(fileKey(fileName));
    if (raw == null) return { body: null, version: null };
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new StorageError('Local data is corrupt and could not be read.', error);
    }
    return { body, version: safeGetItem(versionKey(fileName)) ?? '0' };
  }

  async write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    // `?? '0'` is defensive: localStorage is externally mutable, so tolerate a
    // present file with a missing version key (treat it as version 0).
    const current = safeGetItem(fileKey(fileName)) == null ? null : safeGetItem(versionKey(fileName)) ?? '0';
    if (expectedVersion !== current) {
      // Best-effort multi-tab guard: catches a tab that wrote in between, on its
      // next save. This is NOT a true cross-tab compare-and-swap (localStorage
      // has none) — full cross-tab coordination (storage events) is deferred;
      // this is the single-device tier. SyncManager re-reads & re-merges.
      throw new ConflictError(`expected version ${expectedVersion}, but local is ${current}`);
    }
    const next = String((Number(current) || 0) + 1);
    try {
      localStorage.setItem(fileKey(fileName), JSON.stringify(body));
    } catch (error) {
      throw new StorageError('Could not save on this device (local storage may be full).', error);
    }
    safeSetItem(versionKey(fileName), next);
    return { version: next };
  }

  /** Synchronous emergency write (tab-close) — see StorageAdapter.writeSync. */
  writeSync(fileName: string, body: object): void {
    const next = String((Number(safeGetItem(versionKey(fileName))) || 0) + 1);
    try {
      localStorage.setItem(fileKey(fileName), JSON.stringify(body));
      safeSetItem(versionKey(fileName), next);
    } catch {
      /* best effort on unload — nothing more we can do */
    }
  }

  async readDocument(ref: string): Promise<Blob> {
    const dataUrl = safeGetItem(DOC_PREFIX + ref);
    if (dataUrl == null) throw new StorageError(`document not found: ${ref}`);
    return (await fetch(dataUrl)).blob(); // data: URLs are fetchable → preserves mime type
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    const dataUrl = await blobToDataUrl(bytes);
    try {
      // Direct setItem (not safeSetItem) so a quota overflow surfaces instead of
      // silently dropping the document — no silent data loss.
      localStorage.setItem(DOC_PREFIX + ref, dataUrl);
    } catch (error) {
      throw new StorageError(
        'Could not store the document on this device (local storage is likely full). Connect a cloud backend for documents.',
        error,
      );
    }
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
