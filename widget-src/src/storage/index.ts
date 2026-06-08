/**
 * The local-first storage layer (implementation plan §4–§5). Browser-coupled:
 * adapters use fetch / Web Crypto / localStorage. The pure file schema + merge
 * logic lives in @roadmap/health-core (roadmap-file.ts, merge.ts, migrate.ts).
 */
export {
  ConflictError,
  StorageError,
  type StorageAdapter,
  type StorageBackendId,
  type ReadResult,
  type WriteResult,
} from './adapter';
export { SyncManager, type SaveResult } from './sync-manager';
// RoadmapStore + its Api* types are imported directly from './roadmap-store' by
// the data shim (lib/roadmap-data.ts) — not re-exported here to avoid a second
// canonical copy of the Api* type names (api.ts owns those).
// Thrown by SyncManager (via migrate) when the cloud file is from a newer app
// version — surfaced here so UI can show "update the app", not a generic error.
export { SchemaTooNewError } from '@roadmap/health-core';
export { MemoryAdapter, MemoryCloud } from './memory-adapter';
export { LocalStorageAdapter } from './local-storage-adapter';
export { DropboxAdapter, type DropboxConfig } from './dropbox';
export { getDeviceId } from './device-id';
export { runStorageSelfTest, type SelfTestResult } from './self-test';
