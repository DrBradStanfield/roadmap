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
import type { RoadmapFile } from '@roadmap/health-core';
import { safeGetItem, safeRemoveItem, safeSetItem } from '../lib/storage';
import {
  ConflictError,
  StorageError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from './adapter';

const FILE_KEY = 'health_roadmap_file_v2';
const VERSION_KEY = 'health_roadmap_file_v2_rev';
const DOC_PREFIX = 'health_roadmap_doc_v2:';

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
    safeRemoveItem(VERSION_KEY);
  }

  async read(): Promise<ReadResult> {
    const raw = safeGetItem(FILE_KEY);
    if (raw == null) return { file: null, version: null };
    let file: RoadmapFile;
    try {
      file = JSON.parse(raw) as RoadmapFile;
    } catch (error) {
      throw new StorageError('Local data is corrupt and could not be read.', error);
    }
    return { file, version: safeGetItem(VERSION_KEY) ?? '0' };
  }

  async write(file: RoadmapFile, expectedVersion: string | null): Promise<WriteResult> {
    // `?? '0'` is defensive: localStorage is externally mutable, so tolerate a
    // present file with a missing version key (treat it as version 0).
    const current = safeGetItem(FILE_KEY) == null ? null : safeGetItem(VERSION_KEY) ?? '0';
    if (expectedVersion !== current) {
      // Best-effort multi-tab guard: catches a tab that wrote in between, on its
      // next save. This is NOT a true cross-tab compare-and-swap (localStorage
      // has none) — full cross-tab coordination (storage events) is deferred;
      // this is the single-device tier. SyncManager re-reads & re-merges.
      throw new ConflictError(`expected version ${expectedVersion}, but local is ${current}`);
    }
    const next = String((Number(current) || 0) + 1);
    try {
      localStorage.setItem(FILE_KEY, JSON.stringify(file));
    } catch (error) {
      throw new StorageError('Could not save on this device (local storage may be full).', error);
    }
    safeSetItem(VERSION_KEY, next);
    return { version: next };
  }

  /** Synchronous emergency write (tab-close) — see StorageAdapter.writeSync. */
  writeSync(file: RoadmapFile): void {
    const next = String((Number(safeGetItem(VERSION_KEY)) || 0) + 1);
    try {
      localStorage.setItem(FILE_KEY, JSON.stringify(file));
      safeSetItem(VERSION_KEY, next);
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
