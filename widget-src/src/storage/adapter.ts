/**
 * The cloud-storage adapter interface (implementation plan §4).
 *
 * Every backend — Dropbox, Google Drive, GitHub, self-host — sits behind this
 * one interface. The widget never talks to a backend directly; it talks to a
 * `SyncManager` (sync-manager.ts) which talks to one adapter.
 *
 * HARD requirement (§4.1): each adapter is folder/repo-scoped — it can only ever
 * touch the app's own `Health Roadmap` data, never the rest of the user's cloud.
 */
import type { RoadmapFile } from '@roadmap/health-core';

export type StorageBackendId =
  | 'google-drive'
  | 'dropbox'
  | 'github'
  | 'self-host'
  | 'local' // no-sync, single-device tier (localStorage) — the "guest" tier
  | 'memory'; // test/demo only

/**
 * Thrown by `write()` when the remote file changed since the `expectedVersion`
 * we read — i.e. another device wrote in between. The SyncManager catches this,
 * re-reads, re-merges, and retries. NOT a fatal error.
 */
export class ConflictError extends Error {
  constructor(message = 'Remote file changed since last read') {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Any other storage failure (network, auth, corruption, verify mismatch). */
export class StorageError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Result of reading the file. `file` is the JSON-parsed object cast to
 * RoadmapFile WITHOUT normalisation — the SyncManager runs it through
 * `migrateFile()` to fill defaults + gate the schema version. `version` is the
 * backend's change token (Dropbox `rev`, Drive `headRevisionId`, GitHub `sha`,
 * mtime/ETag) — opaque to everything above the adapter.
 */
export interface ReadResult {
  file: RoadmapFile | null;
  version: string | null;
}

export interface WriteResult {
  version: string;
}

export interface StorageAdapter {
  readonly id: StorageBackendId;
  readonly label: string;

  /** Establish folder/repo-scoped access (OAuth/PKCE, pasted token, or local pick). */
  connect(): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;

  /** Read the record file. Returns {file:null, version:null} if it doesn't exist yet. */
  read(): Promise<ReadResult>;

  /**
   * Write the record file with an optimistic-concurrency precondition.
   * @param expectedVersion the `version` from the read this write is based on,
   *   or null for a first-ever create. Throws ConflictError if the remote moved.
   */
  write(file: RoadmapFile, expectedVersion: string | null): Promise<WriteResult>;

  /** Read an uploaded document blob (e.g. 'documents/doc_1.pdf'). */
  readDocument(ref: string): Promise<Blob>;

  /**
   * Write an uploaded document blob. Per §5.3, callers write the blob FIRST,
   * then commit the `documents[]` reference via `write()` — so the JSON write is
   * the atomic commit point and orphan blobs are harmless.
   */
  writeDocument(ref: string, bytes: Blob): Promise<void>;

  /**
   * OPTIONAL synchronous last-ditch write, used only on tab-close /
   * visibilitychange where an async chain may not finish (esp. mobile). Only
   * backends whose write is genuinely synchronous (localStorage) implement it;
   * cloud backends omit it (network can't be sync) and fall back to a
   * best-effort async flush. No version check — it's the emergency
   * last-write-on-this-device path.
   */
  writeSync?(file: RoadmapFile): void;
}
